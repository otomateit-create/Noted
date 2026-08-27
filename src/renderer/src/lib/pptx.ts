/**
 * Conversion des cours au format PowerPoint.
 *
 * **Ce qu'un .pptx contient, et ce qu'on peut en faire.** Une diapositive n'est
 * pas une page : c'est une liste de formes posees a des coordonnees absolues,
 * avec leurs couleurs, leurs ombres et leurs animations. Personne ne sait la
 * redessiner fidelement sans le moteur de rendu de PowerPoint ou celui de
 * LibreOffice — deux dependances qu'une application censee marcher hors ligne
 * sur un Mac, sans rien installer, ne peut pas se permettre.
 *
 * On garde donc ce qui se travaille : le titre de chaque diapositive, ses
 * puces avec leurs niveaux, ses tableaux, ses images, le texte de ses schemas,
 * et les notes du presentateur — souvent le seul endroit ou le professeur
 * explique ce que la diapositive se contente de montrer. Ce qui est perdu est
 * dit franchement : la mise en page.
 *
 * **Une diapositive devient une section.** `<h2>Diapositive 12 — Titre</h2>`
 * : c'est ce qui permet au decoupage de faire un passage par diapositive, a
 * l'assistant de citer « Diapositive 12 » et au clic sur cette citation de
 * revenir au bon endroit — exactement la mecanique des titres d'un document
 * Word, sans rien ajouter ailleurs.
 *
 * **Cote renderer, comme les PDF.** Le navigateur possede deja tout ce qu'il
 * faut : `DecompressionStream` pour ouvrir l'archive, `DOMParser` pour lire le
 * XML. Le meme travail dans le processus principal demanderait deux
 * bibliotheques de plus. En prime, la vue « Original » d'un deck converti en
 * texte reutilise cette fonction telle quelle.
 */

import { ZipArchive } from './zip'

/** Espaces de noms du format. Ce sont eux qui identifient les balises. */
const NS = {
  presentation: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  relation: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  package: 'http://schemas.openxmlformats.org/package/2006/relationships',
  diagram: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart'
}

/**
 * Les formats d'image que l'ecran sait afficher.
 *
 * PowerPoint enregistre aussi des metafichiers Windows (.emf, .wmf) — c'est ce
 * que devient un graphique Excel colle dans une diapositive. Aucun navigateur ne
 * sait les dessiner : les afficher donnerait une icone d'image cassee au milieu
 * du cours. Ils sont donc ecartes, et comptes, pour que le cours dise ce qui lui
 * manque au lieu de le cacher.
 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

/** Les espaces reserves qui repetent le meme texte sur chaque diapositive. */
const CHROME = new Set(['dt', 'ftr', 'sldNum'])

export interface PptxDocument {
  html: string
  warnings: string[]
}

export async function convertPptx(bytes: Uint8Array): Promise<PptxDocument> {
  const zip = ZipArchive.open(bytes)
  const warnings = new Set<string>()
  let unreadableImages = 0

  const parts = await slideParts(zip)
  if (parts.length === 0) {
    throw new Error('Ce fichier ne contient aucune diapositive lisible.')
  }

  const blocks: string[] = []

  for (const [index, part] of parts.entries()) {
    const number = index + 1

    let xml: string | null
    try {
      xml = await zip.text(part)
    } catch {
      xml = null
    }

    if (!xml) {
      // Une diapositive illisible garde son titre et son rang : le cours
      // continue de se lire, et le trou est visible la ou il est.
      warnings.add(`La diapositive ${number} n’a pas pu etre lue.`)
      blocks.push(`<h2>Diapositive ${number}</h2>`)
      continue
    }

    const document = parseXml(xml)
    const tree = document.getElementsByTagNameNS(NS.presentation, 'spTree')[0]
    const links = await relations(zip, part)

    const title = tree ? slideTitle(tree) : null
    const heading = title
      ? `Diapositive ${number} — ${title}`
      : `Diapositive ${number}`

    const body: string[] = [`<h2>${escape(heading)}</h2>`]

    if (tree) {
      const rendered = await renderTree(tree, {
        zip,
        links,
        warnings,
        onUnreadableImage: () => {
          unreadableImages += 1
        }
      })
      body.push(...rendered)
    }

    const notes = await speakerNotes(zip, links)
    if (notes) body.push(notes)

    blocks.push(body.join('\n'))
  }

  if (unreadableImages > 0) {
    warnings.add(
      `${unreadableImages} image${unreadableImages > 1 ? 's' : ''} de ce cours ` +
        'sont dans un format que l’ecran ne sait pas afficher (graphique Excel ' +
        'colle, metafichier Windows) : elles ne figurent pas dans le texte.'
    )
  }

  return { html: blocks.join('\n'), warnings: [...warnings] }
}

