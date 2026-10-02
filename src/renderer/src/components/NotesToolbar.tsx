import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  AArrowDown,
  AArrowUp,
  AlignCenter,
  AlignLeft,
  CodeXml,
  Highlighter,
  List,
  ListOrdered,
  Quote,
  Table,
  Workflow
} from 'lucide-react'
import { HIGHLIGHT_COLORS, TEXT_COLORS } from '@shared/types'

interface NotesToolbarProps {
  editor: Editor | null
}

/** Couleurs de texte proposees, en plus des cinq couleurs de surlignage. */
const TEXT_COLOURS = [{ label: 'Par défaut', value: null }, ...TEXT_COLORS]

/**
 * Le trait des icones de la barre, un peu plus fin que celui de lucide par
 * defaut : a cette taille, le trait de 2 pesait plus lourd que les lettres
 * G, I, S, B dessinees a cote.
 */
const ICON = { size: 15, strokeWidth: 1.8, 'aria-hidden': true } as const

export default function NotesToolbar({ editor }: NotesToolbarProps): React.JSX.Element | null {
  // L'editeur ne previent pas React quand la selection change : on force un
  // rendu a chaque transaction pour que l'etat actif des boutons suive.
  const [, forceRender] = useState(0)

  useEffect(() => {
    if (!editor) return
    const update = (): void => forceRender((tick) => tick + 1)

    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor])

  if (!editor) return null

  return (
    <div className="toolbar" role="toolbar" aria-label="Mise en forme">
      <ToolGroup>
        <FontSizeStepper editor={editor} />
      </ToolGroup>

      <ToolGroup>
        <ToolButton
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Gras (⌘B)"
        >
          <strong>G</strong>
        </ToolButton>
        <ToolButton
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italique (⌘I)"
        >
          <em>I</em>
        </ToolButton>
        <ToolButton
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          title="Souligné (⌘U)"
        >
          <u>S</u>
        </ToolButton>
        <ToolButton
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="Barré"
        >
          <s>B</s>
        </ToolButton>
      </ToolGroup>

      <ToolGroup>
        <ColourMenu editor={editor} />
        <HighlightMenu editor={editor} />
      </ToolGroup>

      <ToolGroup>
        <ToolButton
          active={editor.isActive({ textAlign: 'left' })}
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          title="Aligner à gauche"
        >
          <AlignLeft {...ICON} />
        </ToolButton>
        <ToolButton
          active={editor.isActive({ textAlign: 'center' })}
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          title="Centrer"
        >
          <AlignCenter {...ICON} />
        </ToolButton>
      </ToolGroup>

      <ToolGroup>
        <ToolButton
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Liste à puces"
        >
          <List {...ICON} />
        </ToolButton>
        <ToolButton
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Liste numérotée"
        >
          <ListOrdered {...ICON} />
        </ToolButton>
        <ToolButton
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Citation"
        >
          <Quote {...ICON} />
        </ToolButton>
        <ToolButton
          active={editor.isActive('codeBlock')}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title="Bloc de code"
        >
          <CodeXml {...ICON} />
        </ToolButton>
      </ToolGroup>

      {/* Les objets que l'assistant sait ecrire, a portee de main aussi pour
          celui qui prend ses notes : un tableau, un encadre, un schema. */}
      <ToolGroup>
        <ToolButton
          active={editor.isActive('table')}
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
          title="Tableau"
        >
          <Table {...ICON} />
        </ToolButton>
        <CalloutMenu editor={editor} />
        <DiagramMenu editor={editor} />
      </ToolGroup>
      {/* Pas de boutons de formule : taper $x^2$ ou $$…$$ compose deja la
          formule pendant la frappe, et l'assistant en ecrit directement dans
          les notes. Les extensions mathematiques restent donc chargees dans
          l'editeur (voir NotesPanel) — seuls les deux boutons sont partis. */}
    </div>
  )
}

function ToolGroup({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="tool-group">{children}</div>
}

/**
 * Un encadre, dessine tel qu'il parait dans la note : un cadre au liseré
 * gauche appuye, un titre et une ligne de texte. Lucide n'a rien qui
 * ressemble a cet objet-la, et le ▣ d'avant ne disait pas ce qu'il inserait.
 * Meme grille et meme trait que les icones lucide voisines.
 */
function CalloutIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={ICON.size}
      height={ICON.size}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3.9 5v14" strokeWidth="3" />
      <path d="M9 9.5h7" strokeWidth="2.4" />
      <path d="M9 14.5h9" />
    </svg>
  )
}

