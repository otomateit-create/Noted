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
 *
 * Reste ce qui ne vit que par le script : un curseur, un pas-a-pas, un index
 * qu'il remplit. Ces parties-la s'affichent dans un cadre isole ou le script
 * tourne (course-frames.ts), le reste du cours demeurant dans le panneau. Le
 * texte donne a l'IA, lui, reste celui de la version nettoyee.
 */

import { htmlToContextText } from './document'
import { cleanInlineStyle, scopeCss } from './scope-css'

/** La classe du conteneur, sous laquelle tout le style du cours est confine. */
export const HTML_COURSE_SCOPE = 'document-html'

export interface HtmlCourse {
  /** Le corps du document, nettoye — ce que lit l'IA. */
  html: string
  /**
   * Si le cours a des parties vivantes : le corps a afficher, ou chacune est
   * remplacee par un cadre, et la page entiere que ces cadres chargent.
   */
  live: { html: string; page: string } | null
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

  // Les parties vivantes sont reperees sur la page brute : le nettoyage
  // retirerait les boutons et les champs qui les signalent.
  const parts = markLiveParts(parsed)
  const page = parts > 0 ? framePage(parsed) : null

  const scripts = parsed.querySelectorAll('script').length
  if (scripts > 0 && parts === 0) {
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

  // Le corps affiche est une copie ou chaque partie vivante laisse une place
  // marquee ; l'original perd ses marques, qui finiraient sinon dans la
  // source des graphiques donnee a l'IA.
  const liveBody = parts > 0 ? withPlaceholders(parsed.body) : null
  unmark(parsed.body)

  sanitise(parsed.body)
  if (liveBody) {
    sanitise(liveBody)
    placeFrames(liveBody)
  }

  const scoped = scopeCss(css, `.${HTML_COURSE_SCOPE}`)
  const scopedCss = bodyStyle ? `${scoped.css}\n.${HTML_COURSE_SCOPE} { ${bodyStyle} }` : scoped.css

  return {
    html: parsed.body.innerHTML,
    live: liveBody && page ? { html: liveBody.innerHTML, page } : null,
    css: scopedCss,
    bodyClass,
    warnings: [...warnings, ...scoped.warnings]
  }
}

function sanitise(body: HTMLElement): void {
  for (const element of Array.from(body.querySelectorAll('*'))) {
    // Deja emporte avec un parent supprime. `contains` plutot que
    // `isConnected` : le corps a afficher est une copie detachee, ou rien
    // n'est jamais « connecte ».
    if (!body.contains(element)) continue

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
// Les parties vivantes
// ---------------------------------------------------------------------------

/** Ce qui ne sert a rien sans le script du cours, ou que le seul CSS anime. */
const LIVE = 'button, input, select, textarea, canvas'

/**
 * Nommes par le script sans pour autant bouger : un sommaire qui suit la
 * lecture vise les titres et les sections. Les compter enfermerait des
 * chapitres entiers dans un cadre, ou l'on ne peut plus surligner.
 */
const NAMED_BUT_STILL = 'h1, h2, h3, h4, h5, h6, section, article, main, header, footer, nav, aside'

/** L'enveloppe d'une partie, qui garde sa place et son habillage dans le cours. */
const SHELL = 'data-noted-shell'
/** Les enfants de l'enveloppe confies au cadre — aucun : tout son contenu. */
const PART = 'data-noted-part'
/** La place, puis le cadre, d'une partie dans le corps affiche. */
const FRAME = 'data-noted-frame'

/**
 * Marque les parties vivantes et rend leur nombre.
 *
 * Une partie vivante tient dans une figure, a defaut dans une section : c'est
 * l'enveloppe. Le cadre n'en prend que les enfants qui vont du premier au
 * dernier element vivant, si bien qu'un titre ou une legende autour restent
 * dans le cours, surlignables. Les commandes hors de toute section — un
 * bouton de theme, un menu — sont l'habillage de la page, pas le cours.
 */
function markLiveParts(parsed: Document): number {
  const script = Array.from(parsed.querySelectorAll('script'), (s) => s.textContent ?? '').join('\n')

  const live = new Set<Element>(parsed.body.querySelectorAll(LIVE))
  if (script) {
    for (const element of Array.from(parsed.body.querySelectorAll('[id]'))) {
      if (!element.matches(NAMED_BUT_STILL) && namedByScript(script, element.id)) live.add(element)
    }
  }

  // Par enveloppe, les enfants qui portent quelque chose de vivant. Aucun,
  // quand seule l'enveloppe est nommee : c'est elle que le script remplit, le
  // cadre prend tout son contenu.
  const wanted = new Map<Element, Set<Element>>()
  for (const element of live) {
    const shell = outermostFigure(element) ?? element.parentElement?.closest('section, article')
    if (!shell) continue
    const members = wanted.get(shell) ?? new Set<Element>()
    wanted.set(shell, members)
    if (element !== shell) members.add(childOf(shell, element))
  }

  // Dans une partie vivante, ce qui est cache attend que le script le montre :
  // un onglet dont l'identifiant est calcule (« "#ipo-" + x ») echappe au
  // reperage par le nom, et resterait sinon invisible dans le cours.
  for (const [shell, want] of wanted) {
    if (want.size === 0) continue
    for (const child of Array.from(shell.children)) {
      if (child.matches('[hidden]') || child.querySelector('[hidden]')) want.add(child)
    }
  }

  const parts: { shell: Element; members: Element[] | null }[] = []
  for (const [shell, want] of wanted) {
    if (want.size === 0) {
      parts.push({ shell, members: null })
      continue
    }
    const children = Array.from(shell.children)
    const indices = Array.from(want, (child) => children.indexOf(child))
    parts.push({ shell, members: children.slice(Math.min(...indices), Math.max(...indices) + 1) })
  }

  // Une partie prise dans une autre est deja montree par le cadre de celle-ci.
  const covers = (outer: (typeof parts)[number], inner: (typeof parts)[number]): boolean =>
    outer !== inner &&
    (outer.members
      ? outer.members.some((member) => member.contains(inner.shell))
      : outer.shell !== inner.shell && outer.shell.contains(inner.shell))
  const kept = parts.filter((part) => !parts.some((other) => covers(other, part)))

  kept.forEach((part, index) => {
    part.shell.setAttribute(SHELL, String(index))
    for (const member of part.members ?? []) member.setAttribute(PART, String(index))
  })
  return kept.length
}

/** Le script nomme-t-il cet identifiant — « #mimRange », « "sgSvg" » ? */
function namedByScript(script: string, id: string): boolean {
  const name = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`#${name}(?![\\w-])|["']${name}["']`).test(script)
}

function outermostFigure(element: Element): Element | null {
  let figure = element.closest('figure')
  for (let outer = figure?.parentElement?.closest('figure'); outer; outer = outer.parentElement?.closest('figure')) {
    figure = outer
  }
  return figure
}

/** L'enfant direct de `ancestor` qui contient `element`. */
function childOf(ancestor: Element, element: Element): Element {
  let child = element
  while (child.parentElement && child.parentElement !== ancestor) child = child.parentElement
  return child
}

function unmark(body: HTMLElement): void {
  for (const element of Array.from(body.querySelectorAll(`[${SHELL}], [${PART}]`))) {
    element.removeAttribute(SHELL)
    element.removeAttribute(PART)
  }
}

/**
 * La page que chargent les cadres : le document entier, script compris, car
 * le script cherche ses elements partout. Chaque cadre n'en montre qu'une
 * partie, que lui designe son adresse.
 */
function framePage(parsed: Document): string {
  const style = parsed.createElement('style')
  style.textContent = FRAME_STYLE
  const script = parsed.createElement('script')
  script.textContent = FRAME_SCRIPT
  parsed.head.prepend(style, script)

  const page = `<!doctype html>\n${parsed.documentElement.outerHTML}`
  style.remove()
  script.remove()
  return page
}

/** Une copie du corps ou chaque partie vivante a cede la place a un repere. */
function withPlaceholders(body: HTMLElement): HTMLElement {
  const copy = body.cloneNode(true) as HTMLElement

  for (const shell of Array.from(copy.querySelectorAll(`[${SHELL}]`))) {
    const index = shell.getAttribute(SHELL) ?? ''
    shell.removeAttribute(SHELL)
    const place = copy.ownerDocument.createElement('div')
    place.setAttribute(FRAME, index)

    const members = Array.from(shell.children).filter((child) => child.getAttribute(PART) === index)
    if (members.length === 0) {
      shell.replaceChildren(place)
      continue
    }

    // Du premier au dernier, texte compris : ce qui est entre deux appartient
    // a la partie.
    const last = members[members.length - 1]
    shell.insertBefore(place, members[0])
    for (let node: ChildNode | null = members[0]; node; ) {
      const next: ChildNode | null = node === last ? null : node.nextSibling
      node.remove()
      node = next
    }
  }

  return copy
}

/** Les reperes deviennent des cadres, une fois le nettoyage passe. */
function placeFrames(body: HTMLElement): void {
  for (const place of Array.from(body.querySelectorAll(`div[${FRAME}]`))) {
    const frame = body.ownerDocument.createElement('iframe')
    frame.setAttribute(FRAME, place.getAttribute(FRAME) ?? '')
    // Des scripts, mais une origine opaque : ni le preload, ni le stockage,
    // ni la fenetre de l'application ne lui sont accessibles.
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('title', 'Partie interactive du cours')
    place.replaceWith(frame)
  }
}

/**
 * Branche les cadres d'un cours affiche, et rend de quoi les debrancher.
 *
 * Chaque cadre recoit son adresse, puis parle par messages : sa hauteur, qu'il
 * ne peut pas imposer lui-meme ; un lien, qu'il ne doit pas suivre chez lui ;
 * un raccourci ou un pincement, que le clavier et le trackpad lui donneraient
 * sinon au lieu de l'application.
 */
export function connectFrames(
  root: HTMLElement,
  base: string,
  goToAnchor: (id: string) => void
): () => void {
  const frames = Array.from(root.querySelectorAll<HTMLIFrameElement>(`iframe[${FRAME}]`))
  for (const frame of frames) frame.src = `${base}?part=${frame.getAttribute(FRAME)}`

  const onMessage = (event: MessageEvent): void => {
    const frame = frames.find((candidate) => candidate.contentWindow === event.source)
    const data: unknown = event.data
    if (!frame || typeof data !== 'object' || data === null) return
    const message = data as Record<string, unknown>

    if (message.type === 'height' && typeof message.height === 'number') {
      frame.style.height = `${Math.max(0, Math.min(message.height, 100_000))}px`
    } else if (message.type === 'link' && typeof message.href === 'string') {
      const href = message.href
      if (href.startsWith('#')) goToAnchor(decodeURIComponent(href.slice(1)))
      // Le gardien de la fenetre l'ouvre dans le navigateur.
      else if (/^(?:https?:|mailto:)/i.test(href)) window.open(href, '_blank')
    } else if (message.type === 'key' && typeof message.key === 'string') {
      frame.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: message.key,
          code: String(message.code ?? ''),
          metaKey: message.metaKey === true,
          ctrlKey: message.ctrlKey === true,
          shiftKey: message.shiftKey === true,
          altKey: message.altKey === true,
          bubbles: true,
          cancelable: true
        })
      )
    } else if (message.type === 'pinch' && typeof message.deltaY === 'number') {
      frame.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: message.deltaY,
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    }
  }

  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

