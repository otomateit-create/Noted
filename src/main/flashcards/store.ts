/**
 * Les sets de flashcards : un fichier JSON par cours sous Flashcards/, meme
 * arborescence que Notes/ et Annotations/.
 *
 * Comme les surlignages, ce sont des donnees de travail, pas du cache : elles
 * vivent dans le vault, se lisent a l'oeil nu, suivent le cours renomme ou
 * deplace et partent a la corbeille avec lui.
 *
 * Deux ecrivains se partagent ces fichiers : la generation en tache de fond
 * (qui ajoute des cartes) et la revision (qui met a jour l'etat d'une carte a
 * chaque reponse). Un verrou par cours serialise leurs ecritures — sans lui,
 * une reponse donnee pendant une generation pourrait etre ecrasee.
 */

import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { HIGHLIGHT_COLORS } from '../../shared/types'
import type { HighlightColorId } from '../../shared/types'
import {
  CARD_COLOURS,
  GENERAL_SET_TITLE,
  generalSetId,
  isGeneralSetId
} from '../../shared/flashcards'
import type {
  CardReview,
  CardSrs,
  Flashcard,
  FlashcardSet,
  FlashcardsOverview,
  ReviewGrade,
  ReviewQueueItem,
  ReviewQueueOptions,
  SetSummary
} from '../../shared/flashcards'
import { applyGrade, buildQueue, computeStats, freshSrs, summariseSet } from '../../shared/srs'
import { readAnnotations } from '../annotations'
import { exists, listSubjects, resolveFlashcardsPath } from '../vault'

const COLOURS = new Set<string>(HIGHLIGHT_COLORS.map((colour) => colour.id))
const GRADES = new Set<string>(['encore', 'difficile', 'bien', 'facile'])

const EMPTY_SET: FlashcardSet = { version: 1, processed: [], cards: [] }

// ---------------------------------------------------------------------------
// L'avis au renderer : la page Flashcards se rafraichit quand les sets bougent
// ---------------------------------------------------------------------------

let notify: (() => void) | null = null

/** Branche l'avis au renderer — une seule fenetre, un seul abonne. */
export function bindFlashcardsNotifier(handler: () => void): void {
  notify = handler
}

/** A appeler apres tout changement visible : cartes ajoutees, etat qui bouge. */
export function notifyFlashcardsChanged(): void {
  notify?.()
}

// ---------------------------------------------------------------------------
// Lecture et ecriture
// ---------------------------------------------------------------------------

/**
 * Retient une carte si elle porte de quoi etre revisee : un identifiant, un
 * recto, un verso. Un etat de repetition abime est remis a neuf plutot que de
 * faire tomber la carte — perdre la planification est benin, perdre la carte
 * ne l'est pas.
 */
function validateCard(raw: unknown): Flashcard | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>

  const { id, recto, verso } = entry
  if (typeof id !== 'string' || !id) return null
  if (typeof recto !== 'string' || !recto) return null
  if (typeof verso !== 'string' || !verso) return null

  const string = (value: unknown): string => (typeof value === 'string' ? value : '')

  const rawSource = (entry.source ?? {}) as Record<string, unknown>
  const colour =
    typeof rawSource.colour === 'string' && COLOURS.has(rawSource.colour)
      ? (rawSource.colour as HighlightColorId)
      : 'retenir'

  const rawSrs = (entry.srs ?? {}) as Record<string, unknown>
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const fallbackSrs = freshSrs(new Date())
  const srs: CardSrs = {
    due: string(rawSrs.due) || fallbackSrs.due,
    interval: number(rawSrs.interval, 0),
    ease: number(rawSrs.ease, 2.5),
    reps: number(rawSrs.reps, 0),
    lapses: number(rawSrs.lapses, 0)
  }

  const history: CardReview[] = Array.isArray(entry.history)
    ? entry.history.flatMap((item): CardReview[] => {
        if (!item || typeof item !== 'object') return []
        const review = item as Record<string, unknown>
        if (typeof review.date !== 'string' || !review.date) return []
        if (typeof review.grade !== 'string' || !GRADES.has(review.grade)) return []
        return [{ date: review.date, grade: review.grade as ReviewGrade }]
      })
    : []

  return {
    id,
    recto,
    verso,
    source: {
      annotationId: string(rawSource.annotationId),
      colour,
      page: typeof rawSource.page === 'number' ? rawSource.page : null,
      heading: typeof rawSource.heading === 'string' ? rawSource.heading : null
    },
    createdAt: string(entry.createdAt) || new Date().toISOString(),
    srs,
    history
  }
}

