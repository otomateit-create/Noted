/**
 * Le pont entre un passage surligne et l'endroit du document ou il se trouve.
 *
 * Un surlignage n'est pas enregistre comme une position — ni un decalage
 * d'octets, qu'un PDF n'a pas, ni un chemin dans le DOM, qui change des qu'un
 * convertisseur evolue. Il est enregistre comme ce qu'il dit : son texte exact,
 * plus le voisinage immediat qui distingue la bonne occurrence des autres.
 * « EBITDA » apparait quarante fois dans un support ; « ajuste de l'EBITDA
 * normatif » n'y apparait qu'une.
 *
 * A la relecture on refait donc une recherche, et non un calcul d'adresse. Le
 * prix est une recherche de texte par surlignage ; le gain est qu'un passage
 * reste retrouvable apres une mise a jour de l'application.
 *
 * Toute la comparaison se fait espaces retires, pour une raison qui n'a rien
 * d'un detail : dans la couche de texte d'un PDF, chaque fragment est un
 * element separe et rien ne les separe dans le texte du DOM — « buyout & LBO »
 * suivi de « Le metier » s'y lit « buyout & LBOLe metier ». Ce qu'on enregistre
 * doit rester lisible, puisqu'on le recopie dans les notes et qu'on l'envoie a
 * l'assistant ; ce qu'on compare doit ignorer ces espaces qui n'existent que
 * pour l'oeil.
 */

import { CONTEXT, readable } from '@shared/passage'
import type { Passage } from '@shared/types'
import { collect, type TextPiece } from './find'

export type { Passage } from '@shared/types'

/**
 * Le texte sans aucun espace, et de quoi revenir aux positions d'origine :
 * `map[i]` donne la position, dans le texte de depart, du i-eme caractere
 * retenu.
 */
function squeeze(text: string): { plain: string; map: number[] } {
  let plain = ''
  const map: number[] = []

  for (let index = 0; index < text.length; index += 1) {
    // Les blancs, et les traits d'union : la justification d'un PDF coupe les
    // mots en bout de ligne (« pou-vait ») la ou le texte extrait pour l'index
    // les recolle (« pouvait »). Un passage trouve par l'index fin ne se
    // retrouverait jamais dans la couche de texte sans les ignorer — et comme
    // on les ignore des deux cotes, les vrais traits d'union (« pre-2023 »)
    // se correspondent toujours.
    if (/[\s\u00AD\u2010\u2011-]/.test(text[index])) continue
    plain += text[index]
    map.push(index)
  }

  return { plain, map }
}

/** Position absolue d'un point du DOM dans le texte rassemble du document. */
function offsetOf(pieces: TextPiece[], node: Node, offset: number): number | null {
  for (const piece of pieces) {
    if (piece.node === node) return piece.start + offset
  }
  return null
}

/**
 * Decrit une selection pour l'enregistrer.
 *
 * `rendered` est le texte tel que le navigateur le rend — `Selection.toString()`
 * et non `Range.toString()`. La difference n'est pas cosmetique : la seconde
 * recolle les noeuds de texte tels quels et rend « conventionsQui prete »,
 * tandis que la premiere consulte la mise en page et retablit les blancs. C'est
 * ce texte-la qu'on recopie dans les notes et qu'on envoie a l'assistant.
 *
 * Renvoie null si la selection deborde du document — une selection qui commence
 * dans la page 3 et finit dans la page 4 n'a pas de texte continu a citer, le
 * texte des deux pages ne se suivant nulle part.
 */
export function describeSelection(
  range: Range,
  root: HTMLElement,
  rendered: string
): Passage | null {
  const { text, pieces } = collect(root)

  const start = offsetOf(pieces, range.startContainer, range.startOffset)
  const end = offsetOf(pieces, range.endContainer, range.endOffset)
  if (start === null || end === null || end <= start) return null

  const selected = readable(rendered)
  if (!selected) return null

  return {
    text: selected,
    before: readable(text.slice(Math.max(0, start - CONTEXT), start)),
    after: readable(text.slice(end, end + CONTEXT))
  }
}

/** Positions de toutes les occurrences d'un texte, sans recouvrement. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []

  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return found
    found.push(at)
    from = at + needle.length
  }
}

/** Nombre de caracteres communs a la fin de `a` et a la fin de `b`. */
function commonSuffix(a: string, b: string): number {
  let count = 0
  while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) {
    count += 1
  }
  return count
}

/** Nombre de caracteres communs au debut de `a` et au debut de `b`. */
function commonPrefix(a: string, b: string): number {
  let count = 0
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1
  return count
}

/**
 * Retrouve un passage dans un document affiche, decoupe en une etendue par
 * noeud de texte.
 *
 * Une seule etendue d'un bout a l'autre serait plus simple, mais elle
 * engloberait tout ce qui se trouve entre les deux — et la couche de texte
 * d'un PDF est semee de `<br>` que pdf.js pose en fin de ligne. Ces balises
 * n'ont pas de position, donc elles se rangent en haut a gauche du cadre : le
 * navigateur y peignait une pastille de couleur par ligne surlignee, empilees
 * dans la marge, sans rapport avec le passage vise. En ne couvrant que les
 * noeuds de texte, il ne reste rien a peindre ailleurs.
 *
 * Quand le texte apparait plusieurs fois, c'est le voisinage qui tranche : on
 * garde l'occurrence dont l'avant et l'apres ressemblent le plus a ceux qui ont
 * ete enregistres. Une seule occurrence suffit a se passer de ce calcul, ce qui
 * est le cas courant.
 */
export function locateAnnotation(root: HTMLElement, annotation: Passage): Range[] {
  const needle = squeeze(annotation.text).plain
  if (!needle) return []

  const { text, pieces } = collect(root)
  const { plain, map } = squeeze(text)

  const found = occurrences(plain, needle)
  if (found.length === 0) return []

  let at = found[0]
  if (found.length > 1) {
    const before = squeeze(annotation.before).plain
    const after = squeeze(annotation.after).plain
    let best = -1

    for (const candidate of found) {
      const score =
        commonSuffix(plain.slice(Math.max(0, candidate - CONTEXT), candidate), before) +
        commonPrefix(plain.slice(candidate + needle.length, candidate + needle.length + CONTEXT), after)
      if (score > best) {
        best = score
        at = candidate
      }
    }
  }

  const start = map[at]
  // Le dernier caractere retenu, plus un : une etendue s'arrete apres ce
  // qu'elle contient, et les blancs qui suivent n'en font pas partie.
  const end = map[at + needle.length - 1] + 1

  const ranges: Range[] = []
  for (const piece of pieces) {
    const pieceEnd = piece.start + piece.node.data.length
    if (pieceEnd <= start || piece.start >= end) continue

    const from = Math.max(start, piece.start) - piece.start
    const to = Math.min(end, pieceEnd) - piece.start
    if (to <= from) continue

    const range = document.createRange()
    range.setStart(piece.node, from)
    range.setEnd(piece.node, to)
    ranges.push(range)
  }

  return ranges
}
