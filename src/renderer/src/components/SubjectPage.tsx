import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FolderInput, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react'
import type { Course, CourseFormat, CourseMove, Subject } from '@shared/types'
import { readableError } from '../lib/errors'
import { coursePreview, type Preview } from '../lib/preview'
import { detectSubjectTheme } from '../lib/subject-theme'
import type { SubjectHue } from '../lib/subject-tint'
import '../styles/subject-page.css'

interface SubjectPageProps {
  subject: Subject
  /** La teinte de la matiere, la meme que sa carte du tableau de bord. */
  hue: SubjectHue
  onOpenCourse: (courseId: string) => void
  onImported: () => Promise<Subject[]>
  onMoved: (moves: CourseMove[]) => void
  onRemoved: (courseIds: string[]) => void
}

/**
 * Tous les cours d'une matiere, la ou le tableau de bord n'en montre que trois.
 *
 * Une mosaique de cartes : chaque cours montre sa premiere page, en feuille,
 * dans une carte de verre depoli — on reconnait un cours a son visage avant
 * d'avoir lu son titre. On y importe, on y renomme, on y range, on y supprime —
 * deplacer un cours vers une autre matiere reste dans la bibliotheque (⌘K),
 * geste plus rare qui ne merite pas sa place ici.
 *
 * Les cours ranges dans un dossier de la matiere — une serie de seances, un
 * cours d'ecole — forment une mosaique a part, sous le nom du dossier. Une
 * matiere sans dossier ne montre rien de tout cela : elle garde exactement la
 * page qu'elle avait.
 */
