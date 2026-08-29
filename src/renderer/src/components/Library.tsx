import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Course,
  CourseMove,
  PendingConversion,
  PhotoProposal,
  Subject
} from '@shared/types'
import PhotoOrder from './PhotoOrder'
import SubjectCreator from './SubjectCreator'
import { readableError } from '../lib/errors'
import '../styles/library.css'

interface LibraryProps {
  subjects: Subject[]
  currentId: string | null
  onSelect: (courseId: string) => void
  onClose: () => void
  onImported: () => Promise<Subject[]>
  /** Des cours ont change d'identifiant : l'application doit les suivre. */
  onMoved: (moves: CourseMove[]) => void
  /** Des cours ont disparu du vault. */
  onRemoved: (courseIds: string[]) => void
}

/**
 * Selecteur de cours, ouvert par ⌘K.
 *
 * Une palette plutot qu'un quatrieme panneau : sur un ecran deja partage en
 * trois, une colonne permanente de navigation couterait de la place a chaque
 * instant pour un geste qu'on fait quelques fois par session.
 *
 * C'est aussi d'ici qu'on renomme, deplace et supprime — le seul endroit ou
 * tous les cours sont deja sous les yeux.
 */
export default function Library({
  subjects,
  currentId,
  onSelect,
  onClose,
  onImported,
  onMoved,
  onRemoved
}: LibraryProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  /** Cours dont le menu de gestion est ouvert. Tant qu'il l'est, Entree n'ouvre plus. */
  const [managed, setManaged] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const matches = useMemo(() => {
    const all = subjects.flatMap((subject) => subject.courses)
    const needle = query.trim().toLowerCase()
    if (!needle) return all

    // La recherche porte sur la matiere autant que sur le titre : « private »
    // doit ramener toute la matiere.
    return all.filter((course) =>
      `${course.subject} ${course.title}`.toLowerCase().includes(needle)
    )
  }, [subjects, query])

  useEffect(() => {
    setHighlighted(0)
  }, [query])

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      // Une gestion en cours se referme d'abord : Echap defait le dernier geste,
      // il ne ferme pas tout d'un coup.
      if (proposal) setProposal(null)
      else if (managed) setManaged(null)
      else onClose()
    }
    if (managed || proposal) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((index) => Math.min(matches.length - 1, index + 1))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((index) => Math.max(0, index - 1))
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const course = matches[highlighted]
      if (course) onSelect(course.id)
    }
  }

  /**
   * Les cours en train d'etre fabriques a partir de photos. Ils n'existent pas
   * encore comme fichiers : ils s'affichent en tete de liste, avec leur
   * avancement, et deviennent des cours ordinaires une fois lus.
   */
  const [pending, setPending] = useState<PendingConversion[]>([])

  /**
   * L'ordre propose pour des photos qu'on vient de choisir, tant qu'il n'est pas
   * accepte. Rien n'a encore ete ecrit : abandonner ne laisse aucune trace.
   */
  const [proposal, setProposal] = useState<PhotoProposal | null>(null)

  useEffect(() => {
    const load = (): void => {
      void window.noted.ocr.pending().then(setPending)
    }
    load()

    const stop = window.noted.ocr.onPendingChanged(() => {
      load()
      // Une fabrication qui s'acheve fait apparaitre un vrai cours : la
      // bibliotheque doit le voir sans qu'on la rouvre.
      void onImported()
    })
    return stop
  }, [onImported])

  const importInto = async (subject: string): Promise<void> => {
    const { imported, photos } = await window.noted.vault.importCourses(subject)
    const refreshed = await onImported()
    const first = imported[0]

    // Les images d'abord, quand il y en a : elles demandent un accord, et
    // ouvrir un document par-dessus la question la ferait manquer.
    if (photos) {
      setProposal(photos)
      return
    }

    // Ouvrir directement le premier document importe : c'est ce qu'on veut
    // faire juste apres l'avoir ajoute.
    if (first && refreshed.some((entry) => entry.courses.some((c) => c.id === first))) {
      onSelect(first)
    }
  }

  /**
   * On cree une matiere pour y mettre quelque chose : le selecteur de fichiers
   * s'ouvre dans la foulee. Le rafraichissement precede l'import pour que la
   * nouvelle matiere apparaisse meme si l'utilisateur annule la selection.
   */
  const createAndImport = async (subject: string): Promise<void> => {
    await onImported()
    await importInto(subject)
  }

  return (
    <div className="library-backdrop" onPointerDown={onClose}>
      <div
        className="library"
        role="dialog"
        aria-label="Bibliothèque de cours"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {proposal ? (
          <PhotoOrder
            proposal={proposal}
            onCancel={() => setProposal(null)}
            onConfirm={() => {
              void window.noted.ocr.importPhotos(proposal)
              setProposal(null)
            }}
          />
        ) : (
          <>
        <div className="library-search">
          <input
            ref={inputRef}
            className="library-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Chercher un cours ou une matière…"
            aria-label="Chercher un cours"
          />
          <kbd className="library-escape">esc</kbd>
        </div>

        <div className="library-results">
          {matches.length === 0 && (
            <p className="library-empty">
              {query ? 'Aucun cours ne correspond.' : 'Aucun cours dans le vault.'}
            </p>
          )}

          {pending.map((entry) => (
            <PendingRow
              key={entry.id}
              entry={entry}
              onDismiss={() => void window.noted.ocr.dismiss(entry.id)}
            />
          ))}

          {matches.map((course, index) => (
            <CourseRow
              key={course.id}
              course={course}
              subjects={subjects}
              active={index === highlighted}
              current={course.id === currentId}
              managed={managed === course.id}
              onManage={(open) => setManaged(open ? course.id : null)}
              onHover={() => !managed && setHighlighted(index)}
              onSelect={() => onSelect(course.id)}
              onMoved={onMoved}
              onRemoved={onRemoved}
            />
          ))}
        </div>

        <footer className="library-footer">
          <span className="library-footer-label">Ajouter dans</span>
          <div className="library-import">
            {subjects.map((subject) => (
              <SubjectChip
                key={subject.name}
                subject={subject}
                onImport={() => void importInto(subject.name)}
                onMoved={onMoved}
                onRemoved={onRemoved}
              />
            ))}
            <SubjectCreator
              triggerClassName="library-import-button library-import-button--new"
              onCreated={createAndImport}
            />
          </div>
        </footer>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Une ligne de cours, et ce qu'on peut lui faire
// ---------------------------------------------------------------------------

type RowMode = 'closed' | 'menu' | 'rename' | 'move' | 'delete'

function CourseRow({
  course,
  subjects,
  active,
  current,
  managed,
  onManage,
  onHover,
  onSelect,
  onMoved,
  onRemoved
}: {
  course: Course
  subjects: Subject[]
  active: boolean
  current: boolean
  managed: boolean
  onManage: (open: boolean) => void
  onHover: () => void
  onSelect: () => void
  onMoved: (moves: CourseMove[]) => void
  onRemoved: (courseIds: string[]) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<RowMode>('closed')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // La ligne se referme quand une autre prend la main : deux menus ouverts en
  // meme temps donneraient a croire que le geste s'appliquera aux deux.
  useEffect(() => {
    if (!managed) {
      setMode('closed')
      setError(null)
    }
  }, [managed])

  const open = (next: RowMode): void => {
    setError(null)
    setMode(next)
    onManage(next !== 'closed')
  }

  /** Enveloppe commune : occupee pendant l'operation, erreur affichee sinon. */
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      setMode('closed')
      onManage(false)
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

  const move = (subject: string): Promise<void> =>
    run(async () => {
      const nextId = await window.noted.course.move(course.id, subject)
      onMoved([{ previousId: course.id, nextId }])
    })

  const remove = (): Promise<void> =>
    run(async () => {
      await window.noted.course.remove(course.id)
      onRemoved([course.id])
    })

  if (mode === 'rename') {
    return (
      <div className="library-row library-row--editing">
        <span className="library-row-subject">{course.subject}</span>
        <InlineName
          initial={course.title}
          busy={busy}
          error={error}
          label="Nouveau nom du cours"
          onSubmit={rename}
          onCancel={() => open('closed')}
        />
      </div>
    )
  }

  if (mode === 'move') {
    const others = subjects.filter((subject) => subject.name !== course.subject)

    return (
      <div className="library-row library-row--editing">
        <span className="library-row-subject">Déplacer vers</span>
        <div className="library-row-choices">
          {others.length === 0 && <span className="library-row-note">Aucune autre matière.</span>}
          {others.map((subject) => (
            <button
              key={subject.name}
              className="library-import-button"
              disabled={busy}
              onClick={() => void move(subject.name)}
            >
              {subject.name}
            </button>
          ))}
          <button className="library-row-cancel" onClick={() => open('closed')}>
            Annuler
          </button>
        </div>
        {error && <span className="library-row-error">{error}</span>}
      </div>
    )
  }

  if (mode === 'delete') {
    return (
      <div className="library-row library-row--editing">
        <span className="library-row-danger">Supprimer ?</span>
        <span className="library-row-note">
          « {course.title} » et sa note partent à la corbeille. Tu pourras les y reprendre.
        </span>
        <div className="library-row-choices">
          <button className="library-row-cancel" onClick={() => open('closed')}>
            Annuler
          </button>
          <button className="library-row-confirm" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Suppression…' : 'Supprimer'}
          </button>
        </div>
        {error && <span className="library-row-error">{error}</span>}
      </div>
    )
  }

  return (
    <div
      className="library-row"
      data-active={active}
      data-current={current}
      data-menu={mode === 'menu'}
      onPointerEnter={onHover}
    >
      <button className="library-row-open" onClick={onSelect}>
        <span className="library-row-subject">{course.subject}</span>
        <span className="library-row-title">{course.title}</span>
        <span className="library-row-meta">
          {course.format === 'pdf'
            ? 'PDF'
            : course.format === 'docx'
              ? 'DOCX'
              : course.format === 'pptx'
                ? 'PPTX'
                : course.format === 'html'
                  ? 'HTML'
                  : 'MD'}
        </span>
      </button>

      {mode === 'menu' ? (
        <div className="library-row-choices">
          <button className="library-row-action" onClick={() => open('rename')}>
            Renommer
          </button>
          <button className="library-row-action" onClick={() => open('move')}>
            Déplacer
          </button>
          <button className="library-row-action library-row-action--danger" onClick={() => open('delete')}>
            Supprimer
          </button>
          <button className="library-row-cancel" onClick={() => open('closed')}>
            ✕
          </button>
        </div>
      ) : (
        <button
          className="library-row-more"
          onClick={() => open('menu')}
          title="Renommer, déplacer ou supprimer"
          aria-label={`Gérer ${course.title}`}
        >
          ⋯
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Une matiere du pied de page, et ce qu'on peut lui faire
// ---------------------------------------------------------------------------

function SubjectChip({
  subject,
  onImport,
  onMoved,
  onRemoved
}: {
  subject: Subject
  onImport: () => void
  onMoved: (moves: CourseMove[]) => void
  onRemoved: (courseIds: string[]) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<RowMode>('closed')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Meme convention que les menus de la barre de notes : un clic ailleurs ou
  // Echap referme, sans avoir a viser une croix.
  useEffect(() => {
    if (mode === 'closed') return

    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setMode('closed')
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [mode])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      setMode('closed')
    } catch (cause) {
      setError(readableError(cause, 'Opération impossible.'))
    } finally {
      setBusy(false)
    }
  }

  const rename = (title: string): Promise<void> =>
    run(async () => {
      const result = await window.noted.vault.renameSubject(subject.name, title)
      onMoved(result.moved)
    })

  const remove = (): Promise<void> =>
    run(async () => {
      await window.noted.vault.deleteSubject(subject.name)
      onRemoved(subject.courses.map((course) => course.id))
    })

  if (mode === 'rename') {
    return (
      <div className="library-chip" ref={ref}>
        <InlineName
          initial={subject.name}
          busy={busy}
          error={error}
          label="Nouveau nom de la matière"
          onSubmit={rename}
          onCancel={() => setMode('closed')}
        />
      </div>
    )
  }

  return (
    <div className="library-chip" ref={ref}>
      <button className="library-import-button" onClick={onImport} title={`Ajouter dans ${subject.name}`}>
        {subject.name}
      </button>
      <button
        className="library-chip-more"
        onClick={() => {
          setError(null)
          setMode((value) => (value === 'menu' ? 'closed' : 'menu'))
        }}
        title={`Renommer ou supprimer ${subject.name}`}
        aria-label={`Gérer la matière ${subject.name}`}
      >
        ⋯
      </button>

      {mode === 'menu' && (
        <div className="tool-popover library-chip-menu">
          <button className="tool-popover-item" onClick={() => setMode('rename')}>
            Renommer
          </button>
          <button
            className="tool-popover-item tool-popover-item--danger"
            onClick={() => setMode('delete')}
          >
            Supprimer
          </button>
        </div>
      )}

      {mode === 'delete' && (
        <div className="tool-popover library-chip-menu library-chip-menu--wide">
          <p className="library-chip-warning">{subjectWarning(subject)}</p>
          {error && <span className="library-row-error">{error}</span>}
          <div className="library-row-choices">
            <button className="library-row-cancel" onClick={() => setMode('closed')}>
              Annuler
            </button>
            <button className="library-row-confirm" disabled={busy} onClick={() => void remove()}>
              {busy ? 'Suppression…' : 'Supprimer'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Ce qu'on s'apprete a perdre, dit sans ambiguite ni faute d'accord. */
function subjectWarning(subject: Subject): string {
  const count = subject.courses.length

  if (count === 0) {
    return `« ${subject.name} » part à la corbeille. Cette matière ne contient aucun cours.`
  }
  if (count === 1) {
    return `« ${subject.name} » et son cours, note comprise, partent à la corbeille.`
  }
  return `« ${subject.name} » et ses ${count} cours, notes comprises, partent à la corbeille.`
}

/**
 * Saisie d'un nom sur place, comme pour la creation d'une matiere : Entree
 * valide, Echap annule. Electron desactive `window.prompt`, et une fenetre de
 * dialogue serait disproportionnee pour changer un mot.
 */
function InlineName({
  initial,
  busy,
  error,
  label,
  onSubmit,
  onCancel
}: {
  initial: string
  busy: boolean
  error: string | null
  label: string
  onSubmit: (value: string) => void | Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  return (
    <div className="library-inline">
      <input
        ref={inputRef}
        className="library-inline-input"
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // La palette ecoute aussi Entree et Echap : sans cela, Echap fermerait
          // toute la fenetre au lieu du seul champ.
          event.stopPropagation()
          if (event.key === 'Enter' && value.trim()) void onSubmit(value)
          if (event.key === 'Escape') onCancel()
        }}
        aria-label={label}
        aria-invalid={Boolean(error)}
      />
      {error ? (
        <span className="library-row-error">{error}</span>
      ) : (
        <span className="library-row-note">Entrée pour valider, échap pour annuler</span>
      )}
    </div>
  )
}


/**
 * Un cours en train d'etre fabrique a partir de photos.
 *
 * Il occupe une ligne comme un cours ordinaire — c'est bien un cours qui
 * arrive — mais il ne s'ouvre pas : il n'existe pas encore. La ligne dit ou en
 * est la lecture, et disparait d'elle-meme quand le cours devient reel.
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
    <div className="library-row library-row--pending" data-failed={failed}>
      <div className="library-row-main">
        <span className="library-row-title">{entry.title}</span>
        <span className="library-row-meta">
          {entry.subject}
          {' · '}
          {failed
            ? entry.failed
            : `lecture des photos — ${entry.done} sur ${entry.total}`}
        </span>
      </div>

      {failed ? (
        <button className="library-row-cancel" onClick={onDismiss} title="Retirer cette ligne">
          Retirer
        </button>
      ) : (
        <span className="ocr-spinner" aria-hidden="true" />
      )}
    </div>
  )
}
