import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type Variants
} from 'framer-motion'
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
// La carte : un rectangle qui grandit avec son texte, un retournement
// ---------------------------------------------------------------------------

/** La forme de la carte : un rectangle 3:2, quelle que soit sa taille. */
const CARD_RATIO = 1.5

/**
 * Les largeurs essayees, de la carte ordinaire a la plus grande. La carte
 * grandit par paliers plutot qu'au pixel pres : la plupart des cartes
 * tombent sur le premier, et la taille ne change d'une carte a l'autre que
 * quand le texte l'exige.
 */
const CARD_WIDTHS = [600, 660, 720, 780, 840, 900, 960]

/**
 * Quand la fenetre bloque le 3:2 avant que le texte tienne, la carte
 * s'etire dans la dimension restee libre — plus allongee si la hauteur
 * manque, plus haute si c'est la largeur —, sans quitter la famille des
 * rectangles.
 */
const RATIO_WIDEST = 1.8
const RATIO_TALLEST = 1.25
const STRETCH_STEP = 40

interface CardSize {
  width: number
  height: number
}

/** Les tailles a essayer, de la plus petite a la plus grande. */
function candidateSizes(bounds: CardSize): CardSize[] {
  const maxWidth = Math.max(0, Math.floor(bounds.width))
  const maxHeight = Math.max(0, Math.floor(bounds.height))
  const fitWidth = Math.min(maxWidth, Math.floor(maxHeight * CARD_RATIO))
  const largest = Math.min(CARD_WIDTHS[CARD_WIDTHS.length - 1], fitWidth)
  const sizes = [...CARD_WIDTHS.filter((width) => width < largest), largest].map((width) => ({
    width,
    height: Math.round(width / CARD_RATIO)
  }))
  // Plafonnee par les paliers et non par la fenetre : rien a etirer.
  if (largest < fitWidth) return sizes

  const last = sizes[sizes.length - 1]
  if (maxHeight * CARD_RATIO < maxWidth) {
    const widest = Math.min(maxWidth, Math.floor(last.height * RATIO_WIDEST))
    for (let width = last.width + STRETCH_STEP; width - STRETCH_STEP < widest; width += STRETCH_STEP) {
      sizes.push({ width: Math.min(width, widest), height: last.height })
    }
  } else {
    const tallest = Math.min(maxHeight, Math.floor(last.width / RATIO_TALLEST))
    for (let height = last.height + STRETCH_STEP; height - STRETCH_STEP < tallest; height += STRETCH_STEP) {
      sizes.push({ width: last.width, height: Math.min(height, tallest) })
    }
  }
  return sizes
}

/**
 * Une formule centree plus large que la carte se resserre, elle seule, a la
 * largeur disponible — jusqu'a 60 % de sa taille, au-dela elle defile. KaTeX
 * compte tout en em : une taille de police sur le bloc met a l'echelle la
 * formule entiere.
 */
function narrowWideFormulas(scroll: HTMLElement): void {
  for (const formula of scroll.querySelectorAll<HTMLElement>('.katex-display')) {
    formula.style.fontSize = ''
    const ratio = formula.clientWidth / formula.scrollWidth
    if (ratio < 1) formula.style.fontSize = `${Math.max(0.6, ratio * 0.98)}em`
  }
}

/** Les deux faces tiennent : rien ne deborde en hauteur, ni formule ni tableau en largeur. */
function contentFits(slot: HTMLElement): boolean {
  return Array.from(slot.querySelectorAll<HTMLElement>('.fc-face-scroll')).every(
    (scroll) =>
      scroll.scrollHeight <= scroll.clientHeight + 1 &&
      Array.from(scroll.querySelectorAll<HTMLElement>('.katex-display, table')).every(
        (block) => block.scrollWidth <= block.clientWidth + 1
      )
  )
}

/**
 * Taille la carte sur son texte : le plus petit palier ou les deux faces
 * tiennent, sans jamais depasser la place disponible (bounds). Le texte
 * garde sa taille ; c'est la carte qui grandit. Si meme la plus grande ne
 * suffit pas, les formules trop larges se resserrent et la face defile — le
 * dernier recours, pas la regle.
 */
