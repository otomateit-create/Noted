/**
 * Conversion entre le document de l'editeur et le Markdown ecrit sur disque.
 *
 * L'editeur est riche (couleurs, alignement, surlignage) alors que le Markdown
 * standard ne connait rien de tout cela. La sortie melange donc du Markdown
 * pour ce qu'il sait exprimer et du HTML en ligne pour le reste — ce que
 * Obsidian affiche correctement, ce qui garde les notes lisibles partout.
 */

import { marked } from 'marked'
import TurndownService from 'turndown'
import {
  DEFAULT_TABLE_ACCENT,
  DEFAULT_TABLE_DESIGN,
  HIGHLIGHT_COLORS,
  TABLE_ACCENTS,
  TABLE_DESIGNS,
  TABLE_MARKER,
  anchorMarker,
  bareLine,
  parseAnchorMarker,
  parseTableMarker,
  tableMarker
} from '@shared/types'
import type { NoteAnchor, TableAccent, TableDesign, TableStyle } from '@shared/types'
import { calloutLabel } from './editor-callout'
import { FENCED_CODE, protectMath, restoreMath, restoreMathNodes } from './math'

/**
 * Une formule sous la forme que l'on ecrit sur disque, ou null si le noeud n'en
 * est pas une. L'editeur represente une formule par un element vide dont le
 * LaTeX vit dans un attribut.
 */
function mathToMarkdown(node: Node): string | null {
  const element = node as HTMLElement
  const type = element.getAttribute?.('data-type')
  if (type !== 'inline-math' && type !== 'block-math') return null

  const latex = element.getAttribute('data-latex') ?? ''
  return type === 'block-math' ? `\n\n$$${latex}$$\n\n` : `$${latex}$`
}

/**
 * Un schema sous la forme que l'on ecrit sur disque : un bloc ```mermaid, que
 * Obsidian rend nativement. Comme une formule, le noeud est vide — sa syntaxe
 * vit dans un attribut — et doit donc etre intercepte avant que turndown ne
 * l'ecarte.
 */
function diagramToMarkdown(node: Node): string | null {
  const element = node as HTMLElement
  if (element.getAttribute?.('data-type') !== 'diagram') return null

  const source = (element.getAttribute('data-source') ?? '').trim()
  return `\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n`
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',

  /**
   * Interception indispensable. Turndown ecarte les elements sans contenu
   * textuel avant meme de consulter ses regles — et un noeud de formule est
   * precisement vide, puisque son LaTeX est dans un attribut. Sans ceci,
   * chaque formule disparaissait de la note au premier enregistrement.
   */
  blankReplacement: (_content, node) =>
    // `isBlock` est pose par turndown sur les noeuds qu'il parcourt ; il
    // n'apparait pas dans la definition de type de HTMLElement.
    mathToMarkdown(node) ??
    diagramToMarkdown(node) ??
    ((node as { isBlock?: boolean }).isBlock ? '\n\n' : '')
})

// Ces balises traversent la conversion intactes : ce sont elles qui portent la
// couleur et l'alignement, que le Markdown ne sait pas representer.
turndown.keep(['span', 'u'])

/**
 * Barre. Turndown seul ne le connait pas et jetait la balise en gardant le
 * texte : un passage barre dans l'editeur redevenait du texte ordinaire au
 * premier enregistrement. `~~texte~~` est la syntaxe GFM, que marked sait
 * deja relire (l'editeur, lui, reconnait le <del> qu'elle produit).
 */
turndown.addRule('strikethrough', {
  filter: ['s', 'del'],
  replacement: (content) => `~~${content}~~`
})

/**
 * Surlignage. La syntaxe ==texte== d'Obsidian ne transporte pas de couleur :
 * on ne l'utilise donc que pour un surlignage sans couleur, et on conserve le
 * HTML des que la couleur porte un sens (« pas compris », « definition »…).
 */
turndown.addRule('highlight', {
  filter: ['mark'],
  replacement: (content, node) => {
    const colour = (node as HTMLElement).style?.backgroundColor
    if (!colour) return `==${content}==`
    return `<mark style="background-color: ${colour}">${content}</mark>`
  }
})

/**
 * TipTap exprime l'alignement par un style sur le paragraphe ; on le traduit
 * en <div align>, la forme qu'Obsidian affiche correctement.
 */
turndown.addRule('alignedParagraph', {
  // On lit le style plutot que de tester `instanceof HTMLElement` : selon que
  // le code tourne dans la fenetre ou dans une implementation DOM legere, les
  // noeuds ne descendent pas de la meme classe.
  filter: (node) => {
    if (node.nodeName !== 'P') return false
    const alignment = (node as HTMLElement).style?.textAlign
    return alignment === 'center' || alignment === 'right' || alignment === 'justify'
  },

  replacement: (content, node) => {
    const alignment = (node as HTMLElement).style?.textAlign ?? 'center'
    // Dans une puce, le bloc reste sur la ligne du marqueur : les lignes vides
    // d'un bloc autonome couperaient la liste en deux a la sauvegarde, et elle
    // ne reviendrait pas entiere a l'ouverture.
    if (node.parentNode?.nodeName === 'LI') return `<div align="${alignment}">${content}</div>`
    return `\n\n<div align="${alignment}">${content}</div>\n\n`
  }
})

