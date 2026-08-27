/**
 * Les flashcards : contrat partage entre le main process et le renderer.
 *
 * Une carte nait d'un surlignage (jaune, vert ou bleu), fabriquee en tache de
 * fond par un agent dedie — jamais par l'assistant de conversation. Un cours a
 * au plus un set, enregistre en JSON sous Flashcards/, meme arborescence que
 * Notes/ et Annotations/ : c'est du travail, pas du cache.
 */

import type { HighlightColorId } from './types'

// ---------------------------------------------------------------------------
// La carte et son etat de repetition espacee
// ---------------------------------------------------------------------------

/** Les quatre reponses possibles en revision, du rate au trop-facile. */
export type ReviewGrade = 'encore' | 'difficile' | 'bien' | 'facile'

/** Boutons de revision, dans l'ordre d'affichage. Raccourcis 1 a 4. */
export const REVIEW_GRADES: readonly {
  id: ReviewGrade
  label: string
  shortcut: string
}[] = [
  { id: 'encore', label: 'Encore', shortcut: '1' },
  { id: 'difficile', label: 'Difficile', shortcut: '2' },
  { id: 'bien', label: 'Bien', shortcut: '3' },
  { id: 'facile', label: 'Facile', shortcut: '4' }
] as const

/**
 * Etat de repetition espacee d'une carte — variante de SM-2, calculee dans
 * `srs.ts`. `interval` est en jours ; 0 tant que la carte est en apprentissage.
 */
export interface CardSrs {
  /** Prochaine echeance, ISO 8601. Une carte neuve est due immediatement. */
  due: string
  /** Intervalle courant en jours. 0 : encore en apprentissage. */
  interval: number
  /** Facilite SM-2. Demarre a 2.5, jamais sous 1.3. */
  ease: number
  /** Nombre de reponses reussies (tout sauf « encore »). */
  reps: number
  /** Nombre d'oublis (« encore » sur une carte deja apprise). */
  lapses: number
}

/** Une reponse donnee en revision, gardee pour les statistiques. */
export interface CardReview {
  /** ISO 8601. */
  date: string
  grade: ReviewGrade
}

/** Le surlignage dont la carte est issue — de quoi y revenir. */
export interface CardSource {
  annotationId: string
  colour: HighlightColorId
  page: number | null
  heading: string | null
}

export interface Flashcard {
  /** Identifiant stable, engendre a la creation. */
  id: string
  /** Question, en Markdown. Formules en $…$ ou $$…$$. */
  recto: string
  /** Reponse, en Markdown. */
  verso: string
  source: CardSource
  /** ISO 8601. */
  createdAt: string
  srs: CardSrs
  history: CardReview[]
}

/** Le fichier d'un set : un par cours, sous Flashcards/<Matiere>/<cours>.json. */
export interface FlashcardSet {
  version: 1
  /**
   * Identifiants des surlignages deja soumis a l'agent de generation, meme
   * ceux dont il n'a tire aucune carte : sans cette liste, chaque passage
   * ecarte serait represente a chaque declenchement.
   */
  processed: string[]
  cards: Flashcard[]
}

/** Les couleurs de surlignage qui engendrent des cartes : jaune, vert, bleu. */
export const CARD_COLOURS: readonly HighlightColorId[] = [
  'retenir',
  'definition',
  'formule'
] as const

// ---------------------------------------------------------------------------
// Le set general d'une matiere
// ---------------------------------------------------------------------------

/**
 * Nom de fichier reserve du set general d'une matiere : des cartes rattachees
 * a la matiere elle-meme, pas a un cours — ecrites a la main via la feuille
 * de collage. Le fichier vit dans le dossier de la matiere
 * (Flashcards/<Matiere>/_matiere.json) : il suit gratuitement les renommages,
 * fusions et suppressions de matiere. Le prefixe « _ » ecarte toute collision
 * avec un nom de cours, et le resolveur de chemins le traite comme n'importe
 * quel identifiant sans extension.
 */
