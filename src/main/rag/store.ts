/**
 * Index des cours ouverts.
 *
 * L'index se construit a l'ouverture du document et vit en memoire tant que
 * l'application tourne.
 *
 * Sa partie lexicale est reconstruite a chaque fois : quelques millisecondes de
 * JavaScript, moins cher a recalculer qu'a relire. Ses vecteurs, eux, sont
 * gardes sur disque — plusieurs secondes de calcul soutenu qu'il serait absurde
 * de refaire a chaque ouverture, alors que le resultat ne change pas tant que le
 * document et le modele restent les memes.
 */

import type {
  CourseAnchor,
  ExtractedCourse,
  VectorPhase,
  VectorStatus
} from '../../shared/types'
import { describeFigures } from '../figures/describe'
import type { FigureDescription } from '../figures/markers'
import { chunkCourse, type Chunk } from './chunk'
import { EMBEDDING_MODEL, embed } from './embedder'
import { CourseIndex } from './search'
import {
  forgetCourseFine,
  prepareCourseFine,
  renameCourseFine,
  startCourseFine
} from './store-fine'
import { chunksFingerprint, loadVectors, saveVectors } from './vector-cache'

export interface IndexedCourse {
  /**
   * Identifiant courant du cours. Il vit sur l'entree, et non dans les
   * fermetures qui l'utilisent : un cours renomme en pleine vectorisation
   * continue ainsi son calcul sous son nouveau nom, au lieu de s'arreter en
   * chemin et de laisser un etat fige a l'ecran.
   */
  courseId: string
  index: CourseIndex
  /** Plan du document, injecte dans le prompt pour guider les recherches. */
  outline: string[]
  anchor: CourseAnchor
  pageCount: number
  looksScanned: boolean
  /**
   * Empreinte du decoupage. Elle ne change que si le document ou le modele
   * change : c'est a elle qu'on reconnait un cours rouvert sans modification.
   */
  signature: string
  /** Ou en est la vectorisation, tel que l'interface l'affiche. */
  status: VectorStatus
  /** Vrai tant qu'un calcul est en cours sur ce cours. */
  running: boolean
  /**
   * Les images du document, dans l'ordre d'apparition : la n-ieme donne le
   * marqueur « [figure n] » du texte.
   */
  media: string[]
  /**
   * Ce que les images disent, par rang de marqueur. Vide tant que la
   * description n'a pas eu lieu, et vide pour toujours sur un cours sans image
   * ou dont les images sont toutes decoratives.
   */
  figures: Map<number, FigureDescription>
  /**
   * La description en cours, s'il y en a une — et ou elle en est.
   *
   * Sert de verrou : un cours rouvert pendant la description repasse par
   * `launch`, relit ses vecteurs en cache et rappelle la fin du second round,
   * ce qui lancerait une seconde serie d'appels sur les memes images. Porte la
   * progression parce que ce meme chemin republie « complet » au passage : il
   * faut de quoi remettre le point sur les images sans avoir a redemander au
   * descripteur ou il en est.
   */
  describing: { done: number; total: number } | null
}

const courses = new Map<string, IndexedCourse>()

/**
 * Nombre de passages vectorises entre deux ecritures sur disque.
 *
 * Un cours de cinq cents pages demande plusieurs minutes de calcul, et rien ne
 * garantit que l'application reste ouverte jusqu'au bout. En ecrivant par
 * tranches, une fermeture en cours de route ne coute que la tranche entamee :
 * la prochaine ouverture reprend la ou l'on s'etait arrete, au lieu de tout
 * recommencer — et de ne jamais aboutir.
 *
 * Cinquante et non deux cents : un cours ordinaire fait quatre-vingt-dix
 * passages, et une tranche plus large que le cours lui-meme ramenait la
 * promesse de reprise a rien — c'etait zero ou tout, sans milieu. La contrepartie
 * est que le fichier de vecteurs est reecrit en entier a chaque tranche, mais il
 * se compte en megaoctets et l'ecriture disparait derriere le calcul.
 */
const SLICE = 50

