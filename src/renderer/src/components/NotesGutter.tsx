/**
 * La marge des notes : ce a quoi chaque passage de la feuille est rattache.
 *
 * La marge ne lit pas les blocs un par un, elle lit des segments. Un segment
 * commence sur un bloc qui porte son ancre et s'arrete au bloc suivant qui en
 * porte une : c'est exactement l'etendue que regit cette ancre. Tout le reste
 * en decoule — la ligne ou se pose le repere, la page a afficher, l'etendue
 * qu'un coup d'oeil rallume.
 *
 * Le repere du segment dit le lieu dans le cours (« p. 12 »), affiche des qu'il
 * change, et le point du passage quand l'ancre en designe un. Les deux ensemble
 * s'il le faut : une note ancree droit sur un passage doit dire de quelle page
 * ce passage vient, sans quoi la page n'apparaitrait nulle part.
 *
 * Tout est mesure dans le repere de la feuille, jamais de l'ecran : les
 * reperes defilent donc avec le texte sans un calcul par cran de molette. La
 * ligne, elle, se mesure sur le caret et non sur la boite du bloc : c'est la
 * seule facon de rester centre quand la taille de police change d'un bloc a
 * l'autre, ou quand le bloc est une liste de huit lignes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { anchorLabel, sameAnchor, type NoteAnchor } from '@shared/types'
import { ANCHORED } from '../lib/editor-anchor'

/** Un bloc de la feuille, tel que la marge a besoin de le connaitre. */
interface Block {
  /** Position du bloc dans le document : c'est la qu'on lit la hauteur du caret. */
  pos: number
  top: number
  bottom: number
  /** La premiere ligne du bloc : c'est sur elle qu'un repere se centre. */
  lineTop: number
  lineHeight: number
  /** L'ancre que le bloc porte lui-meme, ou null s'il herite. */
  own: NoteAnchor | null
  /** Rien d'ecrit dedans : une ligne vide, ou un bloc qu'on vient de vider. */
  blank: boolean
}

/** L'etendue que regit une ancre : de son bloc au prochain bloc ancre. */
interface Run {
  key: number
  anchor: NoteAnchor
  /** Le lieu a afficher, ou null quand c'est le meme que juste au-dessus. */
  place: string | null
  /**
   * La premiere ligne ecrite du segment, ou null s'il n'y en a aucune. Une
   * ancre portee par une ligne vide — la protection deposee a la fermeture
   * d'un groupe, ou ce qui reste d'un bloc qu'on a efface — ne se voit pas :
   * un repere sans note en face ne dit rien a personne. Elle garde pourtant
   * son role, et se montre des que du texte en releve.
   */
  lineTop: number | null
  lineHeight: number
  top: number
  bottom: number
}

interface NotesGutterProps {
  editor: Editor | null
  /**
   * Rejoint dans le cours l'endroit que designe cette ancre. `signal` demande
   * qu'on l'y montre : c'est un clic volontaire, pas un suivi de defilement.
   */
  onGoTo: (anchor: NoteAnchor, signal?: boolean) => void
}

