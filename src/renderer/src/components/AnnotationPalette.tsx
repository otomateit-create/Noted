import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HIGHLIGHT_COLORS, type Annotation, type HighlightColorId } from '@shared/types'

interface AnnotationPaletteProps {
  /** Ou pointer, en coordonnees de fenetre : le milieu haut de la selection. */
  anchor: { x: number; y: number }
  /** Le surlignage vise, ou null quand il s'agit d'une selection pas encore posee. */
  annotation: Annotation | null
  onPick: (colour: HighlightColorId) => void
  onComment: (comment: string) => void
  onRemove: () => void
  onExplain: () => void
  onClose: () => void
}

/** Distance entre la selection et la palette, pour ne pas couvrir le texte vise. */
const GAP = 10

/**
 * La palette qui apparait sur une selection.
 *
 * Elle sort la ou l'oeil est deja — au-dessus du passage qu'on vient de
 * selectionner — plutot que dans une barre d'outils qu'il faudrait aller
 * chercher. Les cinq couleurs sont dans l'ordre de leurs raccourcis, si bien
 * que la palette apprend les touches a qui ne les connait pas encore.
 */
export default function AnnotationPalette({
  anchor,
  annotation,
  onPick,
  onComment,
  onRemove,
  onExplain,
  onClose
}: AnnotationPaletteProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState(annotation?.comment ?? '')
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)

  // Le passage change sans que la palette soit demontee : le brouillon suit.
  useEffect(() => {
    setDraft(annotation?.comment ?? '')
    setWriting(Boolean(annotation?.comment))
  }, [annotation])

  useEffect(() => {
    if (writing) inputRef.current?.focus()
  }, [writing])

  /**
   * Placee apres la mesure, jamais avant : une palette posee puis corrigee
   * saute a l'oeil, et sa largeur depend de ce qu'elle contient — la version
   * avec note ancree est plus haute que la version nue.
   */
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const box = element.getBoundingClientRect()
    const left = Math.min(
      Math.max(GAP, anchor.x - box.width / 2),
      window.innerWidth - box.width - GAP
    )
    // Au-dessus de la selection, sauf tout en haut de la fenetre ou il n'y a
    // plus de place : la palette passe alors dessous.
    const above = anchor.y - box.height - GAP
    setPlaced({ left, top: above < GAP ? anchor.y + GAP * 3 : above })
  }, [anchor, writing, annotation])

  const submitComment = (): void => {
    onComment(draft.trim())
    setWriting(false)
  }

  return (
    <div
      ref={ref}
      className="palette"
      style={{ left: placed?.left ?? anchor.x, top: placed?.top ?? anchor.y }}
      // La selection survit au clic sur la palette : sans cela, viser une
      // couleur effacerait le passage qu'on s'apprete a surligner.
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="palette-row">
        {HIGHLIGHT_COLORS.map((colour) => (
          <button
            key={colour.id}
            className="palette-swatch"
            style={{ background: colour.hex }}
            data-active={annotation?.colour === colour.id}
            onClick={() => onPick(colour.id)}
            title={`${colour.label} — ${colour.meaning} (${colour.shortcut})`}
            aria-label={colour.label}
          >
            <span className="palette-key">{colour.shortcut}</span>
          </button>
        ))}

        <span className="palette-separator" aria-hidden="true" />

        <button
          className="palette-action"
          onClick={() => setWriting((open) => !open)}
          data-active={writing}
          title="Accrocher une note à ce passage"
        >
          Note
        </button>
        <button className="palette-action" onClick={onExplain} title="Demander à Claude">
          Expliquer
        </button>

        {annotation && (
          <button
            className="palette-action palette-action--remove"
            onClick={onRemove}
            title="Retirer ce surlignage"
          >
            Retirer
          </button>
        )}
      </div>

      {writing && (
        <div className="palette-note">
          <textarea
            ref={inputRef}
            className="palette-note-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Les chiffres 1 a 5 changent de couleur tant qu'on n'ecrit pas :
              // ici ils doivent redevenir des chiffres.
              event.stopPropagation()
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submitComment()
              }
            }}
            onBlur={submitComment}
            placeholder={
              annotation
                ? 'Ce que tu veux retenir de ce passage…'
                : 'Choisis d’abord une couleur.'
            }
            disabled={!annotation}
            rows={2}
          />
          {annotation && <span className="palette-note-hint">⏎ pour garder · ⇧⏎ pour aller à la ligne</span>}
        </div>
      )}
    </div>
  )
}
