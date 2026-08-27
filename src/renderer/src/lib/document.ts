/**
 * Passage d'un document affiche (HTML) au texte envoye a l'IA.
 *
 * Volontairement separe du convertisseur des notes : celui-ci sert a
 * enregistrer ce que l'utilisateur ecrit et doit rester strictement fidele,
 * tandis que celui-la prepare un texte a lire pour un modele — les tableaux y
 * comptent, les images en base64 non.
 */

import TurndownService from 'turndown'
import { tables } from 'turndown-plugin-gfm'
import { markdownToHtml } from './markdown'
import { protectMath, restoreMath } from './math'
import { sanitiseHtml } from './sanitise'

const converter = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*'
})

/**
 * Ce texte est lu par un modele, jamais re-interprete comme du Markdown. Les
 * echappements de turndown n'y servent donc a rien et le rendent moins clair :
 * « match\\_type » et « \\=INDEX(...) » au lieu de « match_type » et
 * « =INDEX(...) », sur un guide de formules Excel c'est genant.
 */
converter.escape = (text: string): string => text

// Un cours de finance est plein de tableaux — comparables, echeanciers de
// dette, comptes de resultat. Sans cette extension, turndown les aplatit en
// une suite de nombres ou plus aucune ligne ne correspond a sa colonne.
converter.use(tables)

/**
 * Une image d'un document Word arrive encodee en base64 : quelques centaines
 * de milliers de caracteres pour un seul schema. On n'en garde que la mention,
 * pour que le modele sache qu'il y a une figure a cet endroit sans qu'elle
 * occupe la moitie du contexte.
 */
converter.addRule('image', {
  filter: ['img'],
  replacement: (_content, node) => {
    const alt = (node as HTMLElement).getAttribute?.('alt')?.trim()
    return alt ? `[figure : ${alt}]` : '[figure]'
  }
})

/**
 * Rend un cours ecrit en Markdown.
 *
 * Les formules sont mises de cote avant l'analyse Markdown et composees apres
 * le nettoyage du HTML : l'analyse abimerait le LaTeX, le nettoyage
 * supprimerait les classes de KaTeX.
 */
export function renderMarkdownCourse(markdown: string): string {
  const { text, formulas } = protectMath(markdown)
  return restoreMath(prepareDocumentHtml(forReading(markdownToHtml(text))), formulas)
}

/**
 * Ce que la conversion produit pour l'editeur, mis en etat d'etre lu.
 *
 * `markdownToHtml` sert d'abord les notes : elle rend les schemas et les cases
 * a cocher sous la forme que l'editeur sait reprendre — un `div` porteur de sa
 * source, une balise `input`. A l'affichage d'un cours, l'editeur n'est pas la
 * et le nettoyage retire les deux : le schema d'un cours disparaissait alors
 * sans laisser de trace, et une liste de taches se lisait comme une liste de
 * puces vides, sans qu'on puisse distinguer ce qui etait fait de ce qui restait
 * a faire. On les remplace donc, ici seulement, par ce qui se lit.
 */
function forReading(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')

  // Faute de dessiner le schema, on en montre la source : elle se lit, et rien
  // du cours n'est perdu.
  for (const diagram of Array.from(parsed.body.querySelectorAll('div[data-type="diagram"]'))) {
    const block = parsed.createElement('pre')
    const code = parsed.createElement('code')
    code.className = 'language-mermaid'
    code.textContent = diagram.getAttribute('data-source') ?? ''
    block.appendChild(code)
    diagram.replaceWith(block)
  }

  for (const box of Array.from(parsed.body.querySelectorAll('input[type="checkbox"]'))) {
    const mark = parsed.createElement('span')
    mark.textContent = box.hasAttribute('checked') ? '☑' : '☐'
    box.replaceWith(mark)
  }

  return parsed.body.innerHTML
}

/**
 * Prepare le HTML d'un document avant affichage et avant conversion en texte.
 * Les deux partent de la meme chaine : ce que voit l'utilisateur et ce que lit
 * le modele sont exactement le meme document.
 */
export function prepareDocumentHtml(raw: string): string {
  const clean = sanitiseHtml(raw)
  const parsed = new DOMParser().parseFromString(clean, 'text/html')

  for (const table of Array.from(parsed.body.querySelectorAll('table'))) {
    unwrapCellParagraphs(table)
    promoteHeaderRow(table)
  }

  restoreMissingHeadings(parsed.body)

  return parsed.body.innerHTML
}

/** Au-dela de cette longueur, un paragraphe en gras est un paragraphe, pas un titre. */
const HEADING_MAX_LENGTH = 100

/**
 * Rattrape la structure des documents qui n'en declarent aucune.
 *
 * Beaucoup de supports sont ecrits sans les styles de Word : leurs titres sont
 * de simples paragraphes mis en gras a la main. Le document arrive alors comme
 * un bloc uniforme, sans rien a citer. Un paragraphe entierement en gras, court
 * et sans ponctuation finale est, dans ces documents-la, un titre.
 *
 * La regle ne s'applique qu'aux documents totalement depourvus de titres : la
 * ou il en existe deja, le gras sert a insister, et le promouvoir casserait la
 * hierarchie reelle.
 */
