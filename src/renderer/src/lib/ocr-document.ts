/**
 * Un cours reconstitue par OCR, vu du cote de l'affichage.
 *
 * Le fichier est un Markdown ordinaire — on peut l'ouvrir dans Obsidian, le
 * lire dans un editeur de texte — avec deux commentaires HTML en plus : un
 * en-tete qui dit d'ou il vient, et un repere par page. Invisibles a l'ecran
 * dans les deux applications, et c'est tout l'interet du choix : le cours reste
 * un fichier que rien n'enferme.
 *
 * Ce module ne fait que les lire. Il ne les ecrit jamais : c'est le processus
 * principal qui compose ces fichiers, au moment de la conversion.
 */

import { OCR_MARKER, PAGE_MARKER, parseOcrMarker, type OcrDocument } from '@shared/types'

export interface OcrCourse {
  /** D'ou vient ce cours : le modele qui l'a lu, l'original qu'il remplace. */
  document: OcrDocument
  /** Le Markdown debarrasse de son en-tete, pret a etre rendu. */
  body: string
  /** Les numeros de page presents, dans l'ordre ou ils apparaissent. */
  pages: number[]
}

/**
 * Reconnait un cours issu d'une lecture par OCR.
 *
 * Rend null pour tout Markdown ordinaire, ce qui est le cas de l'immense
 * majorite : la reconnaissance tient a la premiere ligne, et rien d'autre n'est
 * lu tant qu'elle n'est pas la.
 */
export function readOcrCourse(markdown: string): OcrCourse | null {
  const lines = markdown.split('\n')

  // L'en-tete est en premiere ligne, ou juste apres un frontmatter eventuel.
  // Chercher plus loin reviendrait a prendre pour un en-tete un commentaire
  // ecrit au milieu du cours.
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first === -1) return null

  const match = lines[first].trim().match(OCR_MARKER)
  if (!match) return null

  const document = parseOcrMarker(match[1])
  if (!document) return null

  const body = lines.slice(first + 1).join('\n').replace(/^\n+/, '')

  const pages: number[] = []
  for (const line of lines) {
    const page = line.trim().match(PAGE_MARKER)
    if (page) pages.push(Number(page[1]))
  }

  return { document, body, pages }
}

/**
 * Le numero de page d'un element du document rendu, en remontant les reperes.
 *
 * Les commentaires HTML survivent au rendu Markdown et restent dans le DOM sans
 * rien afficher : ils sont donc consultables la ou ils ont ete poses, ce qui
 * permet de dire a quelle page appartient un paragraphe sans tenir de table de
 * correspondance a cote.
 */
export function pageOfNode(node: Node): number | null {
  // On remonte le document a l'envers depuis l'element, en passant d'un frere
  // au precedent puis en montant d'un cran : c'est l'ordre du texte lu.
  let current: Node | null = node

  while (current) {
    let sibling: Node | null = current.previousSibling

    while (sibling) {
      const found = lastPageMarkerWithin(sibling)
      if (found !== null) return found
      sibling = sibling.previousSibling
    }

    current = current.parentNode
  }

  return null
}

/** Le dernier repere de page contenu dans ce noeud, en profondeur. */
function lastPageMarkerWithin(node: Node): number | null {
  if (node.nodeType === Node.COMMENT_NODE) {
    const match = `<!--${node.nodeValue}-->`.match(PAGE_MARKER)
    return match ? Number(match[1]) : null
  }

  const children = Array.from(node.childNodes)
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const found = lastPageMarkerWithin(children[index])
    if (found !== null) return found
  }

  return null
}
