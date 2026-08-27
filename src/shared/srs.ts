/**
 * Repetition espacee — variante de SM-2 a la maniere d'Anki.
 *
 * Deux phases par carte : apprentissage (interval === 0, pas encore diplomee)
 * ou revision (interval >= 1). Chaque grade y a un effet different — voir
 * `applyLearningGrade` et `applyReviewGrade` ci-dessous. Module pur : aucune
 * dependance hors `./flashcards`, aucun etat de module, charge tel quel par
 * le main (CommonJS) et le renderer (Vite).
 */

import { ACQUIRED_INTERVAL } from './flashcards'
import type {
  CardSrs,
  Flashcard,
  FlashcardsStats,
  ReviewGrade,
  ReviewScope,
  SetSummary
} from './flashcards'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/** Bornes de l'ease SM-2 : jamais une carte trop rigide, ni trop volatile. */
const MIN_EASE = 1.3
const MAX_EASE = 3.5

/** Au-dela, l'intervalle cesse de croitre : une carte revient au moins une fois par an. */
const MAX_INTERVAL = 365

function clampEase(ease: number): number {
  return Math.min(MAX_EASE, Math.max(MIN_EASE, ease))
}

function clampInterval(interval: number): number {
  return Math.min(MAX_INTERVAL, interval)
}

function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString()
}

/** Etat d'une carte neuve : due immediatement, rien d'appris. */
export function freshSrs(now: Date): CardSrs {
  return { due: now.toISOString(), interval: 0, ease: 2.5, reps: 0, lapses: 0 }
}

/**
 * Une carte en apprentissage (interval 0) n'est pas encore diplomee : « bien »
 * ou « facile » la fait passer en revision ; « encore » et « difficile » la
 * laissent en place, pour la repasser dans la session ou sous peu.
 */
function applyLearningGrade(srs: CardSrs, grade: ReviewGrade, now: Date): CardSrs {
  if (grade === 'encore') {
    return { ...srs, due: now.toISOString() }
  }
  if (grade === 'difficile') {
    return {
      ...srs,
      due: new Date(now.getTime() + 10 * MINUTE_MS).toISOString(),
      reps: srs.reps + 1
    }
  }
  if (grade === 'bien') {
    return { ...srs, interval: 1, due: addDays(now, 1), reps: srs.reps + 1 }
  }
  // facile : diplome directement a 3 jours, avec un bonus d'ease.
  return {
    ...srs,
    interval: 3,
    due: addDays(now, 3),
    reps: srs.reps + 1,
    ease: clampEase(srs.ease + 0.15)
  }
}

/**
 * Une carte en revision (interval >= 1) a deja ete diplomee. « encore » la
 * fait retomber en apprentissage (un lapse) ; les trois autres grades
 * allongent l'intervalle, plus ou moins selon l'ease de la carte.
 */
function applyReviewGrade(srs: CardSrs, grade: ReviewGrade, now: Date): CardSrs {
  if (grade === 'encore') {
    return {
      ...srs,
      interval: 0,
      lapses: srs.lapses + 1,
      ease: clampEase(srs.ease - 0.2),
      due: now.toISOString()
    }
  }
  if (grade === 'difficile') {
    const interval = clampInterval(Math.max(srs.interval + 1, Math.round(srs.interval * 1.2)))
    return {
      ...srs,
      interval,
      ease: clampEase(srs.ease - 0.15),
      reps: srs.reps + 1,
      due: addDays(now, interval)
    }
  }
  if (grade === 'bien') {
    const interval = clampInterval(
      Math.max(srs.interval + 1, Math.round(srs.interval * srs.ease))
    )
    return { ...srs, interval, reps: srs.reps + 1, due: addDays(now, interval) }
  }
  // facile : le plus grand bond, avec un bonus d'ease.
  const interval = clampInterval(
    Math.max(srs.interval + 1, Math.round(srs.interval * srs.ease * 1.3))
  )
  return {
    ...srs,
    interval,
    ease: clampEase(srs.ease + 0.15),
    reps: srs.reps + 1,
    due: addDays(now, interval)
  }
}

