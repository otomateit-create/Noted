import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Bot, Check, X } from 'lucide-react'
import { marked } from 'marked'
import { REVIEW_GRADES } from '@shared/flashcards'
import type { ReviewGrade, ReviewQueueItem, ReviewScope } from '@shared/flashcards'
import { applyGrade } from '@shared/srs'
import type { HighlightColorId } from '@shared/types'
import { protectMath, restoreMath } from '../lib/math'
import { subjectTint } from '../lib/subject-tint'
import FlashcardsTutor from './FlashcardsTutor'
import '../styles/flashcards.css'

/**
 * L'ecran de revision : la file d'un set ou d'une matiere entiere, une carte
 * a la fois. Recto seul d'abord — espace ou clic retourne — puis les quatre
 * reponses, avec l'intervalle que chacune projette. « Encore » remet la carte
 * en fin de file : elle repasse dans la meme session.
 */

export interface ReviewRequest {
  /** Ce qu'on revise, pour l'en-tete : le titre du cours ou de la matiere. */
  title: string
  /** La matiere, pour la lumiere ambiante de la session. */
  subject: string
  courseIds: string[]
  shuffle: boolean
  /** Perimetre de la file : l'algorithme, tout le deck, ou les difficiles. */
  scope: ReviewScope
  /** Prochaine echeance connue, pour l'ecran « rien a reviser ». */
  nextDue: string | null
  /** Session multi-cours : le cours d'origine s'affiche sur chaque carte. */
  mixed: boolean
}

interface FlashcardsReviewProps {
  request: ReviewRequest
  onExit: () => void
}

type Phase = 'loading' | 'empty' | 'review' | 'done' | 'error'

// ---------------------------------------------------------------------------
// Mise en forme partagee avec le tableau de bord
// ---------------------------------------------------------------------------

/** « 3 cartes », « 1 cours » — l'accord sans y penser. */
export function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/** Une echeance en langage courant : « aujourd'hui », « demain », « le 24 aout ». */
export function dueDayLabel(iso: string): string {
  const due = new Date(iso)
  const now = new Date()
  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000)

  if (days <= 0) return "aujourd'hui"
  if (days === 1) return 'demain'
  return `le ${due.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`
}

/**
 * L'ecart projete sous un bouton de reponse. « Encore » retombe a maintenant :
 * la carte repasse dans la session, d'ou le « < 10 min ».
 */
function formatDelay(ms: number): string {
  if (ms < 60_000) return '< 10 min'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(ms / 3_600_000)
  if (hours < 24) return `${hours} h`
  const days = Math.round(ms / 86_400_000)
  if (days < 30) return `${days} j`
  if (days < 365) return `${Math.round(days / 30.44)} mois`
  const years = days / 365.25
  return years < 1.5 ? '1 an' : `${Math.round(years)} ans`
}

// ---------------------------------------------------------------------------
// Le contenu d'une carte : Markdown et formules, la recette du chat
// ---------------------------------------------------------------------------

/**
 * L'injection est sure : la politique de securite du document interdit tout
 * script en ligne, le HTML issu du Markdown ne peut rien executer.
 * Exportee : l'apercu de la feuille de collage rend les cartes a l'identique.
 */
export function renderCardHtml(markdown: string): string {
  if (!markdown) return ''
  const { text, formulas } = protectMath(markdown)
  // breaks : la feuille de collage est ligne a ligne — un retour simple dans
  // un verso est une respiration voulue, pas du remplissage a fusionner.
  const html = marked.parse(text, { async: false, gfm: true, breaks: true })
  if (typeof html !== 'string') return ''
  return restoreMath(html, formulas)
}

