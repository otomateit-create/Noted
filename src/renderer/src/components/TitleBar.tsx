import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ClaudeStatus, Course, Subject } from '@shared/types'
import type { SaveState } from './NotesPanel'
import type { Panneaux } from '../lib/layout'
import CourseNav from './CourseNav'
import '../styles/titlebar.css'

interface TitleBarProps {
  course: Course | null
  /** Matiere affichee (page de matiere), quand aucun cours n'est ouvert. */
  subjectLabel: string | null
  /** Toutes les matieres, pour le navigateur de cours. */
  subjects: Subject[]
  status: ClaudeStatus | null
  /** Lesquelles des trois sections sont a l'ecran. */
  panneaux: Panneaux
  saveState: SaveState
  onSave: () => void
  onTogglePanneau: (panel: keyof Panneaux) => void
  onOpenCourse: (id: string) => void
  onShortcuts: () => void
  onHome: () => void
  onBack: () => void
  onForward: () => void
  canGoBack: boolean
  canGoForward: boolean
}

export default function TitleBar({
  course,
  subjectLabel,
  subjects,
  status,
  panneaux,
  saveState,
  onSave,
  onTogglePanneau,
  onOpenCourse,
  onShortcuts,
  onHome,
  onBack,
  onForward,
  canGoBack,
  canGoForward
}: TitleBarProps): React.JSX.Element {
  return (
    <header className="titlebar">
      {/* Reserve la place des boutons de fenetre macOS. */}
      <div className="titlebar-gutter" />

      <button className="titlebar-brand" onClick={onHome} title="Retour à l'accueil">
        <span className="titlebar-brand-mark">Noted</span>
        {subjectLabel && (
          <>
            <span className="breadcrumb-separator">›</span>
            <span className="titlebar-brand-subject">{subjectLabel}</span>
          </>
        )}
      </button>

      <div className="titlebar-nav">
        <button
          className="icon-button"
          onClick={onBack}
          disabled={!canGoBack}
          title="Page précédente (⌘[)"
          aria-label="Page précédente"
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        <button
          className="icon-button"
          onClick={onForward}
          disabled={!canGoForward}
          title="Page suivante (⌘])"
          aria-label="Page suivante"
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>

      {course && <CourseNav course={course} subjects={subjects} onOpenCourse={onOpenCourse} />}

      {/* Contre le fil d'Ariane et non dans le groupe de droite : le bouton
          agit sur la note du cours nomme juste a cote. */}
      {course && <SaveButton state={saveState} onSave={onSave} />}

      {course && <PanelSwitch panneaux={panneaux} onToggle={onTogglePanneau} />}

      <div className="titlebar-actions">
        <ClaudeIndicator status={status} />

        <button className="icon-button" onClick={openVault} title="Ouvrir le dossier Noted">
          Dossier
        </button>

        <button className="icon-button" onClick={onShortcuts} title="Raccourcis clavier (⌘/)">
          ?
        </button>
      </div>
    </header>
  )
}

/** Les trois sections, dans l'ordre ou elles se suivent a l'ecran. */
const SECTIONS: Array<{ id: keyof Panneaux; label: string; shortcut: string }> = [
  { id: 'course', label: 'Cours', shortcut: '⌘1' },
  { id: 'notes', label: 'Notes', shortcut: '⌘2' },
  { id: 'chat', label: 'Assistant', shortcut: '⌘3' }
]

/**
 * Les trois sections de l'espace de travail, allumees ou eteintes d'un clic.
 *
 * Un seul bloc de trois plutot que trois boutons separes : ils commandent la
 * meme chose et se lisent ensemble — le dessin dit qu'on compose une
 * disposition, pas qu'on declenche trois actions sans rapport. C'est aussi ce
 * qui rend lisible d'un coup d'oeil ce qui est a l'ecran et ce qui n'y est pas,
 * la ou l'ancien bouton « Assistant », seul dans le groupe de droite, ne disait
 * rien des deux autres.
 *
 * La derniere allumee reste allumee — le clic est sans effet plutot que grise :
 * un bouton desactive dirait « indisponible » la ou il s'agit d'une evidence,
 * et il le dirait sur celui qu'on vient justement de choisir.
 */