// ---------------------------------------------------------------------------
// L'ordre des diapositives
// ---------------------------------------------------------------------------

/**
 * Les diapositives, dans l'ordre de la presentation.
 *
 * Cet ordre ne se devine pas des noms de fichiers : `slide3.xml` est le
 * troisieme cree, pas le troisieme montre — deplacer une diapositive dans
 * PowerPoint ne renomme rien. Seule la liste `sldIdLst` du fichier de
 * presentation dit l'ordre reel, et elle designe ses diapositives par des
 * identifiants de relation qu'il faut resoudre.
 */
async function slideParts(zip: ZipArchive): Promise<string[]> {
  try {
    const xml = await zip.text('ppt/presentation.xml')
    if (xml) {
      const links = await relations(zip, 'ppt/presentation.xml')
      const list = parseXml(xml).getElementsByTagNameNS(NS.presentation, 'sldId')

      const parts = Array.from(list)
        .map((entry) => links.get(entry.getAttributeNS(NS.relation, 'id') ?? ''))
        .filter((part): part is string => !!part && zip.has(part))

      if (parts.length > 0) return parts
    }
  } catch {
    // Presentation illisible : on se rabat sur les fichiers presents, dans
    // l'ordre de leur numero. Ce n'est pas forcement l'ordre de la
    // presentation, mais c'est le cours plutot que rien.
  }

  return zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
}

function slideNumber(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0)
}

// ---------------------------------------------------------------------------
// Le contenu d'une diapositive
// ---------------------------------------------------------------------------

interface Context {
  zip: ZipArchive
  /** Identifiants de relation de cette diapositive, resolus en noms de fichiers. */
  links: Map<string, string>
  warnings: Set<string>
  onUnreadableImage: () => void
}

/**
 * Parcourt les formes d'une diapositive et rend leur contenu.
 *
 * L'ordre suivi est celui du fichier, qui est l'ordre de superposition — pas
 * l'ordre de lecture. Trier par position serait tentant, mais un espace reserve
 * herite ses coordonnees du modele de diapositive et n'en porte aucune :
 * la moitie des formes se retrouverait en haut a gauche. L'ordre du fichier suit
 * l'ordre de creation, qui suit presque toujours la lecture ; le titre, lui, est
 * sorti a part et pose en premier.
 */
async function renderTree(tree: Element, context: Context): Promise<string[]> {
  const blocks: string[] = []

  for (const shape of Array.from(tree.children)) {
    if (shape.namespaceURI !== NS.presentation) continue

    if (shape.localName === 'grpSp') {
      blocks.push(...(await renderTree(shape, context)))
      continue
    }

    if (shape.localName === 'sp') {
      // Le titre est deja pose au-dessus, et le pied de page — date, numero,
      // nom du cours — se repete a l'identique sur chaque diapositive : indexe
      // cinquante fois, il repondrait a la place du cours.
      const placeholder = placeholderType(shape)
      if (placeholder && (CHROME.has(placeholder) || isTitle(placeholder))) continue

      const body = child(shape, NS.presentation, 'txBody')
      if (body) blocks.push(...renderTextBody(body, isPlaceholder(shape)))
      continue
    }

    if (shape.localName === 'pic') {
      const image = await renderPicture(shape, context)
      if (image) blocks.push(image)
      continue
    }

    if (shape.localName === 'graphicFrame') {
      blocks.push(...(await renderGraphicFrame(shape, context)))
    }
  }

  return blocks
}

/** Le titre de la diapositive, tel que son espace reserve le porte. */
function slideTitle(tree: Element): string | null {
  for (const shape of Array.from(tree.getElementsByTagNameNS(NS.presentation, 'sp'))) {
    const placeholder = placeholderType(shape)
    if (!placeholder || !isTitle(placeholder)) continue

    const body = child(shape, NS.presentation, 'txBody')
    if (!body) continue

    const text = paragraphs(body)
      .map((paragraph) => paragraph.text)
      .filter(Boolean)
      .join(' — ')

    if (text) return text
  }

  return null
}