function restoreMissingHeadings(body: HTMLElement): void {
  if (body.querySelector('h1, h2, h3, h4, h5, h6')) return

  for (const paragraph of Array.from(body.querySelectorAll('p'))) {
    // Une cellule de tableau en gras est un en-tete de colonne, pas un titre.
    if (paragraph.closest('table')) continue

    const text = paragraph.textContent?.trim() ?? ''
    if (!text || text.length > HEADING_MAX_LENGTH) continue
    if (/[.;:!?,]$/.test(text)) continue

    const bold = paragraph.querySelector('strong, b')
    if (bold?.textContent?.trim() !== text) continue

    const heading = paragraph.ownerDocument.createElement('h2')
    heading.textContent = text
    paragraph.replaceWith(heading)
  }
}

/**
 * Word enveloppe le contenu de chaque cellule dans un paragraphe. Laisse tels
 * quels, ces paragraphes introduisent des retours a la ligne au milieu des
 * cellules et disloquent le tableau une fois converti.
 */
function unwrapCellParagraphs(table: HTMLTableElement): void {
  for (const cell of Array.from(table.querySelectorAll('td, th'))) {
    const paragraphs = Array.from(cell.children).filter((child) => child.tagName === 'P')
    if (paragraphs.length !== 1 || cell.children.length !== 1) continue
    paragraphs[0].replaceWith(...Array.from(paragraphs[0].childNodes))
  }
}

/**
 * Un tableau Word ne declare pas sa ligne d'en-tete : toutes ses cellules sont
 * des <td>, et l'en-tete n'est reconnaissable qu'a sa mise en gras. Sans <th>,
 * le tableau ressort en HTML brut au lieu d'un tableau lisible, et chaque
 * chiffre perd la colonne a laquelle il appartient — sur un tableau de marges
 * de dette ou de comparables, l'information devient inexploitable.
 */
function promoteHeaderRow(table: HTMLTableElement): void {
  if (table.querySelector('th')) return

  const first = table.querySelector('tr')
  if (!first) return

  const cells = Array.from(first.children).filter((child) => child.tagName === 'TD')
  if (cells.length === 0) return

  // Une ligne entierement en gras est un en-tete. A defaut, un tableau dont
  // toutes les cellules tiennent sur une ligne est un tableau de donnees, et sa
  // premiere ligne en est l'en-tete. Ce qui reste — typiquement un tableau de
  // mise en page, avec plusieurs paragraphes par cellule — n'est pas converti :
  // le format en colonnes ne saurait pas le representer sans le disloquer.
  const allBold = cells.every((cell) => {
    const text = cell.textContent?.trim() ?? ''
    if (!text) return true
    return cell.querySelector('strong, b')?.textContent?.trim() === text
  })
  const simpleCells = Array.from(table.querySelectorAll('td, th')).every(
    (cell) => cell.querySelector('p, div, ul, ol, table, br') === null
  )
  if (!allBold && !simpleCells) return

  for (const cell of cells) {
    const header = table.ownerDocument.createElement('th')
    header.innerHTML = cell.innerHTML
    cell.replaceWith(header)
  }
}

/**
 * Les images du document, dans l'ordre ou elles apparaissent.
 *
 * C'est ce qui permet au processus principal de savoir quelle image occupe quel
 * emplacement : le n-ieme `[figure]` du texte extrait correspond au n-ieme nom
 * de cette liste. On aurait pu ecrire l'identite de l'image dans le marqueur
 * lui-meme, mais ce marqueur est lu par un modele — y coller une empreinte de
 * trente-deux caracteres hexadecimaux ne lui apprend rien et encombre ce qu'il
 * lit. La correspondance voyage donc a cote du texte, pas dedans.
 *
 * Seules les images posees sur le disque peuvent etre lues. Une image restee
 * en base64, ou pointant vers le web, garde neanmoins sa place dans la liste —
 * sous un nom vide, que la lecture saura ecarter. La retirer decalerait toutes
 * les suivantes, et le texte d'une capture irait se poser sous le marqueur
 * d'une autre.
 */
export function mediaNames(html: string): string[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html')

  return Array.from(parsed.querySelectorAll('img'))
    .map((image) => image.getAttribute('src') ?? '')
    .map((source) =>
      source.startsWith('noted-media://') ? source.slice('noted-media://'.length) : ''
    )
}

/**
 * Un cours Markdown, ses images changees en marqueurs de figure.
 *
 * C'est le pendant, pour le Markdown, de ce que le convertisseur Word fait plus
 * haut : `![schema](noted-media://…)` devient `[figure : schema]`, et le nom de
 * l'image part dans la liste, a la meme position. Une image que l'application
 * ne sait pas lire — une adresse web, un chemin quelconque — laisse un nom vide
 * pour tenir sa place.
 */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

export function figuresFromMarkdown(markdown: string): { text: string; media: string[] } {
  const media: string[] = []

  const text = markdown.replace(MARKDOWN_IMAGE, (_match, alt: string, url: string) => {
    media.push(
      url.startsWith('noted-media://')
        ? url.slice('noted-media://'.length).replace(/\/+$/, '')
        : ''
    )
    const label = alt.trim()
    return label ? `[figure : ${label}]` : '[figure]'
  })

  return { text, media }
}

export function htmlToContextText(html: string): string {
  return converter
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
