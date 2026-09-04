/**
 * Rendu des formules mathematiques dans le texte affiche.
 *
 * L'assistant ecrit ses formules en LaTeX, entre $ ou entre $$. Laissees telles
 * quelles, elles s'affichent en charabia : « $\frac{Dette nette}{EBITDA}$ ».
 * KaTeX les compose vraiment, comme dans un manuel.
 *
 * L'extraction precede l'analyse Markdown, sinon celle-ci abime le LaTeX :
 * les underscores deviennent de l'italique et les antislashs disparaissent.
 * La reinsertion, elle, vient en dernier — apres le nettoyage du HTML, qui
 * supprimerait les classes dont KaTeX a besoin pour se mettre en page.
 */

import katex from 'katex'

interface Formula {
  tex: string
  /** true pour une formule isolee et centree, false pour une formule en ligne. */
  display: boolean
}

export interface ProtectedMarkdown {
  /** Markdown ou les formules ont ete remplacees par des jetons inertes. */
  text: string
  formulas: Formula[]
}

/**
 * Jeton purement alphanumerique : l'analyseur Markdown le traverse sans y
 * toucher, la ou une suite de symboles se ferait echapper.
 */
function token(index: number): string {
  return `zzformulezz${index}zz`
}

const TOKEN_PATTERN = /zzformulezz(\d+)zz/g

/**
 * Un bloc de code ferme. Les deux marqueurs de Markdown comptent : ne blinder
 * que les ``` laissait un extrait ouvert par ~~~ a la merci de la recherche de
 * formules, et un « $100 » dans du code y devenait du KaTeX — du HTML compose
 * au milieu d'un bloc de code, ou il s'interpretait comme des balises.
 */
export const FENCED_CODE = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm

/**
 * Une formule ecrite comme un bloc de code de langage « math ». C'est la forme
 * qu'emploient plusieurs generateurs de Markdown ; sans cette regle, le bloc
 * s'affiche en LaTeX brut dans un cadre gris.
 */
