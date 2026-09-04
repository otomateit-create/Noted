/**
 * Index fin des cours ouverts.
 *
 * Jumeau de `store.ts` : meme cycle de vie, meme cache sur disque, meme
 * reprise a l'ouverture — mais pour le decoupage fin, et a son tour.
 *
 * Deux differences, et elles se tiennent. Le decoupage se fait a l'ouverture du
 * cours, mais la vectorisation attend que le round large soit entierement ecrit
 * sur le disque : les deux se disputaient sinon le meme moteur, tranche contre
 * tranche, et celui qu'on attend pour poser une question avancait deux fois
 * moins vite. Et ce round-ci n'a pas de canal d'etat a lui : il rend compte a
 * celui qui l'a lance, qui possede deja le point de progression et sait quoi en
 * faire.
 */

import type { ExtractedCourse } from '../../shared/types'
import { chunkCourseFine, type FineChunk } from './chunk-fine'
import { EMBEDDING_MODEL, embed } from './embedder'
import { FineIndex } from './fine-index'
import { chunksFingerprint, loadVectors, saveVectors } from './vector-cache'

export interface FineIndexedCourse {
  /**
   * Identifiant courant du cours, pour la meme raison que sur `IndexedCourse` :
   * il vit sur l'entree et non dans les fermetures qui l'utilisent, si bien
   * qu'un cours renomme en pleine vectorisation poursuit son calcul sous son
   * nouveau nom au lieu de s'arreter en chemin.
   */
  courseId: string
  index: FineIndex
  /**
   * Empreinte du decoupage fin. Elle ne partage rien avec celle du round large
   * — ce sont deux textes differents — mais elle joue le meme role : reconnaitre
   * un cours rouvert sans modification.
   */
  signature: string
  /** Vrai tant qu'un calcul fin tourne sur ce cours. */
  running: boolean
  /**
   * Les passages fins, gardes sur l'entree.
   *
   * Le decoupage se fait a l'ouverture du cours, la vectorisation seulement
   * quand le round large a fini : entre les deux il faut bien que quelqu'un
   * tienne le resultat. Le garder ici evite surtout d'avoir a retenir tout le
   * texte du cours pour le redecouper plus tard.
   */
  chunks: FineChunk[]
  /** Passages fins deja vectorises et ecrits sur le disque. */
  done: number
}

/** Ce que le round fin rapporte a qui l'a lance, pour que l'ecran suive. */
export type FineReport = (etat: {
  done: number
  total: number
  fini: boolean
  reason?: string
}) => void

const courses = new Map<string, FineIndexedCourse>()

/**
 * Les trois constantes qui suivent, et la boucle de vectorisation plus bas, sont
 * recopiees de `store.ts` au lieu d'etre partagees avec lui. C'est un choix
 * assume, et il doit etre dit ici avant que quelqu'un ne vienne « nettoyer » la
 * duplication.
 *
 * Generaliser `vectorise()` pour qu'il serve les deux decoupages obligerait a
 * toucher au chemin qui fonctionne aujourd'hui : c'est lui qui alimente la
 * recherche de l'assistant, lui qu'on regarde avancer a l'ecran, et le seul dont
 * une regression se paie en heures de calcul refaites sur tout un vault. Le
 * round fin, lui, est un supplement dont rien ne depend encore. Trente lignes en
 * double coutent infiniment moins cher que le risque de casser l'autre.
 *
 * La contrepartie a accepter : une correction apportee a la boucle large ne
 * descend pas ici toute seule. Les valeurs ci-dessous sont celles de `store.ts`,
 * et c'est la-bas que chacune raconte l'experience qui l'a fixee.
 */

/** Passages vectorises entre deux ecritures sur disque. */
const SLICE = 50

/** Tentatives supplementaires apres un moteur qui n'a pas repondu. */
const RETRIES = 2

/** Pause entre deux tentatives, le temps que le processus mort soit enterre. */
const PAUSE = 3 * 1000

/**
 * Decoupe le cours en passages fins, et s'arrete la.
 *
 * Rien n'est vectorise ici, et c'est tout l'objet de la separation : le round
 * fin ne doit pas disputer le moteur au round large. Les deux passaient
 * autrefois dans la meme file d'attente, tranche contre tranche, et le premier
 * — celui qui fait vivre la recherche de l'assistant, celui qu'on regarde
 * avancer a l'ecran — avancait deux fois moins vite pour un supplement dont
 * rien ne depend tant qu'il n'est pas fini. On decoupe donc a l'ouverture, ce
 * qui coute quelques dizaines de millisecondes, et on attend son tour.
 */
export function prepareCourseFine(extracted: ExtractedCourse): void {
  const chunks = chunkCourseFine(extracted)
  const signature = chunksFingerprint(chunks, EMBEDDING_MODEL)

  const known = courses.get(extracted.courseId)
  // Meme document, meme decoupage : l'entree en place est deja la bonne, et la
  // remplacer rendrait orphelin un calcul en cours sur les memes fichiers.
  if (known && known.signature === signature) return

  courses.set(extracted.courseId, {
    courseId: extracted.courseId,
    index: new FineIndex(chunks),
    signature,
    running: false,
    chunks,
    done: 0
  })
}

/**
 * Lance — ou reprend — la vectorisation fine d'un cours deja decoupe.
 *
 * Appele par le round large au moment ou il s'acheve, et lui seul : c'est
 * l'ordre voulu, le decoupage large d'abord, le fin ensuite. Un calcul
 * interrompu reprend ici sans rien de plus, parce que `loadVectors` relit ce
 * qui est deja sur le disque et que la boucle repart de la — exactement comme
 * le round large le fait depuis toujours.
 */
