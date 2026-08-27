/**
 * Le tableau de l'editeur, augmente de son habillage.
 *
 * TipTap fournit le tableau ; on lui ajoute deux attributs — un design et une
 * couleur d'accent — qui ne changent que son apparence. Ils survivent a
 * l'aller-retour Markdown grace au commentaire pose au-dessus du tableau
 * (voir `markdown.ts`), si bien qu'un tableau garde son habillage d'une
 * session a l'autre sans que la note cesse d'etre un fichier Markdown
 * ordinaire.
 */

import { Table, TableView } from '@tiptap/extension-table'
import type { TableOptions } from '@tiptap/extension-table'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { DEFAULT_TABLE_ACCENT, DEFAULT_TABLE_DESIGN } from '@shared/types'
import type { TableAccent, TableDesign } from '@shared/types'

/**
 * Le tableau tel qu'il s'affiche a l'ecran.
 *
 * Des que les colonnes sont redimensionnables, ce n'est plus `renderHTML` qui
 * construit le tableau visible mais cette vue, fournie a prosemirror-tables par
 * le greffon de redimensionnement — et il l'instancie sans lui passer les
 * attributs du noeud. L'habillage n'arrivait donc jamais jusqu'au DOM, alors
 * meme qu'il etait correct dans le document et dans le Markdown enregistre.
 *
 * On le repose ici, a la construction et a chaque mise a jour. Ecrire sur le
 * tableau depuis sa propre vue est sans danger : `ignoreMutation` ecarte deja
 * les changements d'attributs poses hors du contenu editable.
 */
class StyledTableView extends TableView {
  constructor(
    node: ProseMirrorNode,
    cellMinWidth: number,
    view?: EditorView,
    HTMLAttributes?: Record<string, unknown>
  ) {
    super(node, cellMinWidth, view, HTMLAttributes)
    this.dress(node)
  }

  update(node: ProseMirrorNode): boolean {
    const kept = super.update(node)
    if (kept) this.dress(node)
    return kept
  }

  private dress(node: ProseMirrorNode): void {
    this.table.setAttribute('data-design', String(node.attrs.design ?? DEFAULT_TABLE_DESIGN))
    this.table.setAttribute('data-accent', String(node.attrs.accent ?? DEFAULT_TABLE_ACCENT))
    this.table.setAttribute('data-largeurs', hasSetWidths(node) ? 'tirees' : 'libres')
  }
}

/**
 * Une colonne a-t-elle recu une largeur ?
 *
 * Les largeurs figees sont indispensables au redimensionnement — mais tant
 * qu'aucune n'existe, elles donnent a chaque colonne exactement la meme part,
 * et une colonne de trois mots occupe autant de place que la description qui en
 * fait quinze. La feuille de style s'en remet donc a cette reponse pour choisir
 * entre largeurs libres et largeurs figees (voir `notes.css`).
 *
 * On lit le document plutot que le DOM : prosemirror pose `min-width` sur les
 * colonnes libres comme `width` sur les autres, et distinguer les deux dans une
 * chaine de style serait un pari sur son ecriture.
 */
function hasSetWidths(node: ProseMirrorNode): boolean {
  const row = node.firstChild
  if (!row) return false

  for (let index = 0; index < row.childCount; index++) {
    const widths = row.child(index).attrs.colwidth
    if (Array.isArray(widths) && widths.some(Boolean)) return true
  }

  return false
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    styledTable: {
      /** Habille le tableau qui contient la selection. */
      setTableStyle: (style: { design?: TableDesign; accent?: TableAccent }) => ReturnType
    }
  }
}

export const StyledTable = Table.extend({
  addOptions(): TableOptions {
    // Le parent existe toujours pour une extension derivee ; le typage, lui,
    // le declare facultatif.
    return {
      ...(this.parent?.() as TableOptions),
      View: StyledTableView
    }
  },

  addAttributes() {
    return {
      ...this.parent?.(),

      design: {
        default: DEFAULT_TABLE_DESIGN,
        parseHTML: (element) => element.getAttribute('data-design') ?? DEFAULT_TABLE_DESIGN,
        renderHTML: (attributes) => ({ 'data-design': attributes.design })
      },

      accent: {
        default: DEFAULT_TABLE_ACCENT,
        parseHTML: (element) => element.getAttribute('data-accent') ?? DEFAULT_TABLE_ACCENT,
        renderHTML: (attributes) => ({ 'data-accent': attributes.accent })
      }
    }
  },

  addCommands() {
    return {
      ...this.parent?.(),

      setTableStyle:
        (style) =>
        ({ state, dispatch }) => {
          // On remonte depuis la selection jusqu'au tableau qui la contient :
          // le curseur est dans une cellule, jamais sur le tableau lui-meme.
          const { $from } = state.selection

          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth)
            if (node.type.name !== this.name) continue

            if (dispatch) {
              dispatch(
                state.tr.setNodeMarkup($from.before(depth), undefined, {
                  ...node.attrs,
                  ...style
                })
              )
            }
            return true
          }

          return false
        }
    }
  }
})