const MATH_FENCE = /^[ \t]*(```|~~~)(?:math|latex|tex)[ \t]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/gm

/**
 * Une formule en ligne entre dollars.
 *
 * Le dollar est aussi une monnaie, et un cours de private equity en est plein :
 * « ($m) », « 90 M$ », « 20 $ ». Tout l'enjeu est de ne pas prendre deux
 * montants pour les bornes d'une formule — auquel cas la phrase entre les deux
 * part en italique de mathematiques, et une ligne de tableau perd une colonne,
 * donc son tableau.
 *
 * Trois garde-fous dans l'expression, chacun pose sur un cas rencontre pour de
 * vrai dans le vault :
 *
 * 1. Le dollar ouvrant colle a ce qui suit, le fermant colle a ce qui precede
 *    (regle de Pandoc). « le fonds a leve $500m puis $1,2bn » cesse d'etre lu
 *    comme la formule « 500m puis ».
 * 2. Le dollar ouvrant n'est pas suivi d'une ponctuation fermante : une formule
 *    ne commence jamais par « ) », « , » ou « . ». Sans cette regle,
 *    « (4,5 M d'actions a 20 $) plus les impots […] encaisse 90 M$ » composait
 *    la phrase entiere en mathematiques.
 * 3. Le dollar fermant n'est suivi ni d'une lettre ni d'un chiffre. C'est ce qui
 *    sauve les tableaux : dans « | Cash net encaisse ($m) | Equity value ($m) |
 *    Enterprise value ($m) | », aucun des trois dollars ne peut fermer, puisque
 *    chacun est suivi d'un « m ». L'entete gardait sinon quatre colonnes la ou
 *    la ligne de separation en annonce cinq — Markdown refuse alors le tableau
 *    et le rend en un seul paragraphe, ou les retours a la ligne deviennent des
 *    espaces : le tableau s'affichait a plat, barres verticales comprises. Pire,
 *    l'editeur de notes reenregistrait ensuite ce paragraphe tel quel, et le
 *    tableau etait perdu pour de bon.
 *
 * Plus une borne de longueur : au-dela de deux cents caracteres, ce n'est plus
 * une formule en ligne mais une phrase prise en otage par deux dollars.
 *
 * Les deux derniers garde-fous ne tiennent pas dans l'expression et vivent dans
 * `opensFormula`.
 *
 * Le corps admet la sequence echappee « \$ » — c'est ainsi qu'on ecrit un
 * signe dollar A L'INTERIEUR d'une formule, et un cours de finance en est
 * plein : « $200/105 = \$1{,}90$ ». Un corps qui l'interdisait coupait la
 * formule a son premier dollar interne, puis la relancait sur ce dollar-la :
 * « $200/105 = \$1{,}90$ » s'affichait « $200/105 = \1,90 », le dollar
 * echappe avale, l'antislash orphelin, et la moitie gauche de l'egalite en
 * texte brut. Les deux delimiteurs, eux, refusent l'antislash qui les
 * precede : un « \$ » n'ouvre ni ne ferme rien.
 */
const INLINE_DOLLAR =
  /(?<!\\)\$(?![\s)\]}>,.;:!?])((?:\\.|[^$\n\\]){1,200}?)(?<![\s\\])\$(?![\p{L}\p{N}])/gu

/** Une barre verticale entouree d'espaces : deux cellules de tableau. */
const CELL_SEPARATOR = /\s\|\s/

/** Une lettre ou un chiffre, accents compris. */
const ALPHANUMERIC = /[\p{L}\p{N}]/u

/**
 * Ce par quoi commence une formule et rien d'autre : un antislash, un indice,
 * un exposant, une accolade.
 */
const LATEX_OPENING = /^[\\_^{]/

/**
 * Les deux garde-fous qui ne tiennent pas dans l'expression.
 *
 * Le premier : un corps qui enjambe une barre verticale entouree d'espaces est
 * une bribe de ligne de tableau, pas une formule. Une ligne
 * « | Valeur ($) | Prix ($m) | » a beau respecter les trois autres regles, le
 * premier dollar y trouve de quoi fermer deux cellules plus loin. Les espaces
 * sont ce qui distingue ce cas d'une valeur absolue « $|x|$ », qui reste une
 * formule.
 *
 * Le second : un dollar ouvrant colle a une lettre ou a un chiffre est une
 * monnaie — « 90 M$ », « 12$ ». Avec une exception, et elle compte : quand ce
 * qui suit ne peut etre que du LaTeX. « r$_{e}^{L}$ », « β$_{L}$ », « E$_1$ »
 * — la variable ecrite hors de la formule, son indice dedans. C'est la forme
 * que produisent les convertisseurs de PDF, et le cours de corporate finance en
 * est plein : une regle qui la refusait laissait « r_{e}^{L} » en clair dans un
 * tableau de synthese.
 */
function opensFormula(tex: string, before: string | undefined): boolean {
  if (CELL_SEPARATOR.test(tex)) return false
  if (before && ALPHANUMERIC.test(before) && !LATEX_OPENING.test(tex)) return false
  return true
}

/** Les formes \( … \) et \[ … \], que produisent certains convertisseurs. */
const INLINE_PARENS = /\\\(([^\n]+?)\\\)/g
const DISPLAY_BRACKETS = /\\\[([\s\S]+?)\\\]/g

export function protectMath(markdown: string): ProtectedMarkdown {
  const formulas: Formula[] = []
  const code: string[] = []

  const keep = (tex: string, display: boolean): string => {
    formulas.push({ tex, display })
    return token(formulas.length - 1)
  }

  // Les blocs « math » avant le blindage du code : ils en ont la syntaxe mais
  // sont des formules, et le blindage les rendrait invisibles a la suite.
  let text = markdown.replace(MATH_FENCE, (_match, _fence: string, tex: string) =>
    keep(tex, true)
  )

  // Le code ensuite : un $ dans un extrait de code n'est pas une formule.
  text = text
    .replace(FENCED_CODE, (block) => {
      code.push(block)
      return `zzcodezz${code.length - 1}zz`
    })
    .replace(/`[^`\n]+`/g, (span) => {
      code.push(span)
      return `zzcodezz${code.length - 1}zz`
    })

  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex: string) => keep(tex, true))
    .replace(DISPLAY_BRACKETS, (_match, tex: string) => keep(tex, true))
    .replace(INLINE_DOLLAR, (match, tex: string, offset: number, whole: string) =>
      opensFormula(tex, whole[offset - 1]) ? keep(tex, false) : match
    )
    .replace(INLINE_PARENS, (_match, tex: string) => keep(tex, false))

  // Le code revient avant l'analyse : c'est elle qui doit le mettre en forme.
  text = text.replace(/zzcodezz(\d+)zz/g, (_match, index: string) => code[Number(index)] ?? '')

  return { text, formulas }
}