/**
 * Formules. L'editeur les represente par des noeuds dedies qui portent leur
 * LaTeX en attribut ; sur disque on veut la notation $…$, celle que lisent
 * Obsidian, l'assistant et n'importe quel editeur de texte.
 */
turndown.addRule('math', {
  filter: (node) => mathToMarkdown(node) !== null,
  replacement: (_content, node) => mathToMarkdown(node) ?? ''
})

turndown.addRule('diagram', {
  filter: (node) => diagramToMarkdown(node) !== null,
  replacement: (_content, node) => diagramToMarkdown(node) ?? ''
})

// --- Tableaux ---------------------------------------------------------------
// Turndown ne sait pas les ecrire, et le greffon GFM ne reconnait pas ceux de
// l'editeur : il attend un <thead>, la ou TipTap range ses cellules d'en-tete
// dans le <tbody> derriere un <colgroup>. On ecrit donc les regles, ce qui
// permet au passage de traiter le contenu des cellules — TipTap y met des
// paragraphes, dont les retours a la ligne casseraient la grille.

/** Une cellule tient sur une ligne : le reste briserait le tableau. */
function cellToMarkdown(content: string): string {
  return content.trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')
}

/** La ligne d'en-tete, qu'elle vienne d'un <thead> ou d'un <tbody> de TipTap. */
function isHeaderRow(row: Node): boolean {
  const parent = row.parentNode as HTMLElement | null
  if (!parent) return false
  if (parent.nodeName === 'THEAD') return true

  const cells = Array.from((row as HTMLElement).children ?? [])
  if (cells.length === 0 || !cells.every((cell) => cell.nodeName === 'TH')) return false

  // Premiere ligne du tableau : au-dessus d'elle, il n'y a que la declaration
  // des colonnes.
  const table = parent.nodeName === 'TABLE' ? parent : (parent.parentNode as HTMLElement | null)
  const first = table?.querySelector?.('tr')
  return first ? first === row : true
}

/**
 * La ligne de separation, qui porte aussi l'alignement de chaque colonne.
 *
 * Le Markdown n'a que cet endroit-la pour le dire : `---:` cadre la colonne a
 * droite, `:---:` la centre. Sans cette lecture, une colonne de montants cadree
 * a droite redevenait cadree a gauche au premier enregistrement, et les chiffres
 * cessaient de se comparer d'un coup d'oeil.
 *
 * Les deux ecritures sont lues : TipTap pose un style en ligne, l'analyseur
 * Markdown pose l'attribut `align` de l'ancien HTML.
 */
function separatorRow(row: Node): string {
  const cells = Array.from((row as HTMLElement).children ?? []) as HTMLElement[]

  const marks = cells.map((cell) => {
    const alignment = cell.style?.textAlign || cell.getAttribute?.('align') || ''
    if (alignment === 'right') return ' ---: |'
    if (alignment === 'center') return ' :---: |'
    return ' --- |'
  })

  return `|${marks.join('')}`
}

turndown.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: (content) => ` ${cellToMarkdown(content)} |`
})

turndown.addRule('tableRow', {
  filter: 'tr',
  replacement: (content, node) => {
    const rule = isHeaderRow(node) ? `\n${separatorRow(node)}` : ''
    return `\n|${content}${rule}`
  }
})

/** Les enveloppes n'ajoutent rien : ce sont les lignes qui portent le tableau. */
turndown.addRule('tableSection', {
  filter: ['thead', 'tbody', 'tfoot'],
  replacement: (content) => content
})

turndown.addRule('tableColumns', {
  filter: ['colgroup', 'col'],
  replacement: () => ''
})

turndown.addRule('table', {
  filter: 'table',
  replacement: (content, node) => {
    const rows = content.trim()
    const element = node as HTMLElement
    const first = element.querySelector?.('tr')

    const marker = tableMarker(
      (element.getAttribute?.('data-design') ?? DEFAULT_TABLE_DESIGN) as TableDesign,
      (element.getAttribute?.('data-accent') ?? DEFAULT_TABLE_ACCENT) as TableAccent
    )

    // Le Markdown n'a pas de tableau sans en-tete : plutot que de rendre une
    // grille qui ne se relira pas, on en pose un vide.
    if (first && !isHeaderRow(first)) {
      const columns = Array.from(first.children ?? []).length
      return `\n\n${marker}|${' |'.repeat(columns)}\n${separatorRow(first)}\n${rows}\n\n`
    }
    return `\n\n${marker}${rows}\n\n`
  }
})

