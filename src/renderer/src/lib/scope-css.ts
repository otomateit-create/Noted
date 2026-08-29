/**
 * Le style d'un cours HTML, confine a son conteneur.
 *
 * Un cours HTML arrive avec sa propre feuille de style, ecrite pour une page
 * entiere : elle pose ses couleurs sur `:root`, sa police sur `body`, ses
 * marges sur `h2`. Injectee telle quelle, elle habillerait toute
 * l'application — Noted nomme ses jetons `--text` et `--space-*`, exactement
 * comme le fait n'importe quel artefact. Et l'inverse vaut aussi : le cours
 * n'est pas dans une iframe, parce que tout l'appareil du panneau — le
 * surlignage par recherche de texte, les ancres des notes, la ligne de lecture
 * — suppose que le document est dans le meme DOM que le reste.
 *
 * On reecrit donc chaque selecteur pour qu'il ne s'applique que sous le
 * conteneur du cours : `h2` devient `.document-html h2`, et `:root`, `html`,
 * `body` deviennent le conteneur lui-meme, puisque c'est lui qui tient lieu de
 * page. Le navigateur fait l'analyse (`CSSStyleSheet`) : pas d'analyseur CSS
 * maison, et les regles imbriquees — `@media`, `@supports`, `@container` —
 * sont parcourues telles qu'il les comprend.
 *
 * Ce qu'on retire au passage : les ressources externes, que la politique de
 * securite de la page bloquerait de toute facon en silence ; le theme sombre,
 * l'application etant claire et le cours devant rester lisible dedans ; et
 * `position: fixed`, qui sortirait un bandeau du panneau pour le coller sur
 * l'interface.
 *
 * Ce qu'on traduit, enfin : tout ce qui mesure la fenetre. Un artefact est
 * ecrit responsive — sa grille s'empile, ses colonnes se rangent — mais il le
 * dit en `@media (max-width: ...)`, qui mesure la fenetre de l'application.
 * Celle-ci fait toute la largeur de l'ecran quand le panneau du cours n'en
 * occupe qu'un tiers : le repli n'etait jamais atteint, et la grille debordait
 * du panneau alors que la regle pour l'eviter etait la, dans la feuille, a ne
 * jamais se declencher. Ces requetes deviennent donc des requetes de conteneur,
 * qui mesurent le panneau — et les longueurs en `vw`, des longueurs en `cqw`,
 * pour la meme raison.
 */

/** Une requete de media qui n'a de sens que pour une page sombre. */
const DARK_SCHEME = /prefers-color-scheme\s*:\s*dark/i

/** Le debut d'un selecteur qui designe la page elle-meme, et ce qui le suit. */
const PAGE_SELECTOR = /^(?::root|html|body)(?![\w-])(\s*>\s*|\s+|)/

