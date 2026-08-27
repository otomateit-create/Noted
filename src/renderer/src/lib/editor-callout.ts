/**
 * Encadres semantiques dans l'editeur de notes.
 *
 * Une definition dans un cadre vert, une formule dans un cadre bleu : en
 * relisant, l'oeil retrouve ce qu'il cherche sans lire. Les cinq couleurs sont
 * exactement celles des surlignages — un encadre « pas compris » a le meme
 * sens qu'un passage surligne « pas compris ».
 *
 * Sur le disque, c'est la syntaxe d'Obsidian :
 *
 *     > [!definition] Le WACC
 *     > Le cout moyen pondere du capital.
 *
 * Le premier bloc est le titre, le reste le corps. Rien n'est fige dans un
 * attribut : on tape dedans comme dans n'importe quel paragraphe.
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { HIGHLIGHT_COLORS } from '@shared/types'
import type { HighlightColorId } from '@shared/types'

const COLOUR_IDS = HIGHLIGHT_COLORS.map((colour) => colour.id) as string[]

/** Le libelle de la legende, servant de titre par defaut a un encadre neuf. */
export function calloutLabel(colour: string): string {
  return HIGHLIGHT_COLORS.find((entry) => entry.id === colour)?.label ?? colour
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Entoure le bloc courant d'un encadre de cette couleur. */
      setCallout: (colour: HighlightColorId) => ReturnType
      /** Retire l'encadre en gardant son contenu. */
      unsetCallout: () => ReturnType
      /** Supprime l'encadre et ce qu'il contient. */
      deleteCallout: () => ReturnType
    }
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  // Un encadre garde son identite quand on edite dedans, plutot que d'etre
  // avale par le bloc qu'on est en train d'ecrire.
  defining: true,

  addAttributes() {
    return {
      colour: {
        default: HIGHLIGHT_COLORS[0].id,
        parseHTML: (element) => {
          const value = element.getAttribute('data-callout') ?? ''
          // Une couleur inconnue — un encadre Obsidian d'un autre type, par
          // exemple — retombe sur la premiere plutot que de casser le rendu.
          return COLOUR_IDS.includes(value) ? value : HIGHLIGHT_COLORS[0].id
        },
        renderHTML: (attributes) => ({ 'data-callout': attributes.colour })
      }
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'note-callout' }), 0]
  },

  addCommands() {
    return {
      setCallout:
        (colour) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { colour }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),

      // « Retirer » garde le texte et jette le cadre ; la croix jette les deux.
      // Il faut donc remonter jusqu'a l'encadre : le curseur est dans un de ses
      // paragraphes, jamais sur lui.
      deleteCallout:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection

          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.name !== this.name) continue
            if (dispatch) dispatch(state.tr.delete($from.before(depth), $from.after(depth)))
            return true
          }

          return false
        }
    }
  }
})