/** Remplace les jetons par les formules composees, pour l'affichage. */
export function restoreMath(html: string, formulas: Formula[]): string {
  return html.replace(TOKEN_PATTERN, (_match, index: string) => {
    const formula = formulas[Number(index)]
    return formula ? renderMath(formula.tex, formula.display) : ''
  })
}

/**
 * Remplace les jetons par les noeuds de l'editeur, qui composeront eux-memes
 * la formule et resteront modifiables. C'est la variante utilisee au
 * chargement d'une note : une formule figee en HTML ne se reediterait plus.
 */
export function restoreMathNodes(html: string, formulas: Formula[]): string {
  return html.replace(TOKEN_PATTERN, (match, index: string) => {
    const formula = formulas[Number(index)]

    // Un jeton dont on n'a pas la formule appartient a quelqu'un d'autre, et il
    // faut le lui laisser. C'est le cas de l'affichage d'un cours : il protege
    // les formules avant d'appeler la conversion Markdown, laquelle refait la
    // meme protection pour son propre compte et se retrouve avec une liste
    // vide. Ce `return ''` effacait alors les jetons du premier appelant, et
    // toutes les formules d'un cours Markdown disparaissaient — sans erreur,
    // sans trace, un trou a leur place dans la phrase.
    if (!formula) return match

    const latex = escapeAttribute(formula.tex.trim())
    return formula.display
      ? `<div data-type="block-math" data-latex="${latex}"></div>`
      : `<span data-type="inline-math" data-latex="${latex}"></span>`
  })
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

/**
 * Formules deja composees.
 *
 * Une reponse en cours d'ecriture est reanalysee trente-six fois par seconde,
 * et chaque passage recomposait toutes ses formules depuis le debut. Une
 * formule ne change pas : la composer une fois suffit. Le cache vit le temps
 * de la session, ce qui represente quelques dizaines de kilo-octets.
 */
const composed = new Map<string, string>()

export function renderMath(tex: string, display: boolean): string {
  const key = `${display ? 'b' : 'i'}|${tex}`
  const known = composed.get(key)
  if (known !== undefined) return known

  const html = compose(tex, display)
  composed.set(key, html)
  return html
}

function compose(tex: string, display: boolean): string {
  try {
    // Un % nu ouvre un commentaire LaTeX : KaTeX tronque silencieusement la
    // fin de la formule (« \geq 100% » perd tout ce qui suit). Ici les
    // formules viennent de cours de finance — un % y est toujours le signe
    // pour-cent, jamais un commentaire : on l'echappe s'il ne l'est pas deja.
    return katex.renderToString(
      tex
        .trim()
        .replace(/(?<!\\)%/g, '\\%')
        // Le mode mathematique de LaTeX avale les espaces : « 2 000 + 90 »
        // sortait « 2000+90 », le separateur des milliers perdu en route. Une
        // espace entre deux chiffres n'est jamais un espacement de formule,
        // toujours un separateur — on la compose comme telle, fine et
        // insecable, ce qu'ecrirait un typographe.
        .replace(/(\d) (?=\d)/g, '$1\\,'),
      {
        displayMode: display,
        // Une faute de frappe dans une formule ne doit pas faire disparaitre la
        // reponse : KaTeX affiche alors l'expression en rouge, et la lecture
        // continue.
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        // La couche HTML seule. Par defaut KaTeX y ajoute une copie MathML,
        // invisible a l'ecran mais presente dans le DOM, avec le source LaTeX
        // dans une balise <annotation>. Un surlignage qui traverse une formule
        // enregistre le texte rendu (Selection.toString), et le retrouve ensuite
        // dans le texte du DOM (collect) : avec la copie MathML entre les deux,
        // les deux textes ne coincidaient plus, et le surlignage restait
        // invisible. Chromium applique en outre text-transform: math-auto au
        // MathML, rendant « 𝐸 » la ou le DOM contient « E ».
        output: 'html',
      },
    )
  } catch {
    return `<code>${escapeHtml(tex)}</code>`
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