function PanelSwitch({
  panneaux,
  onToggle
}: {
  panneaux: Panneaux
  onToggle: (panel: keyof Panneaux) => void
}): React.JSX.Element {
  const seule = SECTIONS.filter((section) => panneaux[section.id]).length === 1

  return (
    <div className="titlebar-panels" role="group" aria-label="Sections affichées">
      {SECTIONS.map((section) => {
        const active = panneaux[section.id]
        const derniere = active && seule

        return (
          <button
            key={section.id}
            className="titlebar-panel"
            data-active={active}
            onClick={() => onToggle(section.id)}
            title={
              derniere
                ? `${section.label} — seule section affichée`
                : active
                  ? `Masquer ${section.label.toLowerCase()} (${section.shortcut} pour l'agrandir)`
                  : `Afficher ${section.label.toLowerCase()} (${section.shortcut} pour l'agrandir)`
            }
            aria-pressed={active}
          >
            {section.label}
          </button>
        )
      })}
    </div>
  )
}

/** Le dossier du vault, revele dans le Finder. */
function openVault(): void {
  void window.noted.vault.paths().then((paths) => window.noted.vault.reveal(paths.root))
}

/**
 * Enregistrer a la souris, pour qui ne connait pas ⌘S.
 *
 * Un carre a la disquette, comme partout ailleurs : le geste est assez connu
 * pour se passer de mot, et la barre de titre y gagne la place. L'etat n'est
 * plus porte par un libelle mais par la couleur du trait — laiton pendant
 * l'ecriture, rouge en cas d'echec — et le detail reste lisible dans
 * l'indicateur du panneau des notes.
 */
function SaveButton({
  state,
  onSave
}: {
  state: SaveState
  onSave: () => void
}): React.JSX.Element {
  /**
   * Nombre de clics, pour afficher un accuse de reception passager. Un booleen
   * ne relancerait pas le minuteur au deuxieme clic, et le second geste
   * paraitrait ignore.
   */
  const [clicked, setClicked] = useState(0)

  useEffect(() => {
    if (clicked === 0) return
    const timer = setTimeout(() => setClicked(0), 1400)
    return () => clearTimeout(timer)
  }, [clicked])

  // L'echec prime sur l'accuse de reception : mieux vaut un bouton qui se
  // dedit qu'un bouton qui rassure a tort.
  const title =
    state === 'error'
      ? "Échec de l'enregistrement — réessayer (⌘S)"
      : 'Enregistrer la note (⌘S)'

  return (
    <button
      className="save-button"
      data-state={state}
      data-confirmed={clicked > 0 && state !== 'error'}
      onClick={() => {
        onSave()
        setClicked((tick) => tick + 1)
      }}
      title={title}
      aria-label={title}
    >
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Le corps, coin superieur droit coupe comme sur une disquette. */}
        <path d="M2.65 2h8.05L14 5.3v8.05a.65.65 0 0 1-.65.65H2.65A.65.65 0 0 1 2 13.35V2.65A.65.65 0 0 1 2.65 2Z" />
        {/* Le volet metallique, puis l'etiquette. */}
        <path d="M5 2v3.5h5V2" />
        <path d="M4.5 9.5h7V14h-7z" />
      </svg>
    </button>
  )
}

function ClaudeIndicator({ status }: { status: ClaudeStatus | null }): React.JSX.Element {
  const state = !status ? 'pending' : status.ready ? 'ready' : 'error'
  const label = status?.detail ?? 'Vérification de la connexion…'

  return (
    <div className="claude-indicator" data-state={state} title={label}>
      <span className="claude-dot" />
      <span className="claude-label">
        {state === 'ready' ? 'Claude' : state === 'pending' ? '…' : 'Hors ligne'}
      </span>
    </div>
  )
}