export default function NotesGutter({ editor, onGoTo }: NotesGutterProps): React.JSX.Element {
  const layer = useRef<HTMLDivElement>(null)
  const [blocks, setBlocks] = useState<Block[]>([])
  /** Le passage dont on vient de demander a voir les notes. */
  const [lit, setLit] = useState<string | null>(null)
  /** Le repere vise par un clic droit : ou est son bloc, et ce qu'il portait. */
  const [menu, setMenu] = useState<{
    x: number
    y: number
    at: number
    anchor: NoteAnchor
  } | null>(null)

  const measure = useCallback(() => {
    const frame = layer.current
    if (!editor || !frame) return

    const origin = frame.getBoundingClientRect()
    const children = editor.view.dom.children
    const next: Block[] = []
    let index = 0

    editor.state.doc.forEach((node, offset) => {
      const element = children[index] as HTMLElement | undefined
      index += 1
      // Un bloc d'une partie repliee n'a pas de place a l'ecran : sa boite
      // vide poserait son repere en haut de la feuille.
      if (!element || element.getClientRects().length === 0) return

      const box = element.getBoundingClientRect()
      const pos = offset + 1

      // La hauteur du caret a l'entree du bloc *est* celle de sa premiere
      // ligne, titre ou paragraphe, quelle que soit la police en jeu. La boite
      // du bloc, elle, ne dirait rien d'utile sur une liste ou une citation de
      // plusieurs lignes. `coordsAtPos` refuse certaines positions : on retombe
      // alors sur le haut de la boite, faute de mieux.
      let lineTop = box.top
      let lineHeight = 0
      try {
        const caret = editor.view.coordsAtPos(pos)
        lineTop = caret.top
        lineHeight = caret.bottom - caret.top
      } catch {
        lineHeight = 0
      }
      if (lineHeight <= 0) {
        lineTop = box.top
        lineHeight = Math.min(box.height, 24)
      }

      next.push({
        pos,
        top: box.top - origin.top,
        bottom: box.bottom - origin.top,
        lineTop: lineTop - origin.top,
        lineHeight,
        own: (node.attrs.ancre as NoteAnchor | null) ?? null,
        // Un tableau ou une image n'ont pas de texte mais sont bien quelque
        // chose : seuls les blocs d'ecriture peuvent etre vides.
        blank: ANCHORED.includes(node.type.name) && node.textContent.trim() === ''
      })
    })

    setBlocks(next)
  }, [editor])

  useEffect(() => {
    if (!editor) return

    measure()
    editor.on('transaction', measure)
    editor.on('update', measure)

    const frame = layer.current
    const observer = frame ? new ResizeObserver(measure) : null
    if (frame && observer) observer.observe(frame)

    return () => {
      editor.off('transaction', measure)
      editor.off('update', measure)
      observer?.disconnect()
    }
  }, [editor, measure])

  /**
   * Les segments, et le lieu que chacun affiche.
   *
   * Un segment s'arrete net au bloc suivant qui porte sa propre ancre : c'est
   * ce qui borne son etendue a ce qui a vraiment ete ecrit dessous. L'ancienne
   * marge prenait au contraire l'enveloppe de tous les blocs relevant de la
   * meme ancre — des notes prises sur le meme passage trois semaines plus tot,
   * quarante blocs plus haut, l'allongeaient jusqu'a elles.
   *
   * Le lieu se reaffiche des qu'il change, que l'ancre porte un passage ou non.
   * L'ancienne marge posait un choix exclusif — un point *ou* un libelle — si
   * bien qu'une note ancree droit sur un passage n'affichait jamais sa page,
   * alors qu'elle la connait : commencer sa journee par un ancrage de passage
   * ne faisait apparaitre aucune page nulle part.
   */
  const runs = useMemo(() => {
    const list: Run[] = []

    for (const block of blocks) {
      if (block.own) {
        list.push({
          key: block.pos,
          anchor: block.own,
          place: null,
          lineTop: block.blank ? null : block.lineTop,
          lineHeight: block.lineHeight,
          top: block.top,
          bottom: block.bottom
        })
      } else if (list.length > 0) {
        const run = list[list.length - 1]
        run.bottom = block.bottom
        // Le repere se pose sur la premiere ligne ecrite du segment, pas sur
        // la ligne vide qui porte l'ancre : c'est le texte qu'il designe.
        if (run.lineTop === null && !block.blank) {
          run.lineTop = block.lineTop
          run.lineHeight = block.lineHeight
        }
      }
    }

    let shown: string | null = null
    for (const run of list) {
      // Un segment sans texte n'affiche rien, et ne compte pas non plus
      // comme affiche : le segment ecrit qui le suit doit pouvoir dire sa
      // page, meme si c'est celle que la ligne vide taisait.
      if (run.lineTop === null) continue
      // `anchorLabel` ne lit que le lieu — page, section, avancement — et
      // ignore le passage : c'est exactement ce qu'on veut afficher ici.
      const place =
        run.anchor.page !== null || run.anchor.section !== null || run.anchor.progress !== null
          ? anchorLabel(run.anchor)
          : null
      if (place !== null && place !== shown) {
        run.place = place
        shown = place
      }
    }

    return list
  }, [blocks])

  // Le rallumage est un coup d'oeil, pas un mode : il s'eteint tout seul.
  useEffect(() => {
    if (!lit) return
    const timer = setTimeout(() => setLit(null), 2600)
    return () => clearTimeout(timer)
  }, [lit])

  const litRuns = lit ? runs.filter((run) => run.anchor.passage?.text === lit) : []

  // Le menu se ferme comme il s'est ouvert : d'un geste ailleurs.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  /**
   * Retire ce que le repere clique affichait — et rien de plus.
   *
   * Un point de passage retourne a sa page : la note cesse de designer une
   * phrase, elle continue de dire d'ou elle vient. Un repere de lieu seul
   * s'efface entierement : le bloc releve alors du dernier repere au-dessus
   * de lui, comme s'il n'avait jamais change d'endroit.
   *
   * L'ancre est relue avant d'ecrire : le document a pu bouger entre la
   * mesure et le clic, et on prefere ne rien faire qu'effacer un voisin.
   */
  const supprimer = useCallback(() => {
    const target = menu
    setMenu(null)
    if (!editor || !target) return

    const node = editor.state.doc.nodeAt(target.at)
    const own = (node?.attrs.ancre as NoteAnchor | null) ?? null
    if (!own || !sameAnchor(own, target.anchor)) return

    const place =
      target.anchor.page !== null ||
      target.anchor.section !== null ||
      target.anchor.progress !== null
    const next = target.anchor.passage && place ? { ...target.anchor, passage: null } : null

    editor.commands.command(({ tr, dispatch }) => {
      if (dispatch) tr.setNodeAttribute(target.at, 'ancre', next)
      return true
    })
  }, [editor, menu])

  return (
    <div className="notes-gutter" ref={layer} aria-hidden="true">
      {litRuns.map((run) => (
        <span
          key={`lit-${run.key}`}
          className="notes-lit"
          style={{ top: run.top, height: run.bottom - run.top }}
        />
      ))}

      {runs.map((run) =>
        run.lineTop !== null && (run.place !== null || run.anchor.passage) ? (
          <button
            key={`mark-${run.key}`}
            className="notes-mark"
            data-passage={run.anchor.passage ? 'true' : undefined}
            // La boite du repere fait la hauteur de la ligne visee, et son
            // contenu s'y centre : c'est ce qui l'aligne au milieu de la ligne
            // plutot que sur le haut du bloc, quatre a six pixels trop haut.
            style={{ top: run.lineTop, height: run.lineHeight }}
            title={
              run.anchor.passage
                ? `« ${run.anchor.passage.text} » — cliquer pour y retourner et voir toutes les notes de ce passage`
                : `${anchorLabel(run.anchor)} — cliquer pour y retourner`
            }
            onClick={() => {
              onGoTo(run.anchor, true)
              if (run.anchor.passage) setLit(run.anchor.passage.text)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              // `run.key` est une position *dans* le bloc ; le noeud, lui, est
              // un cran avant.
              setMenu({ x: event.clientX, y: event.clientY, at: run.key - 1, anchor: run.anchor })
            }}
          >
            {run.place !== null && <span className="notes-mark-place">{run.place}</span>}
            {run.anchor.passage && <span className="notes-mark-dot" />}
          </button>
        ) : null
      )}

      {menu && (
        <div
          className="anchor-menu"
          style={{ left: menu.x, top: menu.y }}
          // Sans quoi le mousedown remonte a la fenetre et ferme le menu
          // avant que le clic n'atteigne son bouton.
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button className="anchor-menu-item" onClick={supprimer}>
            Supprimer l&rsquo;ancrage
          </button>
        </div>
      )}
    </div>
  )
}