/**
 * Encadres semantiques, dans la syntaxe d'Obsidian. Le premier bloc est le
 * titre, porte par la premiere ligne ; le reste suit, prefixe comme une
 * citation.
 */
turndown.addRule('callout', {
  filter: (node) =>
    node.nodeName === 'DIV' && Boolean((node as HTMLElement).getAttribute?.('data-callout')),

  replacement: (content, node) => {
    const colour = (node as HTMLElement).getAttribute?.('data-callout') ?? ''
    const [title, ...rest] = content.trim().split('\n')
    const body = rest.map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')

    return `\n\n> [!${colour}] ${title.trim()}\n${body ? `${body}\n` : ''}\n`
  }
})

/**
 * Filet de securite : un <div align> peut revenir de la note elle-meme, par
 * exemple si elle a ete editee dans Obsidian. Sans cette regle, turndown le
 * depouillerait et l'alignement serait perdu.
 */
turndown.addRule('alignedDiv', {
  filter: (node) =>
    node.nodeName === 'DIV' && Boolean((node as HTMLElement).getAttribute?.('align')),

  replacement: (content, node) => {
    const alignment = (node as HTMLElement).getAttribute?.('align') ?? 'center'
    return `\n\n<div align="${alignment}">${content}</div>\n\n`
  }
})

/**
 * Sort les formules du document avant la conversion, en laissant un jeton de
 * texte a leur place.
 *
 * Turndown ne se contente pas d'ignorer les elements vides : il resserre aussi
 * les espaces autour d'eux, si bien qu'une formule en milieu de phrase se
 * recollait au mot suivant — « $\\frac{D}{E}$dans ce montage ». Un jeton
 * textuel se comporte comme un mot ordinaire et preserve l'espacement.
 */
function extractMathNodes(html: string): { text: string; formulas: string[] } {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const formulas: string[] = []

  const nodes = parsed.body.querySelectorAll(
    '[data-type="inline-math"], [data-type="block-math"]'
  )

  for (const node of Array.from(nodes)) {
    const latex = node.getAttribute('data-latex') ?? ''
    const display = node.getAttribute('data-type') === 'block-math'

    formulas.push(display ? `$$${latex}$$` : `$${latex}$`)
    const placeholder = parsed.createTextNode(`zzformulezz${formulas.length - 1}zz`)

    if (display) {
      // Une formule isolee doit rester un bloc a elle seule, sinon elle se
      // fond dans le paragraphe qui la precede.
      const paragraph = parsed.createElement('p')
      paragraph.appendChild(placeholder)
      node.replaceWith(paragraph)
    } else {
      node.replaceWith(placeholder)
    }
  }

  return { text: parsed.body.innerHTML, formulas }
}

// --- Ancres ------------------------------------------------------------------
// Meme principe que l'habillage des tableaux : le Markdown n'a nulle part ou
// porter un attribut sur un paragraphe, on le pose donc dans un commentaire
// HTML juste au-dessus. Obsidian ne l'affiche pas, la note reste un fichier
// texte ordinaire, et le passage voyage avec elle.

/**
 * Sort les ancres du HTML de l'editeur et laisse un jeton a leur place.
 *
 * Turndown ignore les commentaires et n'a pas de prise sur l'element qui porte
 * l'attribut : le jeton, lui, traverse la conversion comme un mot ordinaire et
 * se retrouve seul sur sa ligne, juste au-dessus du bloc qu'il annonce.
 */
function extractAnchors(html: string): { text: string; anchors: NoteAnchor[] } {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const anchors: NoteAnchor[] = []

  for (const element of Array.from(parsed.body.querySelectorAll('[data-ancre]'))) {
    const raw = element.getAttribute('data-ancre') ?? ''
    element.removeAttribute('data-ancre')

    let anchor: NoteAnchor
    try {
      anchor = JSON.parse(raw) as NoteAnchor
    } catch {
      continue
    }

    anchors.push(anchor)
    const token = parsed.createElement('p')
    token.textContent = `zzancrezz${anchors.length - 1}zz`
    element.before(token)
  }

  return { text: parsed.body.innerHTML, anchors }
}

