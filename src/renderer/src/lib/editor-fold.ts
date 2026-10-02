/**
 * Replier une partie de la note sous son titre.
 *
 * Pour reviser : on replie, on se recite ce que la partie contient, on deplie
 * pour verifier. Le repli est un regard sur la note, pas une modification :
 * rien ne part sur le disque, rien n'entre dans l'historique d'annulation, et
 * l'assistant lit toujours la note entiere. Les blocs replies restent dans le
 * document ; une decoration les retire seulement de l'ecran.
 *
 * Une partie court de son titre au titre suivant d'une taille au moins egale
 * (`sectionEnd`) : replier une grande partie emporte ses subdivisions. Le
 * titre de la page ne se replie pas — il cacherait la note entiere.
 *
 * Le curseur n'habite jamais une partie repliee. Y entrer — Entree au bout du
 * titre, retour arriere depuis le titre suivant — la deplie : on ecrit dans ce
 * qu'on voit. La replier alors qu'il s'y trouve le remonte au bout du titre.
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { noteTitles, sectionEnd, type NoteTitle } from './note-titles'

interface FoldState {
  /** La position des titres replies. */
  folded: number[]
  decorations: DecorationSet
}

export const foldKey = new PluginKey<FoldState>('repli')

/** Une partie repliee : son titre, et l'etendue qu'elle cache. */
interface Fold {
  title: number
  from: number
  to: number
}

/** Les titres qu'on peut replier : ceux qui ont quelque chose sous eux. */
function foldable(doc: ProseMirrorNode, titles: NoteTitle[]): NoteTitle[] {
  return titles.filter(
    (title) => title.level !== null && sectionEnd(titles, title, doc.childCount) > title.index + 1
  )
}

function foldsOf(doc: ProseMirrorNode, titles: NoteTitle[], folded: number[]): Fold[] {
  const offsets: number[] = []
  doc.forEach((_node, offset) => offsets.push(offset))

  return titles
    .filter((title) => folded.includes(title.pos))
    .map((title) => {
      const end = sectionEnd(titles, title, doc.childCount)
      return {
        title: title.pos,
        from: title.pos + doc.child(title.index).nodeSize,
        to: end < offsets.length ? offsets[end] : doc.content.size
      }
    })
}

/**
 * Le chevron pose au bout de chaque titre. Un element du DOM, pas du texte :
 * il ne part ni dans la note, ni dans ce que l'assistant lit.
 */
function chevron(folded: boolean) {
  return (view: EditorView, getPos: () => number | undefined): HTMLElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'note-fold-toggle'
    button.contentEditable = 'false'
    button.dataset.folded = String(folded)
    button.title = folded ? 'Déplier cette partie' : 'Replier cette partie'
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
    // Au mousedown, et en l'empechant : un clic laisse sinon l'editeur poser
    // le curseur a cote du chevron avant que le repli n'ait lieu.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const at = getPos()
      if (at === undefined) return
      const title = view.state.doc.resolve(at).before(1)
      view.dispatch(toggled(view.state, view.state.tr, title))
    })
    return button
  }
}

function decorate(doc: ProseMirrorNode, titles: NoteTitle[], folded: number[]): DecorationSet {
  const decorations: Decoration[] = []

  for (const title of foldable(doc, titles)) {
    const node = doc.child(title.index)
    const closed = folded.includes(title.pos)
    decorations.push(
      Decoration.widget(title.pos + node.nodeSize - 1, chevron(closed), {
        side: 1,
        // La cle, et non la fonction, decide s'il faut redessiner : sans elle,
        // chaque frappe refaisait tous les chevrons de la note.
        key: closed ? 'repli-ferme' : 'repli-ouvert',
        ignoreSelection: true,
        stopEvent: () => true
      })
    )
    if (closed) decorations.push(Decoration.node(title.pos, title.pos + node.nodeSize, { class: 'note-fold-head' }))
  }

  for (const fold of foldsOf(doc, titles, folded)) {
    doc.nodesBetween(fold.from, fold.to, (node, pos) => {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'note-folded' }))
      return false
    })
  }

  return DecorationSet.create(doc, decorations)
}

/**
 * Pose un nouvel ensemble de parties repliees. Le curseur qui se retrouverait
 * cache remonte au bout du titre de la partie qui le cache.
 */
