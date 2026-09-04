/**
 * Chargement, rendu et extraction de texte des PDF.
 *
 * L'extraction tourne ici, cote renderer, parce que pdf.js y est chez lui :
 * le document est deja charge pour l'affichage, on en tire le texte au passage
 * plutot que de le relire dans le main process.
 */

import * as pdfjs from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { RefProxy, TextItem } from 'pdfjs-dist/types/src/display/api'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ExtractedCourse, ExtractedPage } from '@shared/types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Deux fragments dont les lignes de base different de moins de ca sont sur la meme ligne. */
const LINE_TOLERANCE = 2.5

/** Un ecart horizontal superieur a ca separe deux mots plutot que deux glyphes. */
const WORD_GAP_RATIO = 0.25

/** En dessous de cette moyenne de caracteres par page, le PDF est sans doute scanne. */
const SCANNED_THRESHOLD = 120

/**
 * Au-dela de ce multiple de l'interligne courant, deux lignes appartiennent a
 * deux paragraphes differents.
 *
 * Un PDF ne contient aucune marque de fin de paragraphe : il ne contient que
 * des glyphes places a des coordonnees. Le blanc qui separe deux paragraphes ne
 * produit aucune ligne — il ne produit qu'un ecart plus grand entre deux lignes
 * de base. Sans ce seuil, tout le document arrive comme une seule coulee, et le
 * decoupage n'a plus d'autre choix que de couper au compteur de caracteres,
 * c'est-a-dire au milieu des phrases.
 *
 * La valeur vient de pdfminer.six (`line_margin = 0,5`, soit un ecart de 1,5
 * interligne), et elle a ete verifiee sur les cours de ce vault : interligne
 * median 21,6 pt, neuvieme decile des ecarts entre 32 et 38 pt. Le seuil tombe
 * dans le creux qui separe nettement les deux, et retient un saut toutes les
 * cinq lignes environ.
 */
const PARAGRAPH_GAP = 1.45

/** Ecart vertical maximal encore considere comme un interligne, et non un saut de bloc. */
const GAP_CEILING = 3.5

export interface OpenDocument {
  document: PDFDocumentProxy
  /** Libere le document et son worker. */
  close: () => Promise<void>
}

export async function loadDocument(bytes: Uint8Array): Promise<OpenDocument> {
  // pdf.js prend possession du buffer ; on lui en donne une copie pour que
  // l'original reste utilisable si on veut recharger le document.
  const task = pdfjs.getDocument({ data: bytes.slice() })
  const document = await task.promise

  // La liberation passe par la tache de chargement, pas par le document :
  // c'est elle qui detient le worker.
  return { document, close: () => task.destroy() }
}

interface PositionedFragment {
  text: string
  x: number
  y: number
  width: number
}

/** Une ligne visuelle, avec ce qu'il faut pour savoir ou elle se pose. */
interface Line {
  text: string
  /** Ligne de base, en coordonnees PDF : elle croit vers le haut de la page. */
  y: number
}

/**
 * Reassemble les fragments d'une page en lignes visuelles.
 *
 * pdf.js renvoie le texte dans l'ordre du fichier, qui n'est pas l'ordre de
 * lecture : une simple concatenation produit une bouillie ou les titres, les
 * colonnes et les notes de bas de page se melangent. On regroupe donc par
 * ligne de base puis on trie de gauche a droite.
 */
function pageLines(fragments: PositionedFragment[]): Line[] {
  if (fragments.length === 0) return []

  const sorted = [...fragments].sort((a, b) => {
    const dy = b.y - a.y
    if (Math.abs(dy) > LINE_TOLERANCE) return dy
    return a.x - b.x
  })

  const lines: Line[] = []
  let current: PositionedFragment[] = [sorted[0]]

  const flush = (): void => {
    const text = joinLine(current).trimEnd()
    if (text.trim()) lines.push({ text, y: current[0].y })
  }

  for (const fragment of sorted.slice(1)) {
    const reference = current[current.length - 1]
    if (Math.abs(fragment.y - reference.y) <= LINE_TOLERANCE) {
      current.push(fragment)
    } else {
      flush()
      current = [fragment]
    }
  }
  flush()

  return lines
}

/**
 * L'interligne courant du document.
 *
 * Mesure sur tout le document et non page par page : une page de titre ou une
 * page a demi vide donne une poignee d'ecarts dont la mediane ne veut rien
 * dire, et le seuil de paragraphe qui en decoule serait aberrant sur cette
 * page-la seulement. Les ecarts trop grands sont ecartes du calcul — ce sont
 * deja des sauts de bloc, ils tireraient la mediane vers le haut.
 */
