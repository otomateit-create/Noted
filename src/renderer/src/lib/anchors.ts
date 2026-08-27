/**
 * Ce que les deux panneaux partagent pour se tenir par la main.
 *
 * Une note dit a quoi elle se rattache ; le cours, lui, doit savoir ou cela
 * tombe dans ce qu'il affiche en ce moment. C'est tout ce qui se joue ici :
 * traduire un passage en rectangles, dans un repere qui resiste au defilement.
 */

import type { Passage } from '@shared/types'
import { locateAnnotation } from './annotate'

/** Un rectangle en coordonnees du contenu defilant, donc insensible au defilement. */
export interface Box {
  top: number
  left: number
  width: number
  height: number
}

/**
 * Ou se trouve un passage dans le document affiche, exprime dans le repere du
 * contenu et non de l'ecran : les reperes poses ainsi defilent avec le texte
 * sans qu'on ait a les recalculer a chaque cran de molette.
 */
export function passageBoxes(body: HTMLElement, root: HTMLElement, passage: Passage): Box[] {
  const frame = body.getBoundingClientRect()
  const boxes: Box[] = []

  for (const range of locateAnnotation(root, passage)) {
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width < 1 && rect.height < 1) continue
      boxes.push({
        top: rect.top - frame.top + body.scrollTop,
        left: rect.left - frame.left + body.scrollLeft,
        width: rect.width,
        height: rect.height
      })
    }
  }

  return boxes
}

/**
 * Ou se trouve un element du document, dans le meme repere que les passages.
 *
 * Ce que dit une image n'existe qu'a l'index : le document, lui, montre
 * l'image. Un passage qui en vient n'a donc pas de texte a encadrer, mais il a
 * bien un endroit — et c'est cet endroit-la qu'on designe.
 */
export function elementBox(body: HTMLElement, element: HTMLElement): Box {
  const frame = body.getBoundingClientRect()
  const rect = element.getBoundingClientRect()

  return {
    top: rect.top - frame.top + body.scrollTop,
    left: rect.left - frame.left + body.scrollLeft,
    width: rect.width,
    height: rect.height
  }
}