function withFolded(state: EditorState, tr: Transaction, folded: number[]): Transaction {
  const titles = noteTitles(state.doc)
  const head = state.selection.head
  const hiding = foldsOf(state.doc, titles, folded).find(
    (fold) => head > fold.from && head < fold.to
  )
  if (hiding) {
    const title = state.doc.nodeAt(hiding.title)
    if (title) tr.setSelection(TextSelection.create(tr.doc, hiding.title + title.nodeSize - 1))
  }
  return tr.setMeta(foldKey, folded).setMeta('addToHistory', false)
}

function toggled(state: EditorState, tr: Transaction, title: number): Transaction {
  const folded = foldKey.getState(state)?.folded ?? []
  return withFolded(
    state,
    tr,
    folded.includes(title) ? folded.filter((pos) => pos !== title) : [...folded, title]
  )
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    repli: {
      /** Replie ou deplie la partie du titre pose a cette position. */
      toggleFold: (pos: number) => ReturnType
      /** Replie les grandes parties : la note se lit alors comme son sommaire. */
      foldParts: () => ReturnType
      unfoldAll: () => ReturnType
      /** Deplie ce qui cache le bloc de premier niveau d'indice donne. */
      unfoldAround: (index: number) => ReturnType
    }
  }
}

export const Fold = Extension.create({
  name: 'repli',

  addCommands() {
    return {
      toggleFold:
        (pos) =>
        ({ state, tr, dispatch }) => {
          if (dispatch) toggled(state, tr, pos)
          return true
        },
      foldParts:
        () =>
        ({ state, tr, dispatch }) => {
          const parts = foldable(state.doc, noteTitles(state.doc)).filter((title) => title.level === 0)
          if (dispatch) withFolded(state, tr, parts.map((title) => title.pos))
          return true
        },
      unfoldAll:
        () =>
        ({ state, tr, dispatch }) => {
          if (dispatch) withFolded(state, tr, [])
          return true
        },
      unfoldAround:
        (index) =>
        ({ state, tr, dispatch }) => {
          const folded = foldKey.getState(state)?.folded ?? []
          if (index >= state.doc.childCount || folded.length === 0) return false
          let pos = 0
          for (let at = 0; at < index; at += 1) pos += state.doc.child(at).nodeSize
          const hiding = foldsOf(state.doc, noteTitles(state.doc), folded)
            .filter((fold) => pos >= fold.from && pos < fold.to)
            .map((fold) => fold.title)
          if (hiding.length === 0) return false
          if (dispatch) withFolded(state, tr, folded.filter((title) => !hiding.includes(title)))
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<FoldState>({
        key: foldKey,
        state: {
          init: (_config, state) => ({ folded: [], decorations: DecorationSet.create(state.doc, []) }),
          apply: (tr, value, _before, state) => {
            const asked = tr.getMeta(foldKey) as number[] | undefined
            if (!asked && !tr.docChanged && !tr.selectionSet) return value
            // Un curseur qui bouge ne concerne le repli que s'il y a du replie.
            if (!asked && !tr.docChanged && value.folded.length === 0) return value

            // Un titre suit sa place a travers les modifications. Celui dont la
            // place a disparu — efface, ou emporte par le rechargement de la
            // note — n'est plus replie.
            let folded =
              asked ??
              value.folded.flatMap((pos) => {
                const mapped = tr.mapping.mapResult(pos, 1)
                return mapped.deleted ? [] : [mapped.pos]
              })

            const titles = noteTitles(state.doc)
            const valid = new Set(foldable(state.doc, titles).map((title) => title.pos))
            folded = [...new Set(folded)].filter((pos) => valid.has(pos))

            // Le curseur est entre dans une partie repliee : elle se deplie.
            if (!asked) {
              const head = state.selection.head
              const entered = foldsOf(state.doc, titles, folded)
                .filter((fold) => head > fold.from && head < fold.to)
                .map((fold) => fold.title)
              folded = folded.filter((pos) => !entered.includes(pos))
            }

            const same =
              folded.length === value.folded.length &&
              folded.every((pos, at) => pos === value.folded[at])
            if (same && !tr.docChanged) return value

            return { folded, decorations: decorate(state.doc, titles, folded) }
          }
        },
        props: {
          decorations: (state) => foldKey.getState(state)?.decorations
        }
      })
    ]
  }
})