interface ToolButtonProps {
  active?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}

function ToolButton({ active, onClick, title, children }: ToolButtonProps): React.JSX.Element {
  return (
    <button
      className="tool-button"
      data-active={Boolean(active)}
      // onMouseDown plutot que onClick : sans cela, le clic retire le focus de
      // l'editeur et la selection est perdue avant que la commande s'applique.
      onMouseDown={(event) => {
        event.preventDefault()
        onClick()
      }}
      title={title}
      aria-pressed={Boolean(active)}
    >
      {children}
    </button>
  )
}

/**
 * Les paliers de taille, du plus petit au plus grand. `null` est la taille
 * heritee du corps du texte — rien a retirer n'a pas de valeur CSS.
 */
const TEXT_SIZES = [
  { size: null, label: 16 },
  { size: '18px', label: 18 },
  { size: '20px', label: 20 },
  { size: '24px', label: 24 }
] as const

function activeSizeIndex(editor: Editor): number {
  const size = (editor.getAttributes('textStyle').fontSize as string | null | undefined) ?? null
  const found = TEXT_SIZES.findIndex((entry) => entry.size === size)
  return found === -1 ? 0 : found
}

/**
 * Un seul controle pour la taille du texte, a la maniere de Word : les
 * fleches montent ou descendent d'un palier, et n'affectent que le texte
 * selectionne — jamais le paragraphe entier. C'est une marque en ligne
 * (`textStyle`, comme la couleur), pas un titre : un H1/H2/H3 s'appliquait
 * forcement a tout le bloc, ce qui n'est pas ce qu'on attend d'un reglage de
 * taille.
 */
function FontSizeStepper({ editor }: { editor: Editor }): React.JSX.Element {
  const index = activeSizeIndex(editor)

  const apply = (next: number): void => {
    const clamped = Math.min(TEXT_SIZES.length - 1, Math.max(0, next))
    const { size } = TEXT_SIZES[clamped]
    if (size === null) editor.chain().focus().unsetFontSize().run()
    else editor.chain().focus().setFontSize(size).run()
  }

  return (
    <div className="tool-stepper" title="Taille du texte">
      <button
        className="tool-stepper-btn"
        onMouseDown={(event) => {
          event.preventDefault()
          apply(index - 1)
        }}
        disabled={index === 0}
        title="Réduire la taille du texte"
      >
        <AArrowDown {...ICON} />
      </button>
      <span className="tool-stepper-value">{TEXT_SIZES[index].label}</span>
      <button
        className="tool-stepper-btn"
        onMouseDown={(event) => {
          event.preventDefault()
          apply(index + 1)
        }}
        disabled={index === TEXT_SIZES.length - 1}
        title="Augmenter la taille du texte"
      >
        <AArrowUp {...ICON} />
      </button>
    </div>
  )
}

/** Menu deroulant generique, ferme au clic exterieur et a l'echappement. */
function useDismiss(onDismiss: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onDismiss])

  return ref
}

