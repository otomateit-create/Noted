interface PanelLabelProps {
  label: string
  /** Le raccourci qui fait la meme chose, rappele dans l'infobulle. */
  shortcut: string
  expanded: boolean
  onToggle: () => void
}

/**
 * Le nom du panneau, qui sert aussi a l'agrandir.
 *
 * Un mode concentration qui ne s'atteint qu'au clavier ne s'atteint jamais :
 * personne ne devine ⌘1. Plutot que d'ajouter un bouton dans une barre deja
 * chargee, c'est l'etiquette du panneau qui devient cliquable — elle est deja
 * la, elle nomme deja la zone, et elle est exactement a l'endroit ou l'on
 * regarde pour savoir ou l'on est.
 */
export default function PanelLabel({
  label,
  shortcut,
  expanded,
  onToggle
}: PanelLabelProps): React.JSX.Element {
  return (
    <button
      className="panel-label"
      onClick={onToggle}
      data-expanded={expanded}
      title={
        expanded
          ? `Revenir aux trois panneaux (${shortcut})`
          : `N'afficher que ce panneau (${shortcut})`
      }
    >
      {label}
    </button>
  )
}