/** Document de l'editeur (HTML) vers le Markdown enregistre sur disque. */
export function htmlToMarkdown(html: string): string {
  const { text: withoutAnchors, anchors } = extractAnchors(html)
  const { text, formulas } = extractMathNodes(withoutAnchors)

  return (
    turndown
      .turndown(text)
      .replace(/zzformulezz(\d+)zz/g, (_match, index: string) => formulas[Number(index)] ?? '')
      .replace(/zzancrezz(\d+)zz/g, (_match, index: string) => {
        const anchor = anchors[Number(index)]
        return anchor ? anchorMarker(anchor) : ''
      })
      .replace(/\n{3,}/g, '\n\n')
      // Le marqueur se colle au bloc qu'il annonce : c'est ce qui permet de le
      // relire sans compter les blocs, et ce qui le rend inoffensif a la
      // lecture — une ligne invisible au ras du paragraphe, pas un trou.
      .replace(/(<!-- ancre [^\n]*-->)\n+/g, '$1\n')
      // Un marqueur immediatement suivi d'un autre n'annonce rien : celui
      // d'apres parle du meme bloc et le remplace. Le cas vient des lignes
      // vides — une ligne vide qui ferme un groupe porte l'ancre de protection
      // de ce qui suit, et n'a pas de texte pour l'en separer. Colles, les deux
      // marqueurs se perdaient tous les deux a la relecture, et le passage du
      // bloc suivant avec eux.
      .replace(/(?:<!-- ancre [^\n]*-->\n)+(?=<!-- ancre )/g, '')
      // Meme raison, en fin de note : un marqueur sans bloc devant lui
      // n'annonce rien, et resterait ecrit en clair dans le document relu.
      .replace(/\n*<!-- ancre [^\n]*-->[ \t]*$/, '')
      .trim()
  )
}

/**
 * Rend chaque marqueur au bloc qui le suit, sous forme d'attribut.
 *
 * Marked laisse passer un commentaire HTML tel quel : il suffit de le recoller
 * a l'ouverture du bloc suivant. On ne compte pas les blocs — on lit ce qui est
 * ecrit, ce qui reste juste meme si un paragraphe a ete supprime a la main.
 */
function applyAnchors(html: string): string {
  return html.replace(
    /<!--\s*ancre\s+(\{[\s\S]*?\})\s*-->\s*(<(?:p|h[1-6]|ul|ol|blockquote|pre)\b)/g,
    (match, body: string, open: string) => {
      const anchor = parseAnchorMarker(body)
      if (!anchor) return match
      return `${open} data-ancre="${escapeAttribute(JSON.stringify(anchor))}"`
    }
  )
}

// --- Habillage des tableaux --------------------------------------------------
// Un tableau Markdown n'a nulle part ou porter un reglage : la syntaxe GFM ne
// prevoit ni attribut ni legende. On le pose donc dans un commentaire HTML
// juste au-dessus, qu'Obsidian n'affiche pas et qu'un editeur de texte laisse
// tranquille — le tableau, lui, reste du Markdown ordinaire.

/**
 * Retire les marqueurs du texte et rend l'habillage de chaque tableau, dans
 * l'ordre du document — le meme ordre que celui des <table> produits ensuite.
 *
 * Les lignes sont examinees debarrassees de leurs chevrons : un tableau dans
 * un encadre compte comme les autres, sinon la correspondance se decalerait.
 */
function extractTableStyles(markdown: string): { text: string; styles: (TableStyle | null)[] } {
  const lines = markdown.split('\n')
  const kept: string[] = []
  const styles: (TableStyle | null)[] = []

  let pending: TableStyle | null = null
  let fenced = false
  let inTable = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const bare = bareLine(line)

    if (bare.startsWith('```') || bare.startsWith('~~~')) {
      fenced = !fenced
      inTable = false
      kept.push(line)
      continue
    }
    if (fenced) {
      kept.push(line)
      continue
    }

    const marker = TABLE_MARKER.exec(bare)
    if (marker) {
      const style = parseTableMarker(marker[1])
      // Un marqueur qui ne precede pas un tableau n'habille rien : on le laisse
      // ou il est plutot que de le faire porter au tableau suivant.
      if (style && bareLine(lines[index + 1] ?? '').startsWith('|')) {
        pending = style
        continue
      }
      kept.push(line)
      continue
    }

    if (bare.startsWith('|')) {
      if (!inTable) {
        styles.push(pending)
        pending = null
        inTable = true
      }
    } else {
      inTable = false
      pending = null
    }

    kept.push(line)
  }

  return { text: kept.join('\n'), styles }
}

/** Repose l'habillage sur les tableaux du HTML, dans le meme ordre. */
function applyTableStyles(html: string, styles: (TableStyle | null)[]): string {
  if (!styles.some(Boolean)) return html

  let index = 0
  return html.replace(/<table>/g, () => {
    const style = styles[index++]
    if (!style) return '<table>'
    return `<table data-design="${style.design}" data-accent="${style.accent}">`
  })
}

/** Un bloc ```mermaid, seul sur ses lignes. */
const DIAGRAM_BLOCK = /^[ \t]*```mermaid[ \t]*\n([\s\S]*?)\n?[ \t]*```[ \t]*$/gm

/**
 * Un encadre d'Obsidian : « > [!definition] Titre », puis les lignes du corps,
 * prefixees comme une citation.
 */
