/**
 * Un cours ecrit en HTML : ce qu'on en garde a l'ecran, et comment l'IA le lit.
 *
 * Un artefact demande a Claude Desktop n'est rien d'autre qu'une page HTML
 * autonome — sa mise en page dans un `<style>`, ses schemas en SVG, parfois un
 * script. Le nettoyage des documents Word et Markdown (`sanitise.ts`) ne
 * convient pas ici : il jette les classes, les styles et le SVG, c'est-a-dire
 * tout ce qui fait la page. Celui-ci garde la mise en forme et ne retire que
 * ce qui pourrait agir : le script, les gestionnaires d'evenements, les
 * formulaires, les ressources externes — que la politique de securite de la
 * page bloquerait de toute facon.
 *
 * Le texte donne a l'IA est celui que l'utilisateur voit, comme pour un Word.
 * A une difference pres, qui est la raison d'etre du format : un graphique
 * n'est pas une image a dechiffrer, c'est du code. On le donne donc a lire —
 * son titre, ses libelles, et sa source quand elle reste raisonnable.
 */

import { htmlToContextText } from './document'
import { cleanInlineStyle, scopeCss } from './scope-css'

/** La classe du conteneur, sous laquelle tout le style du cours est confine. */
export const HTML_COURSE_SCOPE = 'document-html'

export interface HtmlCourse {
  /** Le corps du document, nettoye. */
  html: string
  /** Sa feuille de style, confinee au conteneur. */
  css: string
  /** Les classes que le document posait sur `<body>` : le conteneur les reprend. */
  bodyClass: string
  /** Ce qui a ete ignore, a montrer discretement. */
  warnings: string[]
}

/**
 * Elements retires avec leur contenu : ce qui agit, ce qui charge, ce qui
 * n'est pas du document.
 */
const DROPPED = new Set([
  'script', 'noscript', 'template', 'slot',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'link', 'meta', 'base', 'head',
  'form', 'input', 'select', 'textarea', 'option', 'optgroup', 'datalist', 'output',
  'dialog', 'canvas', 'audio', 'video', 'source', 'track', 'map', 'area',
  // Dans un SVG : du HTML arbitraire, et l'animation declarative.
  'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set', 'feimage'
])

/** Elements conserves. Les autres sont deballes : leur texte reste. */
const ALLOWED = new Set([
  'p', 'br', 'hr', 'span', 'div', 'main',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'small',
  'kbd', 'abbr', 'cite', 'q', 'dfn', 'time', 'var', 'samp', 'wbr', 'address', 'bdi', 'bdo',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'picture', 'figure', 'figcaption',
  'section', 'article', 'nav', 'header', 'footer', 'aside',
  'details', 'summary',
  // SVG
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'defs', 'use', 'symbol', 'marker', 'clippath', 'mask',
  'pattern', 'lineargradient', 'radialgradient', 'stop', 'title', 'desc', 'image',
  'filter', 'switch', 'view',
  // MathML
  'math', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup',
  'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover',
  'mmultiscripts', 'menclose', 'mpadded', 'mphantom', 'mstyle', 'semantics', 'annotation'
])

/** Attributs retires quels que soient leur valeur et leur element. */
const FORBIDDEN_ATTRIBUTES = new Set([
  'srcset', 'formaction', 'action', 'ping', 'target', 'rel', 'download',
  'contenteditable', 'autofocus', 'is', 'slot'
])

/** Attributs qui portent une adresse, a verifier. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'poster', 'data', 'cite', 'background'])

/**
 * Adresses admises : le web (ouvert dans le navigateur, jamais ici), une ancre
 * du document, les images de l'application, et les images en donnees — sauf
 * le SVG, qui peut porter du script.
 */