/**
 * Tentatives supplementaires apres un moteur qui n'a pas repondu.
 *
 * L'echec libere le processus de calcul : la tentative suivante repart sur un
 * processus neuf, qui recharge son modele — ce qui suffit a passer un demarrage
 * rate. Au-dela, insister ne ferait que boucler ; ce qui est deja ecrit reste
 * acquis, et la prochaine ouverture du cours reprendra a partir de la.
 */
const RETRIES = 2

/**
 * Pause entre deux tentatives.
 *
 * L'echec vient de liberer le processus de calcul, et sa mort n'est effective
 * qu'au tour de boucle suivant. Repartir dans l'instant demandait un moteur
 * neuf a un systeme encore occupe a enterrer l'ancien : les trois tentatives
 * s'epuisaient en moins d'une seconde, sans qu'aucune ait vraiment eu sa chance,
 * et l'echec paraissait immediat.
 */
const PAUSE = 3 * 1000

/** Prevenu a chaque changement d'etat, pour que l'interface suive. */
let announce: (status: VectorStatus) => void = () => {}

export function watchVectorStatus(handler: (status: VectorStatus) => void): void {
  announce = handler
}

/**
 * Les cours dont le texte est arrive mais dont l'index n'existe pas encore.
 *
 * Entre l'arrivee du texte et la creation de l'entree, il se passe le
 * decoupage en passages — une trentaine de secondes sur un cours de cinq cents
 * pages. Sans cet etat, le cours n'avait aucun point a l'ecran pendant tout ce
 * temps : « en preparation » se confondait avec « rien ne se passe ». On ne le
 * pose que pour un cours inconnu : un cours deja indexe garde son etat, complet
 * ou en cours, et ne retombe pas a zero.
 */
const preparing = new Map<string, VectorStatus>()

export function prepareCourse(courseId: string): void {
  if (courses.has(courseId) || preparing.has(courseId)) return
  const status: VectorStatus = { courseId, phase: 'attente', done: 0, total: 0 }
  preparing.set(courseId, status)
  announce(status)
}

/**
 * La preparation n'a pas abouti : l'index ne viendra pas. Le point provisoire
 * ne doit pas clignoter pour un travail qui s'est arrete — il passe en echec,
 * avec la raison, comme le ferait le calcul lui-meme.
 */
export function failPreparation(courseId: string, cause: unknown): void {
  if (!preparing.has(courseId)) return
  const status: VectorStatus = {
    courseId,
    phase: 'echec',
    done: 0,
    total: 0,
    reason: cause instanceof Error ? cause.message : String(cause)
  }
  preparing.set(courseId, status)
  announce(status)
}

/** Etat de la vectorisation d'un cours, ou null s'il n'est pas ouvert. */
export function vectorStatus(courseId: string): VectorStatus | null {
  return courses.get(courseId)?.status ?? preparing.get(courseId) ?? null
}

export function indexCourse(extracted: ExtractedCourse): IndexedCourse {
  const { chunks, outline } = chunkCourse(extracted)
  const signature = chunksFingerprint(chunks, EMBEDDING_MODEL)

  // L'index existe a partir d'ici, quel que soit le chemin : l'etat provisoire
  // a fait son office.
  preparing.delete(extracted.courseId)

  const known = courses.get(extracted.courseId)
  if (known && known.signature === signature) {
    // Meme document, meme decoupage : l'index est deja le bon, et le refaire
    // lancerait un second calcul concurrent du premier sur le meme fichier.
    // En revanche, une vectorisation restee en plan reprend ici — c'est la
    // reprise a l'ouverture, et elle ne demande rien de plus.
    if (!known.running && known.status.phase !== 'complet') {
      launch(known, chunks)
    }
    alsoIndexFine(extracted)
    return known
  }

  const entry: IndexedCourse = {
    courseId: extracted.courseId,
    index: new CourseIndex(chunks),
    outline,
    anchor: extracted.anchor,
    pageCount: extracted.pageCount,
    looksScanned: extracted.looksScanned,
    signature,
    status: {
      courseId: extracted.courseId,
      phase: 'attente',
      done: 0,
      total: chunks.length
    },
    running: false,
    media: extracted.media ?? [],
    figures: new Map(),
    describing: null
  }

  courses.set(extracted.courseId, entry)

  // L'attente est annoncee des la creation, et seulement la. Sans cette
  // annonce, un cours reste sans le moindre point a l'ecran tant que rien n'a
  // abouti — « pas encore commence » ne se distingue alors pas de « jamais
  // indexe ». Et la placer au debut du calcul plutot qu'ici ferait, a chaque
  // reprise, retomber le compteur a zero et effacer la raison du dernier echec.
  announce(entry.status)

  // Les vecteurs arrivent apres coup : l'index lexical est immediatement
  // utilisable, et la recherche par le sens s'ajoute des qu'elle est prete.
  launch(entry, chunks)

  alsoIndexFine(extracted)

  return entry
}

