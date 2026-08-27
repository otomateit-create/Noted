/**
 * La note telle que le modele la lit, et le chemin retour vers le fichier.
 *
 * Une note ancree porte, au-dessus de ses blocs, des lignes
 * « <!-- ancre {"p":46,"t":"…","b":"…","a":"…"} --> » : la page, et le
 * passage exact du cours en face duquel le bloc a ete ecrit. Sur une vraie
 * note, ces lignes font plus de la moitie du fichier — et le modele n'en tire
 * rien d'autre que le numero de page. Longtemps il les a pourtant recues
 * entieres, avec la consigne de les recopier au caractere pres a chaque
 * reecriture : des milliers de tokens de recopie, et une ancre perdue sans
 * bruit au premier guillemet deplace.
 *
 * Ce module tient les deux sens du voyage. A l'aller, `viewOf` remplace chaque
 * ligne d'ancre par un repere court (« <!-- ancre p. 46 --> ») : ce que le
 * modele lit, cite et vise. Au retour, `rawSpanOf` retrouve dans le fichier
 * brut le passage qu'il a vise dans la vue, et `reattachAnchors` rend a chaque
 * bloc d'une reecriture l'ancre qu'il avait — la meme, au caractere pres — en
 * reconnaissant le bloc a son texte. Le renderer, lui, continue de recevoir un
 * Markdown avec ses marqueurs complets : rien ne change au-dela de ce fichier.
 *
 * Tout ici est pur — ni Electron, ni disque, ni modele — pour pouvoir etre
 * prouve a part sur les vraies notes du vault.
 */

import { readable } from '../shared/passage'
import { ANCHOR_MARKER, anchorMarker, parseAnchorMarker, sameAnchor } from '../shared/types'
import type { NoteAnchor } from '../shared/types'

export const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/

/** Les lignes d'ancre completes d'un Markdown, ou qu'elles s'y trouvent. */
export const ANCHOR_LINES = new RegExp(ANCHOR_MARKER.source, 'gm')

/**
 * Toute ligne d'ancre, complete ou courte. C'est ce qu'on retire de ce que le
 * modele ecrit : une ancre se rederive ou se rattache, elle ne se transporte
 * pas — et un repere court recopie depuis la vue ne designe rien.
 */
const ANY_ANCHOR_LINE = /^[ \t]*<!--\s*ancre\b[^\n]*?-->[ \t]*$/gm

// ---------------------------------------------------------------------------
// La vue : ce que le modele lit
// ---------------------------------------------------------------------------

/** Le repere court d'une ancre : l'endroit, sans le passage. */
export function shortMarker(anchor: NoteAnchor | null): string {
  if (!anchor) return '<!-- ancre -->'
  if (anchor.page !== null) return `<!-- ancre p. ${anchor.page} -->`
  if (anchor.section !== null) return `<!-- ancre « ${anchor.section} » -->`
  if (anchor.progress !== null) return `<!-- ancre ~${Math.round(anchor.progress * 100)} % -->`
  return '<!-- ancre -->'
}

export interface NoteView {
  /** Le Markdown tel que le modele le lit. */
  text: string
  /** Le Markdown brut dont il vient. */
  raw: string
  /** Vrai pour chaque ligne qui etait une ligne d'ancre. Meme nombre de lignes des deux cotes. */
  marker: boolean[]
}

/**
 * La vue d'une note. Une ligne d'ancre devient un repere court, toute autre
 * ligne reste identique : la vue et le brut ont exactement le meme nombre de
 * lignes, et c'est ce qui rend le retour trivial.
 */
export function viewOf(raw: string): NoteView {
  const marker: boolean[] = []
  const lines = raw.split('\n').map((line) => {
    const match = ANCHOR_MARKER.exec(line)
    if (!match) {
      marker.push(false)
      return line
    }
    marker.push(true)
    return shortMarker(parseAnchorMarker(match[1]))
  })
  return { text: lines.join('\n'), raw, marker }
}

