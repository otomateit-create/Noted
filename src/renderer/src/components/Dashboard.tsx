import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Plus } from 'lucide-react'
import type { Course, Subject } from '@shared/types'
import { readableError } from '../lib/errors'
import { detectSubjectTheme } from '../lib/subject-theme'
import { Card3D, containerVariants, itemVariants } from './ui/animated-3d-card'
import '../styles/dashboard.css'

interface DashboardProps {
  subjects: Subject[]
  onOpenSubject: (name: string) => void
  onImported: () => Promise<Subject[]>
}

/** Au-dela, la description deborderait des trois lignes que la carte lui laisse. */
const RECENT_LIMIT = 3

/**
 * Ecran d'accueil : une carte 3D par matiere, colorée par sa thematique —
 * finance, marketing, IA, blockchain — detectee depuis le titre, avec le
 * symbole de la famille pose en haut a gauche.
 *
 * Ni index exhaustif (⌘K le fait deja), ni simple ecran de bienvenue : c'est
 * aussi ici qu'on atterrit au tout premier lancement, quand le vault est vide.
 */
export default function Dashboard({
  subjects,
  onOpenSubject,
  onImported
}: DashboardProps): React.JSX.Element {
  const [drafting, setDrafting] = useState(false)

  return (
    <div className="home">
      <div className="home-inner">
        {subjects.length === 0 && (
          <section className="home-intro">
            <h1 className="home-intro-title">Noted</h1>
            <p className="home-intro-lede">
              Ton cours à gauche, tes notes au centre, Claude à droite — qui a lu
              le document en entier. Crée une première matière pour commencer.
            </p>
          </section>
        )}

        {subjects.length > 0 && <h2 className="home-heading">Matières</h2>}

        <motion.div
          className="relative grid w-full grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          style={{ perspective: '1500px', transformStyle: 'preserve-3d' }}
        >
          {subjects.map((subject) => (
            <SubjectCard3D key={subject.name} subject={subject} onOpenSubject={onOpenSubject} />
          ))}

          <motion.div variants={itemVariants} style={{ transformStyle: 'preserve-3d' }}>
            {drafting ? (
              <DraftCard onDone={onImported} onClose={() => setDrafting(false)} />
            ) : (
              <button
                className="flex h-52 w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-black/15 text-[color:var(--shell-text-dim)] transition-colors duration-150 hover:border-black/25 hover:bg-black/[0.022] hover:text-[color:var(--shell-text-mid)]"
                onClick={() => setDrafting(true)}
              >
                <Plus aria-hidden="true" className="h-6 w-6" />
                <span className="text-[13.5px]">Nouvelle matière</span>
              </button>
            )}
          </motion.div>
        </motion.div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Une carte de matiere
// ---------------------------------------------------------------------------

function SubjectCard3D({
  subject,
  onOpenSubject
}: {
  subject: Subject
  onOpenSubject: (name: string) => void
}): React.JSX.Element {
  const theme = detectSubjectTheme(subject.name)
  const description = useMemo(() => describe(subject.courses), [subject.courses])

  return (
    <motion.div variants={itemVariants} style={{ transformStyle: 'preserve-3d' }}>
      <Card3D
        title={subject.name}
        description={description}
        icon={theme.icon}
        gradient={theme.gradient}
        variant="premium"
        size="md"
        className="h-52"
        onClick={() => onOpenSubject(subject.name)}
      />
    </motion.div>
  )
}

/**
 * Ce que la carte raconte sous le titre : combien de cours, et lesquels sont
 * arrives en dernier. Les cours eux-memes s'ouvrent depuis la page de la
 * matiere ou ⌘K — la carte, elle, ouvre la matiere.
 */
function describe(courses: Course[]): string {
  if (courses.length === 0) {
    return "Aucun cours pour l'instant — glisse un PDF, un DOCX, un PPTX ou un Markdown."
  }

  const recent = newestFirst(courses)
    .slice(0, RECENT_LIMIT)
    .map((course) => course.title)

  return `${courseCountLabel(courses.length)} · ${recent.join(' · ')}`
}

// ---------------------------------------------------------------------------
// La carte neuve : elle arrive entiere, le nom deja pret a etre saisi
// ---------------------------------------------------------------------------

/**
 * Pas un bouton qui se transforme en champ, mais la carte definitive posee
 * tout de suite, dont on ne remplit que le titre. La thematique suit la
 * saisie : taper « Corporate Finance » fait apparaitre les chandeliers et le
 * vert avant meme de valider.
 */
function DraftCard({
  onDone,
  onClose
}: {
  onDone: () => Promise<Subject[]>
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const theme = detectSubjectTheme(name.trim() || 'Nouvelle matiere')

  const submit = async (): Promise<void> => {
    const clean = name.trim()
    if (!clean || busy) return

    setBusy(true)
    try {
      await window.noted.vault.createSubject(clean)
      await onDone()
      onClose()
    } catch (cause) {
      setError(readableError(cause, 'Impossible de créer cette matière.'))
      setBusy(false)
    }
  }

  return (
    <div
      className={`relative flex h-52 w-full flex-col justify-between overflow-hidden rounded-2xl bg-gradient-to-br p-6 text-white shadow-xl ring-1 ring-white/20 ${theme.gradient}`}
    >
      <div className="opacity-90 drop-shadow-lg">{theme.icon}</div>

      <div className="space-y-3">
        <input
          ref={inputRef}
          className="w-full cursor-text select-text bg-transparent text-xl font-semibold tracking-tight text-white placeholder:text-white/60 drop-shadow-md"
          value={name}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
            if (event.key === 'Escape') onClose()
          }}
          onBlur={() => {
            if (!name.trim()) onClose()
          }}
          placeholder="Nom de la matière"
          aria-label="Nom de la nouvelle matière"
          aria-invalid={Boolean(error)}
        />
        <p className={`text-sm leading-relaxed drop-shadow-sm ${error ? 'text-red-200' : 'text-white/85'}`}>
          {error ?? (busy ? 'Création…' : 'entrée pour valider, échap pour annuler')}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * Les cours les plus recemment ajoutes au vault d'abord. C'est la date
 * d'arrivee du fichier qui compte, pas celle de la derniere ouverture :
 * « mes derniers cours » designe ce qu'on vient de deposer.
 */
function newestFirst(courses: Course[]): Course[] {
  return [...courses].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
    return a.title.localeCompare(b.title, 'fr')
  })
}

function courseCountLabel(count: number): string {
  return count === 1 ? '1 cours' : `${count} cours`
}