/**
 * Lance le second decoupage, celui qui sert a poser une note au bon paragraphe.
 *
 * Rien de ce qui se passe la-dedans ne doit pouvoir retarder ni faire echouer ce
 * qui precede. Le decoupage large fait vivre la recherche de l'assistant : c'est
 * lui qu'on attend, c'est lui qui s'affiche, et son echec se paie en reponses
 * moins bonnes a chaque question. Le decoupage fin n'apporte qu'un confort de
 * prise de notes. D'ou le `try` autour d'un appel qui, par ailleurs, rend deja
 * la main aussitot : il ne fait que deposer son calcul en arriere-plan.
 *
 * Appele sur les deux chemins de retour, et pas seulement sur le cours neuf. Le
 * chemin « meme document, meme empreinte » est celui de la reprise : c'est la
 * que le round large rattrape une vectorisation restee en plan a la fermeture
 * precedente, et le round fin a exactement le meme besoin — sans cet appel, un
 * cours rouvert dans la meme session ne rattraperait jamais son index fin
 * manquant. `indexCourseFine` tient son propre registre et sa propre empreinte :
 * sur un cours deja fin-indexe et complet, l'appel ne coute qu'un decoupage et
 * une empreinte, et ne relance aucun calcul.
 *
 * Il vient apres `launch` et jamais avant : les vectorisations de documents
 * passent une par une dans la file de l'embedder, et deposer la premiere tranche
 * fine avant la premiere tranche large ferait attendre celle-ci pour rien.
 */
function alsoIndexFine(extracted: ExtractedCourse): void {
  try {
    prepareCourseFine(extracted)
  } catch (cause) {
    console.warn(`[rag] index fin impossible pour ${extracted.courseId} :`, cause)
  }
}

function launch(entry: IndexedCourse, chunks: Chunk[]): void {
  entry.running = true
  void vectorise(entry, chunks)
    // Sans ce filet, la moindre exception ici devient un rejet non intercepte
    // dans le processus principal : personne n'attend cette promesse, l'appel
    // qui l'a lancee a rendu la main depuis longtemps.
    .catch((cause: unknown) => {
      // Meme reserve que partout ailleurs : on n'annonce rien au nom d'un cours
      // qui a ete ferme ou reindexe entre-temps.
      if (courses.get(entry.courseId) !== entry) return
      entry.status = {
        ...entry.status,
        phase: 'echec',
        reason: cause instanceof Error ? cause.message : String(cause)
      }
      announce(entry.status)
    })
    .finally(() => {
      entry.running = false
    })
}

/**
 * Vectorise un cours, en reprenant ce qui a deja ete calcule.
 *
 * Rien n'est jamais suppose acquis : ni que le cours est encore ouvert, ni que
 * le moteur repondra, ni que le disque acceptera l'ecriture. Chaque etape
 * franchie est annoncee, et l'etat annonce dit exactement ou en est le travail
 * — ce que l'interface reprend telle quelle.
 */