function fitCard(slot: HTMLElement, bounds: CardSize): CardSize {
  const scrolls = Array.from(slot.querySelectorAll<HTMLElement>('.fc-face-scroll'))
  for (const scroll of scrolls) {
    delete scroll.dataset.overflow
    for (const formula of scroll.querySelectorAll<HTMLElement>('.katex-display')) {
      formula.style.fontSize = ''
    }
  }

  let size: CardSize = { width: 0, height: 0 }
  for (const candidate of candidateSizes(bounds)) {
    size = candidate
    slot.style.width = `${size.width}px`
    slot.style.height = `${size.height}px`
    if (contentFits(slot)) return size
  }

  for (const scroll of scrolls) {
    narrowWideFormulas(scroll)
    if (scroll.scrollHeight > scroll.clientHeight + 1) scroll.dataset.overflow = ''
  }
  return size
}

/**
 * L'en-tete d'une face, comme la ligne du haut d'une fiche bristol : ce
 * qu'on lit — question ou reponse — et d'ou vient la carte.
 */
function FaceHead({
  label,
  chip,
  context
}: {
  label: string
  chip: { color: string; label: string } | null
  context: string[]
}): React.JSX.Element {
  return (
    <header className="fc-face-head">
      <span className="fc-face-label">{label}</span>
      <span className="fc-face-source">
        {chip && <span className="fc-chip" style={{ background: chip.color }} title={chip.label} />}
        <span className="fc-face-source-text">{context.join(' · ')}</span>
      </span>
    </header>
  )
}

/**
 * La carte et son retournement. Elle pivote sur son axe vertical, comme une
 * fiche qu'on retourne entre deux doigts, et se souleve a mi-course : elle
 * grossit un peu, son ombre s'etale et palit sur le bureau. La levee se lit
 * sur l'angle lui-meme — |sin| vaut 0 a plat, 1 sur la tranche —, si bien
 * qu'un retournement repris en plein vol retombe sans a-coup.
 */
function FlipCard({
  revealed,
  onReveal,
  front,
  back
}: {
  revealed: boolean
  onReveal: () => void
  front: React.ReactNode
  back: React.ReactNode
}): React.JSX.Element {
  const reduce = useReducedMotion()
  const angle = useMotionValue(0)
  const lift = useTransform(angle, (degrees) => Math.abs(Math.sin((degrees * Math.PI) / 180)))
  const scale = useTransform(lift, (value) => 1 + 0.035 * value)
  const groundScale = useTransform(lift, (value) => 1 + 0.14 * value)
  const groundOpacity = useTransform(lift, (value) => 1 - 0.55 * value)

  useEffect(() => {
    const controls = animate(
      angle,
      revealed ? 180 : 0,
      reduce ? { duration: 0 } : { duration: 0.62, ease: [0.45, 0.05, 0.2, 1] }
    )
    return () => controls.stop()
  }, [angle, revealed, reduce])

  return (
    <>
      <motion.div
        className="fc-ground"
        aria-hidden="true"
        style={{ scaleX: groundScale, opacity: groundOpacity }}
      />
      <motion.div
        className="fc-card"
        data-flippable={!revealed}
        onClick={() => {
          if (!revealed) onReveal()
        }}
        style={{ rotateY: angle, scale }}
      >
        {front}
        {back}
      </motion.div>
    </>
  )
}

/**
 * L'entree et la sortie d'une carte. Elle monte de la pile ; elle en sort
 * de deux facons : mise de cote a gauche quand elle est reglee pour la
 * session, reglissee dans la pile quand « Encore » la fait repasser.
 */
type Leaving = 'aside' | 'again'

const SLOT: Variants = {
  enter: { opacity: 0, y: 14, scale: 0.955 },
  rest: {
    opacity: 1,
    x: 0,
    y: 0,
    scale: 1,
    rotate: 0,
    transition: { duration: 0.34, ease: [0.22, 0.61, 0.36, 1] }
  },
  exit: (leaving: Leaving) =>
    leaving === 'again'
      ? { opacity: 0, y: 22, scale: 0.94, transition: { duration: 0.26, ease: [0.4, 0, 1, 1] } }
      : {
          opacity: 0,
          x: -80,
          y: -6,
          rotate: -4,
          transition: { duration: 0.26, ease: [0.4, 0, 1, 1] }
        }
}

/**
 * L'emplacement d'une carte : il la taille sur son texte avant le premier
 * affichage (effet de mise en page), puis a chaque changement de la place
 * disponible. La taille retenue remonte a la scene, qui y cale la pile.
 */
