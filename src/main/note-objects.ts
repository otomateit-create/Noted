/**
 * Les objets poses dans une note : tableaux, schemas, encadres.
 *
 * L'assistant sait deja ecrire et remplacer du texte. Mais toucher a un objet
 * par le texte suppose de le recopier au caractere pres — vingt lignes de
 * syntaxe Mermaid pour changer un mot, et un refus au moindre espace de
 * travers. On lui donne donc de quoi les designer par leur numero, exactement
 * comme l'utilisateur les designe du doigt a l'ecran.
 *
 * Rien de plus n'est invente : un objet reste une portion du Markdown, et le
 * modifier reste un remplacement de texte, avec le meme apercu a valider.
 */

import { TABLE_MARKER, bareLine, parseTableMarker } from '../shared/types'
import type { TableStyle } from '../shared/types'

export type NoteObjectKind = 'tableau' | 'schema' | 'encadre'

export interface NoteObject {
  /** 1-indexe : c'est le numero que l'assistant manipule. */
  index: number
  kind: NoteObjectKind
  /** Bornes dans le Markdown, marqueur d'habillage compris. */
  start: number
  end: number
  /** Le texte exact de l'objet. */
  raw: string
  /** Ce qu'il est, en une ligne lisible. */
  summary: string
  /** Pour un tableau. */
  style?: TableStyle
  /** Pour un schema : « mindmap », « flowchart », « timeline »… */
  diagram?: string
  /** Pour un encadre. */
  colour?: string
}

/** Le debut de chaque ligne, en decalage dans le texte entier. */
function lineStarts(lines: string[]): number[] {
  const starts: number[] = []
  let offset = 0

  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }

  return starts
}

function tableSummary(rows: string[], style: TableStyle | null): string {
  const cells = (row: string): string[] =>
    row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim())

  const header = cells(rows[0] ?? '')
  // L'en-tete, sa separation, puis les donnees.
  const body = Math.max(0, rows.length - 2)

  const dressed = style
    ? `, design ${style.design}, accent ${style.accent}`
    : ''

  return `${header.length} colonnes « ${header.join(' | ')} », ${body} ligne(s)${dressed}`
}

function diagramSummary(source: string): { kind: string; summary: string } {
  const lines = source.split('\n').filter((line) => line.trim())
  const first = lines[0]?.trim() ?? ''
  const kind = /^(mindmap|timeline|flowchart|graph|sequenceDiagram|pie|gantt|classDiagram)/.exec(
    first
  )?.[1]

  if (kind === 'mindmap') {
    // Le libelle seul, debarrasse de l'identifiant et de l'enveloppe de forme :
    // « root((LBO)) » se lit « LBO ».
    const root = (lines[1]?.trim() ?? '?').replace(
      /^[\w-]*(?:\(\(|\)\)|\{\{|\[|\(|\))(.*?)(?:\)\)|\(\(|\}\}|\]|\)|\()$/,
      '$1'
    )
    return { kind, summary: `carte mentale, racine « ${root} », ${lines.length - 1} noeud(s)` }
  }
  if (kind === 'timeline') {
    const title = lines.find((line) => /^\s*title\s/i.test(line))?.trim().slice(6) ?? ''
    const steps = lines.length - 1 - (title ? 1 : 0)
    return {
      kind,
      summary: `frise${title ? ` « ${title} »` : ''}, ${steps} étape(s)`
    }
  }
  if (kind === 'flowchart' || kind === 'graph') {
    const arrows = lines.filter((line) => /-->|---|-\.->|==>/.test(line)).length
    return { kind: 'flowchart', summary: `schéma de flux, ${arrows} flèche(s)` }
  }

  return { kind: kind ?? 'schema', summary: `schéma « ${first} »` }
}

/**
 * Les objets d'une note, dans l'ordre ou on les lit.
 *
 * Les blocs de code non-Mermaid sont traverses sans etre analyses : une barre
 * verticale y est du code, pas un tableau.
 */
