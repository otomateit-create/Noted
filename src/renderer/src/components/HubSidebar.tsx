import { Brain, GraduationCap, Layers, Settings } from 'lucide-react'
import '../styles/hub.css'

/** Les ecrans d'accueil : tout ce qui n'est ni l'espace de travail ni une matiere. */
export type HubView = 'dashboard' | 'flashcards' | 'memoire' | 'reglages'

interface HubSidebarProps {
  /** Nul depuis l'espace de travail : aucune des trois zones n'y est active. */
  current: HubView | null
  onNavigate: (view: HubView) => void
}

const ITEMS: ReadonlyArray<{ view: HubView; label: string; icon: React.ReactNode }> = [
  { view: 'dashboard', label: 'Matières', icon: <GraduationCap aria-hidden="true" /> },
  { view: 'flashcards', label: 'Flashcards', icon: <Layers aria-hidden="true" /> },
  { view: 'memoire', label: 'Mémoire', icon: <Brain aria-hidden="true" /> }
]

/**
 * Barre laterale de l'accueil : les grandes zones de l'application, pas la
 * navigation fine — celle-ci reste a ⌘K. Elle n'existe que sur la coque ;
 * l'espace de travail garde tout l'ecran pour le cours et les notes.
 */
export default function HubSidebar({ current, onNavigate }: HubSidebarProps): React.JSX.Element {
  return (
    <nav className="hub-sidebar" aria-label="Sections de l'application">
      {ITEMS.map((item) => (
        <button
          key={item.view}
          className="hub-item"
          data-active={item.view === current}
          onClick={() => onNavigate(item.view)}
          aria-current={item.view === current ? 'page' : undefined}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}

      {/* Detache en bas : les parametres ne sont pas une zone de travail, on
          n'y va que pour regler quelque chose et on en repart. */}
      <button
        className="hub-item hub-item-foot"
        data-active={current === 'reglages'}
        onClick={() => onNavigate('reglages')}
        aria-current={current === 'reglages' ? 'page' : undefined}
        title="Paramètres"
      >
        <Settings aria-hidden="true" />
        <span>Paramètres</span>
      </button>
    </nav>
  )
}