function medianGap(pages: Line[][]): number {
  const gaps: number[] = []

  for (const lines of pages) {
    for (let index = 1; index < lines.length; index += 1) {
      const gap = lines[index - 1].y - lines[index].y
      if (gap > 0 && gap < 200) gaps.push(gap)
    }
  }

  if (gaps.length === 0) return 0
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * L'en-tete courant de chaque page, ou null.
 *
 * Une ligne de haut de page qui reapparait a l'identique sur la page voisine
 * n'est pas du contenu : c'est le nom de la section en cours, repete par la
 * mise en page. La repetition est le seul critere — ni la taille, ni la graisse
 * ne sont lisibles depuis pdf.js hors rendu, et la position seule confondrait
 * l'en-tete avec la premiere phrase du texte.
 *
 * On exige une page *voisine*, et non une frequence sur tout le document : un
 * en-tete courant accompagne sa section et disparait avec elle. Compter sur
 * l'ensemble des pages ferait manquer toutes les sections courtes.
 */
function runningHeads(pages: Line[][]): (string | null)[] {
  const tops = pages.map((lines) => lines[0]?.text ?? '')

  return tops.map((top, index) => {
    // Un en-tete tient sur une ligne ; une phrase qui court sur toute la
    // largeur est du texte, meme si le hasard la repete.
    if (!top.trim() || top.length > 120) return null

    const key = normalise(top)
    if (!key) return null

    const before = index > 0 ? normalise(tops[index - 1]) : ''
    const after = index + 1 < tops.length ? normalise(tops[index + 1]) : ''

    return key === before || key === after ? top.trim() : null
  })
}

/** Un numero seul, ou un numero de section : le vocabulaire d'un sommaire. */
const TOC_ENTRY = /^\s*(?:\d{1,3}|\d+(?:\.\d+){0,3}\.?|[IVXLC]{1,5}\.?)\s*$/
/** « ... 16 » ou « ....... 16 » : le renvoi de page d'un sommaire imprime. */
const TOC_LEADER = /[.·…]{3,}\s*\d{1,3}\s*$/

/**
 * Une page de sommaire.
 *
 * Son texte est du renvoi, pas du contenu : « Le pont de creation de valeur
 * ...... 16 » n'a rien a repondre a personne, et ses titres empiles font un
 * amas de mots-cles qui remonte a toutes les questions sans jamais y repondre.
 */
function looksLikeToc(lines: Line[]): boolean {
  if (lines.length < 4) return false

  // Le titre de la page le dit souvent lui-meme — parfois lettre par lettre,
  // « S O M M A I R E », d'ou la suppression des espaces avant de comparer.
  const heading = lines[0].text.replace(/\s+/g, '').toLowerCase()
  if (/^(sommaire|tabledesmati|contents|tableofcontents)/.test(heading)) return true

  const marks = lines.filter(
    (line) => TOC_ENTRY.test(line.text) || TOC_LEADER.test(line.text)
  ).length

  return marks / lines.length >= 0.4
}

/** Une ligne coupee par une cesure : le mot reprend sur la suivante. */
const HYPHENATED = /(\p{Ll})[-‐‑]$/u

/**
 * Assemble les lignes d'une page en paragraphes.
 *
 * C'est ici que l'information de mise en page devient de la structure : les
 * lignes d'un meme paragraphe sont recollees en une phrase continue, et les
 * paragraphes separes par une ligne vide — la seule frontiere sur laquelle le
 * decoupage puisse ensuite couper sans casser une phrase en deux.
 */
function assemble(lines: Line[], gap: number): string {
  if (lines.length === 0) return ''

  const paragraphs: string[] = []
  let current = lines[0].text

  for (let index = 1; index < lines.length; index += 1) {
    const distance = lines[index - 1].y - lines[index].y
    // Un ecart negatif ou demesure signale une colonne, un encadre, un saut
    // ailleurs sur la page : dans le doute, on ouvre un paragraphe.
    const broken =
      gap <= 0 ||
      distance <= 0 ||
      distance > gap * GAP_CEILING ||
      distance > gap * PARAGRAPH_GAP

    if (broken) {
      paragraphs.push(current)
      current = lines[index].text
      continue
    }

    // Meme paragraphe : les deux lignes n'en font plus qu'une. La cesure de fin
    // de ligne est un artefact de mise en page, pas un trait d'union du mot.
    const match = HYPHENATED.exec(current)
    current = match
      ? `${current.slice(0, -1)}${lines[index].text.trimStart()}`
      : `${current} ${lines[index].text.trimStart()}`
  }
  paragraphs.push(current)

  return paragraphs
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Recolle les fragments d'une meme ligne. pdf.js decoupe parfois un mot en
 * plusieurs fragments (ligatures, changement de police) : on n'insere un
 * espace que si l'ecart horizontal le justifie vraiment.
 */
function joinLine(fragments: PositionedFragment[]): string {
  let line = ''
  let previousEnd: number | null = null
  let previousWidth = 0

  for (const fragment of fragments) {
    if (previousEnd !== null) {
      const gap = fragment.x - previousEnd
      const reference = previousWidth || fragment.width
      const needsSpace = gap > reference * WORD_GAP_RATIO
      if (needsSpace && !line.endsWith(' ') && !fragment.text.startsWith(' ')) {
        line += ' '
      }
    }
    line += fragment.text
    previousEnd = fragment.x + fragment.width
    previousWidth = fragment.width / Math.max(fragment.text.length, 1)
  }

  return line
}

async function extractPage(page: PDFPageProxy): Promise<Line[]> {
  const content = await page.getTextContent()

  const fragments: PositionedFragment[] = content.items
    .filter((item): item is TextItem => 'str' in item)
    .filter((item) => item.str.length > 0)
    .map((item) => ({
      text: item.str,
      // transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
      x: item.transform[4],
      y: item.transform[5],
      width: item.width
    }))

  return pageLines(fragments)
}

/**
 * En deca de ces dimensions, une image de PDF est une decoration — un logo, un
 * separateur, une puce — et la donner a lire couterait vingt secondes pour
 * rendre une ligne vide. Le processus principal refait son propre tri sur le
 * poids du fichier ; celui-ci evite seulement d'ecrire des vignettes inutiles.
 */
const FIGURE_MIN_SIDE = 100
const FIGURE_MIN_AREA = 40_000

/**
 * Plafond d'images extraites d'un document. Aucun support de cours n'approche
 * ce nombre de vraies captures ; un PDF pathologique — un fond decoratif pose
 * sur chaque page en grand format — s'arrete la au lieu d'inonder le disque et
 * la file de lecture.
 */
const FIGURE_CEILING = 60

/** Ce qu'un objet image de pdf.js peut porter, selon le chemin de decodage. */
interface PdfImage {
  bitmap?: ImageBitmap
  data?: Uint8ClampedArray
  width?: number
  height?: number
  kind?: number
}

/** Les donnees brutes de pdf.js en RGBA, pretes pour un canvas. */
function toRgba(image: PdfImage): Uint8ClampedArray<ArrayBuffer> | null {
  const { data, width = 0, height = 0, kind } = image
  if (!data) return null

  const out = new Uint8ClampedArray(width * height * 4)

  // Les trois formes que pdf.js produit : 1 bit noir et blanc (les scans de
  // photocopieuse), RGB, RGBA.
  if (kind === 1) {
    const rowBytes = Math.ceil(width / 8)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const value = bit ? 255 : 0
        const at = (y * width + x) * 4
        out[at] = out[at + 1] = out[at + 2] = value
        out[at + 3] = 255
      }
    }
    return out
  }

  if (kind === 2) {
    for (let i = 0, j = 0; i < width * height; i += 1, j += 3) {
      const at = i * 4
      out[at] = data[j]
      out[at + 1] = data[j + 1]
      out[at + 2] = data[j + 2]
      out[at + 3] = 255
    }
    return out
  }

  if (kind === 3) {
    out.set(data.subarray(0, out.length))
    return out
  }

  return null
}