/** La pastille d'origine : la couleur du surlignage dont la carte est nee. */
const CHIPS: Record<HighlightColorId, { color: string; label: string }> = {
  retenir: { color: 'var(--hl-retenir)', label: 'À retenir' },
  incompris: { color: 'var(--hl-incompris)', label: 'Pas compris' },
  definition: { color: 'var(--hl-definition)', label: 'Définition' },
  formule: { color: 'var(--hl-formule)', label: 'Formule / chiffre' },
  transversal: { color: 'var(--hl-transversal)', label: 'Transversal' }
}

// ---------------------------------------------------------------------------

export default function FlashcardsReview({
  request,
  onExit
}: FlashcardsReviewProps): React.JSX.Element {
  const reduce = useReducedMotion()

  const [phase, setPhase] = useState<Phase>('loading')
  const [queue, setQueue] = useState<ReviewQueueItem[]>([])
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // « Reviser quand meme » : la meme file, cartes pas encore dues comprises.
  const [ahead, setAhead] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // Le tuteur de la carte : la carte glisse a gauche, le chat s'ouvre a droite.
  const [tutorOpen, setTutorOpen] = useState(false)

  // Le bilan de la session : reponses donnees, reussites, cartes distinctes.
  const [answered, setAnswered] = useState(0)
  const [succeeded, setSucceeded] = useState(0)
  const seenRef = useRef(new Set<string>())

  useEffect(() => {
    let alive = true
    setPhase('loading')
    window.noted.flashcards
      .queue(request.courseIds, { shuffle: request.shuffle, ahead, scope: request.scope })
      .then((items) => {
        if (!alive) return
        setQueue(items)
        setIndex(0)
        setRevealed(false)
        setPhase(items.length === 0 ? 'empty' : 'review')
      })
      .catch(() => {
        if (alive) setPhase('error')
      })
    return () => {
      alive = false
    }
  }, [request, ahead, attempt])

  const current: ReviewQueueItem | undefined = queue[index]

  // Changer de carte referme le tuteur : sa conversation portait sur l'autre.
  useEffect(() => {
    setTutorOpen(false)
  }, [index])

  const faces = useMemo(() => {
    if (!current) return null
    return {
      recto: renderCardHtml(current.card.recto),
      verso: renderCardHtml(current.card.verso)
    }
  }, [current])

  // Les intervalles projetes sous les quatre boutons, calcules sur la carte
  // du moment avec le meme module que le main : ce qui est promis est tenu.
  const delays = useMemo(() => {
    if (!current) return null
    const now = new Date()
    const projected = {} as Record<ReviewGrade, string>
    for (const grade of REVIEW_GRADES) {
      const next = applyGrade(current.card.srs, grade.id, now)
      projected[grade.id] = formatDelay(new Date(next.due).getTime() - now.getTime())
    }
    return projected
  }, [current])

  const grade = useCallback(
    async (choice: ReviewGrade): Promise<void> => {
      const item = queue[index]
      if (!item || busy) return

      setBusy(true)
      setSaveError(null)
      try {
        const updated = await window.noted.flashcards.answer(
          item.courseId,
          item.card.id,
          choice
        )

        seenRef.current.add(item.card.id)
        setAnswered((count) => count + 1)
        if (choice !== 'encore') setSucceeded((count) => count + 1)

        // Toujours due (« encore ») : la carte repart en fin de file.
        let next = queue
        if (updated && new Date(updated.srs.due).getTime() <= Date.now()) {
          next = [...queue, { ...item, card: updated }]
          setQueue(next)
        }

        if (index + 1 >= next.length) {
          setPhase('done')
        } else {
          setIndex(index + 1)
          setRevealed(false)
        }
      } catch {
        setSaveError("La réponse n'a pas pu être enregistrée — réessaie.")
      } finally {
        setBusy(false)
      }
    },
    [queue, index, busy]
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Le clavier appartient au tuteur quand on y ecrit : ni retournement ni
      // reponse au milieu d'une question — seul Echap referme le panneau.
      const target = event.target as HTMLElement | null
      if (target?.closest?.('.fc-tutor')) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setTutorOpen(false)
        }
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'Escape') {
        event.preventDefault()
        if (tutorOpen) setTutorOpen(false)
        else onExit()
        return
      }

      if (phase !== 'review') return

      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        if (!event.repeat && !busy) setRevealed((flipped) => !flipped)
        return
      }

      if (!revealed || busy) return
      const match = REVIEW_GRADES.find((entry) => entry.shortcut === event.key)
      if (match) {
        event.preventDefault()
        void grade(match.id)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [phase, revealed, busy, grade, onExit, tutorOpen])

  const tint = subjectTint(request.subject)
  const total = queue.length
  const position = Math.min(index + 1, Math.max(total, 1))
  const progress = phase === 'done' ? 100 : total > 0 ? (index / total) * 100 : 0

  const chip = current ? CHIPS[current.card.source.colour] : null
  const contextBits: string[] = []
  if (current) {
    if (request.mixed) contextBits.push(current.courseTitle)
    if (current.card.source.page !== null) contextBits.push(`p. ${current.card.source.page}`)
    else if (current.card.source.heading) contextBits.push(current.card.source.heading)
    if (contextBits.length === 0 && chip) contextBits.push(chip.label)
  }

  return (
    <div
      className="fc-session"
      style={{ '--tint-from': tint.from, '--tint-to': tint.to } as React.CSSProperties}
    >
      <header className="fc-top">
        <button className="fc-quit" onClick={onExit} title="Quitter la session">
          <X aria-hidden="true" />
          <span>Quitter</span>
          <kbd className="fc-kbd">esc</kbd>
        </button>
        <div className="fc-top-title">{request.title}</div>
        <div className="fc-top-count" aria-label="Progression">
          {phase === 'review' ? `${position} / ${total}` : ''}
        </div>
      </header>

      <div className="fc-progress" role="presentation">
        <div className="fc-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      {phase === 'loading' && (
        <div className="fc-stage">
          <p className="fc-ghost">Préparation de la session…</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="fc-stage">
          <div className="fc-final">
            <h2 className="fc-final-title">La file n'a pas pu être chargée</h2>
            <div className="fc-final-actions">
              <button className="fc-primary" onClick={() => setAttempt((n) => n + 1)}>
                Réessayer
              </button>
              <button className="fc-secondary" onClick={onExit}>
                Retour
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'empty' && (
        <div className="fc-stage">
          <motion.div
            className="fc-final"
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
          >
            {request.scope === 'difficult' ? (
              <>
                <h2 className="fc-final-title">Aucune carte difficile</h2>
                <p className="fc-final-note">
                  Rien ne résiste dans ce deck pour l'instant.
                </p>
                <div className="fc-final-actions">
                  <button className="fc-secondary" onClick={onExit}>
                    Retour
                  </button>
                </div>
              </>
            ) : ahead || request.scope === 'all' ? (
              <>
                <h2 className="fc-final-title">Aucune carte dans ce set</h2>
                <p className="fc-final-note">
                  Les surlignages jaunes, verts et bleus de ce cours n'ont pas encore
                  donné de cartes.
                </p>
                <div className="fc-final-actions">
                  <button className="fc-secondary" onClick={onExit}>
                    Retour
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="fc-final-title">Rien à réviser pour l'instant</h2>
                <p className="fc-final-note">
                  {request.nextDue
                    ? `Prochaine échéance ${dueDayLabel(request.nextDue)}.`
                    : 'Toutes les cartes sont à jour.'}
                </p>
                <div className="fc-final-actions">
                  <button className="fc-primary" onClick={() => setAhead(true)}>
                    Réviser quand même
                  </button>
                  <button className="fc-secondary" onClick={onExit}>
                    Retour
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </div>
      )}

      {phase === 'done' && (
        <div className="fc-stage">
          <motion.div
            className="fc-final"
            initial={reduce ? false : { opacity: 0, y: 10, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.32, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <span className="fc-final-glyph" aria-hidden="true">
              <Check />
            </span>
            <h2 className="fc-final-title">Session terminée</h2>
            <div className="fc-final-stats">
              <div className="fc-final-stat">
                <span className="fc-final-value">{seenRef.current.size}</span>
                <span className="fc-final-label">
                  {seenRef.current.size === 1 ? 'carte vue' : 'cartes vues'}
                </span>
              </div>
              {answered > 0 && (
                <div className="fc-final-stat">
                  <span className="fc-final-value">
                    {Math.round((succeeded / answered) * 100)} %
                  </span>
                  <span className="fc-final-label">de réussite</span>
                </div>
              )}
            </div>
            <button className="fc-primary" onClick={onExit}>
              Retour
            </button>
          </motion.div>
        </div>
      )}

      {phase === 'review' && current && faces && delays && (
        <div className="fc-stage" data-tutor={tutorOpen || undefined}>
          <div className="fc-study">
            <div className="fc-context">
              {chip && (
                <span
                  className="fc-chip"
                  style={{ background: chip.color }}
                  title={chip.label}
                />
              )}
              <span>{contextBits.join(' · ')}</span>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={index}
                className="fc-scene"
                initial={reduce ? false : { opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -10 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
              >
                <motion.div
                  className="fc-card"
                  data-flippable={!revealed}
                  onClick={() => {
                    if (!revealed && !busy) setRevealed(true)
                  }}
                  animate={{ rotateX: revealed ? 180 : 0 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 200, damping: 24, mass: 0.9 }
                  }
                >
                  <section className="fc-face fc-face--front" aria-hidden={revealed}>
                    <div className="fc-face-scroll">
                      <div
                        className="fc-markdown"
                        dangerouslySetInnerHTML={{ __html: faces.recto }}
                      />
                    </div>
                  </section>
                  <section className="fc-face fc-face--back" aria-hidden={!revealed}>
                    <div className="fc-face-scroll">
                      <div className="fc-recap">
                        <div
                          className="fc-markdown"
                          dangerouslySetInnerHTML={{ __html: faces.recto }}
                        />
                      </div>
                      <div className="fc-face-rule" aria-hidden="true" />
                      <div
                        className="fc-markdown"
                        dangerouslySetInnerHTML={{ __html: faces.verso }}
                      />
                    </div>
                  </section>
                </motion.div>
                <button
                  className="fc-tutor-toggle"
                  data-active={tutorOpen || undefined}
                  title={tutorOpen ? 'Fermer le tuteur' : 'Demander au tuteur comment retenir cette carte'}
                  aria-label={tutorOpen ? 'Fermer le tuteur' : 'Ouvrir le tuteur'}
                  onClick={() => setTutorOpen((open) => !open)}
                >
                  <Bot aria-hidden="true" />
                </button>
              </motion.div>
            </AnimatePresence>

            <div className="fc-controls">
              {!revealed ? (
                <button className="fc-flip" onClick={() => setRevealed(true)}>
                  Retourner la carte
                  <kbd className="fc-kbd">espace</kbd>
                </button>
              ) : (
                <div className="fc-grades" role="group" aria-label="Réponse">
                  {REVIEW_GRADES.map((entry) => (
                    <button
                      key={entry.id}
                      className={`fc-grade fc-grade--${entry.id}`}
                      disabled={busy}
                      onClick={() => void grade(entry.id)}
                    >
                      <span className="fc-grade-head">
                        <kbd className="fc-kbd">{entry.shortcut}</kbd>
                        <span className="fc-grade-label">{entry.label}</span>
                      </span>
                      <span className="fc-grade-delay">{delays[entry.id]}</span>
                    </button>
                  ))}
                </div>
              )}
              {saveError && <p className="fc-save-error">{saveError}</p>}
            </div>
          </div>

          <AnimatePresence>
            {tutorOpen && (
              <FlashcardsTutor
                key={current.card.id}
                item={current}
                onClose={() => setTutorOpen(false)}
              />
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}