export function listNoteObjects(markdown: string): NoteObject[] {
  const lines = markdown.split('\n')
  const starts = lineStarts(lines)
  const found: NoteObject[] = []

  const at = (index: number): number => starts[index] ?? markdown.length
  const endOf = (index: number): number => Math.min(markdown.length, at(index) + lines[index].length)

  let index = 0
  while (index < lines.length) {
    const bare = bareLine(lines[index])

    // Un bloc de code. Seul ```mermaid nous interesse ; les autres se sautent.
    const fence = /^```(\w*)/.exec(bare)
    if (fence) {
      let close = index + 1
      while (close < lines.length && !bareLine(lines[close]).startsWith('```')) close++

      if (fence[1] === 'mermaid') {
        const source = lines.slice(index + 1, close).join('\n')
        const { kind, summary } = diagramSummary(source)
        found.push({
          index: found.length + 1,
          kind: 'schema',
          start: at(index),
          end: endOf(Math.min(close, lines.length - 1)),
          raw: markdown.slice(at(index), endOf(Math.min(close, lines.length - 1))),
          summary,
          diagram: kind
        })
      }

      index = close + 1
      continue
    }

    // Un tableau, precede ou non de son marqueur d'habillage.
    const marker = TABLE_MARKER.exec(bare)
    const markerStyle = marker ? parseTableMarker(marker[1]) : null
    const tableStart = marker && bareLine(lines[index + 1] ?? '').startsWith('|') ? index : null
    const firstRow = tableStart === null ? index : index + 1

    if (bareLine(lines[firstRow] ?? '').startsWith('|')) {
      let last = firstRow
      while (last + 1 < lines.length && bareLine(lines[last + 1]).startsWith('|')) last++

      const rows = lines.slice(firstRow, last + 1).map((line) => bareLine(line))
      const from = tableStart ?? firstRow

      found.push({
        index: found.length + 1,
        kind: 'tableau',
        start: at(from),
        end: endOf(last),
        raw: markdown.slice(at(from), endOf(last)),
        summary: tableSummary(rows, markerStyle),
        ...(markerStyle ? { style: markerStyle } : {})
      })

      index = last + 1
      continue
    }

    // Un encadre : sa premiere ligne le declare, les suivantes le prolongent.
    const callout = /^>\s*\[!([a-zA-Z-]+)\]\s*(.*)$/.exec(lines[index].trim())
    if (callout) {
      let last = index
      while (last + 1 < lines.length && lines[last + 1].trim().startsWith('>')) last++

      found.push({
        index: found.length + 1,
        kind: 'encadre',
        start: at(index),
        end: endOf(last),
        raw: markdown.slice(at(index), endOf(last)),
        summary: `encadré ${callout[1]}${callout[2].trim() ? ` « ${callout[2].trim()} »` : ''}`,
        colour: callout[1].toLowerCase()
      })

      index = last + 1
      continue
    }

    index++
  }

  return found
}

/**
 * Un passage qui contient l'objet et n'apparait qu'une fois dans la note.
 *
 * Deux tableaux identiques ne sont pas rares dans un cours — la meme grille
 * vide recopiee deux fois. Le remplacement vise un texte, pas un decalage : il
 * faut donc elargir vers le haut jusqu'a lever l'ambiguite, et rendre aussi ce
 * qu'on a pris en plus, pour le reecrire tel quel.
 */
export function uniqueTarget(
  markdown: string,
  object: NoteObject
): { target: string; prefix: string } | null {
  const occurrences = (text: string): number => (text ? markdown.split(text).length - 1 : 0)

  if (occurrences(object.raw) === 1) return { target: object.raw, prefix: '' }

  // On remonte ligne a ligne. Vingt lignes suffisent largement a distinguer
  // deux objets ; au-dela, mieux vaut dire qu'on ne sait pas viser.
  let from = object.start
  for (let step = 0; step < 20; step++) {
    const previous = markdown.lastIndexOf('\n', from - 2)
    if (previous === -1) break

    from = previous + 1
    const target = markdown.slice(from, object.end)
    if (occurrences(target) === 1) {
      return { target, prefix: markdown.slice(from, object.start) }
    }
  }

  return null
}