/** Convertit un objet image de pdf.js en PNG. Null si trop petit ou illisible. */
async function figureToPng(image: PdfImage): Promise<Uint8Array | null> {
  const width = image.bitmap?.width ?? image.width ?? 0
  const height = image.bitmap?.height ?? image.height ?? 0
  if (width < FIGURE_MIN_SIDE || height < FIGURE_MIN_SIDE || width * height < FIGURE_MIN_AREA) {
    return null
  }

  const canvas = window.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null

  if (image.bitmap) {
    context.drawImage(image.bitmap, 0, 0)
  } else {
    const rgba = toRgba(image)
    if (!rgba) return null
    context.putImageData(new ImageData(rgba, width, height), 0, 0)
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return null

  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Les images posees sur une page, en PNG, dans l'ordre ou elles sont peintes.
 *
 * La liste des operations de dessin est le seul endroit ou un PDF avoue ses
 * images : il n'y a pas d'equivalent du `<img>` d'un document HTML. Une image
 * repetee sur la page — un fond, un filigrane — n'est prise qu'une fois.
 */
async function pageFigures(page: PDFPageProxy): Promise<Uint8Array[]> {
  const operators = await page.getOperatorList()

  const names: unknown[] = []
  const seen = new Set<unknown>()
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const fn = operators.fnArray[index]
    if (
      fn === pdfjs.OPS.paintImageXObject ||
      fn === pdfjs.OPS.paintInlineImageXObject ||
      fn === pdfjs.OPS.paintImageXObjectRepeat
    ) {
      const name = operators.argsArray[index]?.[0]
      if (name !== undefined && !seen.has(name)) {
        seen.add(name)
        names.push(name)
      }
    }
  }

  const figures: Uint8Array[] = []
  for (const name of names) {
    try {
      const image = await resolveImage(page, name)
      if (!image) continue

      const png = await figureToPng(image)
      if (png) figures.push(png)
    } catch {
      // Une image qui ne se decode pas est une image qu'on ne lira pas ; les
      // autres et le texte de la page continuent d'exister.
    }
  }

  return figures
}

/**
 * Retrouve un objet image par son nom, en attendant son decodage.
 *
 * La forme directe de `objs.get` jette des que l'objet n'est pas encore
 * resolu — et c'est un cas reel, pas une precaution : la liste d'operations
 * rend la main avant que toutes les images soient decodees, et huit images sur
 * trente-sept y echappaient sur un vrai cours de la bibliotheque. La forme a
 * rappel attend le decodage ; le delai borne l'attente, pour qu'un objet
 * abandonne par pdf.js ne suspende pas l'extraction entiere.
 */
function resolveImage(page: PDFPageProxy, name: unknown): Promise<PdfImage | null> {
  // Une image inline arrive deja decodee, directement dans l'argument.
  if (typeof name !== 'string') return Promise.resolve((name as PdfImage) ?? null)

  const store = name.startsWith('g_') ? page.commonObjs : page.objs

  return new Promise((resolve) => {
    const quit = setTimeout(() => resolve(null), 5_000)
    try {
      store.get(name, (image: PdfImage) => {
        clearTimeout(quit)
        resolve(image ?? null)
      })
    } catch {
      clearTimeout(quit)
      resolve(null)
    }
  })
}

/**
 * Extrait tout le document en gardant l'ancre de page. Le marqueur `=== Page N ===`
 * est ce qui permet a Claude de citer « page 12 » et a l'application de renvoyer
 * l'utilisateur au bon endroit du document.
 */
export async function extractCourse(
  courseId: string,
  document: PDFDocumentProxy,
  onProgress?: (page: number, total: number) => void,
  /**
   * Vrai des que l'appelant a cesse de vouloir ce document. Il faut que la
   * question soit posee, et non deduite des erreurs : fermer le document fait
   * echouer toutes les pages restantes, ce qui, sans ce signal, se lirait comme
   * une suite de pages illisibles et produirait un cours tronque — mis en cache
   * comme s'il etait complet.
   */
  abandoned?: () => boolean
): Promise<ExtractedCourse> {
  const pageCount = document.numPages
  const lines: Line[][] = []

  // Premiere passe : les lignes de chaque page, telles quelles. Rien n'est
  // encore assemble — l'interligne du document et les en-tetes courants ne se
  // voient qu'une fois toutes les pages lues, et ils decident de tout le reste.
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (abandoned?.()) throw new Error('Lecture abandonnee.')

    // Une page se lit pour elle seule. Une police cassee, un flux de contenu
    // corrompu, une image la ou l'on attendait du texte : l'incident est reel
    // et local. Sans cette reserve, il faisait perdre les cinq cents autres
    // pages, sans que rien a l'ecran ne dise laquelle avait pose probleme.
    let extracted: Line[] = []
    try {
      const page = await document.getPage(pageNumber)
      extracted = await extractPage(page)
      page.cleanup()
    } catch {
      // La page reste vide : elle ne sera ni indexee, ni citable, et le reste
      // du document continue d'exister.
    }

    lines.push(extracted)
    onProgress?.(pageNumber, pageCount)
  }

  // Le meme controle apres la boucle, et non par prudence decorative : un
  // abandon survenu pendant la lecture de la derniere page est avale par la
  // reserve ci-dessus, et plus aucun tour ne vient ensuite le remarquer. Sans
  // cette ligne, ce seul cas laisse passer un document ampute de sa fin, qui
  // serait mis en cache comme s'il etait complet.
  if (abandoned?.()) throw new Error('Lecture abandonnee.')

  // Seconde passe : purement calculatoire, et instantanee a cote de la lecture.
  const gap = medianGap(lines)
  const heads = runningHeads(lines)

  const pages: ExtractedPage[] = lines.map((pageContent, index) => {
    const section = heads[index]
    // L'en-tete courant sort du corps : repete sur chaque page de sa section,
    // il y serait indexe autant de fois, et il repondrait a la place du texte
    // qu'il surmonte. Il ne disparait pas pour autant — il devient l'etiquette
    // de la page.
    const body = section ? pageContent.slice(1) : pageContent

    return {
      page: index + 1,
      text: assemble(body, gap),
      section,
      toc: looksLikeToc(pageContent)
    }
  })

  // Compte sur le texte seul, avant la pose des marqueurs de figures : un
  // document scanne doit rester reconnu comme tel, meme si chacune de ses
  // pages est une grande image.
  const characters = pages.reduce((total, page) => total + page.text.length, 0)
  const looksScanned = pageCount > 0 && characters / pageCount < SCANNED_THRESHOLD

  // Les images du document : chacune est posee sur le disque et signalee par
  // un marqueur dans le texte, pour etre decrite apres la vectorisation.
  // Seulement quand le document est lisible : les pages d'un scan sont des
  // images, et les extraire ici rendrait le document entier en doublon.
  let media: string[] | undefined
  if (!looksScanned) {
    const names: string[] = []

    for (const [index, page] of pages.entries()) {
      if (abandoned?.()) throw new Error('Lecture abandonnee.')
      if (names.length >= FIGURE_CEILING) break

      try {
        const proxy = await document.getPage(page.page)
        const figures = await pageFigures(proxy)
        proxy.cleanup()

        for (const png of figures) {
          if (names.length >= FIGURE_CEILING) break
          // L'image part sur le disque sous son empreinte, et le texte recoit
          // un marqueur a sa place : c'est exactement le contrat du chemin
          // Word, et c'est ce qui permet au processus principal de rendre
          // chaque capture a son emplacement, avant le decoupage en passages.
          const name = await window.noted.media.keep(png, 'image/png')
          names.push(name)
          pages[index].text = pages[index].text ? `${pages[index].text}\n\n[figure]` : '[figure]'
        }
      } catch {
        // Une page dont les images ne se lisent pas garde son texte : rien
        // d'autre a faire.
      }
    }

    if (names.length > 0) media = names
  }

  const markdown = pages
    .map((page) => {
      const label = page.section ? `=== Page ${page.page} — ${page.section} ===` : `=== Page ${page.page} ===`
      return `${label}\n\n${page.text}`
    })
    .join('\n\n')

  return {
    courseId,
    anchor: 'page',
    pageCount,
    pages,
    markdown,
    // Approximation volontairement grossiere : elle sert a prevenir avant de
    // charger un document enorme, pas a facturer quoi que ce soit.
    approxTokens: Math.ceil(markdown.length / 3.6),
    looksScanned,
    media
  }
}