/** Retire toute ligne d'ancre d'un texte que le modele a ecrit. */
export function stripAnchorLines(text: string): string {
  return text.replace(ANY_ANCHOR_LINE, '').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------------------
// Le retour : de la vue au fichier
// ---------------------------------------------------------------------------

export interface RawSpan {
  text: string
  start: number
  end: number
}

/** Le debut de chaque ligne, en decalage dans le texte entier. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

/** L'indice de la ligne qui contient ce decalage. */
function lineAt(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}

/**
 * Le passage du fichier brut qui correspond a un passage de la vue, ou null
 * si le passage n'y est pas exactement une fois.
 *
 * Les deux textes ont les memes lignes ; seules les lignes d'ancre different.
 * Un passage qui commence ou finit sur une ligne d'ancre — le modele a recopie
 * un repere court — prend la ligne brute entiere de ce cote-la.
 */
export function rawSpanOf(view: NoteView, target: string): RawSpan | null {
  if (!target) return null
  const start = view.text.indexOf(target)
  if (start === -1 || view.text.indexOf(target, start + 1) !== -1) return null
  const end = start + target.length

  const viewStarts = lineStarts(view.text)
  const rawStarts = lineStarts(view.raw)
  const rawLines = view.raw.split('\n')

  const viewLines = view.text.split('\n')
  const startLine = lineAt(viewStarts, start)
  const startColumn = start - viewStarts[startLine]
  // Un passage qui commence au saut de ligne qui clot un repere — juste apres
  // lui — ne prend pas le repere : il commence a la fin de la ligne brute.
  const rawStart =
    rawStarts[startLine] +
    (view.marker[startLine]
      ? startColumn >= viewLines[startLine].length
        ? rawLines[startLine].length
        : 0
      : startColumn)

  const endLine = lineAt(viewStarts, end)
  const endColumn = end - viewStarts[endLine]
  const rawEnd =
    endColumn === 0
      ? rawStarts[endLine]
      : rawStarts[endLine] + (view.marker[endLine] ? rawLines[endLine].length : endColumn)

  return { text: view.raw.slice(rawStart, rawEnd), start: rawStart, end: rawEnd }
}

/**
 * Un passage qui contient `span` et n'apparait qu'une fois dans le brut.
 *
 * Le renderer vise un texte, pas un decalage, et exige qu'il soit unique.
 * Or une ligne d'ancre porte le texte du cours : une phrase que la note
 * recopie du support apparait aussi dans l'ancre du bloc, et le passage vise
 * — unique dans la vue — se trouve deux fois dans le brut. On remonte alors
 * ligne a ligne jusqu'a lever l'ambiguite, comme pour les objets, et on rend
 * ce qu'on a pris en plus pour le reecrire tel quel.
 */
export function widenToUnique(raw: string, span: RawSpan): { target: string; prefix: string } | null {
  const occurrences = (text: string): number => (text ? raw.split(text).length - 1 : 0)
  if (occurrences(span.text) === 1) return { target: span.text, prefix: '' }

  let from = span.start
  for (let step = 0; step < 20 && from > 0; step += 1) {
    const previous = raw.lastIndexOf('\n', from - 2)
    from = previous === -1 ? 0 : previous + 1
    const target = raw.slice(from, span.end)
    if (occurrences(target) === 1) return { target, prefix: raw.slice(from, span.start) }
  }
  return null
}

// ---------------------------------------------------------------------------
// Les blocs : decoupage commun a l'insertion et a la reecriture
// ---------------------------------------------------------------------------

/**
 * Decoupe un Markdown en blocs de premier niveau — ceux que l'editeur
 * connaitra une fois la proposition acceptee.
 *
 * On ne comprend pas du Markdown ici, on reconnait des frontieres : une ligne
 * vide separe deux blocs, un titre fait bloc a lui seul, une cloture ```
 * garde son contenu d'un seul tenant. Les morceaux d'une meme liste se
 * recollent ensuite, ligne vide comprise — une liste aeree ne fait qu'un
 * bulletList dans l'editeur, et poser un marqueur entre deux de ses elements
 * la couperait en deux listes a l'ecran.
 */
export function splitBlocks(markdown: string): string[] {
  const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
  const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
  const LIST_HEAD = /^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/
  const LIST_BODY = /^[ \t]{2,}\S/

  const raw: string[] = []
  let current: string[] = []
  let fence: string | null = null

  const close = (): void => {
    if (current.length > 0) raw.push(current.join('\n'))
    current = []
  }

  for (const line of markdown.split('\n')) {
    if (fence) {
      current.push(line)
      const closing = FENCE_CLOSE.exec(line)
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
        fence = null
        close()
      }
      continue
    }

    const opening = FENCE_OPEN.exec(line)
    if (opening) {
      close()
      current.push(line)
      fence = opening[1]
      continue
    }

    if (line.trim() === '') {
      close()
      continue
    }

    if (HEADING_PATTERN.test(line)) {
      close()
      raw.push(line)
      continue
    }

    current.push(line)
  }
  close()

  const blocks: string[] = []
  for (const block of raw) {
    const previous = blocks[blocks.length - 1]
    const continuation =
      previous !== undefined &&
      LIST_HEAD.test(previous) &&
      (LIST_HEAD.test(block) || LIST_BODY.test(block))

    if (continuation) blocks[blocks.length - 1] = `${previous}\n\n${block}`
    else blocks.push(block)
  }

  return blocks
}