/** Une adresse dans une valeur CSS qui ne pointe ni vers le document ni vers des donnees. */
const EXTERNAL_URL = /url\(\s*["']?\s*(?!data:|#|noted-media:)/i

/** Une longueur relative a la largeur de la fenetre — ici, celle du panneau. */
const VIEWPORT_WIDTH = /(-?\d*\.?\d+)vw\b/gi

/**
 * Les seuls mots qu'une condition de media peut contenir pour devenir une
 * condition de conteneur.
 *
 * Une liste blanche, et non une liste noire : ce qui n'est pas reconnu reste
 * une requete de media, donc se comporte comme avant. `screen` en fait partie
 * parce que l'application est un ecran et rien d'autre — la mention est vraie,
 * et se retire sans rien changer. `print` et les `prefers-*` n'y sont pas :
 * ils ne parlent pas de largeur, et n'ont pas d'equivalent qui mesure un
 * element.
 */
const CONTAINER_SAFE = new Set(['screen', 'only', 'and', 'or', 'width', 'min-width', 'max-width'])

export interface ScopedCss {
  css: string
  warnings: string[]
}

/**
 * Reecrit une feuille de style pour qu'elle ne s'applique que sous `scope`,
 * un selecteur simple — « .document-html ».
 */
export function scopeCss(css: string, scope: string): ScopedCss {
  const warnings: string[] = []

  // Une feuille importee est une ressource externe : elle n'arriverait jamais.
  // On la retire avant l'analyse, car une feuille construite ne l'accepte pas.
  const local = css.replace(/@import\b[^;]*;?/gi, () => {
    warnings.push('Une feuille de style externe (@import) a été ignorée.')
    return ''
  })

  const sheet = new CSSStyleSheet()
  try {
    sheet.replaceSync(local)
  } catch {
    warnings.push('Le style du document n’a pas pu être lu.')
    return { css: '', warnings }
  }

  return { css: rewriteRules(Array.from(sheet.cssRules), scope).join('\n'), warnings }
}

/**
 * Nettoie une declaration de style en ligne — l'attribut `style` d'un element.
 * Le navigateur l'analyse comme le reste, ce qui rend le nettoyage identique.
 */
export function cleanInlineStyle(value: string): string {
  const sheet = new CSSStyleSheet()
  try {
    sheet.replaceSync(`x{${value}}`)
  } catch {
    return ''
  }
  const rule = sheet.cssRules[0]
  if (!(rule instanceof CSSStyleRule)) return ''
  cleanDeclarations(rule.style)
  return rule.style.cssText
}

function rewriteRules(rules: CSSRule[], scope: string): string[] {
  const out: string[] = []

  for (const rule of rules) {
    // Une regle de style d'abord : avec l'imbrication CSS, elle est aussi une
    // regle de groupe, et le test de groupe l'attraperait par erreur.
    if (rule instanceof CSSStyleRule) {
      const text = rewriteStyleRule(rule, scope)
      if (text) out.push(text)
      continue
    }

    if (rule instanceof CSSMediaRule && DARK_SCHEME.test(rule.conditionText)) continue

    if (rule instanceof CSSGroupingRule) {
      const inner = rewriteRules(Array.from(rule.cssRules), scope)
      if (inner.length === 0) continue
      out.push(`${groupPrelude(rule)} {\n${inner.join('\n')}\n}`)
      continue
    }

    if (rule instanceof CSSFontFaceRule) {
      // Une police a telecharger ne viendra pas : la regle ne servirait a rien.
      if (EXTERNAL_URL.test(rule.style.getPropertyValue('src'))) continue
      out.push(rule.cssText)
      continue
    }

    if (
      rule instanceof CSSImportRule ||
      rule instanceof CSSNamespaceRule ||
      rule instanceof CSSPageRule
    ) {
      continue
    }

    // @keyframes, @property, @font-feature-values : pas de selecteur, rien a
    // confiner.
    out.push(rule.cssText)
  }

  return out
}

/** Le debut d'une regle de groupe — « @media (max-width: 600px) » — tel que le navigateur l'ecrit. */
function prelude(rule: CSSRule): string {
  const text = rule.cssText
  return text.slice(0, text.indexOf('{')).trim()
}

/**
 * Le debut d'une regle de groupe, une requete de media sur la largeur devenant
 * une requete de conteneur : c'est le panneau qu'elle doit mesurer, pas la
 * fenetre.
 */
function groupPrelude(rule: CSSRule): string {
  const text = prelude(rule)
  if (!(rule instanceof CSSMediaRule)) return text

  const condition = containerCondition(rule.conditionText)
  return condition === null ? text : `@container ${condition}`
}

/**
 * La condition d'un `@media` traduite pour un conteneur, ou null si elle parle
 * d'autre chose que de largeur — et doit alors rester une requete de media.
 *
 * La virgule d'une liste de requetes devient un `or` : une condition de
 * conteneur ne connait pas la virgule, mais elle connait l'alternative.
 */
function containerCondition(condition: string): string | null {
  // Les longueurs partent d'abord, sans quoi le « px » de « 760px » passerait
  // pour un mot que la liste blanche ne connait pas.
  const words = condition
    .replace(/-?\d*\.?\d+[a-z%]*/gi, ' ')
    .toLowerCase()
    .match(/[a-z][a-z0-9-]*/g)

  if (!words || !words.every((word) => CONTAINER_SAFE.has(word))) return null
  if (!words.some((word) => word.endsWith('width'))) return null

  const rewritten = condition
    .replace(/\bonly\s+screen\b|\bscreen\b/gi, ' ')
    .replace(/,/g, ' or ')
    .replace(/^\s*(?:and|or)\b\s*/i, '')
    .replace(/\s*\b(?:and|or)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  return rewritten || null
}

function rewriteStyleRule(rule: CSSStyleRule, scope: string): string | null {
  cleanDeclarations(rule.style)

  // Les regles imbriquees dans celle-ci sont relatives a son selecteur : elles
  // sont deja confinees par lui, on les recopie telles quelles.
  const nested = Array.from(rule.cssRules).map((child) => child.cssText)
  if (rule.style.length === 0 && nested.length === 0) return null

  const selectors = splitSelectors(rule.selectorText).map((selector) =>
    scopeSelector(selector, scope)
  )

  return `${selectors.join(', ')} {\n${rule.style.cssText}\n${nested.join('\n')}\n}`
}

/**
 * Retire d'une declaration ce qui n'a pas sa place dans le panneau : les
 * ressources externes, et le positionnement fixe, ramene a `sticky` — ce qui
 * s'en rapproche le plus a l'interieur d'une zone qui defile. Et rapporte au
 * panneau ce qui se rapportait a la fenetre : une largeur en `vw`.
 */
function cleanDeclarations(style: CSSStyleDeclaration): void {
  for (const name of Array.from(style)) {
    const value = style.getPropertyValue(name)
    if (EXTERNAL_URL.test(value)) {
      style.removeProperty(name)
      continue
    }
    if (name === 'position' && value === 'fixed') {
      style.setProperty('position', 'sticky', style.getPropertyPriority(name))
      continue
    }
    // `content` est du texte a afficher : un « 5vw » y est un mot, pas une
    // longueur. On compare plutot que de tester, la substitution rendant
    // d'elle-meme la valeur inchangee quand il n'y avait rien a traduire.
    if (name === 'content') continue
    const rebased = value.replace(VIEWPORT_WIDTH, '$1cqw')
    if (rebased !== value) style.setProperty(name, rebased, style.getPropertyPriority(name))
  }
}

/**
 * Les selecteurs d'une liste, separes sur les virgules de premier niveau —
 * pas celles de `:is(a, b)` ni d'un attribut.
 */
function splitSelectors(list: string): string[] {
  const selectors: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''

  for (const character of list) {
    if (quote) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '(' || character === '[') {
      depth += 1
    } else if (character === ')' || character === ']') {
      depth -= 1
    } else if (character === ',' && depth === 0) {
      selectors.push(current)
      current = ''
      continue
    }
    current += character
  }
  selectors.push(current)

  return selectors.map((selector) => selector.trim()).filter(Boolean)
}

/**
 * Un selecteur, confine sous `scope`.
 *
 * `h2` devient `.document-html h2`. `body`, `html` et `:root` designent la
 * page : ils deviennent le conteneur lui-meme, et ce qui les qualifiait le
 * qualifie — `body.dark .card` devient `.document-html.dark .card`,
 * `body > main` devient `.document-html > main`.
 */
function scopeSelector(selector: string, scope: string): string {
  let rest = selector
  let combinator = ' '
  let page = false

  for (;;) {
    const match = PAGE_SELECTOR.exec(rest)
    if (!match) break
    page = true
    rest = rest.slice(match[0].length)
    combinator = match[1].includes('>') ? ' > ' : match[1] ? ' ' : ''
  }

  if (!page) return `${scope} ${rest}`
  if (!rest) return scope
  return `${scope}${combinator}${rest}`
}