/**
 * Relit le set d'un cours. Un fichier absent, tronque ou edite de travers rend
 * un set vide plutot qu'une erreur — meme raison que pour les surlignages.
 */
export async function readSet(courseId: string): Promise<FlashcardSet> {
  const target = resolveFlashcardsPath(courseId)

  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(target, 'utf8'))
  } catch {
    return { ...EMPTY_SET, processed: [], cards: [] }
  }

  if (!parsed || typeof parsed !== 'object') return { ...EMPTY_SET, processed: [], cards: [] }
  const raw = parsed as Record<string, unknown>

  const processed = Array.isArray(raw.processed)
    ? raw.processed.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  const cards = Array.isArray(raw.cards)
    ? raw.cards.map(validateCard).filter((card): card is Flashcard => card !== null)
    : []

  return { version: 1, processed, cards }
}

/**
 * Ecrit le set entier, par fichier temporaire puis rename atomique. Un set
 * sans carte ni surlignage traite efface le fichier : un squelette vide dans
 * le Finder laisserait croire qu'il reste du travail.
 */
async function writeSet(courseId: string, set: FlashcardSet): Promise<void> {
  const target = resolveFlashcardsPath(courseId)

  if (set.cards.length === 0 && set.processed.length === 0) {
    await fs.rm(target, { force: true })
    return
  }

  const serialised = `${JSON.stringify(set, null, 2)}\n`

  try {
    if ((await fs.readFile(target, 'utf8')) === serialised) return
  } catch {
    // Premier set de ce cours : rien a comparer.
  }

  await fs.mkdir(path.dirname(target), { recursive: true })

  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, serialised, 'utf8')
  await fs.rename(temporary, target)
}

// ---------------------------------------------------------------------------
// Verrou par cours : generation et revision ecrivent le meme fichier
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>()

/** Enchaine les modifications d'un meme set : relire, transformer, ecrire. */
async function withSet<T>(
  courseId: string,
  transform: (set: FlashcardSet) => Promise<T> | T
): Promise<T> {
  const previous = locks.get(courseId) ?? Promise.resolve()
  const task = previous.then(async () => {
    const set = await readSet(courseId)
    const result = await transform(set)
    await writeSet(courseId, set)
    return result
  })
  // La chaine ne doit pas se rompre sur une erreur : on garde la promesse
  // apaisee pour le suivant, l'erreur part chez l'appelant.
  locks.set(
    courseId,
    task.catch(() => undefined)
  )
  return task
}

// ---------------------------------------------------------------------------
// Ce que la generation depose
// ---------------------------------------------------------------------------

/** Une carte telle que l'agent de generation la produit : recto, verso, source. */
export interface DraftCard {
  recto: string
  verso: string
  annotationId: string
}

/**
 * Ajoute les cartes d'une fournee de generation et marque traites tous les
 * surlignages soumis — meme ceux dont l'agent n'a rien tire, sans quoi ils
 * seraient representes a chaque declenchement.
 */
export async function appendCards(
  courseId: string,
  drafts: DraftCard[],
  submitted: { id: string; colour: HighlightColorId; page: number | null; heading: string | null }[]
): Promise<number> {
  return withSet(courseId, (set) => {
    const byId = new Map(submitted.map((annotation) => [annotation.id, annotation]))
    const now = new Date()

    let added = 0
    for (const draft of drafts) {
      const origin = byId.get(draft.annotationId)
      if (!origin) continue
      set.cards.push({
        id: randomUUID(),
        recto: draft.recto,
        verso: draft.verso,
        source: {
          annotationId: origin.id,
          colour: origin.colour,
          page: origin.page,
          heading: origin.heading
        },
        createdAt: now.toISOString(),
        srs: freshSrs(now),
        history: []
      })
      added += 1
    }

    const processed = new Set(set.processed)
    for (const annotation of submitted) processed.add(annotation.id)
    set.processed = [...processed]

    return added
  }).then((added) => {
    if (added > 0) notifyFlashcardsChanged()
    return added
  })
}