/**
 * Rend une page dans un canvas, a la largeur demandee.
 *
 * Renvoie de quoi annuler le rendu en cours. Sans cela, faire glisser le
 * separateur relance le rendu des pages a chaque pixel et le moteur continue
 * de vider sa file longtemps apres qu'on a lache la souris — et comme il
 * refuse de peindre deux fois le meme canvas a la fois, la page qu'on
 * redimensionne reste blanche.
 */
export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  targetWidth: number
): { done: Promise<void>; cancel: () => void } {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Contexte 2D indisponible')

  const unscaled = page.getViewport({ scale: 1 })
  const scale = targetWidth / unscaled.width
  // On rend a la densite de l'ecran, sinon le texte est floute sur Retina.
  const density = window.devicePixelRatio || 1
  const viewport = page.getViewport({ scale: scale * density })

  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(viewport.width / density)}px`
  canvas.style.height = `${Math.floor(viewport.height / density)}px`

  const task = page.render({ canvas, canvasContext: context, viewport })
  return { done: task.promise, cancel: () => task.cancel() }
}

/**
 * Pose la couche de texte au-dessus de la page peinte.
 *
 * Une page de PDF est une image : il n'y a rien a selectionner dessus, et c'est
 * pour cela qu'on ne pouvait rien y surligner. pdf.js sait poser par-dessus des
 * glyphes transparents, places au pixel pres sur ceux de l'image. Le texte reste
 * invisible, mais le curseur l'attrape — la selection, le surlignage et le
 * copier-coller redeviennent possibles sans que rien ne change a l'oeil.
 *
 * Les positions sont exprimees en pourcentage du cadre et les corps de police
 * en multiples de `--total-scale-factor` : c'est cette variable qui aligne la
 * couche sur l'image, et elle porte donc l'echelle d'affichage, non celle du
 * rendu Retina.
 */
export function renderTextLayer(
  page: PDFPageProxy,
  container: HTMLElement,
  targetWidth: number
): { done: Promise<void>; cancel: () => void } {
  const unscaled = page.getViewport({ scale: 1 })
  const scale = targetWidth / unscaled.width

  forgetRelay(container)
  container.replaceChildren()
  container.style.setProperty('--total-scale-factor', String(scale))
  // pdf.js arrondit les dimensions de la couche au pixel entier, par une regle
  // qui n'a pas de valeur par defaut hors de sa propre feuille de style.
  container.style.setProperty('--scale-round-x', '1px')
  container.style.setProperty('--scale-round-y', '1px')

  const layer = new TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport: page.getViewport({ scale })
  })

  const done = layer.render().then(() => installRelay(container))

  return {
    done,
    cancel: () => {
      forgetRelay(container)
      layer.cancel()
    }
  }
}

/* --- Les liens du document -------------------------------------------------
 *
 * Le sommaire d'un PDF n'est pas du texte souligne : ce sont des annotations
 * « Link », des rectangles poses a cote de la page et qui designent chacun une
 * destination. Rien de tout cela n'apparait dans l'image peinte, ni dans la
 * couche de texte qui ne porte que des glyphes — d'ou un sommaire inerte tant
 * qu'on ne va pas lire les annotations pour lui.
 *
 * pdf.js sait les rendre lui-meme, mais par l'appareil du visionneur
 * (`AnnotationLayer`, son service de liens, sa feuille de style), qui apporte
 * avec lui les formulaires, les commentaires et l'editeur. On ne lit ici que
 * ce qui sert : ou est le rectangle, et vers quoi il pointe.
 */

/** Un lien de la page. La boite est en pourcentage du cadre de celle-ci. */
export interface PdfLink {
  left: number
  top: number
  width: number
  height: number
  /** La page visee dans le document, ou null pour un lien externe. */
  page: number | null
  /** Ou tomber dans cette page, en fraction de sa hauteur depuis le haut. */
  offset: number
  /** L'adresse visee hors du document, ou null pour un renvoi interne. */
  url: string | null
}

/**
 * L'ordonnee visee par une destination, dans le repere du PDF.
 *
 * Une destination dit comment cadrer la page d'arrivee, et chaque forme le dit
 * a sa maniere : `XYZ` donne un coin, `FitH` une ligne, `FitR` un rectangle.
 * Les autres (`Fit`, `FitV`) cadrent la page entiere et n'ont donc pas de
 * hauteur a donner : on tombe alors en haut de la page, ce qu'elles demandent.
 */
function destinationTop(destination: unknown[]): number | null {
  const shape = (destination[1] as { name?: string } | null)?.name
  const at = (index: number): number | null =>
    typeof destination[index] === 'number' ? (destination[index] as number) : null

  if (shape === 'XYZ') return at(3)
  if (shape === 'FitH' || shape === 'FitBH') return at(2)
  if (shape === 'FitR') return at(5)
  return null
}

/**
 * Resout une destination en une page et une hauteur dans cette page.
 *
 * Une destination arrive soit nommee — « s6-4 », a chercher dans la table du
 * document — soit deja explicite. Dans les deux cas elle finit en tableau dont
 * le premier terme designe la page : une reference a resoudre, ou son rang en
 * clair pour les documents qui numerotent directement.
 */
async function resolveDestination(
  document: PDFDocumentProxy,
  viewport: PageViewport,
  destination: string | unknown[]
): Promise<{ page: number; offset: number } | null> {
  const explicit =
    typeof destination === 'string' ? await document.getDestination(destination) : destination
  if (!Array.isArray(explicit) || explicit.length === 0) return null

  const first = explicit[0]
  const page =
    typeof first === 'number' ? first + 1 : (await document.getPageIndex(first as RefProxy)) + 1

  const top = destinationTop(explicit)
  if (top === null) return { page, offset: 0 }

  // La conversion passe par le cadre de la page d'ou part le lien, et non par
  // celui de la page visee : les supports de cours ont un format unique, et
  // c'est deja sur cette hypothese que le panneau reserve la hauteur de toutes
  // ses pages a partir de la premiere. Une page a ouvrir de moins par lien.
  const [, y] = viewport.convertToViewportPoint(0, top)
  return { page, offset: Math.min(1, Math.max(0, y / viewport.height)) }
}

/**
 * Les liens d'une page, prets a etre poses par-dessus l'image.
 *
 * Un lien casse — destination absente de la table, page disparue — est un lien
 * de moins, pas une page sans liens : chacun se resout de son cote.
 */
export async function pageLinks(
  document: PDFDocumentProxy,
  pageNumber: number
): Promise<PdfLink[]> {
  const page = await document.getPage(pageNumber)
  const annotations = await page.getAnnotations({ intent: 'display' })
  const viewport = page.getViewport({ scale: 1 })
  page.cleanup()

  const links = await Promise.all(
    annotations
      .filter((annotation) => annotation.subtype === 'Link')
      .map(async (annotation): Promise<PdfLink | null> => {
        // Le rectangle est donne dans le repere du PDF, origine en bas a
        // gauche : convertir ses deux coins le remet a l'endroit, et le
        // pourcentage le rend independant de la largeur d'affichage et du zoom.
        const corner = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1])
        const opposite = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3])
        const box = [corner[0], corner[1], opposite[0], opposite[1]]
        const width = Math.abs(box[2] - box[0])
        const height = Math.abs(box[3] - box[1])
        // Un rectangle degenere ne se clique pas, mais il attraperait quand
        // meme le curseur : autant ne pas le poser.
        if (width < 1 || height < 1) return null

        const frame = {
          left: (Math.min(box[0], box[2]) / viewport.width) * 100,
          top: (Math.min(box[1], box[3]) / viewport.height) * 100,
          width: (width / viewport.width) * 100,
          height: (height / viewport.height) * 100
        }

        if (annotation.url) return { ...frame, page: null, offset: 0, url: annotation.url }
        if (!annotation.dest) return null

        const target = await resolveDestination(document, viewport, annotation.dest).catch(
          () => null
        )
        if (!target) return null
        return { ...frame, page: target.page, offset: target.offset, url: null }
      })
  )

  return links.filter((link): link is PdfLink => link !== null)
}

/* --- Le relais du glissement ----------------------------------------------
 *
 * Les glyphes transparents sont des boites absolues qui ne couvrent que leurs
 * propres lettres. Entre deux lignes, dans une marge, autour d'une figure, il
 * n'y a rien a attraper : un glissement qui passe par ces blancs voit sa
 * selection sauter a la fin de la page au lieu de s'etendre au fil du texte.
 *
 * pdf.js resout cela par un calque supplementaire, le dernier enfant de la
 * couche, replie sous elle au repos et deplie sur toute sa surface le temps
 * d'un glissement : le moteur de selection a alors une cible continue. Le
 * calque se deplace en outre juste apres le point d'ancrage courant, ce qui
 * donne a la selection un sens de lecture stable quand elle traverse deux
 * pages.
 *
 * Ce mecanisme vit dans `TextLayerBuilder`, la classe du visionneur, que nous
 * n'utilisons pas : nous posons la couche nous-memes avec la classe bas niveau
 * `TextLayer`, qui ne construit que les glyphes. Ce qui suit reprend donc la
 * logique de `TextLayerBuilder.#bindMouse`, reduite a ce qui sert ici.
 *
 * Chromium n'a plus besoin du contournement depuis sa version 148 ; Electron 43
 * en embarque la 142. La verification reste, pour que le deplacement du calque
 * s'eteigne de lui-meme a la prochaine montee de version.
 */