function ColourMenu({ editor }: { editor: Editor }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(() => setOpen(false))
  // Le trait sous le A porte la couleur du texte sous le curseur, comme dans
  // Word : on voit ce qu'on va poser, et ce qui est deja pose.
  const current = (editor.getAttributes('textStyle').color as string | undefined) ?? null

  return (
    <div className="tool-menu" ref={ref}>
      <button
        className="tool-button"
        data-active={open}
        onMouseDown={(event) => {
          event.preventDefault()
          setOpen((value) => !value)
        }}
        title="Couleur du texte"
      >
        <span className="tool-glyph-colour" aria-hidden="true">
          A
          <span className="tool-colour-bar" style={{ background: current ?? 'var(--text)' }} />
        </span>
      </button>

      {open && (
        <div className="tool-popover">
          {TEXT_COLOURS.map((colour) => (
            <button
              key={colour.label}
              className="tool-popover-item"
              onMouseDown={(event) => {
                event.preventDefault()
                if (colour.value) editor.chain().focus().setColor(colour.value).run()
                else editor.chain().focus().unsetColor().run()
                setOpen(false)
              }}
            >
              <span
                className="tool-popover-swatch"
                style={{ background: colour.value ?? 'var(--text)' }}
              />
              {colour.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Surlignage des notes. Il reprend exactement les cinq couleurs semantiques du
 * document : un passage marque « pas compris » a le meme sens qu'il soit dans
 * le cours ou dans les notes.
 */
function HighlightMenu({ editor }: { editor: Editor }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(() => setOpen(false))

  return (
    <div className="tool-menu" ref={ref}>
      <button
        className="tool-button"
        data-active={open || editor.isActive('highlight')}
        onMouseDown={(event) => {
          event.preventDefault()
          setOpen((value) => !value)
        }}
        title="Surligner"
      >
        <Highlighter {...ICON} />
      </button>

      {open && (
        <div className="tool-popover">
          {HIGHLIGHT_COLORS.map((colour) => (
            <button
              key={colour.id}
              className="tool-popover-item"
              onMouseDown={(event) => {
                event.preventDefault()
                // La teinte translucide, pas la couleur pleine : appliquee en
                // fond derriere un texte clair, la couleur saturee le rendrait
                // illisible.
                editor.chain().focus().setHighlight({ color: colour.wash }).run()
                setOpen(false)
              }}
              title={colour.meaning}
            >
              <span className="tool-popover-swatch" style={{ background: colour.hex }} />
              {colour.label}
            </button>
          ))}
          <button
            className="tool-popover-item"
            onMouseDown={(event) => {
              event.preventDefault()
              editor.chain().focus().unsetHighlight().run()
              setOpen(false)
            }}
          >
            <span className="tool-popover-swatch tool-popover-swatch--none" />
            Retirer
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Encadres semantiques. Memes cinq couleurs, meme sens : ce qui est encadre en
 * vert est une definition, dans le cours comme dans les notes.
 */
function CalloutMenu({ editor }: { editor: Editor }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(() => setOpen(false))

  return (
    <div className="tool-menu" ref={ref}>
      <button
        className="tool-button"
        data-active={open || editor.isActive('callout')}
        onMouseDown={(event) => {
          event.preventDefault()
          setOpen((value) => !value)
        }}
        title="Encadré"
      >
        <CalloutIcon />
      </button>

      {open && (
        <div className="tool-popover">
          {HIGHLIGHT_COLORS.map((colour) => (
            <button
              key={colour.id}
              className="tool-popover-item"
              onMouseDown={(event) => {
                event.preventDefault()
                editor.chain().focus().setCallout(colour.id).run()
                setOpen(false)
              }}
              title={colour.meaning}
            >
              <span className="tool-popover-swatch" style={{ background: colour.hex }} />
              {colour.label}
            </button>
          ))}
          <button
            className="tool-popover-item"
            onMouseDown={(event) => {
              event.preventDefault()
              editor.chain().focus().unsetCallout().run()
              setOpen(false)
            }}
          >
            <span className="tool-popover-swatch tool-popover-swatch--none" />
            Retirer
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Schemas. Le menu ne propose pas une syntaxe vide mais un exemple qui tient
 * debout : on part d'un schema qui s'affiche, et on remplace les mots.
 */
const DIAGRAM_MODELS = [
  {
    label: 'Carte mentale',
    hint: 'Un sujet, ses branches',
    source: `mindmap
  root((Sujet))
    Première branche
      Un élément
    Deuxième branche
      Un élément
    Troisième branche
      Un élément`
  },
  {
    label: 'Schéma de flux',
    hint: 'Des étapes, des choix',
    source: `flowchart TD
  A[Point de départ] --> B{Condition}
  B -->|oui| C[Une suite]
  B -->|non| D[Une autre]`
  },
  {
    label: 'Frise',
    hint: 'Des dates, des jalons',
    source: `timeline
  title Déroulé
  Étape 1 : Ce qui se passe
  Étape 2 : Ce qui suit`
  }
]

function DiagramMenu({ editor }: { editor: Editor }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(() => setOpen(false))

  return (
    <div className="tool-menu" ref={ref}>
      <button
        className="tool-button"
        data-active={open || editor.isActive('diagram')}
        onMouseDown={(event) => {
          event.preventDefault()
          setOpen((value) => !value)
        }}
        title="Schéma"
      >
        <Workflow {...ICON} />
      </button>

      {open && (
        <div className="tool-popover">
          {DIAGRAM_MODELS.map((model) => (
            <button
              key={model.label}
              className="tool-popover-item"
              onMouseDown={(event) => {
                event.preventDefault()
                editor
                  .chain()
                  .focus()
                  .insertContent({ type: 'diagram', attrs: { source: model.source } })
                  .run()
                setOpen(false)
              }}
              title={model.hint}
            >
              {model.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