function isTitle(placeholder: string): boolean {
  return placeholder === 'title' || placeholder === 'ctrTitle'
}

/** Le type d'espace reserve d'une forme, ou null si c'est une zone de texte libre. */
function placeholderType(shape: Element): string | null {
  const properties = child(shape, NS.presentation, 'nvSpPr')
  const nvPr = properties ? child(properties, NS.presentation, 'nvPr') : null
  const ph = nvPr ? child(nvPr, NS.presentation, 'ph') : null

  // Un espace reserve sans type declare est un corps de texte : c'est le
  // defaut du format.
  if (!ph) return null
  return ph.getAttribute('type') ?? 'body'
}

function isPlaceholder(shape: Element): boolean {
  return placeholderType(shape) !== null
}

// ---------------------------------------------------------------------------
// Le texte
// ---------------------------------------------------------------------------

interface Paragraph {
  /** Niveau de retrait, 0 pour le premier. */
  level: number
  /** Texte brut, pour les usages ou la mise en forme ne sert a rien. */
  text: string
  /** Le meme, en HTML : gras et italique conserves. */
  html: string
  /** Vrai, faux, ou null quand le paragraphe s'en remet a son modele. */
  bullet: boolean | null
}

function paragraphs(body: Element): Paragraph[] {
  return children(body, NS.drawing, 'p').map((paragraph) => {
    const properties = child(paragraph, NS.drawing, 'pPr')
    const level = Number(properties?.getAttribute('lvl') ?? 0)

    const pieces: Run[] = []
    let plain = ''

    for (const node of Array.from(paragraph.children)) {
      if (node.namespaceURI !== NS.drawing) continue

      // Un retour a la ligne dans une puce : PowerPoint le note comme une
      // balise, pas comme un caractere.
      if (node.localName === 'br') {
        pieces.push({ text: '', bold: false, italic: false, lineBreak: true })
        plain += ' '
        continue
      }

      // `r` : un fragment de texte. `fld` : un champ calcule — numero de
      // diapositive, date — dont la derniere valeur connue est ecrite dedans.
      if (node.localName !== 'r' && node.localName !== 'fld') continue

      const text = child(node, NS.drawing, 't')?.textContent ?? ''
      if (!text) continue

      plain += text
      const style = child(node, NS.drawing, 'rPr')
      pieces.push({
        text,
        bold: style?.getAttribute('b') === '1',
        italic: style?.getAttribute('i') === '1',
        lineBreak: false
      })
    }

    return {
      level: Number.isFinite(level) ? Math.max(0, level) : 0,
      text: plain.replace(/\s+/g, ' ').trim(),
      html: renderRuns(pieces),
      bullet: hasBullet(properties)
    }
  })
}

/** Un fragment de texte d'un paragraphe, avec la mise en forme qui lui est propre. */
interface Run {
  text: string
  bold: boolean
  italic: boolean
  lineBreak: boolean
}

/**
 * Recolle les fragments d'un paragraphe.
 *
 * PowerPoint coupe le texte a chaque mot, parfois a chaque espace : la
 * correction orthographique, un changement de langue ou une simple retouche
 * suffisent a ouvrir un fragment. Rendus tels quels, huit mots en gras
 * donnaient quinze balises imbriquees — et, dans le texte envoye a l'IA,
 * autant d'etoiles de Markdown collees entre chaque mot. On ne pose donc la
 * mise en forme qu'une fois par suite de fragments qui la partagent.
 */
function renderRuns(pieces: Run[]): string {
  const merged: Run[] = []

  for (const piece of pieces) {
    const last = merged[merged.length - 1]
    if (
      last &&
      !last.lineBreak &&
      !piece.lineBreak &&
      last.bold === piece.bold &&
      last.italic === piece.italic
    ) {
      last.text += piece.text
      continue
    }
    merged.push({ ...piece })
  }

  return merged.map((piece) => (piece.lineBreak ? '<br>' : emphasise(piece))).join('')
}

/** Rend au fragment le gras et l'italique que la diapositive lui donnait. */
function emphasise(run: Run): string {
  let html = escape(run.text)
  if (run.bold) html = `<strong>${html}</strong>`
  if (run.italic) html = `<em>${html}</em>`
  return html
}

