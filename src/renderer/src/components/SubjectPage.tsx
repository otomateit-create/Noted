import { useEffect, useMemo, useRef, useState } from 'react'
import type { Course, CourseMove, PendingConversion, PhotoProposal, Subject } from '@shared/types'
import { readableError } from '../lib/errors'
import { subjectTint } from '../lib/subject-tint'
import { PhotoOrderDialog } from './PhotoOrder'
import '../styles/subject-page.css'

interface SubjectPageProps {
  subject: Subject
  onOpenCourse: (courseId: string) => void
  onImported: () => Promise<Subject[]>
  onMoved: (moves: CourseMove[]) => void
  onRemoved: (courseIds: string[]) => void
}

/**
 * Tous les cours d'une matiere, la ou le tableau de bord n'en montre que cinq.
 *
 * La page emprunte sa lumiere a la teinte de la matiere : on sait ou l'on se
 * trouve avant meme d'avoir lu le titre. On y importe, on y renomme, on y
 * supprime — deplacer un cours vers une autre matiere reste dans la
 * bibliotheque (⌘K), geste plus rare qui ne merite pas sa place ici.
 */
export default function SubjectPage({
  subject,
  onOpenCourse,
  onImported,
  onMoved,
  onRemoved
}: SubjectPageProps): React.JSX.Element {
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * L'ordre propose pour des images qui viennent d'etre choisies, tant qu'il
   * n'est pas accepte. Rien n'est encore ecrit : abandonner ne laisse rien.
   */
  const [proposal, setProposal] = useState<PhotoProposal | null>(null)
  /** Les cours de cette matiere en train d'etre lus. Ils n'existent pas encore. */
  const [pending, setPending] = useState<PendingConversion[]>([])

  const tint = subjectTint(subject.name)
  const rows = useMemo(() => newestFirst(subject.courses), [subject.courses])

  // La lecture dure des minutes : sans cette ligne, importer des photos depuis
  // cette page n'y produirait rien de visible, et le geste passerait pour perdu.
  useEffect(() => {
    const load = (): void => {
      void window.noted.ocr
        .pending()
        .then((entries) => setPending(entries.filter((entry) => entry.subject === subject.name)))
    }
    load()

    return window.noted.ocr.onPendingChanged(() => {
      load()
      // Une lecture qui s'acheve fait apparaitre un vrai cours dans la matiere.
      void onImported()
    })
  }, [subject.name, onImported])

  const importCourses = async (): Promise<void> => {
    setImporting(true)
    setError(null)
    try {
      const { photos } = await window.noted.vault.importCourses(subject.name)
      await onImported()
      // Les images ne sont pas des cours : elles se lisent, et leur ordre
      // demande un accord avant que la lecture ne parte.
      if (photos) setProposal(photos)
    } catch (cause) {
      setError(readableError(cause, "L'import a échoué."))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div
      className="matter"
      style={{ '--tint-from': tint.from, '--tint-to': tint.to } as React.CSSProperties}
    >
      <div className="matter-inner">
        <header className="matter-head">
          <div className="matter-id">
            <span className="matter-orb" aria-hidden="true" />
            <div>
              <h1 className="matter-title">{subject.name}</h1>
              <p className="matter-count">{courseCountLabel(subject.courses.length)}</p>
            </div>
          </div>

          <button
            className="glass-button"
            disabled={importing}
            onClick={() => void importCourses()}
            title="PDF, Word, PowerPoint, Markdown — ou des photos et captures d’écran, qui deviendront un seul cours"
          >
            {importing ? 'Import…' : 'Importer des cours'}
          </button>
        </header>

        {error && <p className="matter-error">{error}</p>}

        {rows.length === 0 && pending.length === 0 ? (
          <p className="matter-empty">Aucun cours dans cette matière pour l'instant.</p>
        ) : (
          <div className="matter-rows">
            {pending.map((entry) => (
              <PendingRow
                key={entry.id}
                entry={entry}
                onDismiss={() => void window.noted.ocr.dismiss(entry.id)}
              />
            ))}

            {rows.map((course) => (
              <CourseRow
                key={course.id}
                course={course}
                onOpenCourse={onOpenCourse}
                onMoved={onMoved}
                onRemoved={onRemoved}
              />
            ))}
          </div>
        )}
      </div>

      {proposal && (
        <PhotoOrderDialog
          proposal={proposal}
          onCancel={() => setProposal(null)}
          onConfirm={() => {
            void window.noted.ocr.importPhotos(proposal)
            setProposal(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * Un cours en train d'etre lu a partir d'images.
 *
 * Il occupe une ligne comme un cours ordinaire — c'en est un qui arrive — mais
 * il ne s'ouvre pas : il n'existe pas encore comme fichier. La ligne disparait
 * d'elle-meme quand le cours devient reel, ou porte la raison de son echec.
 */
function PendingRow({
  entry,
  onDismiss
}: {
  entry: PendingConversion
  onDismiss: () => void
}): React.JSX.Element {
  const failed = Boolean(entry.failed)

  return (
    <div className="matter-row matter-row--pending">
      <div className="matter-row-open matter-row-open--still">
        <span className="matter-format">{failed ? '!' : 'OCR'}</span>
        <span className="matter-row-name">{entry.title}</span>
        <span className="matter-row-progress">
          {failed ? entry.failed : `lecture — ${entry.done} sur ${entry.total}`}
        </span>
      </div>

      {failed && (
        <div className="matter-row-actions matter-row-actions--shown">
          <button className="matter-action" onClick={onDismiss}>
            Retirer
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Une ligne de cours, et ce qu'on peut lui faire
// ---------------------------------------------------------------------------

type RowMode = 'idle' | 'rename' | 'delete'

function CourseRow({
  course,
  onOpenCourse,
  onMoved,
  onRemoved
}: {
  course: Course
  onOpenCourse: (courseId: string) => void
  onMoved: (moves: CourseMove[]) => void
  onRemoved: (courseIds: string[]) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<RowMode>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      setMode('idle')
    } catch (cause) {
      setError(readableError(cause, 'Opération impossible.'))
    } finally {
      setBusy(false)
    }
  }

  const rename = (title: string): Promise<void> =>
    run(async () => {
      const nextId = await window.noted.course.rename(course.id, title)
      onMoved([{ previousId: course.id, nextId }])
    })

  const remove = (): Promise<void> =>
    run(async () => {
      await window.noted.course.remove(course.id)
      onRemoved([course.id])
    })

  const cancel = (): void => {
    setMode('idle')
    setError(null)
  }

  if (mode === 'rename') {
    return (
      <div className="matter-row matter-row--editing">
        <RenameField
          initial={course.title}
          busy={busy}
          error={error}
          onSubmit={rename}
          onCancel={cancel}
        />
      </div>
    )
  }

  if (mode === 'delete') {
    return (
      <div className="matter-row matter-row--editing">
        <span className="matter-row-danger">Supprimer « {course.title} » ?</span>
        <div className="matter-row-choices">
          <button className="glass-button glass-button--quiet" onClick={cancel}>
            Annuler
          </button>
          <button className="glass-button glass-button--danger" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
        {error && <span className="matter-row-error">{error}</span>}
      </div>
    )
  }

  return (
    <div className="matter-row">
      <button className="matter-row-open" onClick={() => onOpenCourse(course.id)}>
        <span className="matter-format">{formatLabel(course.format)}</span>
        <span className="matter-row-name">{course.title}</span>
      </button>

      <div className="matter-row-actions">
        <button
          className="matter-action"
          onClick={() => setMode('rename')}
          aria-label={`Renommer ${course.title}`}
        >
          Renommer
        </button>
        <button
          className="matter-action matter-action--danger"
          onClick={() => setMode('delete')}
          aria-label={`Supprimer ${course.title}`}
        >
          Supprimer
        </button>
      </div>
    </div>
  )
}

/**
 * Saisie du nouveau nom sur place. Electron desactive `window.prompt`, et une
 * fenetre de dialogue serait disproportionnee pour changer un mot.
 */
function RenameField({
  initial,
  busy,
  error,
  onSubmit,
  onCancel
}: {
  initial: string
  busy: boolean
  error: string | null
  onSubmit: (value: string) => void | Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  return (
    <div className="matter-rename">
      <input
        ref={inputRef}
        className="matter-rename-input"
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && value.trim()) void onSubmit(value)
          if (event.key === 'Escape') onCancel()
        }}
        aria-label="Nouveau nom du cours"
        aria-invalid={Boolean(error)}
      />
      {error ? (
        <span className="matter-row-error">{error}</span>
      ) : (
        <span className="matter-row-hint">entrée pour valider, échap pour annuler</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Les cours les plus recemment ajoutes au vault d'abord, comme sur l'accueil. */
function newestFirst(courses: Course[]): Course[] {
  return [...courses].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
    return a.title.localeCompare(b.title, 'fr')
  })
}

function courseCountLabel(count: number): string {
  if (count === 0) return 'Aucun cours'
  return count === 1 ? '1 cours' : `${count} cours`
}

function formatLabel(format: Course['format']): string {
  return format === 'pdf'
    ? 'PDF'
    : format === 'docx'
      ? 'DOCX'
      : format === 'pptx'
        ? 'PPTX'
        : 'MD'
}