const CALLOUT_BLOCK = /^ {0,3}> ?\[!([a-zA-Z-]+)\][ \t]*([^\n]*)\n?((?:^ {0,3}>[^\n]*\n?)*)/gm

/** Les couleurs d'encadre reconnues : celles de la legende, et rien d'autre. */
const CALLOUT_IDS = new Set<string>(HIGHLIGHT_COLORS.map((colour) => colour.id))

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Un attribut porte des retours a la ligne, mais les ecrire tels quels
    // rend le HTML fragile a relire : on les code.
    .replace(/\n/g, '&#10;')
}

/**
 * Sort les schemas du texte avant l'analyse Markdown, qui en ferait des blocs
 * de code affiches en toutes lettres.
 */
function extractDiagrams(markdown: string): { text: string; sources: string[] } {
  const sources: string[] = []

  const text = markdown.replace(DIAGRAM_BLOCK, (_match, source: string) => {
    sources.push(source)
    return `zzschemazz${sources.length - 1}zz`
  })

  return { text, sources }
}

/** Un marqueur d'ancre, seul sur sa ligne, tel qu'il est ecrit sur le disque. */
const ANCHOR_LINE = /^[ \t]*<!--[ \t]*ancre[ \t]+(\{.*\})[ \t]*-->[ \t]*$/gm

/**
 * Met les marqueurs d'ancre a l'abri avant l'analyse Markdown.
 *
 * Un marqueur porte desormais le passage exact du cours que le bloc commente,
 * recopie tel quel — et un cours n'ecrit pas en Markdown. Il s'y trouve des
 * antislashs, des soulignes, des dollars : « 2,2 Md\$ d'ECP » suffit a ce que
 * la protection des formules y voie une formule et que ce qui revient ne soit
 * plus ce qui etait parti. Le marqueur cessait alors d'etre un commentaire
 * bien forme, et son contenu — plusieurs lignes de cours — se deversait dans
 * la note a la vue de l'utilisateur.
 *
 * Il sort donc du texte avant tout le reste, comme les schemas et l'habillage
 * des tableaux, et pour la meme raison : c'est de la donnee, pas de la prose,
 * et rien de ce qui sait lire du Markdown n'a affaire avec elle.
 */
function extractAnchorMarkers(markdown: string): { text: string; markers: string[] } {
  const markers: string[] = []

  // Le jeton est suivi d'une ligne vide, et ce n'est pas cosmetique : marked
  // voit dans une ligne ouverte par « <!-- » un bloc HTML, qui se termine avec
  // le commentaire et laisse le paragraphe suivant commencer seul. Un jeton
  // n'est que du texte : colle au bloc qu'il annonce, il fusionnerait avec lui
  // en un seul paragraphe, et le marqueur rendu se retrouverait *dans* le bloc
  // au lieu d'etre devant — la ou on va le rechercher pour en refaire un
  // attribut. La ligne vide rend au jeton la separation que le commentaire
  // avait d'office.
  const text = markdown.replace(ANCHOR_LINE, (match) => {
    markers.push(match.trim())
    return `zzmarqueurzz${markers.length - 1}zz\n`
  })

  return { text, markers }
}

/** Rend les marqueurs au HTML, juste avant qu'ils redeviennent des attributs. */
function restoreAnchorMarkers(html: string, markers: string[]): string {
  return html.replace(
    /<p>\s*zzmarqueurzz(\d+)zz\s*<\/p>|zzmarqueurzz(\d+)zz/g,
    (_match, wrapped: string | undefined, bare: string | undefined) =>
      markers[Number(wrapped ?? bare)] ?? ''
  )
}

/** Les schemas reviennent en noeuds d'editeur, qui composeront leur image. */
function restoreDiagrams(html: string, sources: string[]): string {
  return html.replace(
    /<p>\s*zzschemazz(\d+)zz\s*<\/p>|zzschemazz(\d+)zz/g,
    (_match, wrapped: string | undefined, bare: string | undefined) => {
      const source = sources[Number(wrapped ?? bare)]
      if (source === undefined) return ''
      return `<div data-type="diagram" data-source="${escapeAttribute(source.trim())}"></div>`
    }
  )
}

/**
 * Traduit les encadres en HTML avant l'analyse Markdown — laissee a marked,
 * une citation en deviendrait une, et le titre se collerait au corps dans un
 * seul paragraphe. Le contenu, lui, passe bien par marked : un encadre peut
 * contenir une liste ou une formule.
 */