/**
 * Dans le cadre : tout est cache sauf la partie, et ses ancetres perdent leur
 * boite pour qu'elle commence au bord. L'enveloppe perd aussi la sienne — fond,
 * bordure, marges : c'est le cours, autour du cadre, qui la dessine deja.
 */
const FRAME_STYLE = `
[data-noted-hide] { display: none !important; }
[data-noted-path], [data-noted-here] {
  margin: 0 !important; padding: 0 !important; border: 0 !important;
  width: auto !important; max-width: none !important; min-width: 0 !important;
  height: auto !important; min-height: 0 !important;
  background: transparent !important; box-shadow: none !important; transform: none !important;
}
[data-noted-path] { display: block !important; position: static !important; overflow: visible !important; }
html[data-noted-path] { overflow: hidden !important; }
[data-noted-here]::before, [data-noted-here]::after { display: none !important; }
`

/** Ecrit en JavaScript ancien, sans balise fermante : il est colle tel quel dans la page. */
const FRAME_SCRIPT = `
(function () {
  var part = new URLSearchParams(location.search).get('part');
  function post(message) { message.noted = true; parent.postMessage(message, '*'); }

  document.addEventListener('DOMContentLoaded', function () {
    var shell = document.querySelector('[${SHELL}="' + part + '"]');
    if (!shell) return;
    if (document.querySelector('[${PART}="' + part + '"]')) {
      for (var i = 0; i < shell.children.length; i++) {
        var child = shell.children[i];
        if (child.getAttribute('${PART}') !== part) child.setAttribute('data-noted-hide', '');
      }
    }
    shell.setAttribute('data-noted-here', '');
    for (var node = shell; node.parentElement; node = node.parentElement) {
      var parentNode = node.parentElement;
      parentNode.setAttribute('data-noted-path', '');
      for (var j = 0; j < parentNode.children.length; j++) {
        if (parentNode.children[j] !== node) parentNode.children[j].setAttribute('data-noted-hide', '');
      }
    }
    var root = document.documentElement;
    new ResizeObserver(function () {
      post({ type: 'height', height: Math.ceil(root.getBoundingClientRect().height) });
    }).observe(root);
  });

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    post({ type: 'link', href: link.getAttribute('href') });
  }, true);

  document.addEventListener('keydown', function (event) {
    if (!event.metaKey && !event.ctrlKey) return;
    post({
      type: 'key', key: event.key, code: event.code, metaKey: event.metaKey,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey
    });
  });

  // Le pincement du trackpad arrive en molette avec Ctrl : il grossit le cours.
  document.addEventListener('wheel', function (event) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    post({ type: 'pinch', deltaY: event.deltaY });
  }, { passive: false });
})();
`

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