/**
 * Ce paragraphe porte-t-il une puce ?
 *
 * La reponse complete se trouve dans le modele de la diapositive, puis dans
 * celui de la presentation, puis dans les valeurs par defaut du format — trois
 * niveaux d'heritage a remonter pour une puce. On s'en tient a ce que le
 * paragraphe declare lui-meme, et l'appelant tranche le reste : un espace
 * reserve porte des puces, une zone de texte libre n'en porte pas.
 */
function hasBullet(properties: Element | null): boolean | null {
  if (!properties) return null
  if (child(properties, NS.drawing, 'buNone')) return false
  if (child(properties, NS.drawing, 'buChar') || child(properties, NS.drawing, 'buAutoNum')) {
    return true
  }
  return null
}

/**
 * Un bloc de texte, rendu en listes et en paragraphes.
 *
 * Les puces consecutives sont regroupees, et leurs niveaux deviennent des
 * listes imbriquees : c'est ce que l'oeil attend d'une diapositive, et ce qui
 * donne au texte envoye a l'IA la hierarchie que le professeur a voulue.
 */
function renderTextBody(body: Element, placeholder: boolean): string[] {
  const blocks: string[] = []
  let list: Paragraph[] = []

  const flush = (): void => {
    if (list.length > 0) blocks.push(renderList(list))
    list = []
  }

  for (const paragraph of paragraphs(body)) {
    if (!paragraph.html) continue

    if (paragraph.bullet ?? placeholder) {
      list.push(paragraph)
      continue
    }

    flush()
    blocks.push(`<p>${paragraph.html}</p>`)
  }

  flush()
  return blocks
}

/**
 * Une suite de puces de niveaux differents, en listes imbriquees.
 *
 * Les profondeurs sont comptees a partir du premier point du bloc, et non a
 * partir de zero : un encadre dont toutes les puces sont au niveau deux ne doit
 * pas arriver indente deux fois pour rien.
 */
function renderList(items: Paragraph[]): string {
  const base = items[0].level
  let html = '<ul>'
  let depth = 0
  let open = false

  for (const item of items) {
    const wanted = Math.max(0, item.level - base)

    if (wanted > depth) {
      // La sous-liste vit dans le point qui la precede : il reste donc ouvert,
      // et se refermera avec elle.
      while (depth < wanted) {
        html += '<ul>'
        depth += 1
      }
    } else {
      if (open) html += '</li>'
      while (depth > wanted) {
        html += '</ul></li>'
        depth -= 1
      }
      open = false
    }

    html += `<li>${item.html}`
    open = true
  }

  if (open) html += '</li>'
  while (depth > 0) {
    html += '</ul></li>'
    depth -= 1
  }

  return `${html}</ul>`
}

// ---------------------------------------------------------------------------
// Les images
// ---------------------------------------------------------------------------

async function renderPicture(shape: Element, context: Context): Promise<string | null> {
  const fill = child(shape, NS.presentation, 'blipFill')
  const blip = fill ? child(fill, NS.drawing, 'blip') : null
  const target = blip ? context.links.get(blip.getAttributeNS(NS.relation, 'embed') ?? '') : null
  if (!target) return null

  const extension = target.slice(target.lastIndexOf('.')).toLowerCase()
  const type = IMAGE_TYPES[extension]
  if (!type) {
    context.onUnreadableImage()
    return null
  }

  const bytes = await context.zip.read(target)
  if (!bytes) return null

  // L'image part sur le disque sous son empreinte et le HTML n'en porte que
  // l'adresse : c'est ce qui rend l'affichage immediat, et c'est aussi ce qui
  // permet a la lecture par OCR de retrouver le fichier pour en tirer le texte
  // d'un schema.
  const name = await window.noted.media.keep(bytes, type)

  const properties = child(shape, NS.presentation, 'nvPicPr')
  const identity = properties ? child(properties, NS.presentation, 'cNvPr') : null
  const description = (
    identity?.getAttribute('descr') ??
    identity?.getAttribute('title') ??
    ''
  ).trim()

  return `<figure><img src="noted-media://${name}" alt="${escape(description)}"></figure>`
}

// ---------------------------------------------------------------------------
// Tableaux, graphiques et schemas
// ---------------------------------------------------------------------------