function renderCallouts(markdown: string): string {
  return markdown.replace(
    CALLOUT_BLOCK,
    (_match, kind: string, title: string, body: string) => {
      const known = CALLOUT_IDS.has(kind.toLowerCase())
      const colour = known ? kind.toLowerCase() : HIGHLIGHT_COLORS[0].id

      // Sans titre, celui de la legende : un encadre dont la premiere ligne
      // serait du corps se lirait comme un titre, ce qu'elle n'est pas. Un type
      // venu d'ailleurs — les [!NOTE], [!WARNING] d'Obsidian — garde le sien :
      // lui coller le libelle de la premiere couleur faisait lire « A retenir »
      // en tete d'un encadre ou ces mots n'existent pas.
      const heading =
        title.trim() || (known ? calloutLabel(colour) : kind[0].toUpperCase() + kind.slice(1))
      const inner = body.replace(/^ {0,3}> ?/gm, '').trim()

      const renderedTitle = marked.parseInline(heading, { async: false, gfm: true })
      const renderedBody = inner ? marked.parse(inner, { async: false, gfm: true }) : ''

      return `\n\n<div data-callout="${colour}"><p>${
        typeof renderedTitle === 'string' ? renderedTitle : heading
      }</p>${typeof renderedBody === 'string' ? renderedBody : ''}</div>\n\n`
    }
  )
}

/** Markdown lu sur disque vers le document de l'editeur (HTML). */
/**
 * Un en-tete de metadonnees, tel qu'en portent les fichiers d'Obsidian et ceux
 * qu'exportent la plupart des editeurs Markdown : trois tirets, des lignes
 * « cle : valeur », trois tirets.
 *
 * Il faut le reconnaitre pour ce qu'il est, faute de quoi les trois premiers
 * tirets se lisent comme un trait horizontal et les trois derniers font du bloc
 * entier un titre de niveau deux — un « title: Cours de private equity matiere:
 * … » en grosses lettres, en tete de chaque cours.
 *
 * Le contenu doit ressembler a du YAML : sinon, ces trois tirets ouvrent bel et
 * bien un trait horizontal, et le document commence par la.
 */
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Le cours sans son en-tete de metadonnees, qui n'est pas du cours. */
export function withoutFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER, (match, body: string) =>
    /^[A-Za-z_][\w-]*[ \t]*:/.test(body.trimStart()) ? '' : match
  )
}

export function markdownToHtml(markdown: string): string {
  if (!markdown.trim()) return ''

  // Les marqueurs d'ancre avant tout : ils portent du texte de cours recopie
  // tel quel, que rien de ce qui suit ne doit avoir l'occasion de relire.
  const { text: withoutAnchors, markers } = extractAnchorMarkers(markdown)

  // Les schemas ensuite : leur syntaxe est un bloc de code aux yeux de marked,
  // et son contenu n'a pas a etre analyse.
  const { text: withoutDiagrams, sources } = extractDiagrams(withoutAnchors)

  // Puis l'habillage des tableaux : le commentaire qui le porte doit dispa-
  // raitre du texte avant que marked n'en fasse du HTML brut.
  const { text: withoutMarkers, styles } = extractTableStyles(withoutDiagrams)

  // Les formules sortent du texte avant tout le reste : l'analyse Markdown
  // prendrait leurs underscores pour de l'italique et avalerait leurs
  // antislashs.
  const { text, formulas } = protectMath(withoutMarkers)

  // Le surlignage ==texte== precede la conversion : marked ne connait pas
  // cette extension et la laisserait telle quelle.
  const withHighlights = text.replace(
    /==([^=\n]+)==/g,
    (_match, highlighted: string) => `<mark>${highlighted}</mark>`
  )

  const parsed = marked.parse(renderCallouts(withHighlights), {
    async: false,
    gfm: true,
    breaks: false
  })
  if (typeof parsed !== 'string') return ''
  const rendered = applyAnchors(restoreAnchorMarkers(applyTableStyles(parsed, styles), markers))

  // L'alignement est stocke en <div align>, la forme qu'Obsidian affiche ;
  // l'editeur, lui, ne sait aligner qu'un paragraphe. Sans cette traduction,
  // rouvrir une note perdrait tout centrage — et le rendrait ineditable.
  const aligned = rendered.replace(
    /<div align="(center|right|justify)">([\s\S]*?)<\/div>/g,
    (_match, alignment: string, content: string) =>
      `<p style="text-align: ${alignment}">${content.trim()}</p>`
  )

  // Une puce alignee porte son alignement sur l'element de liste lui-meme, en
  // plus du paragraphe : c'est le seul niveau ou le marqueur — la puce, le
  // numero — suit le texte au lieu de rester colle a gauche.
  const alignedItems = aligned.replace(
    /<li>(\s*<p style="text-align: (center|right|justify)">)/g,
    (_match, head: string, alignment: string) => `<li style="text-align: ${alignment}">${head}`
  )

  // Les formules et les schemas reviennent en noeuds d'editeur, pas en HTML
  // fige : ils doivent rester modifiables.
  return restoreMathNodes(restoreDiagrams(alignedItems, sources), formulas)
}

