/**
 * L'ordre du cours dans une note.
 *
 * Une note se lit en face du cours : ce qui parle de la p. 46 doit se trouver
 * avant ce qui parle de la p. 60, et deux blocs sur la meme page dans l'ordre
 * des passages qu'ils commentent. Rien ne le garantit a l'ecriture — le
 * lecteur tape ou il veut, l'assistant ajoute dans l'ordre de ses reponses —
 * d'ou ce tri, applique apres coup sur le Markdown brut, la seule forme que
 * les deux cotes de l'application partagent.
 *
 * Il ne sait rien du cours : les cles lui sont fournies, une par marqueur,
 * dans l'ordre du texte. C'est le main qui les calcule, parce que lui seul
 * tient l'index fin qui donne le rang d'un passage dans sa page. Ici, on ne
 * fait que decouper, comparer et recoller.
 */

import { ANCHOR_MARKER, parseAnchorMarker, type NoteAnchor, type OrderKey } from './types'

/** L'ordre du document : l'unite d'abord, le rang du passage ensuite. */
export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  return a[0] - b[0] || a[1] - b[1]
}

/**
 * Les marqueurs d'ancre d'une note, dans l'ordre du texte.
 *
 * Un marqueur illisible donne null a sa place, et non rien : les cles rendues
 * par le main se rangent par position, et sauter une entree decalerait toutes
 * les suivantes d'un cran.
 */
export function noteAnchors(markdown: string): (NoteAnchor | null)[] {
  const anchors: (NoteAnchor | null)[] = []
  for (const line of markdown.split('\n')) {
    const match = ANCHOR_MARKER.exec(line)
    if (match) anchors.push(parseAnchorMarker(match[1]))
  }
  return anchors
}

interface Segment {
  lines: string[]
  key: OrderKey | null
  rank: number
}

/**
 * La note rangee dans l'ordre du cours.
 *
 * L'unite du tri est le segment : un marqueur et tout ce qui le suit jusqu'au
 * marqueur suivant. C'est exactement la portee d'une ancre — un bloc sans
 * marqueur releve du dernier au-dessus de lui —, si bien qu'un tableau, un
 * encadre ou un schema, qui ne peuvent pas porter d'ancre, voyagent avec le
 * paragraphe qui la porte, et qu'un titre reste colle au bloc qu'il annonce
 * quand les deux ont ete ancres ensemble.
 *
 * `keys` : une cle par marqueur, dans l'ordre du texte — ce que `noteAnchors`
 * enumere. Un segment sans cle (marqueur illisible, index pas encore charge)
 * suit son predecesseur : il ne vote pas, il ne bloque pas. Ce qui precede le
 * premier marqueur n'a pas d'endroit dans le cours et reste en tete.
 *
 * Le tri est stable : deux segments de meme cle gardent leur ordre d'ecriture.
 * Et quand rien ne bouge, le texte est rendu tel quel, au caractere pres — ce
 * qui permet a l'appelant de ne rien reecrire dans ce cas.
 */
export function sortAnchoredNote(markdown: string, keys: (OrderKey | null)[]): string {
  const head: string[] = []
  const segments: Segment[] = []

  for (const line of markdown.split('\n')) {
    if (ANCHOR_MARKER.test(line)) {
      segments.push({ lines: [line], key: keys[segments.length] ?? null, rank: segments.length })
    } else if (segments.length === 0) {
      head.push(line)
    } else {
      segments[segments.length - 1].lines.push(line)
    }
  }
  if (segments.length < 2) return markdown

  let inherited: OrderKey = [-Infinity, 0]
  for (const segment of segments) {
    if (segment.key) inherited = segment.key
    else segment.key = inherited
  }

  const sorted = [...segments].sort(
    (a, b) => compareOrderKeys(a.key as OrderKey, b.key as OrderKey) || a.rank - b.rank
  )
  if (sorted.every((segment, index) => segment.rank === index)) return markdown

  return [head, ...sorted.map((segment) => segment.lines)]
    .map((lines) => lines.join('\n').replace(/\s+$/, ''))
    .filter((part) => part !== '')
    .join('\n\n')
}