function CardSlot({
  bounds,
  content,
  onSize,
  children
}: {
  bounds: CardSize | null
  content: string
  onSize: (size: CardSize) => void
  children: React.ReactNode
}): React.JSX.Element {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<CardSize | null>(null)

  useLayoutEffect(() => {
    const slot = ref.current
    if (!slot || !bounds) return
    const measure = (): void => {
      const next = fitCard(slot, bounds)
      setSize((prev) =>
        prev && prev.width === next.width && prev.height === next.height ? prev : next
      )
      onSize(next)
    }
    measure()
    // Les fontes de KaTeX peuvent arriver apres la premiere mesure.
    let alive = true
    void document.fonts.ready.then(() => {
      if (alive) measure()
    })
    return () => {
      alive = false
    }
  }, [bounds, content, onSize])

  return (
    <motion.div
      ref={ref}
      className="fc-slot"
      variants={SLOT}
      initial={reduce ? false : 'enter'}
      animate="rest"
      exit={reduce ? undefined : 'exit'}
      style={size ?? undefined}
    >
      {children}
    </motion.div>
  )
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

  // Comment la carte qu'on vient de noter quitte la scene.
  const [leaving, setLeaving] = useState<Leaving>('aside')

  // La place que laisse la colonne d'etude, et la taille de la carte du moment.
  const studyRef = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<CardSize | null>(null)
  const [cardSize, setCardSize] = useState<CardSize | null>(null)

  useLayoutEffect(() => {
    const study = studyRef.current
    if (!study) return
    const read = (): void => {
      const width = study.clientWidth
      const height = study.clientHeight
      setRoom((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height }
      )
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(study)
    return () => observer.disconnect()
  }, [phase])

  // La carte laisse de chaque cote la place du robot du tuteur — a droite
  // seulement quand le tuteur est ouvert —, et dessous celle de la pile et
  // des commandes. Elle ne sort jamais de la fenetre.
  const bounds = useMemo(
    () =>
      room && { width: room.width - (tutorOpen ? 60 : 112), height: room.height - 124 },
    [room, tutorOpen]
  )

  const handleSize = useCallback((size: CardSize) => {
    setCardSize((prev) =>
      prev && prev.width === size.width && prev.height === size.height ? prev : size
    )
  }, [])

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

  // Les objets { __html } memorises, pas seulement les chaines : React 19
  // reecrit innerHTML des que l'objet change d'identite.
  const faces = useMemo(() => {
    if (!current) return null
    return {
      recto: { __html: renderCardHtml(current.card.recto) },
      verso: { __html: renderCardHtml(current.card.verso) }
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
        const again = updated !== null && new Date(updated.srs.due).getTime() <= Date.now()
        if (again) {
          next = [...queue, { ...item, card: updated }]
          setQueue(next)
        }
        setLeaving(again ? 'again' : 'aside')

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
          <div className="fc-study" ref={studyRef}>
            <div className="fc-scene" style={cardSize ?? undefined}>
              {/* Les cartes qui restent, en pile sous celle du moment : deux
                  tranches au plus, qui s'effacent quand la file s'epuise. */}
              <div
                className="fc-stack"
                data-depth={Math.min(2, total - index - 1)}
                aria-hidden="true"
              >
                <span className="fc-stack-card" />
                <span className="fc-stack-card" />
              </div>

              <AnimatePresence initial={false} custom={leaving}>
                <CardSlot
                  key={index}
                  bounds={bounds}
                  content={faces.recto.__html + faces.verso.__html}
                  onSize={handleSize}
                >
                  <FlipCard
                    revealed={revealed}
                    onReveal={() => {
                      if (!busy) setRevealed(true)
                    }}
                    front={
                      <section className="fc-face fc-face--front" aria-hidden={revealed}>
                        <FaceHead label="Question" chip={chip} context={contextBits} />
                        <div className="fc-face-scroll">
                          <div className="fc-markdown" dangerouslySetInnerHTML={faces.recto} />
                        </div>
                      </section>
                    }
                    back={
                      <section className="fc-face fc-face--back" aria-hidden={!revealed}>
                        <FaceHead label="Réponse" chip={chip} context={contextBits} />
                        <div className="fc-face-scroll">
                          <div className="fc-recap">
                            <div className="fc-markdown" dangerouslySetInnerHTML={faces.recto} />
                          </div>
                          <div className="fc-face-rule" aria-hidden="true" />
                          <div className="fc-markdown" dangerouslySetInnerHTML={faces.verso} />
                        </div>
                      </section>
                    }
                  />
                </CardSlot>
              </AnimatePresence>

              <button
                className="fc-tutor-toggle"
                data-active={tutorOpen || undefined}
                title={tutorOpen ? 'Fermer le tuteur' : 'Demander au tuteur comment retenir cette carte'}
                aria-label={tutorOpen ? 'Fermer le tuteur' : 'Ouvrir le tuteur'}
                onClick={() => setTutorOpen((open) => !open)}
              >
                <Bot aria-hidden="true" />
              </button>
            </div>

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
