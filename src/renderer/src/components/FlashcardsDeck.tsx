import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { ChevronLeft, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import type { Flashcard, ReviewScope } from '@shared/flashcards'
import { isAcquired, isDifficultCard, isDue } from '@shared/srs'
import { countLabel, dueDayLabel, renderCardHtml } from './FlashcardsReview'
import '../styles/flashcards.css'

/**
 * Le deck d'un set : toutes ses cartes a plat, feuilletables, chacune avec son
 * menu « ⋯ » pour la modifier sur place ou la supprimer — puis, sous la
 * liste, les trois facons de
 * lancer une session : l'algorithme, tout le deck en vrac, ou seulement les
 * cartes qui resistent.
 */

interface FlashcardsDeckProps {
  subject: string
  setId: string
  title: string
  onBack: () => void
  onCompose: () => void
  onReview: (scope: ReviewScope) => void
}

const cascade: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } }
}

const block: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 0.61, 0.36, 1] } }
}

/** La ligne de contexte d'une carte : d'ou elle vient, ou elle en est. */
function cardMetaLabel(card: Flashcard, now: Date): string {
  const bits: string[] = []
  if (card.source.page !== null) bits.push(`p. ${card.source.page}`)
  else if (card.source.heading) bits.push(card.source.heading)

  if (card.history.length === 0) bits.push('nouvelle')
  else if (isDue(card.srs, now)) bits.push('à revoir')
  else if (isAcquired(card.srs)) bits.push(`acquise — revient ${dueDayLabel(card.srs.due)}`)
  else bits.push(`revient ${dueDayLabel(card.srs.due)}`)

  return bits.join(' · ')
}

export default function FlashcardsDeck({
  subject,
  setId,
  title,
  onBack,
  onCompose,
  onReview
}: FlashcardsDeckProps): React.JSX.Element {
  const reduce = useReducedMotion()

  const [cards, setCards] = useState<Flashcard[] | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.noted.flashcards
        .cards(setId)
        .then((items) => {
          if (alive) setCards(items)
        })
        .catch(() => {
          if (alive) setCards([])
        })
    }
    load()
    // La generation en fond ou une suppression ailleurs : le deck suit.
    const unsubscribe = window.noted.flashcards.onChanged(load)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [setId])

  useEffect(() => {
    if (menuFor === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuFor(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuFor])

  const remove = useCallback(
    (cardId: string) => {
      setMenuFor(null)
      setFailure(null)
      window.noted.flashcards
        .removeCard(setId, cardId)
        .then(() => {
          setCards((previous) =>
            previous ? previous.filter((card) => card.id !== cardId) : previous
          )
        })
        .catch(() => setFailure("La carte n'a pas pu être supprimée — réessaie."))
    },
    [setId]
  )

  const edit = useCallback((cardId: string) => {
    setMenuFor(null)
    setFailure(null)
    setEditing(cardId)
  }, [])

  const save = useCallback(
    (cardId: string, faces: { recto: string; verso: string }) => {
      setFailure(null)
      window.noted.flashcards
        .updateCard(setId, cardId, faces)
        .then((updated) => {
          if (!updated) {
            setFailure("La carte n'a pas pu être modifiée — les deux faces doivent être remplies.")
            return
          }
          setEditing(null)
          setCards((previous) =>
            previous ? previous.map((card) => (card.id === cardId ? updated : card)) : previous
          )
        })
        .catch(() => setFailure("La carte n'a pas pu être modifiée — réessaie."))
    },
    [setId]
  )

  const toggleMenu = useCallback((cardId: string) => {
    setMenuFor((open) => (open === cardId ? null : cardId))
  }, [])

  const total = cards?.length ?? 0
  const now = new Date()
  const due = (cards ?? []).filter((card) => isDue(card.srs, now)).length
  const difficult = useMemo(
    () => (cards ?? []).filter(isDifficultCard).length,
    [cards]
  )

  return (
    <div className="hub-page">
      <motion.div
        className="hub-page-inner"
        variants={cascade}
        initial={reduce ? false : 'hidden'}
        animate="visible"
      >
        <motion.button className="fc-back" variants={block} onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
          {subject}
        </motion.button>

        <motion.header className="fc-compose-head" variants={block}>
          <div className="fc-subhead-id">
            <h1 className="fc-subhead-title">{title}</h1>
            <p className="fc-subhead-meta">
              {cards === null
                ? '…'
                : `${countLabel(total, 'carte', 'cartes')} · ${
                    due > 0 ? `${due} à revoir` : 'à jour'
                  }`}
            </p>
          </div>
          <button className="fc-secondary fc-add" onClick={onCompose}>
            <Plus aria-hidden="true" />
            Ajouter
          </button>
        </motion.header>

        {menuFor !== null && (
          <div
            className="fc-menu-backdrop"
            aria-hidden="true"
            onClick={() => setMenuFor(null)}
          />
        )}

        <motion.section className="fc-deck" variants={block} aria-label="Cartes du deck">
          {cards === null ? (
            <p className="fc-ghost">Chargement…</p>
          ) : cards.length === 0 ? (
            <p className="fc-deck-empty">Aucune carte dans ce deck.</p>
          ) : (
            <div className="fc-deck-list">
              {cards.map((card) => (
                editing === card.id ? (
                  <DeckCardEditor
                    key={card.id}
                    card={card}
                    onSave={save}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <DeckCard
                    key={card.id}
                    card={card}
                    menuOpen={menuFor === card.id}
                    onToggleMenu={toggleMenu}
                    onEdit={edit}
                    onRemove={remove}
                  />
                )
              ))}
            </div>
          )}
          {failure && <p className="fc-compose-error">{failure}</p>}
        </motion.section>

        <motion.section className="fc-modes" variants={block} aria-label="Lancer une session">
          <button
            className="fc-mode fc-mode--primary"
            disabled={total === 0}
            onClick={() => onReview('due')}
          >
            <span className="fc-mode-name">Réviser</span>
            <span className="fc-mode-note">
              {due > 0 ? countLabel(due, 'carte due', 'cartes dues') : "rien de dû pour l'instant"}
            </span>
          </button>
          <button className="fc-mode" disabled={total === 0} onClick={() => onReview('all')}>
            <span className="fc-mode-name">Tout mélanger</span>
            <span className="fc-mode-note">
              {total === 1 ? "l'unique carte, en vrac" : `les ${total} cartes, même acquises`}
            </span>
          </button>
          <button
            className="fc-mode"
            disabled={difficult === 0}
            onClick={() => onReview('difficult')}
          >
            <span className="fc-mode-name">Les difficiles</span>
            <span className="fc-mode-note">
              {difficult > 0
                ? countLabel(difficult, 'carte à retravailler', 'cartes à retravailler')
                : "aucune pour l'instant"}
            </span>
          </button>
        </motion.section>
      </motion.div>
    </div>
  )
}

/**
 * Une carte de la liste. Memoisee : ouvrir un menu ne doit pas re-parser le
 * Markdown et les formules des dizaines d'autres cartes du deck.
 */
const DeckCard = memo(function DeckCard({
  card,
  menuOpen,
  onToggleMenu,
  onEdit,
  onRemove
}: {
  card: Flashcard
  menuOpen: boolean
  onToggleMenu: (cardId: string) => void
  onEdit: (cardId: string) => void
  onRemove: (cardId: string) => void
}): React.JSX.Element {
  const faces = useMemo(
    () => ({ recto: renderCardHtml(card.recto), verso: renderCardHtml(card.verso) }),
    [card.recto, card.verso]
  )

  return (
    <article className="fc-deck-card">
      <div className="fc-deck-card-head">
        <span className="fc-deck-card-meta">
          <span
            className="fc-chip"
            style={{ background: `var(--hl-${card.source.colour})` }}
            aria-hidden="true"
          />
          <span className="fc-deck-card-meta-text">{cardMetaLabel(card, new Date())}</span>
        </span>
        <button
          className="fc-deck-more"
          aria-label="Options de la carte"
          aria-expanded={menuOpen}
          onClick={() => onToggleMenu(card.id)}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="fc-deck-menu" role="menu">
            <button className="fc-deck-menu-item" role="menuitem" onClick={() => onEdit(card.id)}>
              <Pencil aria-hidden="true" />
              Modifier
            </button>
            <button
              className="fc-deck-menu-item fc-deck-menu-item--danger"
              role="menuitem"
              onClick={() => onRemove(card.id)}
            >
              <Trash2 aria-hidden="true" />
              Supprimer
            </button>
          </div>
        )}
      </div>
      <div
        className="fc-markdown fc-deck-card-q"
        dangerouslySetInnerHTML={{ __html: faces.recto }}
      />
      <div className="fc-preview-rule" aria-hidden="true" />
      <div className="fc-markdown" dangerouslySetInnerHTML={{ __html: faces.verso }} />
    </article>
  )
})

