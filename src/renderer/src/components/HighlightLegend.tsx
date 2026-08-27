import { useEffect, useState } from 'react'
import { HIGHLIGHT_COLORS } from '@shared/types'
import '../styles/legend.css'

/**
 * Legende des codes couleur, appelee depuis le bandeau du panneau du cours.
 *
 * Elle tenait le bas du panneau en permanence. Sur un PDF, ces quelques
 * centimetres manquaient a la lecture pour un rappel dont on n'a besoin qu'au
 * moment de surligner : elle s'ouvre donc a la demande, et se referme des que
 * la souris quitte la zone.
 */
export default function HighlightLegend(): React.JSX.Element {
  const [open, setOpen] = useState(false)

  // La souris n'est pas le seul chemin pour refermer.
  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    // La sortie est ecoutee sur l'ensemble bouton + rectangle : passer de l'un
    // a l'autre ne compte pas comme une sortie, le rectangle etant un
    // descendant du bouton dans l'arbre.
    <div className="legend" onMouseLeave={() => setOpen(false)}>
      <button
        className="icon-button legend-trigger"
        onClick={() => setOpen((shown) => !shown)}
        data-active={open}
        aria-expanded={open}
        title="Le sens des couleurs de surlignage"
      >
        Légende
      </button>

      {open && (
        <div className="legend-pop">
          <ul className="legend-items">
            {HIGHLIGHT_COLORS.map((colour) => (
              <li key={colour.id} className="legend-item">
                <span
                  className="legend-swatch"
                  style={{ background: colour.hex }}
                  aria-hidden="true"
                />
                <span className="legend-text">
                  <span className="legend-label">{colour.label}</span>
                  <span className="legend-meaning">{colour.meaning}</span>
                </span>
                <kbd className="legend-key">{colour.shortcut}</kbd>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