/** Une carte creee a la demande, par l'assistant : pas de surlignage derriere. */
export interface ManualCard {
  recto: string
  verso: string
  colour: HighlightColorId
  page: number | null
  heading: string | null
}

/**
 * Ajoute des cartes demandees en conversation. Meme set, meme repetition
 * espacee que les cartes nees d'un surlignage — seule l'origine differe :
 * `annotationId` reste vide, la couleur dit la nature de la carte.
 */
export async function appendManualCards(
  courseId: string,
  cards: ManualCard[]
): Promise<{ added: number; total: number }> {
  const result = await withSet(courseId, (set) => {
    const now = new Date()
    for (const card of cards) {
      set.cards.push({
        id: randomUUID(),
        recto: card.recto,
        verso: card.verso,
        source: {
          annotationId: '',
          colour: card.colour,
          page: card.page,
          heading: card.heading
        },
        createdAt: now.toISOString(),
        srs: freshSrs(now),
        history: []
      })
    }
    return { added: cards.length, total: set.cards.length }
  })
  if (result.added > 0) notifyFlashcardsChanged()
  return result
}

/**
 * Les surlignages d'un cours qui attendent encore leurs cartes : couleur
 * eligible, et jamais soumis a la generation.
 */
export async function pendingAnnotations(
  courseId: string
): Promise<{ id: string; colour: HighlightColorId; page: number | null; heading: string | null; text: string; before: string; after: string }[]> {
  const [annotations, set] = await Promise.all([readAnnotations(courseId), readSet(courseId)])
  const processed = new Set(set.processed)
  const eligible = new Set<string>(CARD_COLOURS)

  return annotations
    .filter((annotation) => eligible.has(annotation.colour) && !processed.has(annotation.id))
    .map((annotation) => ({
      id: annotation.id,
      colour: annotation.colour,
      page: annotation.page,
      heading: annotation.heading,
      text: annotation.text,
      before: annotation.before,
      after: annotation.after
    }))
}

// ---------------------------------------------------------------------------
// Ce que l'interface demande
// ---------------------------------------------------------------------------

/** Date de la derniere reponse donnee sur un lot de cartes, ISO ou null. */
function lastReviewOf(cards: Flashcard[]): string | null {
  let last: string | null = null
  for (const card of cards) {
    for (const review of card.history) {
      if (!last || review.date > last) last = review.date
    }
  }
  return last
}

/**
 * Le tableau de bord : seules les matieres ayant au moins une carte
 * apparaissent — dans un set de cours ou dans le set general de la matiere.
 */
export async function overview(
  generation: { generating: boolean; pending: number }
): Promise<FlashcardsOverview> {
  const now = new Date()
  const subjects = await listSubjects()

  const grouped: { subject: string; general: SetSummary | null; sets: SetSummary[] }[] = []
  const everything: Flashcard[] = []

  for (const subject of subjects) {
    const sets: SetSummary[] = []
    for (const course of subject.courses) {
      const set = await readSet(course.id)
      if (set.cards.length === 0) continue
      everything.push(...set.cards)
      sets.push({
        courseId: course.id,
        courseTitle: course.title,
        subject: subject.name,
        ...summariseSet(set.cards, now),
        lastReview: lastReviewOf(set.cards)
      })
    }

    // Le set general : des cartes collees a la main, rattachees a la matiere
    // elle-meme. Il compte dans les stats et suffit a faire vivre la matiere
    // au tableau de bord, meme sans set de cours.
    const generalId = generalSetId(subject.name)
    const generalSet = await readSet(generalId)
    everything.push(...generalSet.cards)
    const general: SetSummary | null =
      generalSet.cards.length === 0
        ? null
        : {
            courseId: generalId,
            courseTitle: GENERAL_SET_TITLE,
            subject: subject.name,
            ...summariseSet(generalSet.cards, now),
            lastReview: lastReviewOf(generalSet.cards)
          }

    if (sets.length > 0 || general) grouped.push({ subject: subject.name, general, sets })
  }

  return {
    stats: computeStats(everything, now),
    subjects: grouped,
    generating: generation.generating,
    pending: generation.pending
  }
}

