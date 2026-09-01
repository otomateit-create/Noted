/**
 * L'apercu d'un cours : sa premiere page, en image, pour la carte de la page
 * de matiere.
 *
 * Un PDF se rend tel quel par pdf.js, a la largeur de la carte. Les autres
 * formats — Word, PowerPoint, Markdown, HTML — n'ont pas de premiere page a
 * proprement parler : on en typographie une, sur une feuille blanche, avec
 * leur vrai debut — premier titre, premiers paragraphes, premieres puces. Ce
 * n'est pas le rendu au pixel pres, mais c'est bien ce cours-la qu'on
 * reconnait avant d'avoir lu son titre.
 *
 * Le rendu se fait une fois, puis vit dans le cache du vault (.noted/apercus,
 * voir main/preview-cache.ts) jusqu'a ce que le fichier change. Les cartes
 * d'une matiere demandent leurs apercus a la file, un a la fois : ouvrir dix
 * PDF en meme temps pour n'en peindre que la premiere page mettrait le
 * processus a genoux pour rien.
 */

import type { Course, CoursePreview } from '@shared/types'
import { prepareDocumentHtml, renderMarkdownCourse } from './document'
import { prepareHtmlCourse } from './html-course'
import { withoutFrontMatter } from './markdown'
import { loadDocument } from './pdf'
import { convertPptx } from './pptx'

/** Largeur de l'image, en pixels : deux fois la carte, pour rester nette sur Retina. */
const WIDTH = 640
/** Hauteur au plus : le haut d'une page A4, aux proportions de la carte (1,42). */
const HEIGHT = 452

/** Au-dela, la feuille est pleine de toute facon. */
const BLOCK_LIMIT = 40

/** Ce que la carte affiche : une URL d'image, et la taille du cours si on la sait. */
export interface Preview {
  url: string
  pages?: number
  words?: number
}

// ---------------------------------------------------------------------------
// La file : un rendu a la fois
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve()

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job)
  chain = next.catch(() => undefined)
  return next
}

// ---------------------------------------------------------------------------
// Ce qu'on garde en memoire pour la session : la meme carte redemandee ne
// relit pas le disque. La cle porte la date du fichier, pour qu'un document
// remplace donne un nouvel apercu.
// ---------------------------------------------------------------------------

const memory = new Map<string, Promise<Preview>>()

export function coursePreview(course: Course): Promise<Preview> {
  const key = `${course.id}@${course.modifiedAt}`
  const known = memory.get(key)
  if (known) return known

  const promise = (async (): Promise<Preview> => {
    const cached = await window.noted.course.readPreview(course.id).catch(() => null)
    const preview = cached ?? (await enqueue(() => build(course)))
    // Comme l'extraction : le cache s'ecrit sans que rien ne l'attende.
    if (!cached) void window.noted.course.cachePreview(course.id, preview)

    return {
      // La copie : TypeScript ne tient pas un tableau venu de l'IPC pour un
      // BlobPart (son tampon pourrait etre partage) ; quelques dizaines de
      // kilo-octets, une fois par cours et par session.
      url: URL.createObjectURL(new Blob([preview.png.slice()], { type: 'image/png' })),
      ...(preview.pages !== undefined ? { pages: preview.pages } : {}),
      ...(preview.words !== undefined ? { words: preview.words } : {})
    }
  })()

  memory.set(key, promise)
  promise.catch(() => memory.delete(key))
  return promise
}

async function build(course: Course): Promise<CoursePreview> {
  switch (course.format) {
    case 'pdf':
      return pdfPreview(course.id)
    case 'docx': {
      const converted = await window.noted.course.readDocx(course.id)
      return sheetPreview(prepareDocumentHtml(converted.html), course.title)
    }
    case 'pptx': {
      const bytes = await window.noted.course.readBytes(course.id)
      const converted = await convertPptx(bytes)
      return sheetPreview(prepareDocumentHtml(converted.html), course.title)
    }
    case 'html': {
      const raw = await window.noted.course.readMarkdown(course.id)
      return sheetPreview(prepareHtmlCourse(raw).html, course.title)
    }
    default: {
      const text = await window.noted.course.readMarkdown(course.id)
      return sheetPreview(renderMarkdownCourse(withoutFrontMatter(text)), course.title)
    }
  }
}

// ---------------------------------------------------------------------------
// PDF : la premiere page, telle quelle
// ---------------------------------------------------------------------------

