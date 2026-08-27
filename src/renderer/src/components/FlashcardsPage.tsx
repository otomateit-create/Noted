import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { GENERAL_SET_TITLE } from '@shared/flashcards'
import type { FlashcardsOverview, ReviewScope, SetSummary } from '@shared/flashcards'
import { detectSubjectTheme } from '../lib/subject-theme'
import { subjectTint } from '../lib/subject-tint'
import FlashcardsCompose from './FlashcardsCompose'
import FlashcardsDashboard from './FlashcardsDashboard'
import FlashcardsDeck from './FlashcardsDeck'
import FlashcardsReview, { countLabel } from './FlashcardsReview'
import type { ReviewRequest } from './FlashcardsReview'
import '../styles/hub.css'
import '../styles/flashcards.css'

/**
 * La section Flashcards, en quatre ecrans : le tableau de bord (les chiffres,
 * les matieres qui ont des sets), une matiere (ses sets, un par cours), le
 * deck d'un set (ses cartes a plat, FlashcardsDeck), et la session de
 * revision (FlashcardsReview). La navigation vit ici, pas dans App : pour la
 * coque, la section reste une seule page. L'ecran courant, lui, est porte
 * par App : on peut partir lire un cours et retrouver son deck en revenant.
 */

export const INITIAL_SCREEN: Screen = { kind: 'dashboard' }

export type Screen =
  | { kind: 'dashboard' }
  | { kind: 'subject'; name: string }
  | { kind: 'deck'; name: string; setId: string; title: string }
  | { kind: 'compose'; name: string; back?: Screen }
  | { kind: 'session'; request: ReviewRequest; nonce: number; back: Screen }

// L'apparition en cascade des pages de la coque : chaque bloc se pose avec un
// leger retard sur le precedent. Coupee si le systeme demande moins de
// mouvement.
const cascade: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } }
}

const block: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 0.61, 0.36, 1] } }
}

interface FlashcardsPageProps {
  screen: Screen
  onScreen: (screen: Screen) => void
}

