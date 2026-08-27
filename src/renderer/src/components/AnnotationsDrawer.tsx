import { useMemo, useState } from 'react'
import { HIGHLIGHT_COLORS, type Annotation, type HighlightColorId } from '@shared/types'

interface AnnotationsDrawerProps {
  annotations: Annotation[]
  onGoTo: (annotation: Annotation) => void
  onRemove: (id: string) => void
  onClose: () => void
}

/** Ou se trouve un passage : une page pour un PDF, un titre sinon. */
function anchorOf(annotation: Annotation): string {
  if (annotation.page !== null) return `p. ${annotation.page}`
  return annotation.heading ?? '—'
}

/**
 * Tout ce qui a ete surligne dans le cours, dans l'ordre du document.
 *
 * Le tiroir vit dans le panneau du cours, sous la barre de recherche : il
 * indexe ce document-la, il reste donc contre lui, et il ne coute aucune
 * largeur tant qu'il est ferme. C'est la meme place que prend ⌘F, pour la meme
 * raison — on y revient en levant les yeux, sans quitter le passage qu'on lit.
 */
export default function AnnotationsDrawer({
  annotations,
  onGoTo,
  onRemove,
  onClose
}: AnnotationsDrawerProps): React.JSX.Element {
  const [filter, setFilter] = useState<HighlightColorId | null>(null)

  const counts = useMemo(() => {
    const tally = new Map<HighlightColorId, number>()
    for (const annotation of annotations) {
      tally.set(annotation.colour, (tally.get(annotation.colour) ?? 0) + 1)
    }
    return tally
  }, [annotations])

  const shown = useMemo(() => {
    const kept = filter ? annotations.filter((entry) => entry.colour === filter) : annotations
    // L'ordre du document, pas celui du surlignage : c'est ainsi qu'on relit.
    return [...kept].sort(
      (a, b) => (a.page ?? 0) - (b.page ?? 0) || a.createdAt.localeCompare(b.createdAt)
    )
  }, [annotations, filter])

  return (
    <div className="drawer">
      <div className="drawer-bar">
        <span className="drawer-title">
          {annotations.length === 1 ? '1 surlignage' : `${annotations.length} surlignages`}
        </span>

        <div className="drawer-filters">
          {HIGHLIGHT_COLORS.map((colour) => {
            const count = counts.get(colour.id) ?? 0
            return (
              <button
                key={colour.id}
                className="drawer-filter"
                data-active={filter === colour.id}
                disabled={count === 0}
                onClick={() => setFilter((current) => (current === colour.id ? null : colour.id))}
                title={`${colour.label} — ${colour.meaning}`}
              >
                <span
                  className="drawer-filter-dot"
                  style={{ background: colour.hex }}
                  aria-hidden="true"
                />
                {count}
              </button>
            )
          })}
        </div>

        <button className="icon-button" onClick={onClose} title="Fermer la liste">
          ✕
        </button>
      </div>

      <div className="drawer-list">
        {shown.length === 0 ? (
          <p className="drawer-empty">
            {annotations.length === 0
              ? 'Sélectionne un passage du cours, puis choisis une couleur — ou tape 1 à 5.'
              : 'Aucun surlignage de cette couleur.'}
          </p>
        ) : (
          shown.map((annotation) => (
            <div key={annotation.id} className="drawer-entry">
              <button className="drawer-entry-main" onClick={() => onGoTo(annotation)}>
                <span className="drawer-entry-head">
                  <span
                    className="drawer-filter-dot"
                    style={{ background: colourOf(annotation.colour) }}
                    aria-hidden="true"
                  />
                  <span className="drawer-entry-anchor">{anchorOf(annotation)}</span>
                </span>
                <span className="drawer-entry-text">{annotation.text}</span>
                {annotation.comment && (
                  <span className="drawer-entry-comment">{annotation.comment}</span>
                )}
              </button>

              <button
                className="icon-button drawer-entry-remove"
                onClick={() => onRemove(annotation.id)}
                title="Retirer ce surlignage"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function colourOf(id: HighlightColorId): string {
  return HIGHLIGHT_COLORS.find((colour) => colour.id === id)?.hex ?? 'currentColor'
}
