/**
 * Taille de police en ligne, portee par la marque `textStyle` — au meme titre
 * que la couleur (Color). Un span qui porte deja `style="color: …"` recoit
 * simplement `font-size: …` en plus : Tiptap fusionne les styles de toutes les
 * extensions d'une meme marque au rendu.
 *
 * A la difference des anciens titres (H1/H2/H3), une marque s'applique
 * uniquement au texte selectionne, jamais au bloc entier — c'est le
 * comportement attendu, celui du selecteur de taille de Word.
 */
import { Extension } from '@tiptap/core'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (size: string) => ReturnType
      unsetFontSize: () => ReturnType
    }
  }
}

export const FontSize = Extension.create({
  name: 'fontSize',

  addOptions() {
    return { types: ['textStyle'] }
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.fontSize || null,
            renderHTML: (attributes: { fontSize?: string | null }) => {
              if (!attributes.fontSize) return {}
              return { style: `font-size: ${attributes.fontSize}` }
            }
          }
        }
      }
    ]
  },

  addCommands() {
    return {
      setFontSize:
        (size: string) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize: null }).run()
    }
  }
})
