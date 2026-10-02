/**
 * Le sommaire de la note : un bouton du bandeau, et la liste des grandes
 * parties qu'il deplie par-dessus la feuille.
 *
 * Il n'est ecrit par personne. L'application le lit dans la note a chaque
 * modification, si bien qu'il ne peut ni vieillir ni mentir — et il ne part
 * jamais sur le disque. Ecrit dans la note, il aurait ete range par page avec
 * le reste au premier tri, recopie par l'assistant a chaque reecriture, et
 * faux des le titre suivant.
 *
 * Il vivait d'abord en tete de la feuille, a trente ecrans de la ou l'on lit
 * dans une longue note. Depuis le bandeau, il s'ouvre la ou l'on est, et dit
 * dans quelle partie on se trouve.
 */

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { Transaction } from '@tiptap/pm/state'
import { TableOfContents } from 'lucide-react'
import { foldKey } from '../lib/editor-fold'
import { noteTitles } from '../lib/note-titles'

/** Une entree du sommaire, et le bloc de premier niveau qu'elle designe. */
interface Entry {
  index: number
  text: string
  /** 0 pour une grande partie, 1 pour ce qu'elle contient. */
  level: number
}

/**
 * Deux niveaux : les grandes parties et leurs subdivisions. Au-dela, le
 * sommaire d'une longue note devient une seconde note — soixante-treize
 * lignes pour les notes d'Investment Banking, contre vingt-trois ainsi.
 */
const DEPTH = 2

function outline(editor: Editor): Entry[] {
  return noteTitles(editor.state.doc).flatMap((title) =>
    title.level !== null && title.level < DEPTH
      ? [{ index: title.index, text: title.text, level: title.level }]
      : []
  )
}

function sameOutline(a: Entry[], b: Entry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, at) =>
        entry.index === b[at].index && entry.text === b[at].text && entry.level === b[at].level
    )
  )
}

/**
 * La partie ou l'on se trouve : le dernier titre passe au-dessus de la ligne
 * de lecture, au tiers haut de la feuille — la meme que celle qui entraine le
 * cours. Un titre replie dans une partie repliee n'a pas de place a l'ecran,
 * et ne compte pas.
 */
function currentEntry(editor: Editor, entries: Entry[]): number | null {
  const body = editor.view.dom.closest('.notes-body')
  if (!body) return null
  const line = body.getBoundingClientRect().top + body.clientHeight / 3
  let current: number | null = null
  for (const entry of entries) {
    const element = editor.view.dom.children[entry.index]
    if (!element || element.getClientRects().length === 0) continue
    if (element.getBoundingClientRect().top > line) break
    current = entry.index
  }
  return current
}

interface NotesOutlineProps {
  editor: Editor | null
  /** Rejoint le bloc de premier niveau d'indice donne. */
  onJump: (index: number) => void
}

export default function NotesOutline({ editor, onJump }: NotesOutlineProps): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([])
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<number | null>(null)
  const [anyFolded, setAnyFolded] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)

  // `transaction` et non `update` : l'ouverture d'une note passe par un
  // chargement qui ne declenche pas `update`, et le sommaire doit la suivre.
  // Le repli, lui, ne change pas le document : il se lit a part.
  useEffect(() => {
    if (!editor) return undefined
    const refresh = (): void => {
      const next = outline(editor)
      setEntries((shown) => (sameOutline(shown, next) ? shown : next))
      setAnyFolded((foldKey.getState(editor.state)?.folded.length ?? 0) > 0)
    }
    const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
      if (transaction.docChanged || transaction.getMeta(foldKey)) refresh()
    }

    refresh()
    editor.on('transaction', onTransaction)
    return () => {
      editor.off('transaction', onTransaction)
    }
  }, [editor])

  // A l'ouverture : ou l'on est, et la liste deroulee jusque-la.
  useEffect(() => {
    if (!open || !editor) return
    setCurrent(currentEntry(editor, entries))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    list.current?.querySelector('[data-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, current])

  // Un clic ailleurs ou Echap : le menu se referme, comme un menu.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Une seule partie ne demande pas de sommaire : elle est deja sous les yeux.
  const usable = entries.length >= 2

  return (
    <div className="notes-outline" ref={root}>
      <button
        type="button"
        className="icon-button notes-outline-trigger"
        data-active={open}
        disabled={!usable}
        aria-expanded={open}
        aria-label="Sommaire"
        title={
          usable
            ? 'Sommaire de la note'
            : 'Le sommaire apparaît dès que la note a deux titres (## ou une ligne agrandie)'
        }
        onClick={() => setOpen((shown) => !shown)}
      >
        <TableOfContents size={15} aria-hidden="true" />
      </button>

      {open && usable && (
        <div className="notes-outline-pop">
          <div className="notes-outline-panel">
            <div className="notes-outline-head">
              <span className="notes-outline-title">Sommaire</span>
              <button
                type="button"
                className="notes-outline-fold"
                onClick={() =>
                  anyFolded ? editor?.commands.unfoldAll() : editor?.commands.foldParts()
                }
                title={
                  anyFolded
                    ? 'Rouvrir toutes les parties de la note'
                    : 'Ne garder que les titres des grandes parties — pour te réciter chacune avant de la rouvrir'
                }
              >
                {anyFolded ? 'Tout déplier' : 'Tout replier'}
              </button>
            </div>
            <ol className="notes-outline-list" ref={list}>
              {entries.map((entry) => (
                <li
                  key={entry.index}
                  className="notes-outline-item"
                  data-level={entry.level}
                  data-current={entry.index === current}
                >
                  <button
                    type="button"
                    className="notes-outline-link"
                    onClick={() => {
                      setOpen(false)
                      onJump(entry.index)
                    }}
                  >
                    {entry.text}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  )
}