// ---------------------------------------------------------------------------
// Le Markdown ecrit par l'assistant
// ---------------------------------------------------------------------------

/**
 * L'encre des ajouts de l'assistant dans une note. Distincte de l'encre du
 * texte et des cinq couleurs semantiques : ce qui vient de lui doit rester
 * reconnaissable de ce qui a ete ecrit a la main. Elle voyage en
 * `<span style="color: …">`, la forme qui survit deja a l'aller-retour
 * Markdown pour la couleur de texte.
 */
export const AI_INK = '#5b7c99'

const COLOUR_WASH = new Map(HIGHLIGHT_COLORS.map((colour) => [colour.id as string, colour.wash]))

const COLOUR_IDS = HIGHLIGHT_COLORS.map((colour) => colour.id).join('|')

/** ==texte=={couleur}, ou couleur est l'un des cinq codes semantiques. */
const COLOURED_HIGHLIGHT = new RegExp(`==([^=\\n]+)==\\{(${COLOUR_IDS})\\}`, 'g')

/** ++texte++, dans une meme ligne : un ajout de l'assistant. */
const AI_ADDITION = /\+\+([^+\n][^\n]*?)\+\+/g

/** Une balise HTML : < ou </, un nom, des attributs sans retour a la ligne. */
const TAG_PATTERN = /<\/?[a-zA-Z][^<>\n]*>/g

/**
 * Prepare le Markdown ecrit par l'assistant : neutralise les balises HTML de
 * son invention, puis convertit ses deux conventions.
 *
 * Le prompt lui interdit deja de composer des balises, mais une interdiction
 * declarative n'est pas une garantie : marked laisse passer le HTML en ligne,
 * et turndown fait survivre <span> et <u> a l'aller-retour. Sans ce filtre,
 * une balise composee par le modele — <span style="color: …">,
 * <div align> — produirait une mise en forme fonctionnelle, indiscernable
 * d'un geste de l'utilisateur.
 *
 * La regle du prompt, appliquee cette fois par du code : une balise n'est
 * admise que si elle figure deja, a l'identique, dans la note en cours
 * d'edition (`base`) — c'est ce qui permet a « remplacer » et « reecrire » de
 * preserver les surlignages et couleurs poses par l'utilisateur, recopies
 * tels quels. Tout le reste est retire, le texte conserve.
 *
 * Blocs de code et formules sont mis a l'abri d'abord — un < y est du texte,
 * pas une balise — et les conventions ne s'y appliquent pas non plus : `++i++`
 * dans un extrait de code est une incrementation, pas une encre.
 */
