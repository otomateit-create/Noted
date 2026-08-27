/**
 * Recoudre les pages lues une a une.
 *
 * Le moteur ne sait regarder qu'une image a la fois, et c'est tres bien ainsi :
 * chaque page part avec un contexte neuf, donc sans derive, et la memoire reste
 * constante quelle que soit l'epaisseur du document. Le prix, c'est qu'aucune
 * page ne sait ce qu'il y avait sur la precedente. Une phrase coupee en bas de
 * page redemarre en majuscule imaginaire, un tableau a cheval se presente comme
 * deux tableaux.
 *
 * Ce fichier repare cela apres coup, et de facon deterministe. Aucun modele
 * n'intervient : ce sont des regles qu'on peut lire, prevoir et verifier, ce qui
 * vaut mieux qu'un raccommodage qui changerait d'avis d'une execution a l'autre.
 *
 * **La regle qui gouverne les reperes de page** : un bloc coupe par un saut de
 * page appartient a la page ou il commence, et le repere se pose apres lui. Un
 * tableau entame page 12 et fini page 13 est donc « le tableau de la page 12 »,
 * ce qui est aussi ce que dirait quelqu'un qui feuillette le document.
 */

import { pageMarker } from '../../shared/types'

export interface ReadPage {
  /** Numero de page, 1-indexe, dans l'ordre du document. */
  page: number
  /** Markdown rendu par le moteur pour cette page. */
  markdown: string
}

type BlockKind = 'table' | 'heading' | 'list' | 'text'

interface Block {
  kind: BlockKind
  lines: string[]
}

/** Une ligne de tableau Markdown : « | a | b | ». */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

/** La ligne de tirets qui separe l'en-tete du corps : « |---|:--:| ». */
function isTableRule(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-')
}

function kindOf(lines: string[]): BlockKind {
  const first = lines[0] ?? ''
  if (isTableRow(first)) return 'table'
  if (/^\s{0,3}#{1,6}\s/.test(first)) return 'heading'
  if (/^\s*([-*+]|\d+[.)])\s/.test(first)) return 'list'
  return 'text'
}

/** Decoupe un Markdown en blocs separes par des lignes vides. */
function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  let current: string[] = []

  const flush = (): void => {
    if (current.length > 0) {
      blocks.push({ kind: kindOf(current), lines: current })
      current = []
    }
  }

  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') flush()
    else current.push(line)
  }
  flush()

  return blocks
}

function render(block: Block): string {
  return block.lines.join('\n')
}

/**
 * Le nombre de colonnes d'une ligne de tableau.
 *
 * Les barres de bord ne comptent pas : « | a | b | » a deux colonnes, pas
 * quatre. Sans cette precaution, deux tableaux identiques paraissaient
 * differents et n'etaient jamais recousus.
 */
function columnCount(line: string): number {
  return line.trim().replace(/^\||\|$/g, '').split('|').length
}

/**
 * Un texte se termine-t-il sur une phrase achevee ?
 *
 * Le point d'un « M. » ou d'un « etc. » compte a tort pour une fin, et le cas
 * est trop rare pour justifier une liste d'abreviations qu'il faudrait tenir a
 * jour. Ce qui est reellement frequent en bas de page — un mot coupe, une virgule,
 * un mot de liaison — est bien vu.
 */
