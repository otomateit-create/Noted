/**
 * Formules dans l'editeur de notes.
 *
 * L'extension de TipTap attend une notation qui lui est propre : $$…$$ pour une
 * formule au fil du texte, $$$…$$$ pour une formule centree. Ce n'est ni la
 * notation de LaTeX, ni celle qu'ecrit l'assistant, ni celle qu'Obsidian relit.
 * On redefinit donc ses regles de saisie sur la convention universelle :
 *
 *     $E = mc^2$        formule au fil du texte
 *     $$E = mc^2$$      formule isolee et centree
 *
 * Les regards en arriere et en avant evitent que la regle en ligne ne morde sur
 * une formule centree en cours de frappe.
 */

import { InputRule } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'

const KATEX_OPTIONS = {
  // Une formule incomplete pendant la frappe ne doit pas faire disparaitre la
  // note : KaTeX l'affiche en rouge et l'edition continue.
  throwOnError: false,
  strict: 'ignore' as const
}

const InlineFormula = InlineMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /(?<!\$)\$([^$\n]+?)\$(?!\$)/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }))
        }
      })
    ]
  }
})

const BlockFormula = BlockMath.extend({
  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$([^$\n]+?)\$\$$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }))
        }
      })
    ]
  }
})

/** Les deux extensions de formule, pretes a etre placees dans l'editeur. */
export const mathExtensions = [
  InlineFormula.configure({ katexOptions: KATEX_OPTIONS }),
  BlockFormula.configure({ katexOptions: KATEX_OPTIONS })
]