/**
 * La file d'une session : un cours (un set) ou plusieurs (toute une matiere).
 * La repetition espacee ordonne, le melange est demande par l'appelant.
 */
export async function reviewQueue(
  courseIds: string[],
  options: ReviewQueueOptions
): Promise<ReviewQueueItem[]> {
  const now = new Date()
  const origin = new Map<string, { courseId: string; courseTitle: string }>()
  const cards: Flashcard[] = []

  const subjects = await listSubjects()
  const titles = new Map<string, string>()
  for (const subject of subjects) {
    for (const course of subject.courses) titles.set(course.id, course.title)
  }

  for (const courseId of courseIds) {
    const set = await readSet(courseId)
    const courseTitle = isGeneralSetId(courseId)
      ? GENERAL_SET_TITLE
      : (titles.get(courseId) ?? courseId)
    for (const card of set.cards) {
      origin.set(card.id, { courseId, courseTitle })
      cards.push(card)
    }
  }

  return buildQueue(cards, now, {
    shuffle: options.shuffle,
    ahead: options.ahead,
    scope: options.scope
  }).map((card) => ({ ...origin.get(card.id)!, card }))
}

/** Les cartes d'un set, telles qu'ecrites — l'ecran du deck les montre toutes. */
export async function listCards(courseId: string): Promise<Flashcard[]> {
  return (await readSet(courseId)).cards
}

/**
 * Supprime une carte. Definitif : contrairement a un set entier, une carte
 * seule n'a pas de fichier a envoyer a la corbeille. Rend faux si elle avait
 * deja disparu.
 */
export async function removeCard(courseId: string, cardId: string): Promise<boolean> {
  const removed = await withSet(courseId, (set) => {
    const index = set.cards.findIndex((card) => card.id === cardId)
    if (index === -1) return false
    set.cards.splice(index, 1)
    return true
  })
  if (removed) notifyFlashcardsChanged()
  return removed
}

/**
 * Reecrit le recto et le verso d'une carte. L'etat de repetition et
 * l'historique restent : corriger une formulation ne fait pas oublier qu'on
 * la connait. Rend la carte mise a jour, ou null si elle a disparu.
 */
export async function updateCard(
  courseId: string,
  cardId: string,
  faces: { recto: string; verso: string }
): Promise<Flashcard | null> {
  const recto = faces.recto.trim()
  const verso = faces.verso.trim()
  if (!recto || !verso) return null

  const updated = await withSet(courseId, (set) => {
    const card = set.cards.find((entry) => entry.id === cardId)
    if (!card) return null
    card.recto = recto
    card.verso = verso
    return { ...card }
  })
  if (updated) notifyFlashcardsChanged()
  return updated
}

/**
 * Enregistre une reponse : nouvel etat de repetition, ligne d'historique.
 * Rend la carte mise a jour, ou null si elle a disparu entre-temps.
 */
export async function answer(
  courseId: string,
  cardId: string,
  grade: ReviewGrade
): Promise<Flashcard | null> {
  return withSet(courseId, (set) => {
    const card = set.cards.find((entry) => entry.id === cardId)
    if (!card) return null

    const now = new Date()
    card.srs = applyGrade(card.srs, grade, now)
    card.history.push({ date: now.toISOString(), grade })
    return card
  })
}

// ---------------------------------------------------------------------------
// Le set suit son cours
// ---------------------------------------------------------------------------

/** Suit un cours renomme ou deplace. Sans fichier, rien a suivre. */
export async function moveFlashcards(previousId: string, nextId: string): Promise<void> {
  const from = resolveFlashcardsPath(previousId)
  if (!(await exists(from))) return

  const to = resolveFlashcardsPath(nextId)
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to)
}

/** Envoie le set a la corbeille : c'est du travail, cela se recupere. */
export async function deleteFlashcards(courseId: string): Promise<void> {
  const target = resolveFlashcardsPath(courseId)
  if (await exists(target)) await shell.trashItem(target)
}