async function vectorise(entry: IndexedCourse, chunks: Chunk[]): Promise<void> {
  // Le cours a pu etre reindexe ou ferme entre-temps : on ne rattache jamais
  // des vecteurs qu'a l'index auquel ils correspondent.
  const current = (): boolean => courses.get(entry.courseId) === entry

  const publish = (phase: VectorPhase, done: number, reason?: string): void => {
    if (!current()) return
    entry.status = { courseId: entry.courseId, phase, done, total: chunks.length, reason }
    announce(entry.status)
  }

  // Un document dont on n'a tire aucun texte — un scan, typiquement. Il n'y a
  // rien a vectoriser et rien ne sera trouvable : mieux vaut le signaler que
  // laisser croire que la recherche fonctionne.
  if (chunks.length === 0) {
    publish('echec', 0)
    return
  }

  // Deuxieme ouverture et suivantes : quelques millisecondes de lecture, et
  // rien ne se calcule. Le processus de calcul n'est meme pas demarre — il ne
  // le sera qu'a la premiere question, pour vectoriser la requete.
  const vectors = (await loadVectors(entry.courseId, chunks, EMBEDDING_MODEL)) ?? []
  if (vectors.length === chunks.length) {
    if (!current()) return
    entry.index.setVectors(vectors)
    publish('complet', vectors.length)
    affiner(entry)
    return
  }

  // Premiere ouverture, ou reprise d'un calcul interrompu. Le tout premier
  // cours d'une installation attend en plus le telechargement du modele.
  publish('calcul', vectors.length)
  let echecs = 0

  while (vectors.length < chunks.length) {
    if (!current()) return

    const slice = chunks.slice(vectors.length, vectors.length + SLICE)
    const { vectors: computed, reason } = await embed(
      slice.map((chunk) => chunk.text),
      'document',
      slice.map((chunk) => chunk.context)
    )

    if (!computed || computed.length !== slice.length) {
      echecs += 1
      if (echecs > RETRIES) {
        publish('echec', vectors.length, reason ?? undefined)
        return
      }
      await new Promise((resume) => setTimeout(resume, PAUSE))
      continue
    }

    echecs = 0
    vectors.push(...computed)

    // « Calcule » ne suffit pas a considerer le travail fait : un vecteur qui
    // n'atteint pas le disque sera a refaire a la prochaine ouverture.
    if (!(await saveVectors(entry.courseId, chunks, EMBEDDING_MODEL, vectors))) {
      publish(
        'echec',
        vectors.length - computed.length,
        'Les vecteurs calculés n’ont pas pu être écrits sur le disque.'
      )
      return
    }

    publish('calcul', vectors.length)
  }

  if (!current()) return
  entry.index.setVectors(vectors)
  publish('complet', vectors.length)
  affiner(entry)
}

/**
 * Le round large est fini : on passe la main au round fin.
 *
 * L'ordre n'est pas un detail de mise en oeuvre, c'est ce que le point de
 * progression raconte. Le decoupage large d'abord — celui dont depend chaque
 * reponse de l'assistant —, et seulement quand il est entierement ecrit sur le
 * disque, l'affinage. Les faire courir ensemble revenait a ralentir de moitie
 * celui qu'on attend pour avancer celui dont on peut se passer.
 *
 * Un echec de l'affinage ne repasse pas le cours en « echec » : la recherche
 * marche, elle vient d'etre calculee. Il laisse le point a l'orange, avec sa
 * raison dans l'infobulle — ce qui est exactement ce qui s'est passe.
 */
function affiner(entry: IndexedCourse): void {
  const current = (): boolean => courses.get(entry.courseId) === entry
  if (!current()) return

  startCourseFine(entry.courseId, ({ done, total, fini, reason }) => {
    if (!current()) return

    // Le seul point de fin des deux rounds, et donc le seul endroit d'ou les
    // images puissent partir se faire decrire.
    if (fini) {
      describeImages(entry, done, total)
      return
    }

    entry.status = { courseId: entry.courseId, phase: 'affine', done, total, reason }
    announce(entry.status)
  })
}

/**
 * Les deux rounds sont finis : reste, sur un document illustre, a faire decrire
 * ses images.
 *
 * Elles passent en dernier parce qu'elles ne servent a rien de ce qui precede :
 * les descriptions n'entrent pas dans les vecteurs, l'assistant les lit dans
 * « lire » et rien d'autre. Le cours est donc deja entierement cherchable quand
 * cette etape commence — c'est ce que dit le point jaune, qui n'annonce pas un
 * travail qu'on attend mais un supplement qui arrive.
 *
 * A la deuxieme ouverture du cours, tout est en cache : l'etape ne dure que le
 * temps de relire une vingtaine de petits fichiers.
 */
