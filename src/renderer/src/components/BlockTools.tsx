/**
 * Les commandes d'un tableau ou d'un encadre, posees sur l'objet lui-meme.
 *
 * Un schema porte les siennes : c'est un noeud a part entiere, avec sa propre
 * vue. Un tableau et un encadre, eux, sont du contenu ordinaire de l'editeur —
 * ils n'ont nulle part ou accrocher un bouton. On les suit donc de l'exterieur :
 * quand le curseur entre dans l'un d'eux, une petite barre vient se poser sur
 * son bord superieur.
 *
 * Les coordonnees sont relatives au cadre qui porte l'editeur, et non a
 * l'ecran : la barre defile avec le texte sans qu'on ait a la recalculer.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { HIGHLIGHT_COLORS, TABLE_ACCENTS, TABLE_DESIGNS } from '@shared/types'
import type { TableAccent } from '@shared/types'

interface Anchor {
  kind: 'table' | 'callout'
  top: number
  right: number
}

/** Le nom de l'accent tel qu'on le lit dans la legende. */
function accentLabel(accent: TableAccent): string {
  if (accent === 'laiton') return 'Laiton'
  return HIGHLIGHT_COLORS.find((colour) => colour.id === accent)?.label ?? accent
}

function accentSwatch(accent: TableAccent): string {
  if (accent === 'laiton') return 'var(--brass)'
  return HIGHLIGHT_COLORS.find((colour) => colour.id === accent)?.hex ?? 'var(--brass)'
}

export default function BlockTools({ editor }: { editor: Editor | null }): React.JSX.Element {
  const layer = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [menu, setMenu] = useState(false)

  const locate = useCallback(() => {
    const frame = layer.current
    if (!editor || !frame) return

    // Sans le focus, il n'y a pas de curseur : le document garde bien une
    // selection, mais elle ne designe pas ou l'utilisateur travaille — a
    // l'ouverture d'une note, elle tombe sur le dernier bloc.
    if (!editor.isFocused) {
      setAnchor(null)
      return
    }

    let element: HTMLElement | null = null
    try {
      const { node } = editor.view.domAtPos(editor.state.selection.from)
      element = node instanceof HTMLElement ? node : node.parentElement
    } catch {
      // La position peut ne plus exister le temps qu'on la relise.
      element = null
    }

    const table = element?.closest('table') ?? null
    const callout = element?.closest<HTMLElement>('[data-callout]') ?? null
    const target = table ?? callout

    if (!target) {
      setAnchor(null)
      setMenu(false)
      return
    }

    const box = target.getBoundingClientRect()
    const origin = frame.getBoundingClientRect()
    setAnchor({
      kind: table ? 'table' : 'callout',
      top: box.y - origin.y,
      right: box.right - origin.x
    })
  }, [editor])

  useEffect(() => {
    if (!editor) return undefined

    locate()
    editor.on('transaction', locate)
    editor.on('selectionUpdate', locate)
    editor.on('focus', locate)
    editor.on('blur', locate)

    // Un schema compose son image apres coup : la feuille grandit alors sans
    // qu'aucune transaction ne le signale, et la barre resterait ou elle
    // etait. On suit donc aussi la hauteur du cadre.
    const observer = new ResizeObserver(() => locate())
    if (layer.current) observer.observe(layer.current)

    return () => {
      editor.off('transaction', locate)
      editor.off('selectionUpdate', locate)
      editor.off('focus', locate)
      editor.off('blur', locate)
      observer.disconnect()
    }
  }, [editor, locate])

  // Un objet dont on sort ferme son menu : il ne vise plus rien.
  useEffect(() => {
    if (!anchor) setMenu(false)
  }, [anchor])

  return (
    <div className="block-tools-layer" ref={layer}>
      {editor && anchor && (
        <div className="block-tools" style={{ top: anchor.top, left: anchor.right }}>
          {anchor.kind === 'table' && (
            <>
              <button
                className="block-tools-button"
                data-active={menu}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setMenu((open) => !open)
                }}
                title="Habillage et structure du tableau"
              >
                Modifier
              </button>
              {menu && <TableMenu editor={editor} onDone={() => setMenu(false)} />}
            </>
          )}

          <button
            className="block-cross"
            onMouseDown={(event) => {
              event.preventDefault()
              if (anchor.kind === 'table') editor.chain().focus().deleteTable().run()
              else editor.chain().focus().deleteCallout().run()
            }}
            title={anchor.kind === 'table' ? 'Supprimer ce tableau' : 'Supprimer cet encadré'}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

/** Habillage et structure, dans le meme menu : ce sont les memes gestes. */
function TableMenu({ editor, onDone }: { editor: Editor; onDone: () => void }): React.JSX.Element {
  const design = (editor.getAttributes('table').design ?? 'sobre') as string
  const accent = (editor.getAttributes('table').accent ?? 'laiton') as string

  const hold = (action: () => void) => (event: React.MouseEvent) => {
    event.preventDefault()
    action()
  }

  return (
    <div className="block-menu">
      <div className="block-menu-title">Habillage</div>
      <div className="block-menu-row">
        {TABLE_DESIGNS.map((entry) => (
          <button
            key={entry.id}
            className="block-menu-chip"
            data-active={design === entry.id}
            title={entry.hint}
            onMouseDown={hold(() => editor.chain().focus().setTableStyle({ design: entry.id }).run())}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="block-menu-row">
        {TABLE_ACCENTS.map((entry) => (
          <button
            key={entry}
            className="block-menu-dot"
            data-active={accent === entry}
            style={{ background: accentSwatch(entry) }}
            title={accentLabel(entry)}
            onMouseDown={hold(() => editor.chain().focus().setTableStyle({ accent: entry }).run())}
          />
        ))}
      </div>

      <div className="block-menu-title">Structure</div>
      <div className="block-menu-row">
        <button
          className="block-menu-chip"
          onMouseDown={hold(() => editor.chain().focus().addRowAfter().run())}
        >
          + ligne
        </button>
        <button
          className="block-menu-chip"
          onMouseDown={hold(() => editor.chain().focus().deleteRow().run())}
        >
          − ligne
        </button>
        <button
          className="block-menu-chip"
          onMouseDown={hold(() => editor.chain().focus().addColumnAfter().run())}
        >
          + colonne
        </button>
        <button
          className="block-menu-chip"
          onMouseDown={hold(() => editor.chain().focus().deleteColumn().run())}
        >
          − colonne
        </button>
      </div>

      <div className="block-menu-row block-menu-row--end">
        <button className="block-menu-chip" onMouseDown={hold(onDone)}>
          Terminé
        </button>
      </div>
    </div>
  )
}
