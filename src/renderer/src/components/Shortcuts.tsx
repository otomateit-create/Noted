import { useEffect } from 'react'
import '../styles/shortcuts.css'

interface ShortcutsProps {
  onClose: () => void
}

interface Group {
  title: string
  entries: Array<{ keys: string; label: string }>
}

/**
 * Ce que l'application sait faire au clavier. La liste n'est pas engendree
 * depuis le code : un raccourci se declare la ou il agit, et vouloir les
 * rassembler automatiquement obligerait a faire remonter chacun jusqu'ici pour
 * un gain nul. Le prix a payer est de tenir cette table a jour.
 */
const GROUPS: Group[] = [
  {
    title: 'Se déplacer',
    entries: [
      { keys: '⌘K', label: 'Bibliothèque : chercher et ouvrir un cours' },
      { keys: '⌘[ / ⌘]', label: 'Page précédente / suivante' },
      { keys: '⌘F', label: 'Chercher dans le cours ouvert' },
      { keys: '⏎ / ⇧⏎', label: 'Occurrence suivante / précédente' },
      { keys: '⌘J', label: "Afficher ou masquer l'assistant" },
      { keys: '⌘1 / ⌘2 / ⌘3', label: 'Cours, notes ou assistant en grand' },
      { keys: '⌘/', label: 'Cette liste' }
    ]
  },
  {
    title: 'Travailler le cours',
    entries: [
      { keys: 'Pincer', label: 'Grossir ou réduire le document' },
      { keys: '1 … 5', label: 'Surligner le passage sélectionné' },
      { keys: 'esc', label: 'Renoncer au surlignage' }
    ]
  },
  {
    title: 'Écrire',
    entries: [
      { keys: '⌘S', label: 'Enregistrer maintenant (sinon automatique)' },
      { keys: '⌘B / ⌘I / ⌘U', label: 'Gras / italique / souligné' },
      { keys: '$…$', label: 'Formule dans le texte' },
      { keys: '$$…$$', label: 'Formule centrée' }
    ]
  },
  {
    title: "Parler à l'assistant",
    entries: [
      { keys: '⏎', label: 'Envoyer le message' },
      { keys: '⇧⏎', label: 'Passer à la ligne sans envoyer' }
    ]
  }
]

export default function Shortcuts({ onClose }: ShortcutsProps): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="library-backdrop" onPointerDown={onClose}>
      <div
        className="shortcuts"
        role="dialog"
        aria-label="Raccourcis clavier"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="shortcuts-head">
          <span className="shortcuts-title">Raccourcis</span>
          <kbd className="library-escape">esc</kbd>
        </header>

        <div className="shortcuts-body">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcuts-group">
              <h2 className="shortcuts-group-title">{group.title}</h2>
              {group.entries.map((entry) => (
                <div key={entry.keys} className="shortcuts-row">
                  <kbd className="shortcuts-keys">{entry.keys}</kbd>
                  <span className="shortcuts-label">{entry.label}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