function describeImages(entry: IndexedCourse, done: number, total: number): void {
  const current = (): boolean => courses.get(entry.courseId) === entry

  // Ce que « complet » annonce reste le compte des passages, et non celui des
  // images : c'est l'infobulle du point vert qui parle, et elle dit « N passages
  // affines ». Y glisser le nombre d'images ferait croire a un cours de vingt et
  // un passages.
  const finish = (): void => {
    if (!current()) return
    entry.status = { courseId: entry.courseId, phase: 'complet', done, total }
    announce(entry.status)
  }

  const progress = (fait: number, sur: number): void => {
    entry.describing = { done: fait, total: sur }
    if (!current()) return
    entry.status = { courseId: entry.courseId, phase: 'images', done: fait, total: sur }
    announce(entry.status)
  }

  if (entry.media.length === 0) {
    finish()
    return
  }

  // Le cours a ete rouvert pendant la description : le round large a relu son
  // cache en quelques millisecondes et vient de republier « complet » par-dessus
  // un travail qui n'est pas fini. On remet le point sur les images et on laisse
  // la description en cours aller au bout.
  if (entry.describing) {
    progress(entry.describing.done, entry.describing.total)
    return
  }

  // Le total definitif — les seules images retenues — n'est connu qu'apres les
  // reductions, qui prennent quelques secondes. D'ici la, le nombre de figures du
  // document est une approximation honnete, et vaut mieux qu'un point qui reste
  // sur l'affinage sans rien dire.
  progress(0, entry.media.length)

  void describeFigures(entry.media, progress)
    .then((figures) => {
      entry.figures = figures
    })
    .catch((cause: unknown) => {
      // Une description qui ne vient pas ne casse rien : le cours est indexe et
      // les marqueurs restent nus. Le dire ici est le seul endroit ou cela se
      // voie, faute d'un etat d'echec qui aurait un sens a l'ecran.
      console.warn(`[figures] description impossible pour ${entry.courseId} :`, cause)
    })
    .finally(() => {
      entry.describing = null
      finish()
    })
}

export function indexedCourse(courseId: string): IndexedCourse | null {
  return courses.get(courseId) ?? null
}

export function forgetCourse(courseId: string): void {
  courses.delete(courseId)
  preparing.delete(courseId)
  forgetCourseFine(courseId)
}

/**
 * Suit un cours renomme ou deplace. L'index ne depend que du texte, qui n'a pas
 * bouge : le reconstruire couterait une relecture complete du document pour un
 * resultat identique.
 */
export function renameCourse(previousId: string, nextId: string): void {
  // Le round fin tient son propre registre, avec sa propre precaution sur un nom
  // deja occupe : il suit le cours ici, avant les sorties anticipees qui
  // viennent plus bas. Un index fin reste sous l'ancien identifiant devient
  // introuvable pour l'ancrage, et plus rien ne peut le liberer.
  renameCourseFine(previousId, nextId)

  // Un cours renomme pendant sa preparation : l'index arrivera sous l'ancien
  // nom et sera deplace a son tour, mais l'etat provisoire, lui, ne doit pas
  // survivre sous un nom que plus personne n'interroge.
  preparing.delete(previousId)

  const entry = courses.get(previousId)
  if (!entry) return

  // Le nouveau nom peut deja etre occupe — un cours indexe puis remplace sur le
  // disque, par exemple. Ecraser l'entree en place rendrait son calcul en cours
  // orphelin : il continuerait a tourner, a ecrire, sans que plus rien ne
  // puisse l'atteindre ni l'arreter. On laisse alors l'occupant tranquille.
  if (courses.has(nextId)) {
    courses.delete(previousId)
    return
  }

  courses.delete(previousId)
  courses.set(nextId, entry)

  // Un calcul en cours lit ce nom a chaque tranche : il poursuit sans rien
  // savoir du renommage, et ecrit desormais sous le nouveau nom — la ou
  // renameVectors vient de deplacer ce qui etait deja calcule.
  entry.courseId = nextId
  entry.status = { ...entry.status, courseId: nextId }
}
