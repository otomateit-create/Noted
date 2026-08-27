/**
 * Le passage du cours dont un texte de note parle le plus.
 *
 * Une note s'ecrit de deux mains dans cette application : celle du lecteur, qui
 * tape dans l'editeur, et celle de l'assistant, qui insere un bloc par
 * `note_inserer`. Les deux posent pourtant exactement la meme question — de quel
 * paragraphe du cours ce texte-ci parle-t-il — et surtout, les deux doivent en
 * recevoir exactement la meme reponse. Deux implementations, meme fideles l'une
 * a l'autre le jour de leur ecriture, finiraient par diverger d'un reglage ou
 * d'une correction : la marge des notes raconterait alors deux histoires
 * differentes selon qui a tenu le stylo, sur un cours ou rien n'a change. D'ou
 * cette machinerie unique, aux deux portes — un texte pour la frappe, une
 * liste pour les blocs d'une insertion — que les deux chemins appellent sans
 * rien y ajouter.
 *
 * Elle vit dans `rag/` et non dans `claude/` parce qu'elle ne doit rien a
 * l'assistant : elle lit l'index fin et interroge le modele de vecteurs, c'est
 * toute la machinerie de ce dossier, et elle ignore ce qu'est une conversation,
 * un outil ou un tour. La ranger chez l'assistant ferait dependre le chemin
 * humain — le plus frequent des deux — d'un dossier qui ne le concerne pas.
 *
 * Un module `claude/anchor.ts` a longtemps tenu l'autre moitie de ce travail :
 * il verifiait sur le cours reel l'ancre que l'assistant affirmait, page par
 * page et passage par passage, et refusait l'outil quand l'endroit n'existait
 * pas. Il a disparu avec le parametre qu'il servait — plus personne n'enonce
 * d'ancre, donc plus rien a verifier. C'est la la simplification de fond : la
 * question « cet endroit existe-t-il » ne se pose plus a personne, il ne reste
 * que « de quel endroit ce texte parle-t-il », et elle a une seule reponse pour
 * les deux mains.
 */

import { compareOrderKeys } from '../../shared/note-order'
import type { NoteAnchor, OrderKey } from '../../shared/types'
import type { FineChunk } from './chunk-fine'
import { embed } from './embedder'
import { fineIndexedCourse } from './store-fine'
import type { FineIndexedCourse } from './store-fine'

/**
 * Le meilleur passage pour ce texte, ou null s'il n'y a rien a proposer.
 *
 * La forme a un seul texte de `resolveAnchorSequence`, et rien d'autre : c'est
 * le chemin de la frappe humaine, ou les blocs arrivent un par un, au rythme
 * des silences du clavier. Seul, un bloc n'a ni voisin qui le borne ni ordre a
 * respecter : il ne reste que le filtre d'attention et le meilleur cosinus,
 * exactement ce que faisait ce chemin depuis toujours.
 */
export async function resolveAutoAnchor(
  courseId: string,
  text: string,
  candidateUnitKeys: string[]
): Promise<NoteAnchor | null> {
  const [anchor] = await resolveAnchorSequence(courseId, [{ text, cited: [] }], candidateUnitKeys)
  return anchor ?? null
}

/**
 * Un bloc a ancrer, dans une suite de blocs.
 *
 * `text` est ce que l'on compare au cours — vide, le bloc ne s'ancre pas.
 * `cited` sont les pages que le bloc nomme lui-meme, « (p. 54) » : quand il y
 * en a, l'ancre se cherche la et nulle part ailleurs. `fixed`, s'il est
 * present, est une ancre deja connue — un bloc conserve d'une reecriture — :
 * elle est rendue telle quelle, et sert de borne a ses voisins.
 */
export interface AnchorSlot {
  text: string
  cited: number[]
  fixed?: NoteAnchor | null
}

/** Combien de passages proches on regarde avant de choisir. */
const CANDIDATES = 6

/**
 * L'ecart de cosinus en deca duquel un candidat qui respecte l'ordre du
 * document l'emporte sur un meilleur qui le rompt.
 *
 * Calibre sur le resume reel d'Investment Banking : les doublons d'un
 * chapitre a l'autre — la liste des cinq etapes, la formule de la valeur
 * d'entreprise — se tiennent a moins de deux centiemes, et la phrase generique
 * qui volait un bloc a quelques pages de son vrai passage a moins de cinq.
 * Au-dela, le texte parle vraiment d'ailleurs, et l'ordre ne doit pas le
 * forcer.
 */