export const GENERAL_SET_BASENAME = '_matiere'

/** Titre affiche pour le set general, la ou un set de cours porte le titre du cours. */
export const GENERAL_SET_TITLE = 'Cartes de la matière'

/** L'identifiant du set general d'une matiere — la ou un cours a son courseId. */
export function generalSetId(subject: string): string {
  return `${subject}/${GENERAL_SET_BASENAME}`
}

export function isGeneralSetId(id: string): boolean {
  return id.endsWith(`/${GENERAL_SET_BASENAME}`)
}

/** Au-dela de cet intervalle en jours, une carte est consideree acquise. */
export const ACQUIRED_INTERVAL = 21

// ---------------------------------------------------------------------------
// Resumes pour l'interface
// ---------------------------------------------------------------------------

/** Un set vu du tableau de bord : le cours, ses comptes, sa prochaine echeance. */
export interface SetSummary {
  courseId: string
  courseTitle: string
  subject: string
  total: number
  /** Cartes a revoir maintenant, nouvelles comprises. */
  due: number
  /** Cartes jamais revues. */
  fresh: number
  /** Cartes dont l'intervalle a depasse ACQUIRED_INTERVAL. */
  acquired: number
  /** Date de la derniere reponse donnee sur ce set, ISO. */
  lastReview: string | null
  /** Prochaine echeance du set, ISO — null si tout est du ou vide. */
  nextDue: string | null
}

/** Les chiffres du tableau de bord, tous cours confondus. */
export interface FlashcardsStats {
  total: number
  dueNow: number
  fresh: number
  acquired: number
  reviewedToday: number
  /** Part des reponses reussies sur 7 jours glissants, 0..1. Null : aucune. */
  successRate: number | null
  /** Prochaine echeance globale, ISO — null si tout est du ou vide. */
  nextDue: string | null
  /** Cartes creees ces 7 derniers jours. */
  createdThisWeek: number
  /** Reussite de la semaine d'avant (j-14 a j-7), 0..1 — pour la tendance. Null : aucune reponse. */
  successRateBefore: number | null
  /** Jours consecutifs avec au moins une revision — aujourd'hui s'il a la sienne, sinon depuis hier. */
  streak: number
  /** Reponses par jour calendaire local, 30 entrees, la derniere pour aujourd'hui. */
  activity: number[]
  /** Total de reponses des 30 jours qui precedent la fenetre d'`activity` — pour la tendance. */
  activityBefore: number
}

export interface FlashcardsOverview {
  stats: FlashcardsStats
  /** Seules les matieres ayant au moins une carte apparaissent. */
  subjects: {
    subject: string
    /** Le set general de la matiere — null tant qu'il n'a aucune carte. */
    general: SetSummary | null
    sets: SetSummary[]
  }[]
  /** Une generation de cartes tourne en ce moment. */
  generating: boolean
  /** Nombre de cours ayant des surlignages eligibles pas encore transformes. */
  pending: number
}

/** Une carte dans une file de revision, avec le cours dont elle vient. */
export interface ReviewQueueItem {
  courseId: string
  courseTitle: string
  card: Flashcard
}

/**
 * Perimetre d'une session : `due` suit l'algorithme (les dues, puis un quota
 * de nouvelles) ; `all` prend absolument toutes les cartes, acquises
 * comprises ; `difficult` ne garde que celles qui resistent. Dans tous les
 * cas, les reponses comptent normalement dans la repetition espacee.
 */
export type ReviewScope = 'due' | 'all' | 'difficult'

/** Options d'une file de revision. */
export interface ReviewQueueOptions {
  /** Melange la file — pour reviser toute une matiere. */
  shuffle?: boolean
  /**
   * Prend aussi les cartes pas encore dues : « reviser quand meme » quand
   * rien n'est a l'echeance. Les reponses comptent normalement.
   */
  ahead?: boolean
  /** Perimetre de la file — `due` si absent. `all` et `difficult` ignorent echeances et quota. */
  scope?: ReviewScope
}