const SAFE_URL =
  /^(?:https?:\/\/|mailto:|#|noted-media:\/\/|data:image\/(?:png|jpe?g|gif|webp);base64,)/i

/** Une adresse locale a un SVG : `url(#degrade)`, `href="#symbole"`. */
const FRAGMENT = /^#/

/**
 * Prepare un cours HTML : son corps nettoye, son style confine, ses avertissements.
 */
export function prepareHtmlCourse(raw: string): HtmlCourse {
  const parsed = new DOMParser().parseFromString(raw, 'text/html')
  const warnings: string[] = []

  const scripts = parsed.querySelectorAll('script').length
  if (scripts > 0) {
    warnings.push(
      scripts === 1
        ? 'Un script a été ignoré : les parties du cours qui en dépendaient peuvent manquer.'
        : `${scripts} scripts ont été ignorés : les parties du cours qui en dépendaient peuvent manquer.`
    )
  }
  const stylesheets = parsed.querySelectorAll('link[rel~="stylesheet"]').length
  if (stylesheets > 0) {
    warnings.push(
      'Une feuille de style externe a été ignorée : le cours doit embarquer son style.'
    )
  }

  // Le style est rassemble avant le nettoyage, qui retirerait les balises
  // <style> : il vit dans le conteneur, pas dans le document.
  const css = Array.from(parsed.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n')
  for (const style of Array.from(parsed.querySelectorAll('style'))) style.remove()

  // Ce que le document posait sur <body> revient au conteneur, qui tient lieu
  // de page : sa classe, et son style en ligne — que l'on ajoute a la feuille.
  const bodyClass = parsed.body.getAttribute('class')?.trim() ?? ''
  const bodyStyle = cleanInlineStyle(parsed.body.getAttribute('style') ?? '')

  sanitise(parsed.body)

  const scoped = scopeCss(css, `.${HTML_COURSE_SCOPE}`)
  const scopedCss = bodyStyle ? `${scoped.css}\n.${HTML_COURSE_SCOPE} { ${bodyStyle} }` : scoped.css

  return {
    html: parsed.body.innerHTML,
    css: scopedCss,
    bodyClass,
    warnings: [...warnings, ...scoped.warnings]
  }
}

function sanitise(body: HTMLElement): void {
  for (const element of Array.from(body.querySelectorAll('*'))) {
    // Deja emporte avec un parent supprime.
    if (!element.isConnected) continue

    const tag = element.localName.toLowerCase()

    if (DROPPED.has(tag)) {
      element.remove()
      continue
    }

    if (!ALLOWED.has(tag)) {
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()

      if (name.startsWith('on') || FORBIDDEN_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name)
        continue
      }

      if (name === 'style') {
        const clean = cleanInlineStyle(attribute.value)
        if (clean) element.setAttribute('style', clean)
        else element.removeAttribute('style')
        continue
      }

      if (URL_ATTRIBUTES.has(name)) {
        const value = attribute.value.trim()
        // Un <use> ne peut viser que le document lui-meme.
        const admissible = tag === 'use' ? FRAGMENT.test(value) : SAFE_URL.test(value)
        if (!admissible) element.removeAttribute(attribute.name)
      }
    }

    // Un lien vers le web passe par le gardien de la fenetre, qui l'ouvre dans
    // le navigateur : sans cela, il naviguerait l'application elle-meme.
    if (tag === 'a') {
      const href = element.getAttribute('href')
      if (href && !FRAGMENT.test(href)) {
        element.setAttribute('target', '_blank')
        element.setAttribute('rel', 'noreferrer')
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Le texte pour l'IA
// ---------------------------------------------------------------------------

/**
 * Au-dela de cette taille, la source d'un graphique n'apprend plus rien au
 * modele — un trace de mille coordonnees ne se lit pas — et elle noierait le
 * vecteur du passage. Les libelles suffisent alors.
 */
const SVG_SOURCE_MAX = 4_000

/**
 * Le texte d'un cours HTML tel que l'IA le lit : ce que l'utilisateur voit,
 * plus les graphiques donnes en code.
 *
 * Le HTML recu est celui qui vient d'etre nettoye et affiche : ce que lit le
 * modele est exactement ce qui est a l'ecran.
 */
export function htmlCourseToContextText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')

  for (const svg of Array.from(parsed.body.querySelectorAll('svg'))) {
    // Un SVG dans un SVG est parti avec le premier.
    if (!svg.isConnected) continue
    svg.replaceWith(figureBlock(parsed, svg))
  }

  // Le titre d'un depliant devient une ligne en gras : la question reste
  // distincte de sa reponse une fois le tout mis a plat.
  for (const summary of Array.from(parsed.body.querySelectorAll('summary'))) {
    const line = parsed.createElement('p')
    const strong = parsed.createElement('strong')
    strong.append(...Array.from(summary.childNodes))
    line.appendChild(strong)
    summary.replaceWith(line)
  }

  return htmlToContextText(parsed.body.innerHTML)
}

/**
 * Ce qu'un graphique devient dans le texte : un marqueur de figure avec son
 * titre, sa description, ses libelles dans l'ordre, et sa source compactee.
 */
function figureBlock(parsed: Document, svg: SVGElement): HTMLElement {
  const block = parsed.createElement('div')

  const title =
    directChildText(svg, 'title') || svg.getAttribute('aria-label')?.trim() || ''
  const description = directChildText(svg, 'desc')
  const labels = Array.from(svg.querySelectorAll('text'))
    .map((text) => text.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)

  addLine(parsed, block, title ? `[figure : ${title}]` : '[figure]')
  if (description) addLine(parsed, block, `Description : ${description}`)
  if (labels.length > 0) addLine(parsed, block, `Libellés : ${labels.join(' · ')}`)

  const source = compactSvg(svg)
  if (source.length <= SVG_SOURCE_MAX) {
    const pre = parsed.createElement('pre')
    const code = parsed.createElement('code')
    code.className = 'language-svg'
    code.textContent = source
    pre.appendChild(code)
    block.appendChild(pre)
  } else {
    addLine(parsed, block, `(source SVG de ${source.length} caractères, non reproduite)`)
  }

  return block
}

function directChildText(svg: SVGElement, tag: string): string {
  for (const child of Array.from(svg.children)) {
    if (child.localName.toLowerCase() === tag) {
      return child.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    }
  }
  return ''
}

function addLine(parsed: Document, block: HTMLElement, text: string): void {
  const line = parsed.createElement('p')
  line.textContent = text
  block.appendChild(line)
}

/**
 * La source d'un SVG, reduite a ce qui se lit : les blancs ramenes a un, les
 * decimales arrondies. Un trace a six decimales n'est pas plus parlant qu'a une.
 */
function compactSvg(svg: SVGElement): string {
  return svg.outerHTML
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/-?\d+\.\d+/g, (number) => {
      const rounded = Math.round(Number(number) * 10) / 10
      return String(rounded)
    })
    .trim()
}