const ORDER_MARGIN = 0.05

/**
 * Le rang d'un passage dans son unite, lu dans son identifiant « p12#3 ».
 * Le decoupage fin numerote dans l'ordre de la page : c'est ce qui range deux
 * notes d'une meme page dans l'ordre des passages qu'elles commentent.
 */
function rankOf(chunk: FineChunk): number {
  return Number(chunk.id.slice(chunk.id.indexOf('#') + 1)) || 0
}

function keyOf(chunk: FineChunk): OrderKey {
  return [chunk.page ?? chunk.sectionIndex ?? 0, rankOf(chunk)]
}

function toAnchor(chunk: FineChunk): NoteAnchor {
  // Le meme objet que celui qu'une selection a la souris produit — c'est ce
  // qui permet a l'ancre automatique de traverser `anchorMarker`, le fichier
  // Markdown et le surlignage de la marge sans qu'aucun de ces trois etages
  // n'ait a savoir d'ou elle vient. `text`, `before` et `after` sortent du
  // decoupage fin deja normalises : il n'y a rien a nettoyer ici.
  return {
    page: chunk.page,
    section: chunk.page === null ? chunk.heading : null,
    progress: null,
    passage: { text: chunk.text, before: chunk.before, after: chunk.after },
    // Ce que dit une image n'est nulle part dans le document affiche : sans
    // ce rang, la note s'ancrerait bien au schema dont elle parle, et le
    // point de la marge n'aurait rien a encadrer.
    figure: chunk.figure
  }
}

function pagesOf(unitKeys: string[]): number[] {
  return unitKeys
    .filter((key) => key.startsWith('page:'))
    .map((key) => Number(key.slice('page:'.length)))
    .filter((page) => Number.isInteger(page))
}

function pageKeys(from: number, to: number): string[] {
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  const keys: string[] = []
  for (let page = lo; page <= hi; page += 1) keys.push(`page:${page}`)
  return keys
}

/**
 * Les pages qu'un bloc affirme : celles qu'il cite, sinon celle de son ancre
 * fixe. Null quand il ne dit rien — il ne borne alors personne.
 */
function knownPages(slot: AnchorSlot): number[] | null {
  if (slot.cited.length > 0) return slot.cited
  if (slot.fixed?.page != null) return [slot.fixed.page]
  return null
}

/**
 * Les cercles ou chercher l'ancre d'un bloc, du plus sur au plus large.
 *
 * D'abord les pages que le bloc cite lui-meme : quand l'assistant ecrit
 * « (p. 54) », il vient de lire la p. 54, et l'ancre n'a plus qu'a choisir la
 * phrase. Puis l'intervalle entre le dernier bloc au-dessus qui nomme une
 * page et le premier en dessous qui en nomme une : une note suit le cours, et
 * ce qui se trouve entre deux citations parle de ce qui se trouve entre les
 * deux pages — c'est ce qui ecarte les doublons d'un autre chapitre, que le
 * cosinus seul ne distingue pas. Puis les pages consultees dans le tour, et
 * enfin tout le cours. Chaque cercle n'est essaye que si le precedent ne
 * retient aucun passage.
 *
 * Les bornes manquantes se prennent aux pages consultees, puis aux limites du
 * cours : un bloc sans aucun voisin qui parle ne recoit pas d'intervalle, et
 * retombe sur le filtre d'attention d'avant.
 */
function circles(
  slots: AnchorSlot[],
  index: number,
  consulted: string[],
  paged: boolean,
  extent: [number, number] | null
): string[][] {
  const tiers: string[][] = []
  if (paged && extent) {
    const slot = slots[index]
    if (slot.cited.length > 0) tiers.push(slot.cited.map((page) => `page:${page}`))

    let lo: number | undefined
    let hi: number | undefined
    for (let at = index - 1; at >= 0 && lo === undefined; at -= 1) {
      const pages = knownPages(slots[at])
      if (pages) lo = Math.min(...pages)
    }
    for (let at = index + 1; at < slots.length && hi === undefined; at += 1) {
      const pages = knownPages(slots[at])
      if (pages) hi = Math.max(...pages)
    }
    const seen = pagesOf(consulted)
    if (lo === undefined && seen.length > 0) lo = Math.min(...seen)
    if (hi === undefined && seen.length > 0) hi = Math.max(...seen)
    if (lo !== undefined || hi !== undefined) {
      tiers.push(pageKeys(lo ?? extent[0], hi ?? extent[1]))
    }
  }
  if (consulted.length > 0) tiers.push(consulted)
  tiers.push([])
  return tiers
}