function endsSentence(text: string): boolean {
  return /[.!?:;»"')\]]\s*$/.test(text.trim())
}

/** Le debut d'un texte est-il la suite de quelque chose ? */
function continuesSentence(text: string): boolean {
  const first = text.trim().charAt(0)
  if (!first) return false

  // Une minuscule en tete de page ne commence pas une phrase — elle la
  // poursuit. Une lettre qui n'a pas de casse (un chiffre, un symbole) ne dit
  // rien, et l'on s'abstient alors de recoudre.
  return first.toLocaleLowerCase('fr') === first && first.toLocaleUpperCase('fr') !== first
}

/**
 * Deux blocs se suivent-ils vraiment, de part et d'autre d'un saut de page ?
 *
 * Prudent par construction : dans le doute, on ne recoud pas. Une page laissee
 * entiere reste lisible ; une page recousue a tort colle deux idees sans rapport
 * et se lit comme une faute.
 */
function joins(previous: Block, next: Block): boolean {
  if (previous.kind === 'table' && next.kind === 'table') {
    const last = previous.lines[previous.lines.length - 1]
    const first = next.lines[0]
    if (columnCount(last) !== columnCount(first)) return false
    return true
  }

  if (previous.kind === 'text' && next.kind === 'text') {
    return !endsSentence(render(previous)) && continuesSentence(render(next))
  }

  // Une liste coupee reprend au meme niveau, et son premier element n'a aucune
  // raison de commencer en minuscule : on ne recoud que ce qui se voit.
  return false
}

/**
 * Colle la suite d'un tableau a son debut.
 *
 * L'en-tete repete en haut de la page suivante — les imprimeurs le font, et le
 * modele le lit consciencieusement — est retire, ainsi que la ligne de tirets
 * qui l'accompagne. Sans cela, le tableau recousu porte son en-tete deux fois,
 * au milieu de ses donnees.
 */
function mergeTables(previous: Block, next: Block): Block {
  const header = previous.lines[0]
  const rows = [...next.lines]

  if (rows[0] === header || columnCount(rows[0]) === columnCount(header)) {
    // Un en-tete repete se reconnait a ce qu'il est suivi d'une ligne de
    // tirets : une ligne de donnees ordinaire ne l'est jamais.
    if (rows[1] && isTableRule(rows[1])) rows.splice(0, 2)
  }
  while (rows.length > 0 && isTableRule(rows[0])) rows.shift()

  return { kind: 'table', lines: [...previous.lines, ...rows] }
}

/** Colle la suite d'un paragraphe a son debut, avec l'espace qui manque. */
function mergeText(previous: Block, next: Block): Block {
  const lines = [...previous.lines]
  const tail = lines.pop() ?? ''
  const [head, ...rest] = next.lines

  // Un mot coupe par un trait d'union en fin de ligne se recolle sans espace ni
  // trait : « rentabi- » suivi de « lite » redonne « rentabilite ».
  const merged = /[\p{L}]-$/u.test(tail.trim())
    ? `${tail.trim().replace(/-$/, '')}${head.trim()}`
    : `${tail.trim()} ${head.trim()}`

  return { kind: 'text', lines: [...lines, merged, ...rest] }
}

/**
 * Assemble les pages lues en un seul document.
 *
 * L'ordre vient du tableau recu, jamais d'un tri fait ici : il est garanti par
 * construction en amont, chaque page etant rangee dans sa case des sa lecture.
 */
export function assemblePages(pages: ReadPage[]): string {
  const parts: string[] = []
  /** Le dernier bloc pose, tant qu'il peut encore accueillir une suite. */
  let pending: Block | null = null
  /**
   * Les reperes des pages traversees par le bloc en attente.
   *
   * Ils ne peuvent pas etre poses tout de suite, puisque le bloc qui les
   * precede n'est pas encore fini. Ils ne peuvent pas non plus etre oublies :
   * un tableau qui court sur trois pages doit laisser derriere lui les reperes
   * des trois, sans quoi les pages suivantes se retrouvent attribuees a la
   * mauvaise. C'est ce que le premier essai ratait — une phrase traversant
   * trois pages perdait son recousage a la deuxieme, parce que le bloc fusionne
   * etait pose aussitot et ne pouvait plus rien accueillir.
   */
  let deferred: string[] = []

  const flushPending = (): void => {
    if (pending) {
      parts.push(render(pending))
      pending = null
    }
    parts.push(...deferred)
    deferred = []
  }

  for (const page of pages) {
    const blocks = splitBlocks(page.markdown).filter((block) => render(block).trim() !== '')

    // Le premier bloc de la page poursuit-il le dernier de la precedente ? Si
    // oui, les deux n'en font qu'un, et ce bloc reste attache a la page ou il a
    // commence — donc pose avant le repere de la page nouvelle.
    const first = blocks[0]
    if (pending && first && joins(pending, first)) {
      pending = pending.kind === 'table' ? mergeTables(pending, first) : mergeText(pending, first)
      blocks.shift()
      deferred.push(pageMarker(page.page))

      // La page n'apportait que cette suite : le bloc fusionne reste ouvert, et
      // peut encore etre poursuivi par la page d'apres.
      if (blocks.length === 0) continue

      // La page a d'autre contenu : le bloc fusionne est clos, et les reperes
      // des pages qu'il traversait se posent derriere lui.
      flushPending()
    } else {
      flushPending()
      parts.push(pageMarker(page.page))
    }

    // Le dernier bloc de la page ne se pose pas tout de suite : il attend de
    // savoir si la page suivante le poursuit.
    const last = blocks.pop() ?? null
    for (const block of blocks) parts.push(render(block))
    pending = last
  }

  flushPending()

  return parts
    .filter((part) => part.trim() !== '')
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