export function startCourseFine(courseId: string, report: FineReport): void {
  const entry = courses.get(courseId)
  if (!entry) return

  if (entry.index.hasVectors) {
    report({ done: entry.chunks.length, total: entry.chunks.length, fini: true })
    return
  }
  if (entry.running) return

  launch(entry, entry.chunks, report)
}

function launch(entry: FineIndexedCourse, chunks: FineChunk[], report: FineReport): void {
  entry.running = true
  void vectoriseFine(entry, chunks, report)
    // Sans ce filet, la moindre exception devient un rejet non intercepte dans
    // le processus principal : personne n'attend cette promesse, et l'appel qui
    // l'a lancee a rendu la main depuis longtemps. La trace console est le seul
    // endroit ou un echec du round fin puisse encore se voir, faute d'un point
    // de progression a lui — et un ancrage qui ne se fait plus ressemble sinon
    // a un simple mauvais resultat.
    .catch((cause: unknown) => {
      console.warn(`[rag] index fin impossible pour ${entry.courseId} :`, cause)
    })
    .finally(() => {
      entry.running = false
    })
}

/**
 * Vectorise le decoupage fin d'un cours, en reprenant ce qui est deja calcule.
 *
 * Copie assumee de `vectorise()` — voir le bloc sur les constantes plus haut —
 * allegee de tout ce qui parlait a l'interface. Deux choses ne s'allegent pas :
 * la reprise, qui ne coute rien de plus que de lire le cache avant de calculer ;
 * et la verification que le cours est toujours celui qu'on croit, parce qu'un
 * vecteur rattache au mauvais passage est bien pire que pas de vecteur du tout.
 */
async function vectoriseFine(
  entry: FineIndexedCourse,
  chunks: FineChunk[],
  report: FineReport
): Promise<void> {
  // Un cours sans passage fin n'est pas un incident. Le round large, lui,
  // annonce son echec dans ce cas, parce que toute la recherche en depend et
  // qu'un scan illisible doit se dire. Ici il n'y a rien a ancrer, rien de
  // casse, et rien a raconter a personne.
  if (chunks.length === 0) {
    // Rien a affiner n'est pas un echec : le cours est traite, point final.
    report({ done: 0, total: 0, fini: true })
    return
  }

  // Le cours a pu etre reindexe ou ferme entre-temps : on ne rattache jamais des
  // vecteurs qu'a l'index auquel ils correspondent.
  const current = (): boolean => courses.get(entry.courseId) === entry

  const avance = (fini: boolean, reason?: string): void => {
    if (!current()) return
    entry.done = vectors.length
    report({ done: vectors.length, total: chunks.length, fini, reason })
  }

  const vectors = (await loadVectors(entry.courseId, chunks, EMBEDDING_MODEL, 'fine')) ?? []
  if (vectors.length === chunks.length) {
    if (!current()) return
    entry.index.setVectors(vectors)
    avance(true)
    return
  }

  avance(false)
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
      // La raison de l'echec n'est pas relevee : elle n'a nulle part ou aller.
      // Ce qui est deja ecrit reste acquis, et la prochaine ouverture du cours
      // reprendra a partir de la.
      if (echecs > RETRIES) {
        avance(false, reason ?? undefined)
        return
      }
      await new Promise((resume) => setTimeout(resume, PAUSE))
      continue
    }

    echecs = 0
    vectors.push(...computed)

    // « Calcule » ne suffit pas a considerer le travail fait : un vecteur qui
    // n'atteint pas le disque sera a refaire, et calculer les tranches suivantes
    // ne ferait qu'allonger un travail dont rien ne se gardera.
    if (!(await saveVectors(entry.courseId, chunks, EMBEDDING_MODEL, vectors, 'fine'))) {
      avance(false, 'Les vecteurs fins calcul\u00e9s n\u2019ont pas pu \u00eatre \u00e9crits sur le disque.')
      return
    }

    avance(false)
  }

  if (!current()) return
  entry.index.setVectors(vectors)
  avance(true)
}

/** L'index fin d'un cours, ou null s'il n'a jamais ete construit. */
export function fineIndexedCourse(courseId: string): FineIndexedCourse | null {
  return courses.get(courseId) ?? null
}

export function forgetCourseFine(courseId: string): void {
  courses.delete(courseId)
}

/**
 * Suit un cours renomme ou deplace, exactement comme `renameCourse` le fait pour
 * le round large. Un index fin laisse sous l'ancien identifiant est perdu deux
 * fois : l'ancrage ne le trouve plus, et plus rien ne peut le liberer.
 */
export function renameCourseFine(previousId: string, nextId: string): void {
  const entry = courses.get(previousId)
  if (!entry) return

  // Le nouveau nom peut deja etre occupe — un cours indexe puis remplace sur le
  // disque, par exemple. Ecraser l'entree en place rendrait son calcul en cours
  // orphelin : il continuerait a tourner et a ecrire dans le cache sans que plus
  // rien ne puisse l'atteindre ni l'arreter. On laisse l'occupant tranquille.
  if (courses.has(nextId)) {
    courses.delete(previousId)
    return
  }

  courses.delete(previousId)
  courses.set(nextId, entry)

  // Un calcul en cours relit ce nom a chaque tranche : il poursuit sans rien
  // savoir du renommage, et ecrit desormais sous le nouveau nom — la ou
  // renameVectors vient de deplacer ce qui etait deja calcule.
  entry.courseId = nextId
}