async function renderGraphicFrame(frame: Element, context: Context): Promise<string[]> {
  const table = frame.getElementsByTagNameNS(NS.drawing, 'tbl')[0]
  if (table) return [renderTable(table)]

  // Un schema SmartArt garde son texte dans une partie separee, que la forme
  // designe par une relation. Le dessin, lui, n'existe qu'en coordonnees : on
  // en sauve les mots, qui sont le contenu du cours.
  const diagram = frame.getElementsByTagNameNS(NS.diagram, 'relIds')[0]
  if (diagram) {
    const target = context.links.get(diagram.getAttributeNS(NS.relation, 'dm') ?? '')
    const words = target ? await partText(context.zip, target) : []
    return words.length > 0 ? ['<p><em>Schéma</em></p>', list(words)] : []
  }

  const chart = frame.getElementsByTagNameNS(NS.chart, 'chart')[0]
  if (chart) {
    const target = context.links.get(chart.getAttributeNS(NS.relation, 'id') ?? '')
    return target ? renderChart(await context.zip.text(target)) : []
  }

  return []
}

function renderTable(table: Element): string {
  const rows: string[] = []
  const header = child(table, NS.drawing, 'tblPr')?.getAttribute('firstRow') === '1'

  for (const [index, row] of children(table, NS.drawing, 'tr').entries()) {
    const cells: string[] = []

    for (const cell of children(row, NS.drawing, 'tc')) {
      // Une cellule fusionnee est representee par ses cases suivantes, vides et
      // marquees : les rendre ajouterait des colonnes fantomes.
      if (cell.getAttribute('hMerge') === '1' || cell.getAttribute('vMerge') === '1') continue

      const body = child(cell, NS.drawing, 'txBody')
      const text = body
        ? paragraphs(body)
            .map((paragraph) => paragraph.html)
            .filter(Boolean)
            .join('<br>')
        : ''

      const span = cell.getAttribute('gridSpan')
      const rowSpan = cell.getAttribute('rowSpan')
      const attributes =
        (span && span !== '1' ? ` colspan="${escape(span)}"` : '') +
        (rowSpan && rowSpan !== '1' ? ` rowspan="${escape(rowSpan)}"` : '')

      const tag = header && index === 0 ? 'th' : 'td'
      cells.push(`<${tag}${attributes}>${text}</${tag}>`)
    }

    if (cells.length > 0) rows.push(`<tr>${cells.join('')}</tr>`)
  }

  return rows.length > 0 ? `<table><tbody>${rows.join('')}</tbody></table>` : ''
}

/**
 * Ce qu'un graphique dit en mots : son titre, ses series, ses categories.
 *
 * Les valeurs chiffrees sont laissees de cote a dessein — une colonne de deux
 * cents nombres sans leur axe n'apprend rien a personne et noierait le passage.
 * Le titre et les etiquettes, eux, disent de quoi parle la figure, ce qui suffit
 * a la retrouver et a savoir qu'elle existe.
 */
function renderChart(xml: string | null): string[] {
  if (!xml) return []

  let document: Document
  try {
    document = parseXml(xml)
  } catch {
    return []
  }

  const title = Array.from(document.getElementsByTagNameNS(NS.chart, 'title'))
    .flatMap((node) => Array.from(node.getElementsByTagNameNS(NS.drawing, 't')))
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ')

  const labels = (parent: Element): string[] =>
    Array.from(parent.getElementsByTagNameNS(NS.chart, 'v'))
      .map((node) => node.textContent?.trim() ?? '')
      .filter(Boolean)

  const series: string[] = []
  const categories: string[] = []

  for (const entry of Array.from(document.getElementsByTagNameNS(NS.chart, 'ser'))) {
    const name = child(entry, NS.chart, 'tx')
    if (name) series.push(...labels(name))

    // Les categories sont les memes pour toutes les series : celles de la
    // premiere suffisent.
    const category = child(entry, NS.chart, 'cat')
    if (category && categories.length === 0) categories.push(...labels(category))
  }

  const lines: string[] = []
  lines.push(`<p><em>Graphique${title ? ` — ${escape(title)}` : ''}</em></p>`)
  if (series.length > 0) lines.push(`<p>Séries : ${escape(series.join(', '))}</p>`)
  if (categories.length > 0) lines.push(`<p>Catégories : ${escape(categories.join(', '))}</p>`)

  return lines
}