/**
 * Le meilleur passage pour chaque bloc d'une suite, dans le meme ordre.
 *
 * Plusieurs blocs a la fois parce que l'assistant ecrit ainsi : une note
 * inseree arrive en plusieurs blocs, dont chacun parle d'un endroit qui lui
 * est propre. Les vectoriser ensemble coute le meme aller-retour vers le
 * worker qu'un texte seul ; les ancrer separement est tout le point — un
 * resume de trente pages n'a pas de page, ses paragraphes en ont une chacun.
 *
 * Mais les ancrer separement ne veut pas dire les ancrer chacun dans son coin.
 * Une note suit le cours, et c'est la contrainte la plus sure qu'on ait : les
 * pages qu'un bloc cite bornent ses voisins (`circles`), et parmi les passages
 * proches d'un bloc, celui qui ne revient pas en arriere par rapport au bloc
 * precedent l'emporte sur un meilleur cosinus qui reculerait — a condition de
 * s'en tenir a `ORDER_MARGIN`. Une ancre fixe compte comme un bloc place :
 * elle borne et ordonne, sans etre recalculee.
 *
 * `consultedUnitKeys` reste le filtre d'attention d'avant — les pages visibles
 * a l'ecran pour le lecteur, celles que l'assistant a lues ou trouvees pour
 * lui — et n'intervient qu'apres les citations et l'intervalle. Jamais une
 * condition : le dernier cercle est toujours le cours entier.
 *
 * Aucun seuil de confiance nulle part : le meilleur score gagne toujours, meme
 * mediocre. Une note posee au mauvais endroit se corrige d'un geste, une note
 * qui refuse de s'ancrer ne laisse rien a corriger.
 *
 * Une entree null n'est pas un incident : c'est l'etat normal tant que le
 * round fin n'a pas fini de calculer, et c'est exactement ce qui se passait
 * avant que l'ancrage automatique n'existe — le bloc reste sans ancre, la
 * note s'ecrit quand meme.
 */