function prepareAiMarkdown(markdown: string, base: string): string {
  const shielded: string[] = []
  const shield = (fragment: string): string => {
    shielded.push(fragment)
    return `zzabrizz${shielded.length - 1}zz`
  }

  let text = markdown
    .replace(FENCED_CODE, shield)
    .replace(/`[^`\n]+`/g, shield)
    .replace(/\$\$[\s\S]+?\$\$/g, shield)
    .replace(/\$[^$\n]+?\$/g, shield)

  const allowed = new Set(base.match(TAG_PATTERN) ?? [])
  text = text.replace(TAG_PATTERN, (tag) => (allowed.has(tag) ? tag : ''))

  // Un marqueur d'ancre illisible ne designerait rien dans la marge : il
  // disparait. Ceux que l'application pose elle-meme, en resolvant le
  // parametre « ancre » sur le cours reel, sont deja verifies.
  text = text.replace(/^<!--\s*ancre\s+([\s\S]*?)\s*-->$/gm, (match, body: string) =>
    parseAnchorMarker(body) ? match : ''
  )

  text = text
    .replace(COLOURED_HIGHLIGHT, (match, content: string, id: string) => {
      const wash = COLOUR_WASH.get(id)
      return wash ? `<mark style="background-color: ${wash}">${content}</mark>` : match
    })
    .replace(AI_ADDITION, `<span style="color: ${AI_INK}">$1</span>`)

  return text.replace(/zzabrizz(\d+)zz/g, (_match, index: string) => shielded[Number(index)] ?? '')
}

/**
 * Markdown de l'assistant vers le document de l'editeur — le chemin qu'emprunte
 * une proposition acceptee ou une reponse inseree dans la note. `base` est la
 * note en cours d'edition : ses balises a elle restent admises.
 */
export function aiMarkdownToHtml(markdown: string, base = ''): string {
  return markdownToHtml(prepareAiMarkdown(markdown, base))
}

/**
 * Markdown de l'assistant vers du HTML d'affichage, pour l'apercu d'une
 * proposition. Meme preparation que `aiMarkdownToHtml` — l'apercu doit montrer
 * ce qui sera reellement applique, balises neutralisees comprises — mais les
 * formules sont composees par KaTeX : un noeud d'editeur est vide hors de
 * l'editeur, et l'apercu n'afficherait rien a la place de chaque formule.
 */
export function renderAiPreview(markdown: string, base = ''): string {
  if (!markdown.trim()) return ''

  const { text: withoutDiagrams, sources } = extractDiagrams(prepareAiMarkdown(markdown, base))
  const { text: withoutMarkers, styles } = extractTableStyles(withoutDiagrams)
  const { text, formulas } = protectMath(withoutMarkers)

  const withHighlights = text.replace(
    /==([^=\n]+)==/g,
    (_match, highlighted: string) => `<mark>${highlighted}</mark>`
  )

  const parsed = marked.parse(renderCallouts(withHighlights), {
    async: false,
    gfm: true,
    breaks: false
  })
  if (typeof parsed !== 'string') return ''

  // Les schemas restent des emplacements vides : c'est l'apercu qui y compose
  // leur image, une fois le moteur charge.
  return restoreMath(restoreDiagrams(applyTableStyles(parsed, styles), sources), formulas)
}

/**
 * Les syntaxes de schema contenues dans un Markdown, pour les verifier avant
 * qu'une proposition n'atteigne l'ecran.
 */
export function diagramSources(markdown: string): string[] {
  return extractDiagrams(markdown).sources
}

/**
 * Verifie les tableaux d'un Markdown : rend la raison du refus, ou null.
 *
 * Un tableau sans ligne de separation n'est pas un tableau pour Markdown, mais
 * une suite de lignes a barres verticales — il s'afficherait en texte brut au
 * milieu de la note. Le nombre de colonnes doit suivre, sans quoi la grille se
 * decale.
 */
export function checkTables(markdown: string): string | null {
  // Hors des blocs de code, ou une barre verticale ne veut rien dire.
  const lines = markdown.replace(FENCED_CODE, '').split('\n')
  const columns = (line: string): number =>
    line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length

  // Un habillage invente ne dit rien de ce que l'utilisateur verrait : on le
  // refuse avec la liste, plutot que de rendre un tableau ordinaire sans
  // expliquer pourquoi le reglage demande n'a pas pris.
  for (const line of lines) {
    const marker = TABLE_MARKER.exec(bareLine(line))
    if (marker && !parseTableMarker(marker[1])) {
      return (
        `l'habillage « ${marker[1]} » n'existe pas. Designs : ${TABLE_DESIGNS.map(
          (design) => design.id
        ).join(', ')} ; accents : ${TABLE_ACCENTS.join(', ')}`
      )
    }
  }

  let declared = 0

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line.startsWith('|')) continue

    // Debut d'un tableau : la ligne suivante doit etre la separation.
    const previous = (lines[index - 1] ?? '').trim()
    if (previous.startsWith('|')) continue

    declared++

    const separator = (lines[index + 1] ?? '').trim()
    if (!/^\|?[\s:|-]+\|[\s:|-]*$/.test(separator) || !separator.includes('-')) {
      return `le tableau commencant par « ${line.slice(0, 60)} » n'a pas sa ligne de separation « | --- | --- | » juste sous l'en-tete`
    }
    if (columns(separator) !== columns(line)) {
      return `le tableau commencant par « ${line.slice(0, 60)} » n'a pas le meme nombre de colonnes que sa ligne de separation`
    }
  }

  /*
   * Le dernier controle, et celui qui manquait : un tableau bien ecrit
   * survit-il vraiment a la conversion ?
   *
   * Les regles ci-dessus lisent le Markdown ; c'est la conversion qui decide.
   * Quand elle refuse un tableau, elle n'echoue pas — elle le rend en un simple
   * paragraphe, barres verticales comprises. L'editeur enregistre ensuite ce
   * paragraphe, ou les retours a la ligne sont devenus des espaces : le tableau
   * est perdu pour de bon, sans un mot.
   *
   * C'est arrive : un « ($m) » dans l'en-tete y ouvrait une formule qui se
   * fermait deux cellules plus loin, et l'en-tete passait de cinq colonnes a
   * quatre (voir INLINE_DOLLAR dans math.ts). Le meme silence guette un tableau
   * colle a la phrase qui le precede, que Markdown refuse d'ouvrir au milieu
   * d'un paragraphe. Compter les tableaux des deux cotes de la conversion
   * attrape les deux, et tout ce qui viendra apres.
   */
  if (declared > 0) {
    const rendered = (aiMarkdownToHtml(markdown).match(/<table/g) ?? []).length
    if (rendered < declared) {
      return `un tableau n'a pas survecu a la conversion (${declared} annonce(s), ${rendered} rendu(s)) — verifie qu'aucune ligne n'est indentee, qu'une ligne vide precede l'en-tete, et qu'aucune cellule de l'en-tete n'ouvre de formule`
    }
  }

  return null
}