export default function SubjectPage({
  subject,
  hue,
  onOpenCourse,
  onImported,
  onMoved,
  onRemoved
}: SubjectPageProps): React.JSX.Element {
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Les dossiers replies. Deplies par defaut : un classement ne cache rien. */
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set())
  /** Vrai quand le champ « Nouveau dossier » de l'en-tete attend un nom. */
  const [naming, setNaming] = useState(false)

  const theme = detectSubjectTheme(subject.name)
  const groups = useMemo(() => groupByFolder(subject.courses), [subject.courses])
  const folders = useMemo(
    () => groups.map((group) => group.folder).filter((name) => name !== null),
    [groups]
  )
  const summary = useMemo(
    () => describe(subject.courses, folders.length),
    [subject.courses, folders.length]
  )

  const toggle = (folder: string): void =>
    setShut((current) => {
      const next = new Set(current)
      if (!next.delete(folder)) next.add(folder)
      return next
    })

  /**
   * `folder` a null depose a la racine de la matiere ; un nom range dans ce
   * dossier, cree s'il manque. Un import abandonne dans le selecteur ne cree
   * donc rien : c'est ce qui evite les dossiers vides.
   */
  const importCourses = async (folder: string | null): Promise<void> => {
    setImporting(true)
    setError(null)
    setNaming(false)
    try {
      await window.noted.vault.importCourses(subject.name, folder)
      await onImported()
    } catch (cause) {
      setError(readableError(cause, "L'import a échoué."))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="matter">
      <div className="matter-inner">
        <header className="matter-head">
          <div className="matter-id">
            <span
              className="matter-badge"
              style={{ '--h': hue.hue } as React.CSSProperties}
              aria-hidden="true"
            >
              {theme.icon}
            </span>
            <div>
              <h1 className="matter-title">{subject.name}</h1>
              <p className="matter-count">{summary}</p>
            </div>
          </div>

          {naming ? (
            // Nommer un dossier et choisir ses cours sont un seul geste : le
            // nom sert de destination a l'import qui suit. Un dossier n'existe
            // donc jamais avant le premier cours qu'on y met.
            <NameField
              label="Nom du nouveau dossier"
              placeholder="Nom du dossier"
              hint="entrée pour choisir les cours à y mettre"
              busy={importing}
              error={null}
              onSubmit={(name) => void importCourses(name)}
              onCancel={() => setNaming(false)}
            />
          ) : (
            <div className="matter-tools">
              <button
                className="glass-button glass-button--quiet"
                disabled={importing}
                onClick={() => setNaming(true)}
                title="Regrouper une série de cours — les séances d’un cours d’école, un thème"
              >
                <FolderPlus aria-hidden="true" />
                Nouveau dossier
              </button>
              <button
                className="glass-button"
                disabled={importing}
                onClick={() => void importCourses(null)}
                title="PDF, Word, PowerPoint, Markdown, HTML"
              >
                {importing ? 'Import…' : 'Importer des cours'}
              </button>
            </div>
          )}
        </header>

        {error && <p className="matter-error">{error}</p>}

        {groups.map(({ folder, courses }) => {
          const closed = folder !== null && shut.has(folder)

          // La racine s'efface quand tout est range ailleurs : un grand cadre
          // vide au-dessus des dossiers ne dirait rien de plus que le bouton
          // « Importer des cours ». Elle revient des qu'un cours l'occupe. Une
          // matiere entierement vide, elle, garde sa tuile : c'est sa seule
          // invitation.
          if (folder === null && courses.length === 0 && folders.length > 0) {
            return null
          }

          return (
            <section className="matter-group" key={folder ?? '·'}>
              {folder !== null && (
                <h2 className="matter-group-head">
                  <button
                    className="matter-group-toggle"
                    aria-expanded={!closed}
                    onClick={() => toggle(folder)}
                  >
                    <ChevronDown aria-hidden="true" data-closed={closed || undefined} />
                    <span className="matter-group-name">{folder}</span>
                    <span className="matter-group-count">{courseCountLabel(courses.length)}</span>
                  </button>
                </h2>
              )}

              {!closed && (
                <div className="matter-grid">
                  {courses.map((course) => (
                    <CourseCard
                      key={course.id}
                      course={course}
                      folders={folders}
                      onOpenCourse={onOpenCourse}
                      onMoved={onMoved}
                      onRemoved={onRemoved}
                    />
                  ))}

                  <button
                    className="matter-add"
                    disabled={importing}
                    onClick={() => void importCourses(folder)}
                  >
                    <Plus aria-hidden="true" />
                    <span>{importing ? 'Import…' : 'Ajouter un cours'}</span>
                  </button>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Ce que l'en-tete dit de la matiere : combien de cours, dans quels formats,
 * et quand le dernier est arrive.
 */
function describe(courses: Course[], folders: number): React.ReactNode {
  if (courses.length === 0) return 'Aucun cours pour l’instant'

  const counts = new Map<string, number>()
  for (const course of courses) {
    const label = formatLabel(course.format)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const formats = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${count} ${label}`)
    .join(' · ')
  const latest = Math.max(...courses.map((course) => course.createdAt))

  return (
    <>
      <b>{courseCountLabel(courses.length)}</b>
      {folders > 0 && ` · ${folders === 1 ? '1 dossier' : `${folders} dossiers`}`} · {formats} ·
      dernier ajout le {formatDay(latest)}
    </>
  )
}

// ---------------------------------------------------------------------------
// La feuille : la premiere page du cours
// ---------------------------------------------------------------------------

/**
 * L'apercu se dessine une fois puis vit dans le cache du vault (lib/preview) :
 * la carte le demande a chaque montage, et le recoit de la memoire de la
 * session ou du disque bien avant qu'un rendu ne soit necessaire.
 */
function usePreview(course: Course): Preview | null {
  const [preview, setPreview] = useState<Preview | null>(null)

  useEffect(() => {
    let cancelled = false
    coursePreview(course).then(
      (result) => {
        if (!cancelled) setPreview(result)
      },
      () => {
        // Pas d'apercu : la feuille reste vide, le cours s'ouvre quand meme.
      }
    )
    return () => {
      cancelled = true
    }
  }, [course])

  return preview
}

function Sheet({
  format,
  preview
}: {
  format: CourseFormat
  preview: Preview | null
}): React.JSX.Element {
  return (
    <span className="matter-sheet">
      {preview ? <img src={preview.url} alt="" /> : <span className="matter-sheet-blank" />}
      <span className="matter-format" data-format={format}>
        {formatLabel(format)}
      </span>
    </span>
  )
}

/** « 46 p. » pour un PDF ; un temps de lecture pour un texte sans pages. */
function sizeLabel(preview: Preview | null): string | null {
  if (!preview) return null
  if (preview.pages !== undefined) return preview.pages === 1 ? '1 p.' : `${preview.pages} p.`
  if (preview.words !== undefined) return `${Math.max(1, Math.round(preview.words / 200))} min`
  return null
}

// ---------------------------------------------------------------------------
// Une carte de cours, et ce qu'on peut lui faire
// ---------------------------------------------------------------------------

type CardMode = 'idle' | 'rename' | 'move' | 'delete'

function CourseCard({
  course,
  folders,
  onOpenCourse,
  onMoved,
  onRemoved
}: {
  course: Course
  /** Les dossiers deja ouverts dans la matiere, destinations possibles. */
  folders: string[]
  onOpenCourse: (courseId: string) => void
  onMoved: (moves: CourseMove[]) => void
  onRemoved: (courseIds: string[]) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<CardMode>('idle')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const preview = usePreview(course)

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

  /**
   * Ranger passe par le main et non par le Finder : c'est lui qui fait suivre
   * la note, les surlignages, les cartes et la memoire, tous ranges ailleurs
   * mais reperes par le chemin du cours.
   */
  const moveTo = (folder: string | null): Promise<void> =>
    run(async () => {
      const nextId = await window.noted.course.move(course.id, course.subject, folder)
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

  const size = sizeLabel(preview)

  return (
    <div className="matter-doc" data-mode={mode}>
      <button
        className="matter-doc-open"
        disabled={mode !== 'idle'}
        onClick={() => onOpenCourse(course.id)}
        aria-label={`Ouvrir ${course.title}`}
      >
        <Sheet format={course.format} preview={preview} />
        {mode === 'idle' && <h3 className="matter-doc-title">{course.title}</h3>}
      </button>

      {mode === 'rename' && (
        <NameField
          initial={course.title}
          label="Nouveau nom du cours"
          hint="entrée pour valider, échap pour annuler"
          busy={busy}
          error={error}
          onSubmit={rename}
          onCancel={cancel}
        />
      )}

      {mode === 'move' && (
        <div className="matter-doc-move">
          {(course.folder !== null || folders.length > 0) && (
            <div className="matter-doc-move-list">
              {course.folder !== null && (
                <button
                  className="matter-doc-move-choice"
                  disabled={busy}
                  onClick={() => void moveTo(null)}
                >
                  Hors dossier
                </button>
              )}
              {folders
                .filter((folder) => folder !== course.folder)
                .map((folder) => (
                  <button
                    key={folder}
                    className="matter-doc-move-choice"
                    disabled={busy}
                    onClick={() => void moveTo(folder)}
                  >
                    {folder}
                  </button>
                ))}
            </div>
          )}
          <NameField
            label="Ranger dans un nouveau dossier"
            placeholder="Nouveau dossier…"
            hint="entrée pour ranger, échap pour annuler"
            busy={busy}
            error={error}
            onSubmit={(name) => void moveTo(name)}
            onCancel={cancel}
          />
        </div>
      )}

      {mode === 'delete' && (
        <div className="matter-doc-confirm">
          <span className="matter-doc-confirm-text">Supprimer « {course.title} » ?</span>
          <div className="matter-doc-confirm-choices">
            <button className="glass-button glass-button--quiet" onClick={cancel}>
              Annuler
            </button>
            <button
              className="glass-button glass-button--danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? 'Suppression…' : 'Supprimer'}
            </button>
          </div>
          {error && <span className="matter-rename-error">{error}</span>}
        </div>
      )}

      {mode === 'idle' && (
        <div className="matter-doc-meta">
          {size && <span>{size}</span>}
          <span>{formatDay(course.createdAt)}</span>
          {course.hasNote && (
            <span className="matter-doc-note" title="Ce cours a des notes" role="img" aria-label="Des notes" />
          )}
          <span className="matter-doc-actions">
            <button
              className="matter-icon"
              onClick={() => setMode('rename')}
              aria-label={`Renommer ${course.title}`}
              title="Renommer"
            >
              <Pencil aria-hidden="true" />
            </button>
            <button
              className="matter-icon"
              onClick={() => setMode('move')}
              aria-label={`Ranger ${course.title} dans un dossier`}
              title="Ranger dans un dossier"
            >
              <FolderInput aria-hidden="true" />
            </button>
            <button
              className="matter-icon matter-icon--danger"
              onClick={() => setMode('delete')}
              aria-label={`Supprimer ${course.title}`}
              title="Supprimer"
            >
              <Trash2 aria-hidden="true" />
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * Saisie d'un nom sur place — celui d'un cours qu'on renomme, celui d'un
 * dossier qu'on ouvre. Electron desactive `window.prompt`, et une fenetre de
 * dialogue serait disproportionnee pour un mot.
 */
function NameField({
  initial = '',
  label,
  placeholder,
  hint,
  busy,
  error,
  onSubmit,
  onCancel
}: {
  initial?: string
  /** Ce que le champ demande, pour qui ne voit pas l'ecran. */
  label: string
  placeholder?: string
  hint: string
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
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && value.trim()) void onSubmit(value)
          if (event.key === 'Escape') onCancel()
        }}
        aria-label={label}
        aria-invalid={Boolean(error)}
      />
      {error ? (
        <span className="matter-rename-error">{error}</span>
      ) : (
        <span className="matter-rename-hint">{hint}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Une mosaique de la page : les cours d'un dossier, ou ceux de la racine. */
interface Group {
  /** null pour les cours poses a la racine de la matiere. */
  folder: string | null
  courses: Course[]
}

/**
 * Repartit les cours d'une matiere entre sa racine et ses dossiers.
 *
 * La racine vient toujours en tete, et toujours — meme vide — pour que la
 * tuile « Ajouter un cours » ait une place ou attendre le premier cours d'une
 * matiere neuve. Les dossiers suivent par ordre alphabetique : leur ordre doit
 * tenir d'une visite a l'autre, la ou les cours se rangent par date d'arrivee.
 */
function groupByFolder(courses: Course[]): Group[] {
  const root: Course[] = []
  const folders = new Map<string, Course[]>()

  for (const course of courses) {
    if (course.folder === null) {
      root.push(course)
      continue
    }
    const known = folders.get(course.folder)
    if (known) known.push(course)
    else folders.set(course.folder, [course])
  }

  return [
    { folder: null, courses: newestFirst(root) },
    ...[...folders]
      .sort((a, b) => a[0].localeCompare(b[0], 'fr'))
      .map(([folder, list]) => ({ folder, courses: newestFirst(list) }))
  ]
}

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

/** « 30 août », et l'annee seulement quand ce n'est pas celle en cours. */
function formatDay(ms: number): string {
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(date)
}

function formatLabel(format: CourseFormat): string {
  return format === 'pdf'
    ? 'PDF'
    : format === 'docx'
      ? 'DOCX'
      : format === 'pptx'
        ? 'PPTX'
        : format === 'html'
          ? 'HTML'
          : 'MD'
}