/** Tout le texte d'une partie du fichier, dans l'ordre, sans les repetitions. */
async function partText(zip: ZipArchive, part: string): Promise<string[]> {
  let xml: string | null
  try {
    xml = await zip.text(part)
  } catch {
    return []
  }
  if (!xml) return []

  const document = parseXml(xml)
  const texts: string[] = []

  for (const node of Array.from(document.getElementsByTagNameNS(NS.drawing, 't'))) {
    const text = node.textContent?.trim()
    // Un schema SmartArt decrit deux fois chaque forme — une fois pour le
    // contenu, une fois pour la mise en page.
    if (text && text !== texts[texts.length - 1]) texts.push(text)
  }

  return texts
}

function list(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`
}

// ---------------------------------------------------------------------------
// Les notes du presentateur
// ---------------------------------------------------------------------------

/**
 * Ce que le professeur a ecrit sous la diapositive.
 *
 * C'est souvent la que se trouve l'explication : la diapositive montre un
 * schema, la note dit ce qu'il faut en retenir. Elle apparait en retrait sous
 * la diapositive et part avec elle dans le contexte de l'assistant.
 */
async function speakerNotes(zip: ZipArchive, links: Map<string, string>): Promise<string | null> {
  const part = [...links.values()].find((target) => /^ppt\/notesSlides\//.test(target))
  if (!part) return null

  let xml: string | null
  try {
    xml = await zip.text(part)
  } catch {
    return null
  }
  if (!xml) return null

  const tree = parseXml(xml).getElementsByTagNameNS(NS.presentation, 'spTree')[0]
  if (!tree) return null

  const blocks: string[] = []

  for (const shape of Array.from(tree.getElementsByTagNameNS(NS.presentation, 'sp'))) {
    const placeholder = placeholderType(shape)
    // La page de notes rappelle le numero de la diapositive et reproduit son
    // image : ni l'un ni l'autre n'est une note.
    if (placeholder && CHROME.has(placeholder)) continue

    const body = child(shape, NS.presentation, 'txBody')
    if (!body) continue

    for (const paragraph of paragraphs(body)) {
      if (paragraph.html) blocks.push(`<p>${paragraph.html}</p>`)
    }
  }

  if (blocks.length === 0) return null

  return `<blockquote><p><em>Notes du présentateur</em></p>${blocks.join('')}</blockquote>`
}

// ---------------------------------------------------------------------------
// Le format, en petit
// ---------------------------------------------------------------------------

function parseXml(text: string): Document {
  const parsed = new DOMParser().parseFromString(text, 'application/xml')
  if (parsed.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Le fichier contient du XML illisible.')
  }
  return parsed
}

/**
 * Les relations d'une partie : chaque identifiant `rId…` rendu au fichier qu'il
 * designe. C'est par elles que passent les images, les schemas, les graphiques
 * et les notes — le XML d'une diapositive ne nomme jamais un fichier
 * directement.
 */
async function relations(zip: ZipArchive, part: string): Promise<Map<string, string>> {
  const directory = part.slice(0, part.lastIndexOf('/'))
  const name = part.slice(part.lastIndexOf('/') + 1)

  const links = new Map<string, string>()

  let xml: string | null
  try {
    xml = await zip.text(`${directory}/_rels/${name}.rels`)
  } catch {
    return links
  }
  if (!xml) return links

  for (const relation of Array.from(
    parseXml(xml).getElementsByTagNameNS(NS.package, 'Relationship')
  )) {
    const id = relation.getAttribute('Id')
    const target = relation.getAttribute('Target')
    // Une cible externe est une adresse web, pas un fichier de l'archive.
    if (!id || !target || relation.getAttribute('TargetMode') === 'External') continue

    links.set(id, resolvePart(directory, target))
  }

  return links
}

/** Un chemin relatif d'une partie a une autre, ramene a un nom de l'archive. */
function resolvePart(directory: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)

  const segments = directory.split('/')
  for (const step of target.split('/')) {
    if (step === '.' || step === '') continue
    if (step === '..') segments.pop()
    else segments.push(step)
  }

  return segments.join('/')
}

function children(parent: Element, namespace: string, name: string): Element[] {
  return Array.from(parent.children).filter(
    (node) => node.namespaceURI === namespace && node.localName === name
  )
}

function child(parent: Element, namespace: string, name: string): Element | null {
  return children(parent, namespace, name)[0] ?? null
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
