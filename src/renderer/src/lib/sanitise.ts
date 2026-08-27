/**
 * Nettoyage du HTML avant affichage.
 *
 * Deux chemins amenent du HTML a l'ecran sans qu'on l'ait ecrit : la conversion
 * des documents Word, et le rendu des cours en Markdown — qui autorise le HTML
 * en ligne. Ces fichiers viennent de l'utilisateur, mais un support de cours
 * telecharge n'est pas forcement inoffensif, et le renderer a acces au pont
 * `window.noted`. On ne laisse donc passer qu'une liste d'elements connus.
 */

import { HIGHLIGHT_COLORS } from '@shared/types'

/** Elements conserves : de quoi rendre un document, rien de plus. */
const ALLOWED = new Set([
  'p', 'br', 'hr', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'small',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'a', 'img', 'figure', 'figcaption'
])

/**
 * Elements supprimes avec leur contenu. Les autres inconnus sont simplement
 * deballes : on garde leur texte. Ceux-ci, non — afficher le corps d'un
 * <script> comme du texte serait absurde.
 */
const DROPPED = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta',
  'form', 'input', 'button', 'select', 'textarea', 'svg', 'math'
])

const ALLOWED_ATTRIBUTES = new Set([
  'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start', 'align'
])

/**
 * Attributs admis sous condition : c'est la valeur, et parfois la balise, qui
 * decident.
 *
 * Ouvrir `class`, `style` ou `data-*` en grand donnerait a un document
 * telecharge le moyen de se faire passer pour l'interface. Les supprimer tous,
 * en revanche, effacait des choses qui appartiennent au cours : la langue d'un
 * bloc de code, l'encadre d'un « > [!attention] », un titre centre. Restreints
 * a une forme connue, ces trois-la portent la mise en forme sans rien offrir.
 */
/** Les encadres reconnus : ceux de la legende de surlignage, et rien d'autre. */
const CALLOUT_IDS = new Set<string>(HIGHLIGHT_COLORS.map((colour) => colour.id))

const CONDITIONAL_ATTRIBUTES: Record<string, (value: string, tag: string) => boolean> = {
  class: (value, tag) =>
    (tag === 'pre' || tag === 'code') && /^language-[\w+-]{1,20}$/.test(value),
  style: (value, tag) =>
    (tag === 'p' || tag === 'div') && /^text-align:\s*(center|right|justify);?$/.test(value.trim()),
  'data-callout': (value) => CALLOUT_IDS.has(value)
}

/**
 * Adresses acceptees. Les images en base64 sont indispensables — c'est ainsi
 * que reviennent les schemas d'un document Word — mais on exclut le SVG, qui
 * peut porter du script.
 */
const SAFE_URL =
  /^(?:https?:\/\/|mailto:|noted-media:\/\/|data:image\/(?:png|jpeg|jpg|gif|webp);base64,)/i

export function sanitiseHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')

  for (const element of Array.from(parsed.body.querySelectorAll('*'))) {
    const tag = element.tagName.toLowerCase()

    if (DROPPED.has(tag)) {
      element.remove()
      continue
    }

    // Element inconnu : on le remplace par son contenu plutot que de le jeter,
    // pour ne pas perdre du texte du cours a cause d'une balise exotique.
    if (!ALLOWED.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()

      const admissible = CONDITIONAL_ATTRIBUTES[name]
      if (admissible) {
        if (!admissible(attribute.value, tag)) element.removeAttribute(attribute.name)
        continue
      }

      if (!ALLOWED_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name)
        continue
      }
      if ((name === 'href' || name === 'src') && !SAFE_URL.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name)
      }
    }
  }

  return parsed.body.innerHTML
}