export async function resolveAnchorSequence(
  courseId: string,
  slots: AnchorSlot[],
  consultedUnitKeys: string[]
): Promise<(NoteAnchor | null)[]> {
  const anchors: (NoteAnchor | null)[] = slots.map((slot) => slot.fixed ?? null)

  const alive = slots
    .map((slot, index) => ({ text: slot.text.trim(), index }))
    .filter((entry) => entry.text !== '' && slots[entry.index].fixed === undefined)
  if (alive.length === 0) return anchors

  const course = fineIndexedCourse(courseId)
  if (!course) return anchors

  // Verifier les vecteurs avant d'appeler le modele, et non l'inverse. Sans
  // cette garde, chaque frappe dans un cours pas encore vectorise reveillerait
  // le moteur — trois cents megaoctets a relire depuis le disque — pour un
  // resultat que l'index rendrait vide de toute facon, faute de quoi comparer.
  if (!course.index.hasVectors) return anchors

  try {
    // Le genre « query » contourne la file d'attente des documents. C'est ce qui
    // garantit qu'une note ecrite pendant l'indexation d'un livre de cinq cents
    // pages obtient son ancre tout de suite, au lieu d'attendre son tour
    // derriere plusieurs minutes de calcul de fond.
    const { vectors } = await embed(
      alive.map((entry) => entry.text),
      'query'
    )
    // La longueur se verifie strictement, comme dans `setVectors` : un vecteur
    // decale d'un cran ancrerait chaque bloc au passage de son voisin — plus
    // nuisible qu'aucune ancre, et invisible a la relecture puisque le
    // resultat reste plausible.
    if (!vectors || vectors.length !== alive.length) return anchors

    const pages = course.index.passages
      .map((chunk) => chunk.page)
      .filter((page): page is number => page !== null)
    const paged = pages.length > 0
    const extent: [number, number] | null = paged
      ? [Math.min(...pages), Math.max(...pages)]
      : null

    const vectorOf = new Map(alive.map((entry, rank) => [entry.index, vectors[rank]]))
    let previous: OrderKey | null = null

    slots.forEach((slot, index) => {
      if (slot.fixed !== undefined) {
        previous = slot.fixed ? (anchorOrderKeyIn(course, slot.fixed) ?? previous) : previous
        return
      }
      const vector = vectorOf.get(index)
      if (!vector) return

      let candidates: { chunk: FineChunk; score: number }[] = []
      for (const tier of circles(slots, index, consultedUnitKeys, paged, extent)) {
        candidates = course.index.topK(vector, CANDIDATES, tier)
        if (candidates.length > 0) break
      }
      if (candidates.length === 0) return

      // Seul, un bloc prend le meilleur score. Dans une suite, parmi les
      // candidats a ORDER_MARGIN du meilleur qui ne reculent pas, la page la
      // plus proche l'emporte : une note suit le cours, et quand un bloc cite
      // la regle (p. 76) et son exemple (p. 97), c'est de la regle qu'il
      // parle d'abord. A page egale, le meilleur score garde la main.
      let chosen = candidates[0]
      if (previous) {
        const floor = chosen.score - ORDER_MARGIN
        for (const candidate of candidates) {
          if (candidate.score < floor) continue
          const key = keyOf(candidate.chunk)
          if (compareOrderKeys(key, previous) < 0) continue
          const current = keyOf(chosen.chunk)
          if (compareOrderKeys(current, previous) < 0 || key[0] < current[0]) chosen = candidate
        }
      }

      anchors[index] = toAnchor(chosen.chunk)
      previous = keyOf(chosen.chunk)
    })

    return anchors
  } catch (cause) {
    // Les gardes ci-dessus couvrent tout ce qu'on sait prevoir, et ce filet
    // n'existe que pour ce qu'on ne sait pas : un moteur qui meurt en pleine
    // reponse, un cache de vecteurs corrompu, une exception venue d'un etage
    // qu'on n'a pas ecrit. Ce qui le justifie n'est pas la probabilite de
    // l'echec mais son prix — cette fonction est appelee pendant que
    // l'utilisateur tape, dans un handler IPC, et une exception qui remonte
    // jusque-la casserait la frappe pour un supplement dont rien ne depend. Le
    // pire que puisse couter ce catch est une ancre manquante, exactement comme
    // un index pas encore pret.
    console.warn(`[rag] ancrage automatique impossible pour ${courseId} :`, cause)
    return anchors
  }
}

/**
 * Le rang, dans son unite, du passage qu'une ancre designe.
 *
 * Par le texte d'abord, au caractere pres : une ancre posee par l'ancrage
 * automatique porte exactement le texte d'un passage du decoupage fin. Puis
 * par recherche des premiers caracteres dans les passages de l'unite mis bout
 * a bout : une ancre posee a la souris encadre une phrase qui ne tombe pas sur
 * les frontieres du decoupage. Zero quand on ne sait pas — la note se range
 * alors en tete de sa page, ce qui reste sa page.
 */
function passageRank(course: FineIndexedCourse, unitKey: string, anchor: NoteAnchor): number {
  const passage = anchor.passage
  if (!passage) return 0

  const chunks = course.index.passages.filter((chunk) => chunk.unitKey === unitKey)
  const exact = chunks.find((chunk) => chunk.text === passage.text)
  if (exact) return rankOf(exact)

  const needle = passage.text.slice(0, 40)
  if (needle.length < 8) return 0
  let offset = 0
  const joined = chunks.map((chunk) => chunk.text).join(' ')
  const at = joined.indexOf(needle)
  if (at < 0) return 0
  for (const chunk of chunks) {
    offset += chunk.text.length + 1
    if (at < offset) return rankOf(chunk)
  }
  return 0
}