export default function FlashcardsPage({
  screen,
  onScreen: setScreen
}: FlashcardsPageProps): React.JSX.Element {
  const [overview, setOverview] = useState<FlashcardsOverview | null>(null)
  const aliveRef = useRef(true)

  // Une session de revision ne survit pas au demontage de la page : quitter
  // la section en pleine session ramene sur l'ecran d'ou elle est partie,
  // plutot que de la relancer depuis le debut au retour.
  const screenRef = useRef(screen)
  screenRef.current = screen
  useEffect(
    () => () => {
      const last = screenRef.current
      if (last.kind === 'session') setScreen(last.back)
    },
    [setScreen]
  )

  const refresh = useCallback(() => {
    window.noted.flashcards
      .overview()
      .then((data) => {
        if (aliveRef.current) setOverview(data)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    refresh()
    const unsubscribe = window.noted.flashcards.onChanged(refresh)
    // Le vault aussi : une matiere ou un cours supprime, renomme ou deplace
    // emporte ses sets — sans quoi la page resterait sur des donnees mortes.
    const unsubscribeVault = window.noted.vault.onChanged(refresh)
    return () => {
      aliveRef.current = false
      unsubscribe()
      unsubscribeVault()
    }
  }, [refresh])

  /** Lance une session sur un ou plusieurs sets d'une matiere. */
  const review = useCallback(
    (
      subject: string,
      sets: SetSummary[],
      title: string,
      shuffle: boolean,
      scope: ReviewScope,
      back: Screen
    ) => {
      const nextDue = sets.reduce<string | null>((earliest, set) => {
        if (!set.nextDue) return earliest
        if (!earliest || new Date(set.nextDue) < new Date(earliest)) return set.nextDue
        return earliest
      }, null)

      setScreen({
        kind: 'session',
        nonce: Date.now(),
        back,
        request: {
          title,
          subject,
          courseIds: sets.map((set) => set.courseId),
          shuffle,
          scope,
          nextDue,
          mixed: sets.length > 1
        }
      })
    },
    []
  )

  if (screen.kind === 'session') {
    const back = screen.back
    return (
      <FlashcardsReview
        key={screen.nonce}
        request={screen.request}
        onExit={() => {
          setScreen(back)
          refresh()
        }}
      />
    )
  }

  if (screen.kind === 'compose') {
    const back = screen.back ?? { kind: 'subject' as const, name: screen.name }
    return (
      <FlashcardsCompose
        subject={screen.name}
        onBack={() => setScreen(back)}
        onDone={() => {
          setScreen(back)
          refresh()
        }}
      />
    )
  }

  if (overview === null) {
    return <div className="hub-page" />
  }

  if (screen.kind === 'deck') {
    const current = screen
    const group = overview.subjects.find((entry) => entry.subject === current.name)
    const summary =
      group?.general?.courseId === current.setId
        ? group.general
        : (group?.sets.find((set) => set.courseId === current.setId) ?? null)
    return (
      <FlashcardsDeck
        subject={current.name}
        setId={current.setId}
        title={current.title}
        onBack={() => setScreen({ kind: 'subject', name: current.name })}
        onCompose={() => setScreen({ kind: 'compose', name: current.name, back: current })}
        onReview={(scope) =>
          review(
            current.name,
            summary ? [summary] : [],
            current.title,
            scope !== 'due',
            scope,
            current
          )
        }
      />
    )
  }

  if (screen.kind === 'subject') {
    const current = screen
    const group = overview.subjects.find((entry) => entry.subject === current.name)
    return (
      <SubjectScreen
        name={current.name}
        general={group?.general ?? null}
        sets={group?.sets ?? []}
        onBack={() => setScreen({ kind: 'dashboard' })}
        onReview={(sets, title) =>
          review(current.name, sets, title, true, 'due', { kind: 'subject', name: current.name })
        }
        onOpenDeck={(setId, title) =>
          setScreen({ kind: 'deck', name: current.name, setId, title })
        }
        onCompose={() => setScreen({ kind: 'compose', name: current.name })}
      />
    )
  }

  return (
    <FlashcardsDashboard
      overview={overview}
      onOpenSubject={(name) => setScreen({ kind: 'subject', name })}
    />
  )
}

// ---------------------------------------------------------------------------
// Ecran 2 : une matiere et ses sets
// ---------------------------------------------------------------------------

function SubjectScreen({
  name,
  general,
  sets,
  onBack,
  onReview,
  onOpenDeck,
  onCompose
}: {
  name: string
  general: SetSummary | null
  sets: SetSummary[]
  onBack: () => void
  onReview: (sets: SetSummary[], title: string) => void
  onOpenDeck: (setId: string, title: string) => void
  onCompose: () => void
}): React.JSX.Element {
  const reduce = useReducedMotion()
  const theme = detectSubjectTheme(name)
  const tint = subjectTint(name)
  const all = general ? [general, ...sets] : sets
  const cards = all.reduce((sum, set) => sum + set.total, 0)
  const due = all.reduce((sum, set) => sum + set.due, 0)

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
          Flashcards
        </motion.button>

        <motion.header
          className="fc-subhead"
          variants={block}
          style={{ '--tint-from': tint.from, '--tint-to': tint.to } as React.CSSProperties}
        >
          <span className="fc-orb" aria-hidden="true">
            {theme.icon}
          </span>
          <div className="fc-subhead-id">
            <h1 className="fc-subhead-title">{name}</h1>
            <p className="fc-subhead-meta">
              {sets.length > 0 ? `${countLabel(sets.length, 'cours', 'cours')} · ` : ''}
              {countLabel(cards, 'carte', 'cartes')} ·{' '}
              {due > 0 ? `${due} à revoir` : 'à jour'}
            </p>
          </div>
          <button className="fc-secondary fc-add" onClick={onCompose}>
            <Plus aria-hidden="true" />
            Ajouter
          </button>
          {/* Tout meles — sets de cours et cartes generales : la matiere entiere. */}
          <button
            className="fc-primary"
            disabled={all.length === 0}
            onClick={() => onReview(all, name)}
          >
            Tout réviser
          </button>
        </motion.header>

        {/* Le set general : des cartes de la matiere elle-meme, ecrites a la
            main via la feuille de collage — pas besoin d'un cours derriere. */}
        <motion.div className="fc-general" variants={block}>
          <button
            className="fc-general-main"
            onClick={() =>
              general ? onOpenDeck(general.courseId, GENERAL_SET_TITLE) : onCompose()
            }
          >
            <span className="fc-set-main">
              <span className="fc-set-name">{GENERAL_SET_TITLE}</span>
              <span className="fc-set-meta">
                {general ? setMetaLabel(general) : 'Aucune carte — écris les tiennes avec le +'}
              </span>
            </span>
            {general &&
              (general.due > 0 ? (
                <span className="fc-pill">{general.due} à revoir</span>
              ) : (
                <span className="fc-calm">à jour</span>
              ))}
            {general && <ChevronRight className="fc-chevron" aria-hidden="true" />}
          </button>
          <button
            className="fc-general-add"
            aria-label="Ajouter des cartes"
            title="Ajouter des cartes"
            onClick={onCompose}
          >
            <Plus aria-hidden="true" />
          </button>
        </motion.div>

        {sets.length > 0 && (
          <motion.section className="hub-group" variants={block}>
            <h2 className="fc-heading">Cours</h2>
            <div className="fc-panel">
              {sets.map((set) => (
                <SetRow
                  key={set.courseId}
                  set={set}
                  onClick={() => onOpenDeck(set.courseId, set.courseTitle)}
                />
              ))}
            </div>
          </motion.section>
        )}
      </motion.div>
    </div>
  )
}

/** La ligne de details d'un set — partagee entre les rangees et le set general. */
function setMetaLabel(set: SetSummary): string {
  const meta: string[] = [countLabel(set.total, 'carte', 'cartes')]
  if (set.fresh > 0) meta.push(countLabel(set.fresh, 'nouvelle', 'nouvelles'))
  if (set.acquired > 0) meta.push(countLabel(set.acquired, 'acquise', 'acquises'))
  const reviewed = lastReviewLabel(set.lastReview)
  if (reviewed) meta.push(reviewed)
  return meta.join(' · ')
}

function SetRow({ set, onClick }: { set: SetSummary; onClick: () => void }): React.JSX.Element {
  return (
    <button className="fc-set" onClick={onClick}>
      <span className="fc-set-main">
        <span className="fc-set-name">{set.courseTitle}</span>
        <span className="fc-set-meta">{setMetaLabel(set)}</span>
      </span>
      {set.due > 0 ? (
        <span className="fc-pill">{set.due} à revoir</span>
      ) : (
        <span className="fc-calm">à jour</span>
      )}
      <ChevronRight className="fc-chevron" aria-hidden="true" />
    </button>
  )
}

/** « revise hier », « revise il y a 5 j » — la fraicheur d'un set, en un mot. */
function lastReviewLabel(iso: string | null): string | null {
  if (!iso) return null
  const then = new Date(iso)
  const now = new Date()
  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)

  if (days <= 0) return "révisé aujourd'hui"
  if (days === 1) return 'révisé hier'
  if (days < 31) return `révisé il y a ${days} j`
  return `révisé le ${then.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`
}
