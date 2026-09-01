import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Plus } from 'lucide-react'
import type { Course, Subject } from '@shared/types'
import { readableError } from '../lib/errors'
import { subjectHue, type SubjectHue } from '../lib/subject-tint'
import { detectSubjectTheme } from '../lib/subject-theme'
import SubjectCard, { containerVariants, itemVariants } from './SubjectCard'
import '../styles/dashboard.css'

interface DashboardProps {
  subjects: Subject[]
  /** La teinte de chaque matiere, attribuee sans doublon (subject-tint.ts). */
  hues: Map<string, SubjectHue>
  onOpenSubject: (name: string) => void
  onImported: () => Promise<Subject[]>
}

/** Au-dela, la description deborderait des deux lignes que la carte lui laisse. */
const RECENT_LIMIT = 3

/**
 * Ecran d'accueil : une carte de papier teinte par matiere — une teinte par
 * matiere, tiree de son nom — avec le symbole de sa famille (finance,
 * marketing, IA, blockchain) detectee depuis le titre.
 *
 * Ni index exhaustif (⌘K le fait deja), ni simple ecran de bienvenue : c'est
 * aussi ici qu'on atterrit au tout premier lancement, quand le vault est vide.
 */
export default function Dashboard({
  subjects,
  hues,
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
            <SubjectTile
              key={subject.name}
              subject={subject}
              hue={hues.get(subject.name) ?? subjectHue(subject.name)}
              onOpenSubject={onOpenSubject}
            />
          ))}

          <motion.div variants={itemVariants} style={{ transformStyle: 'preserve-3d' }}>
            {drafting ? (
              <DraftCard onDone={onImported} onClose={() => setDrafting(false)} />
            ) : (
              <button className="home-new" onClick={() => setDrafting(true)}>
                <Plus aria-hidden="true" />
                <span>Nouvelle matière</span>
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

function SubjectTile({
  subject,
  hue,
  onOpenSubject
}: {
  subject: Subject
  hue: SubjectHue
  onOpenSubject: (name: string) => void
}): React.JSX.Element {
  const theme = detectSubjectTheme(subject.name)

  return (
    <motion.div variants={itemVariants} style={{ transformStyle: 'preserve-3d' }}>
      <SubjectCard
        title={subject.name}
        description={describe(subject.courses)}
        icon={theme.icon}
        hue={hue.hue}
        onOpen={() => onOpenSubject(subject.name)}
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
 * tout de suite, dont on ne remplit que le titre. La teinte et le symbole
 * suivent la saisie : taper « Corporate Finance » fait apparaitre les
 * chandeliers avant meme de valider.
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

  const draftName = name.trim() || 'Nouvelle matiere'
  const theme = detectSubjectTheme(draftName)
  const hue = subjectHue(draftName)

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
      className="subject-card subject-card--draft"
      style={{ '--h': hue.hue } as React.CSSProperties}
    >
      <div className="subject-card-top">
        <div className="subject-card-icon">{theme.icon}</div>
      </div>

      <div className="subject-card-body">
        <input
          ref={inputRef}
          className="subject-card-input"
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
        <p className={`subject-card-hint${error ? ' subject-card-hint--error' : ''}`}>
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