/**
 * Les blocs devant lesquels un marqueur d'ancre sait se poser.
 *
 * Le miroir de `applyAnchors` cote renderer : a la relecture, un marqueur ne
 * devient attribut que colle a un paragraphe, un titre, une liste, une
 * citation ou un bloc de code. Devant tout le reste — tableau, schema,
 * encadre, HTML d'habillage — il resterait un commentaire orphelin que
 * l'editeur avale sans le rendre. Ces blocs-la relevent du bloc qui les
 * precede, exactement comme quand ils sortent de la main de l'utilisateur.
 */
export function anchorable(block: string): boolean {
  const head = block.trimStart()
  if (head.startsWith('<')) return false
  if (head.startsWith('|')) return false
  if (/^(?:`{3,}|~{3,})[ \t]*mermaid\b/i.test(head)) return false
  if (/^>[ \t]*\[!/.test(head)) return false
  return true
}

/**
 * Le propos d'un bloc de note, debarrasse de sa mise en forme.
 *
 * Sert deux comparaisons qui veulent la meme chose : l'ancrage automatique,
 * qui confronte le bloc aux passages du cours deja normalises par
 * `readable()`, et l'appariement d'une reecriture, qui reconnait un bloc a ses
 * mots et non a ses etoiles. Le nettoyage reste volontairement grossier : on
 * retire des signes, on ne comprend pas du Markdown.
 */
export function plainNote(markdown: string): string {
  return readable(
    markdown
      // Marqueurs d'habillage et lignes d'ancre : du dialogue entre la note et
      // l'application, jamais du propos.
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Les clotures de bloc partent, leur contenu reste : les libelles d'un
      // schema sont souvent tout ce qu'une note de ce genre porte de sens.
      .replace(/^ {0,3}```.*$/gm, ' ')
      // <mark> et <span> recopies de la note de l'utilisateur.
      .replace(/<[^>]+>/g, ' ')
      // Surlignages et ajouts : le texte reste, le code couleur part —
      // « definition », « retenir » sont des mots de l'interface, que le cours
      // n'emploie pas.
      .replace(/==([\s\S]+?)=={[a-z-]+}/g, '$1')
      .replace(/\+\+([\s\S]+?)\+\+/g, '$1')
      // La ligne qui fait d'un tableau un tableau, et qui n'est que ponctuation.
      .replace(/^ {0,3}\|?(?:\s*:?-{3,}:?\s*\|)+.*$/gm, ' ')
      // Titres, citations, puces, numeros de liste, type d'un encadre.
      .replace(/^[ \t]*(?:>[ \t]*)*(?:#{1,6}|[-*+]|\d+[.)])[ \t]+/gm, ' ')
      .replace(/\[!\w+\]/g, ' ')
      // Ce qui reste : delimiteurs de formule, barres de tableau, emphase, code
      // en ligne, chevrons de citation.
      .replace(/[$|`*_>]/g, ' ')
  )
}

/**
 * Les pages qu'un texte cite lui-meme : « (p. 54) », « p. 76 », « pp. 72-76 ».
 *
 * C'est la forme que le prompt impose a l'assistant pour chaque affirmation
 * tiree du cours, et c'est la meilleure information d'ancrage qui existe : sur
 * une note reelle, chaque bloc qui citait une page etait ancre a cette page,
 * chaque bloc qui n'en citait pas etait ancre de travers. Une plage s'ouvre
 * entierement, bornee a vingt pages : au-dela, ce n'est plus une citation.
 */
export function citedPages(text: string): number[] {
  const pages = new Set<number>()
  for (const match of text.matchAll(/\bpp?\.\s*(\d{1,4})(?:\s*[\u2013-]\s*(\d{1,4}))?/g)) {
    const from = Number(match[1])
    const to = match[2] ? Number(match[2]) : from
    for (let page = from; page <= Math.min(to, from + 20); page += 1) pages.add(page)
  }
  return [...pages].sort((a, b) => a - b)
}

/**
 * Vrai si le bloc annonce celui qui le suit : un titre, ou une phrase courte
 * qui s'ouvre sur deux-points — « Three technical adjustments make the
 * comparables truly comparable: ». Ni l'un ni l'autre ne dit de quoi il parle
 * sans le bloc d'apres, et les deux en partagent l'ancre.
 */
export function announces(block: string): boolean {
  if (HEADING_PATTERN.test(block)) return true
  const single = !block.includes('\n')
  return single && block.trim().length <= 160 && /:\s*$/.test(block.trim())
}

/**
 * Le texte qu'un bloc presente a l'ancrage. Un titre seul — trois mots — se
 * compare mal a des passages de plusieurs phrases : on lui adjoint le bloc
 * qu'il annonce, dont il partagera presque toujours l'ancre. Meme chose pour
 * une phrase d'annonce (`announces`).
 */
export function anchoringText(blocks: string[], index: number): string {
  const block = blocks[index]
  if (!anchorable(block)) return ''
  const own = plainNote(block)
  if (announces(block)) {
    const next = blocks[index + 1]
    return next === undefined ? own : `${own} ${plainNote(next)}`
  }
  return own
}

// ---------------------------------------------------------------------------
// Les ancres effectives d'un brut, et leur rattachement a une reecriture
// ---------------------------------------------------------------------------

export interface AnchoredBlock {
  block: string
  /** L'ancre effective : la sienne, ou celle du dernier marqueur au-dessus. */
  anchor: NoteAnchor | null
}

/**
 * Les blocs d'un Markdown brut avec l'ancre effective de chacun. Un bloc sans
 * marqueur releve du dernier marqueur au-dessus de lui : c'est la convention
 * de l'editeur, et c'est cette ancre-la — heritee ou non — qu'un bloc doit
 * retrouver s'il est deplace.
 */
export function anchoredBlocks(raw: string): AnchoredBlock[] {
  // Les lignes sans leurs marqueurs, chacune avec l'ancre en vigueur.
  const lines: string[] = []
  const anchorOfLine: (NoteAnchor | null)[] = []
  let current: NoteAnchor | null = null

  for (const line of raw.split('\n')) {
    const match = ANCHOR_MARKER.exec(line)
    if (match) {
      current = parseAnchorMarker(match[1]) ?? current
      continue
    }
    lines.push(line)
    anchorOfLine.push(current)
  }

  // On redecoupe le texte nettoye, et on retrouve la premiere ligne de chaque
  // bloc pour lui donner l'ancre en vigueur a cet endroit.
  const clean = lines.join('\n')
  const blocks = splitBlocks(clean)
  const result: AnchoredBlock[] = []
  let cursor = 0

  for (const block of blocks) {
    const firstLine = block.split('\n')[0]
    let line = cursor
    while (line < lines.length && lines[line] !== firstLine) line += 1
    const anchor = line < lines.length ? anchorOfLine[line] : current
    result.push({ block, anchor })
    if (line < lines.length) cursor = line + block.split('\n').length
  }

  return result
}

/** Les mots d'un bloc, replies : c'est a eux qu'un bloc se reconnait. */
function tokensOf(block: string): string[] {
  return plainNote(block)
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2)
}

/**
 * Ressemblance de deux blocs par leurs mots, entre 0 et 1.
 *
 * Le coefficient de recouvrement — l'intersection rapportee au plus petit des
 * deux — vaut 1 quand un bloc en contient un autre : c'est ce qui reconnait un
 * paragraphe coupe en deux, ou deux paragraphes fondus en un. Sur des blocs
 * trop courts pour qu'un recouvrement veuille dire quelque chose, on revient
 * a Dice, plus exigeant.
 */
function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const counts = new Map<string, number>()
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1)
  let common = 0
  for (const word of b) {
    const left = counts.get(word) ?? 0
    if (left > 0) {
      common += 1
      counts.set(word, left - 1)
    }
  }
  const smallest = Math.min(a.length, b.length)
  return smallest >= 4 ? common / smallest : (2 * common) / (a.length + b.length)
}

/** En deca, deux blocs ne parlent pas de la meme chose. */
const MATCH_THRESHOLD = 0.6

export interface ReattachedBlock extends AnchoredBlock {
  /** Vrai si le bloc a retrouve son ancre d'avant ; faux s'il est nouveau. */
  matched: boolean
}

/**
 * Rend a chaque bloc d'une reecriture l'ancre qu'il avait dans le texte
 * d'avant, en le reconnaissant a ses mots.
 *
 * Deux passes. D'abord les blocs dont le texte nettoye est identique — un
 * bloc que la reecriture n'a pas touche. Puis, par ressemblance decroissante,
 * les blocs retouches, fondus ou coupes ; un bloc d'avant peut servir a
 * plusieurs blocs d'apres, c'est ce qu'exige un paragraphe coupe en deux, et
 * a ressemblance egale c'est le bloc le plus proche en position qui gagne.
 * Un titre que rien ne reconnait prend l'ancre du bloc qu'il annonce, pour
 * que le marqueur reste sur le titre, la ou il etait.
 *
 * Les blocs qui restent sans ancre sont nouveaux : c'est a l'appelant de les
 * ancrer comme il ancre une insertion. L'ancre rendue est celle d'avant, au
 * caractere pres — jamais recalculee.
 */
export function reattachAnchors(base: string, rewritten: string): ReattachedBlock[] {
  const olds = anchoredBlocks(base).map((entry, index) => ({
    ...entry,
    index,
    tokens: tokensOf(entry.block),
    key: tokensOf(entry.block).join(' ')
  }))
  const news = splitBlocks(stripAnchorLines(rewritten)).map((block, index) => ({
    block,
    index,
    tokens: tokensOf(block),
    key: tokensOf(block).join(' ')
  }))

  const result: ReattachedBlock[] = news.map((entry) => ({
    block: entry.block,
    anchor: null,
    matched: false
  }))
  const scale = news.length > 0 ? olds.length / news.length : 1

  // Premiere passe : texte identique.
  const byKey = new Map<string, typeof olds>()
  for (const old of olds) {
    if (!old.key) continue
    const list = byKey.get(old.key) ?? []
    list.push(old)
    byKey.set(old.key, list)
  }
  for (const entry of news) {
    const candidates = entry.key ? byKey.get(entry.key) : undefined
    if (!candidates || candidates.length === 0) continue
    const expected = entry.index * scale
    candidates.sort((a, b) => Math.abs(a.index - expected) - Math.abs(b.index - expected))
    result[entry.index] = { block: entry.block, anchor: candidates[0].anchor, matched: true }
  }

  // Seconde passe : ressemblance, du plus sur au moins sur.
  const pairs: { score: number; distance: number; from: number; to: number }[] = []
  for (const entry of news) {
    if (result[entry.index].matched || entry.tokens.length === 0) continue
    const expected = entry.index * scale
    for (const old of olds) {
      const score = similarity(old.tokens, entry.tokens)
      if (score < MATCH_THRESHOLD) continue
      pairs.push({ score, distance: Math.abs(old.index - expected), from: old.index, to: entry.index })
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.distance - b.distance)
  for (const pair of pairs) {
    if (result[pair.to].matched) continue
    result[pair.to] = { block: news[pair.to].block, anchor: olds[pair.from].anchor, matched: true }
  }

  // Un titre que rien ne reconnait suit le bloc qu'il annonce.
  for (let index = 0; index < result.length; index += 1) {
    const entry = result[index]
    if (entry.matched || !HEADING_PATTERN.test(entry.block)) continue
    const next = result[index + 1]
    if (next?.matched && next.anchor) {
      result[index] = { block: entry.block, anchor: next.anchor, matched: true }
    }
  }

  return result
}

/**
 * Recompose un Markdown a partir de blocs ancres : un marqueur devant chaque
 * bloc dont l'ancre change — la regle de l'editeur, qui laisse la marge
 * lisible et le fichier propre. Un bloc sans ancre, ou qui repete l'ancre du
 * marqueur precedent, releve de ce marqueur ; un bloc devant lequel un
 * marqueur ne sait pas se poser aussi.
 */
export function assembleAnchored(items: AnchoredBlock[]): string {
  let previous: NoteAnchor | null = null
  return items
    .map(({ block, anchor }) => {
      if (!anchor || !anchorable(block) || sameAnchor(anchor, previous)) return block
      previous = anchor
      return `${anchorMarker(anchor)}\n${block}`
    })
    .join('\n\n')
}