/** Applique une reponse et rend le nouvel etat. Pur : ne modifie rien. */
export function applyGrade(srs: CardSrs, grade: ReviewGrade, now: Date): CardSrs {
  return srs.interval === 0
    ? applyLearningGrade(srs, grade, now)
    : applyReviewGrade(srs, grade, now)
}

/** La carte est-elle a l'echeance ? */
export function isDue(srs: CardSrs, now: Date): boolean {
  return new Date(srs.due).getTime() <= now.getTime()
}

/** La carte est-elle consideree acquise ? */
export function isAcquired(srs: CardSrs): boolean {
  return srs.interval >= ACQUIRED_INTERVAL
}

/** Une carte jamais revue : aucune entree d'historique. */
function isNewCard(card: Flashcard): boolean {
  return card.history.length === 0
}

/**
 * Une carte difficile : deja vue, et la peine se voit — un oubli enregistre,
 * une ease erodee sous son niveau de depart, ou l'une des deux dernieres
 * reponses en « encore » ou « difficile ».
 */
export function isDifficultCard(card: Flashcard): boolean {
  if (card.history.length === 0) return false
  if (card.srs.lapses > 0 || card.srs.ease < 2.5) return true
  return card.history
    .slice(-2)
    .some((review) => review.grade === 'encore' || review.grade === 'difficile')
}

function byDueAscending(a: Flashcard, b: Flashcard): number {
  return new Date(a.srs.due).getTime() - new Date(b.srs.due).getTime()
}

/** Melange Fisher-Yates ; rend un nouveau tableau, sans toucher a celui recu. */
function shuffled<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/**
 * Construit la file d'une session : les cartes dues d'abord (les plus en
 * retard en tete), puis un nombre plafonne de nouvelles. `ahead` ajoute en
 * fin de file les cartes pas encore dues ; `shuffle` melange le tout ensuite.
 * Les perimetres `all` et `difficult` court-circuitent tout cela : un passage
 * en revue, sans echeances ni quota de nouvelles.
 */
export function buildQueue(
  cards: Flashcard[],
  now: Date,
  options?: { newLimit?: number; shuffle?: boolean; ahead?: boolean; scope?: ReviewScope }
): Flashcard[] {
  const newLimit = options?.newLimit ?? 20
  const shuffle = options?.shuffle ?? false
  const ahead = options?.ahead ?? false
  const scope = options?.scope ?? 'due'

  if (scope !== 'due') {
    const pool = scope === 'all' ? [...cards] : cards.filter(isDifficultCard)
    return shuffle ? shuffled(pool) : pool
  }

  const due = cards
    .filter((card) => !isNewCard(card) && isDue(card.srs, now))
    .sort(byDueAscending)

  const fresh = cards
    .filter(isNewCard)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, newLimit)

  let queue = [...due, ...fresh]

  if (ahead) {
    const later = cards
      .filter((card) => !isNewCard(card) && !isDue(card.srs, now))
      .sort(byDueAscending)
    queue = [...queue, ...later]
  }

  return shuffle ? shuffled(queue) : queue
}

/** La plus recente date d'historique, toutes cartes confondues — null si aucune. */
function latestReviewDate(cards: Flashcard[]): string | null {
  let latest: string | null = null
  for (const card of cards) {
    for (const review of card.history) {
      if (latest === null || new Date(review.date).getTime() > new Date(latest).getTime()) {
        latest = review.date
      }
    }
  }
  return latest
}

/** La plus proche echeance parmi les cartes pas encore dues — null si aucune. */
function nextDueDate(cards: Flashcard[], now: Date): string | null {
  let next: string | null = null
  for (const card of cards) {
    if (isDue(card.srs, now)) continue
    if (next === null || new Date(card.srs.due).getTime() < new Date(next).getTime()) {
      next = card.srs.due
    }
  }
  return next
}