/**
 * La meme carte, ouverte pour etre reecrite : les deux faces en Markdown,
 * telles qu'elles sont dans le fichier. ⌘↵ enregistre, Echap abandonne. La
 * repetition espacee n'est pas touchee — on corrige une formulation, on ne
 * repart pas de zero.
 */
function DeckCardEditor({
  card,
  onSave,
  onCancel
}: {
  card: Flashcard
  onSave: (cardId: string, faces: { recto: string; verso: string }) => void
  onCancel: () => void
}): React.JSX.Element {
  const [recto, setRecto] = useState(card.recto)
  const [verso, setVerso] = useState(card.verso)
  const first = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    first.current?.focus()
  }, [])

  const ready = recto.trim().length > 0 && verso.trim().length > 0
  const submit = (): void => {
    if (ready) onSave(card.id, { recto, verso })
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <article className="fc-deck-card fc-deck-card--editing" onKeyDown={onKeyDown}>
      <label className="fc-deck-edit-field">
        <span className="fc-deck-edit-label">Recto</span>
        <textarea
          ref={first}
          className="fc-sheet fc-deck-edit-area"
          value={recto}
          onChange={(event) => setRecto(event.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="fc-deck-edit-field">
        <span className="fc-deck-edit-label">Verso</span>
        <textarea
          className="fc-sheet fc-deck-edit-area"
          value={verso}
          onChange={(event) => setVerso(event.target.value)}
          spellCheck={false}
        />
      </label>
      <div className="fc-compose-actions">
        <button className="fc-primary" disabled={!ready} onClick={submit}>
          Enregistrer
        </button>
        <button className="fc-secondary" onClick={onCancel}>
          Annuler
        </button>
        <span className="fc-deck-edit-hint">⌘↵ pour enregistrer · Markdown et $…$ acceptés</span>
      </div>
    </article>
  )
}