/** Une couche de texte et son calque de relais. */
const relays = new Map<HTMLElement, HTMLElement>()
let watching = false
/** Le dernier intervalle vu, pour savoir de quel bout la selection s'etend. */
let lastRange: Range | null = null

function installRelay(container: HTMLElement): void {
  const end = document.createElement('div')
  end.className = 'endOfContent'
  container.append(end)
  relays.set(container, end)

  container.addEventListener('mousedown', (event) => {
    container.classList.add('selecting')
    beginSelection(container, event)
  })
  watchSelection()
}

/* --- Le glissement depuis un blanc ----------------------------------------
 *
 * Les glyphes d'une page sont des boites *absolues* : la couche qui les porte
 * n'a, elle, aucun contenu en flux. Un appui sur un interligne, sur la marge de
 * la page, sur le blanc entre deux colonnes tombe donc sur un element ou le
 * navigateur ne peut designer aucune position de caret — il n'y a rien a
 * attraper, et le glissement ne demarre pas. Rendre la couche selectionnable n'y
 * change rien : ce n'est pas une interdiction qu'on lui oppose, c'est une
 * absence. C'est la difference avec un document ordinaire, ou cliquer dans la
 * marge d'un paragraphe pose le curseur sur la lettre la plus proche.
 *
 * On refait donc ce travail a la main, et seulement la : quand l'appui tombe sur
 * un glyphe, le navigateur sait faire et on ne s'en mele pas.
 */