/** Les comptes d'un set pour le tableau de bord. */
export function summariseSet(
  cards: Flashcard[],
  now: Date
): Pick<SetSummary, 'total' | 'due' | 'fresh' | 'acquired' | 'lastReview' | 'nextDue'> {
  return {
    total: cards.length,
    due: cards.filter((card) => isDue(card.srs, now)).length,
    fresh: cards.filter(isNewCard).length,
    acquired: cards.filter((card) => isAcquired(card.srs)).length,
    lastReview: latestReviewDate(cards),
    nextDue: nextDueDate(cards, now)
  }
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** Reponses donnees le jour calendaire local de `now`, tous cours confondus. */
function countReviewedToday(cards: Flashcard[], now: Date): number {
  let count = 0
  for (const card of cards) {
    for (const review of card.history) {
      if (isSameLocalDay(new Date(review.date), now)) {
        count++
      }
    }
  }
  return count
}

/** Part des reponses reussies (tout sauf « encore ») sur les 7 derniers jours. */
function computeSuccessRate(cards: Flashcard[], now: Date): number | null {
  const since = now.getTime() - WEEK_MS
  let total = 0
  let success = 0
  for (const card of cards) {
    for (const review of card.history) {
      if (new Date(review.date).getTime() >= since) {
        total++
        if (review.grade !== 'encore') success++
      }
    }
  }
  return total === 0 ? null : success / total
}

/** La cle d'un jour calendaire local — pour compter les revisions par jour. */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Le jour local situe `back` jours avant `now` — en dates civiles, pas en millisecondes. */
function dayBefore(now: Date, back: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
}

/** Reponses par jour calendaire local, toutes cartes confondues. */
function reviewsPerDay(cards: Flashcard[]): Map<string, number> {
  const perDay = new Map<string, number>()
  for (const card of cards) {
    for (const review of card.history) {
      const key = localDayKey(new Date(review.date))
      perDay.set(key, (perDay.get(key) ?? 0) + 1)
    }
  }
  return perDay
}

/**
 * Jours consecutifs avec au moins une revision. Aujourd'hui compte s'il a
 * deja la sienne ; sinon la serie court depuis hier — elle n'est pas rompue
 * tant que la journee n'est pas finie.
 */
function computeStreak(perDay: Map<string, number>, now: Date): number {
  let back = perDay.has(localDayKey(now)) ? 0 : 1
  let streak = 0
  while (perDay.has(localDayKey(dayBefore(now, back)))) {
    streak += 1
    back += 1
  }
  return streak
}

/** Part des reponses reussies dans [depuis, jusqua), 0..1 — null si aucune. */
function successRateBetween(
  cards: Flashcard[],
  since: number,
  until: number
): number | null {
  let total = 0
  let success = 0
  for (const card of cards) {
    for (const review of card.history) {
      const at = new Date(review.date).getTime()
      if (at >= since && at < until) {
        total++
        if (review.grade !== 'encore') success++
      }
    }
  }
  return total === 0 ? null : success / total
}

/** Les chiffres globaux du tableau de bord. */
export function computeStats(cards: Flashcard[], now: Date): FlashcardsStats {
  const summary = summariseSet(cards, now)
  const perDay = reviewsPerDay(cards)

  const activity: number[] = []
  for (let back = 29; back >= 0; back--) {
    activity.push(perDay.get(localDayKey(dayBefore(now, back))) ?? 0)
  }
  let activityBefore = 0
  for (let back = 59; back >= 30; back--) {
    activityBefore += perDay.get(localDayKey(dayBefore(now, back))) ?? 0
  }

  const weekAgo = now.getTime() - WEEK_MS

  return {
    total: summary.total,
    dueNow: summary.due,
    fresh: summary.fresh,
    acquired: summary.acquired,
    reviewedToday: countReviewedToday(cards, now),
    successRate: computeSuccessRate(cards, now),
    nextDue: summary.nextDue,
    createdThisWeek: cards.filter((card) => new Date(card.createdAt).getTime() >= weekAgo)
      .length,
    successRateBefore: successRateBetween(cards, now.getTime() - 2 * WEEK_MS, weekAgo),
    streak: computeStreak(perDay, now),
    activity,
    activityBefore
  }
}