async function pdfPreview(courseId: string): Promise<CoursePreview> {
  const bytes = await window.noted.course.readBytes(courseId)
  const handle = await loadDocument(bytes)

  try {
    const page = await handle.document.getPage(1)
    const unscaled = page.getViewport({ scale: 1 })
    // Pas de densite d'ecran ici, contrairement a renderPage : l'apercu est
    // deja rendu a deux fois sa taille d'affichage, et il part sur le disque.
    const viewport = page.getViewport({ scale: WIDTH / unscaled.width })

    const full = document.createElement('canvas')
    full.width = Math.floor(viewport.width)
    full.height = Math.floor(viewport.height)
    const context = full.getContext('2d')
    if (!context) throw new Error('Contexte 2D indisponible')
    await page.render({ canvas: full, canvasContext: context, viewport }).promise
    page.cleanup()

    // Une page portrait est coupee a la hauteur de la carte ; une diapositive,
    // plus basse, part entiere.
    const cropped = document.createElement('canvas')
    cropped.width = full.width
    cropped.height = Math.min(full.height, HEIGHT)
    cropped.getContext('2d')?.drawImage(full, 0, 0)

    return { png: await toPng(cropped), pages: handle.document.numPages }
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------
// Les autres formats : une feuille typographiee avec le debut du texte
// ---------------------------------------------------------------------------

interface Block {
  kind: 'heading' | 'text' | 'bullet'
  text: string
}

/** Titres, paragraphes et puces, dans l'ordre du document, et le nombre de mots. */
function blocksFromHtml(html: string): { blocks: Block[]; words: number } {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const words = (parsed.body.textContent ?? '').split(/\s+/).filter(Boolean).length

  const blocks: Block[] = []
  let previous = ''
  for (const element of parsed.body.querySelectorAll('h1, h2, h3, h4, p, li')) {
    if (blocks.length >= BLOCK_LIMIT) break
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    // Une puce faite d'un paragraphe donnerait le meme texte deux fois.
    if (!text || text === previous) continue
    previous = text

    const tag = element.tagName.toLowerCase()
    blocks.push({
      kind: tag === 'li' ? 'bullet' : tag === 'p' ? 'text' : 'heading',
      text
    })
  }

  return { blocks, words }
}

async function sheetPreview(html: string, fallbackTitle: string): Promise<CoursePreview> {
  const { blocks, words } = blocksFromHtml(html)
  const png = await toPng(drawSheet(blocks, fallbackTitle))
  return { png, words }
}

const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"
const SERIF = "'Charter', 'Iowan Old Style', 'Palatino', Georgia, serif"
const MARGIN = 56

/**
 * Une feuille blanche, un titre, puis le texte : les memes voix que
 * l'application — le titre en type systeme, le corps en serif de lecture.
 */
function drawSheet(blocks: Block[], fallbackTitle: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Contexte 2D indisponible')

  context.fillStyle = '#fffdf8'
  context.fillRect(0, 0, WIDTH, HEIGHT)

  const width = WIDTH - MARGIN * 2
  const remaining = [...blocks]
  const title = remaining[0]?.kind === 'heading' ? remaining.shift()!.text : fallbackTitle

  context.fillStyle = '#191a1f'
  context.font = `600 26px ${SANS}`
  let y = wrap(context, title, MARGIN, 66, width, 32, 2) + 16

  for (const block of remaining) {
    if (y > HEIGHT - 12) break

    if (block.kind === 'heading') {
      y += 8
      context.fillStyle = '#2b2620'
      context.font = `600 17px ${SANS}`
      y = wrap(context, block.text, MARGIN, y, width, 24, 2) + 6
      continue
    }

    context.fillStyle = '#3a3630'
    context.font = `15px ${SERIF}`
    if (block.kind === 'bullet') {
      context.fillText('•', MARGIN + 2, y)
      y = wrap(context, block.text, MARGIN + 18, y, width - 18, 22, 3) + 4
    } else {
      y = wrap(context, block.text, MARGIN, y, width, 22, 4) + 8
    }
  }

  return canvas
}

/**
 * Ecrit un texte mot a mot en le pliant a la largeur donnee, au plus
 * `maxLines` lignes, la derniere close par des points de suspension si le
 * texte continue. Rend l'ordonnee de la ligne suivante.
 */
function wrap(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
): number {
  const words = text.split(' ')
  let line = ''
  let lines = 0

  for (let index = 0; index < words.length; index += 1) {
    const candidate = line ? `${line} ${words[index]}` : words[index]
    if (context.measureText(candidate).width <= maxWidth || !line) {
      line = candidate
      continue
    }

    lines += 1
    if (lines === maxLines) {
      context.fillText(ellipsize(context, line, maxWidth), x, y)
      return y + lineHeight
    }
    context.fillText(line, x, y)
    y += lineHeight
    line = words[index]
  }

  if (line) {
    context.fillText(ellipsize(context, line, maxWidth), x, y)
    y += lineHeight
  }
  return y
}

function ellipsize(context: CanvasRenderingContext2D, line: string, maxWidth: number): string {
  if (context.measureText(line).width <= maxWidth) return line
  let cut = line
  while (cut.length > 1 && context.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1)
  }
  return `${cut}…`
}

function toPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("L'image de l'aperçu n'a pas pu être encodée."))
        return
      }
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
    }, 'image/png')
  })
}