/** La position de texte la plus proche d'un point, dans une couche donnee. */
function positionAt(
  layer: HTMLElement,
  x: number,
  y: number
): { node: Node; offset: number } | null {
  let best: { span: HTMLElement; box: DOMRect } | null = null
  let closest = Number.POSITIVE_INFINITY

  for (const span of Array.from(layer.querySelectorAll<HTMLElement>('span'))) {
    if (span.firstChild?.nodeType !== Node.TEXT_NODE) continue
    const box = span.getBoundingClientRect()
    if (box.width < 0.5 || box.height < 0.5) continue

    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0
    // La ligne se decide avant la colonne : on ne change pas de ligne pour
    // quelques pixels de moins a l'horizontale.
    const distance = dy * 1000 + dx
    if (distance < closest) {
      closest = distance
      best = { span, box }
    }
  }

  if (!best) return null

  // Le caractere exact se laisse trouver par le navigateur, une fois le point
  // ramene a l'interieur de la ligne retenue.
  const inside = document.caretRangeFromPoint(
    Math.min(Math.max(x, best.box.left + 0.5), best.box.right - 0.5),
    best.box.top + best.box.height / 2
  )
  if (inside) return { node: inside.startContainer, offset: inside.startOffset }
  return best.span.firstChild ? { node: best.span.firstChild, offset: 0 } : null
}