function anchorOrderKeyIn(course: FineIndexedCourse | null, anchor: NoteAnchor): OrderKey | null {
  if (anchor.page !== null) {
    return [anchor.page, course ? passageRank(course, `page:${anchor.page}`, anchor) : 0]
  }

  if (anchor.section !== null) {
    if (!course) return null
    for (const chunk of course.index.passages) {
      if (chunk.heading === anchor.section && chunk.unitKey.startsWith('section:')) {
        return [
          Number(chunk.unitKey.slice('section:'.length)),
          passageRank(course, chunk.unitKey, anchor)
        ]
      }
    }
    return null
  }

  return anchor.progress === null ? null : [anchor.progress, 0]
}

/**
 * La place d'une ancre dans l'ordre du document, ou null si on ne sait pas.
 *
 * Trois echelles, une par nature de document, jamais melangees au sein d'un
 * meme cours : la page d'un PDF se compare directement ; la section d'un
 * document a titres n'a pas d'ordre en elle-meme — c'est son rang dans le
 * decoupage fin, seul endroit ou le titre et l'ordinal cohabitent, qui le
 * donne ; la fraction parcourue d'un support sans titres est deja un nombre.
 * Dans chaque unite, le rang du passage departage ensuite deux notes de la
 * meme page.
 *
 * Rendre null n'est pas une erreur : une section disparue d'un cours
 * re-extrait, un index pas encore charge. L'appelant traite ces ancres-la en
 * abstentionnistes — elles ne votent pas sur la place d'une note, elles ne la
 * bloquent pas non plus.
 */
export function anchorOrderKey(courseId: string, anchor: NoteAnchor): OrderKey | null {
  return anchorOrderKeyIn(fineIndexedCourse(courseId), anchor)
}

/**
 * Les unites du cours d'ou viennent les passages ainsi references.
 *
 * L'assistant ne voit jamais un `unitKey`. Ce que ses outils lui rendent, et
 * donc tout ce qu'il peut avoir cite avant d'ecrire une note, c'est l'ancre
 * lisible d'un passage : « p. 12 », « 2. Les covenants › Le seuil ». La
 * traduction de l'une vers l'autre doit bien se faire quelque part, et elle ne
 * peut se faire ni chez l'assistant, qui n'a jamais vu d'unite, ni de tete.
 *
 * Pour un document pagine elle serait triviale — « p. 12 » donne « page:12 ».
 * Pour un document a titres elle ne l'est pas du tout : l'ancre porte le chemin
 * des titres, et rien dans le decoupage large ne porte l'ordinal que `unitKey`
 * exige. Le recompter serait un piege, pour deux raisons dont chacune suffit.
 * D'abord l'assistant ne voit jamais le document dans l'ordre : huit resultats
 * de recherche pris aux quatre coins d'un cours ne se numerotent pas. Ensuite,
 * meme a parcourir tout le decoupage large, le compte serait faux : le rang
 * zero revient au preambule qu'il existe ou non, si bien qu'un cours commencant
 * par son titre — c'est-a-dire presque tous — decale d'un cran chacune de ses
 * sections. Et un decalage d'un cran ancre chaque note a la section voisine, ce
 * qui se lit comme une faute de l'ancrage et non comme une faute de comptage.
 *
 * D'ou ce detour par l'index fin, seul endroit ou les deux formes coexistent
 * sur le meme objet. Le pont ne tient que parce que l'ancre est ecrite par la
 * meme expression dans les deux decoupages : « p. » suivi du numero d'un cote,
 * le chemin des titres joint par « › » de l'autre, avec le meme repli
 * « Introduction » quand il n'y a pas encore de titre. Les deux fichiers
 * doivent rester d'accord la-dessus ; le jour ou l'un des deux ecrira ses
 * ancres autrement, c'est ici que le lien se rompra, sans bruit.
 *
 * Un tableau vide n'est pas un echec : `resolveAutoAnchor` le lit comme
 * « cherche partout », ce qui est exactement ce qu'il faut faire quand on ne
 * sait pas d'ou la note vient.
 */
export function unitKeysForAnchors(courseId: string, anchors: string[]): string[] {
  if (anchors.length === 0) return []

  const course = fineIndexedCourse(courseId)
  if (!course) return []

  const wanted = new Set(anchors)
  const keys = new Set<string>()

  for (const chunk of course.index.passages) {
    if (wanted.has(chunk.anchor)) keys.add(chunk.unitKey)
  }

  return [...keys]
}