function beginSelection(container: HTMLElement, event: MouseEvent): void {
  if (event.button !== 0) return

  const target = event.target as HTMLElement | null
  const onBlank = target === container || target?.classList.contains('endOfContent')
  if (!onBlank) return

  const start = positionAt(container, event.clientX, event.clientY)
  const selection = document.getSelection()
  if (!start || !selection) return

  event.preventDefault()
  selection.setBaseAndExtent(start.node, start.offset, start.node, start.offset)

  const onMove = (move: MouseEvent): void => {
    // La couche sous le pointeur, et non celle de depart : une selection doit
    // pouvoir courir d'une page a la suivante.
    const over = document.elementFromPoint(move.clientX, move.clientY)
    const layer = over?.closest<HTMLElement>('.textLayer') ?? container
    const end = positionAt(layer, move.clientX, move.clientY)
    if (end) selection.extend(end.node, end.offset)
  }

  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function forgetRelay(container: HTMLElement): void {
  relays.delete(container)
  container.classList.remove('selecting')
}

/** Replie le calque sous sa couche : le glissement est fini. */
function foldRelay(end: HTMLElement, container: HTMLElement): void {
  container.append(end)
  end.style.width = ''
  end.style.height = ''
  container.classList.remove('selecting')
}

function foldAll(): void {
  relays.forEach(foldRelay)
}

function watchSelection(): void {
  if (watching) return
  watching = true

  let pressed = false
  document.addEventListener('pointerdown', () => {
    pressed = true
  })
  document.addEventListener('pointerup', () => {
    pressed = false
    foldAll()
  })
  window.addEventListener('blur', () => {
    pressed = false
    foldAll()
  })
  document.addEventListener('keyup', () => {
    if (!pressed) foldAll()
  })

  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) {
      foldAll()
      return
    }

    // Seules les couches que la selection traverse restent depliees.
    const touched = new Set<HTMLElement>()
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index)
      for (const container of relays.keys()) {
        if (!touched.has(container) && range.intersectsNode(container)) touched.add(container)
      }
    }
    for (const [container, end] of relays) {
      if (touched.has(container)) container.classList.add('selecting')
      else foldRelay(end, container)
    }

    if (chromiumHandlesItself()) return

    // De quel bout la selection s'etend-elle ? Si la borne de fin n'a pas
    // bouge, c'est le debut qui suit la souris.
    const range = selection.getRangeAt(0)
    const fromStart =
      lastRange !== null &&
      (range.compareBoundaryPoints(Range.END_TO_END, lastRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, lastRange) === 0)

    let anchor: Node | null = fromStart ? range.startContainer : range.endContainer
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode
    if (!anchor) return

    // Une borne posee au tout debut d'un noeud appartient en realite au noeud
    // precedent : on remonte jusqu'au dernier qui porte du contenu.
    if (!fromStart && range.endOffset === 0) {
      let walk: Node = anchor
      do {
        while (!walk.previousSibling) {
          if (!walk.parentNode) return
          walk = walk.parentNode
        }
        walk = walk.previousSibling
      } while (walk.childNodes.length === 0)
      anchor = walk
    }

    const parent = anchor.parentElement
    const container = parent?.closest<HTMLElement>('.textLayer')
    const end = container ? relays.get(container) : undefined
    if (parent && container && end) {
      end.style.width = container.style.width
      end.style.height = container.style.height
      parent.insertBefore(end, fromStart ? anchor : anchor.nextSibling)
    }

    lastRange = range.cloneRange()
  })
}

/** Vrai a partir de Chromium 148, ou le contournement n'a plus lieu d'etre. */
function chromiumHandlesItself(): boolean {
  const version = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1]
  return !!version && Number.parseInt(version, 10) >= 148
}
