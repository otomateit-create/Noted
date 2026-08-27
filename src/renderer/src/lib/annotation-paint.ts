/**
 * Peindre les surlignages a l'ecran, sans toucher au document.
 *
 * Meme mecanique que la recherche ⌘F : le navigateur peint des etendues, rien
 * n'est insere dans le HTML. C'est ce qui compte pour un PDF, dont la couche de
 * texte est reconstruite par pdf.js a chaque rendu de page, comme pour un Word,
 * dont le HTML appartient a React — y glisser des balises reviendrait a leur
 * retirer le document sous les pieds au rendu suivant.
 *
 * Le registre du navigateur est global, la ou les surlignages arrivent par
 * morceaux : une page de PDF apporte les siens en entrant dans le cadre et les
 * retire en sortant. Ce module tient donc le total, et le recompose a chaque
 * changement plutot que de demander a chaque page de connaitre les autres.
 */

import { HIGHLIGHT_COLORS, type HighlightColorId } from '@shared/types'

/**
 * Un surlignage et les etendues qui le peignent — une par noeud de texte, ce
 * qui evite d'englober au passage ce qui n'est pas du texte.
 */
export interface PaintedRange {
  id: string
  colour: HighlightColorId
  ranges: Range[]
}

const NAME_PREFIX = 'noted-hl-'

/** Le passage qu'on vient de rejoindre depuis la liste, le temps d'un clin d'oeil. */
const FOCUS = 'noted-hl-focus'

/** Ce que chaque source apporte : « page-12 », « html ». */
const sources = new Map<string, PaintedRange[]>()

function available(): boolean {
  return typeof CSS !== 'undefined' && Boolean(CSS.highlights)
}

function repaint(): void {
  if (!available()) return

  for (const colour of HIGHLIGHT_COLORS) {
    const ranges: Range[] = []
    for (const painted of sources.values()) {
      for (const entry of painted) {
        if (entry.colour === colour.id) ranges.push(...entry.ranges)
      }
    }

    const name = `${NAME_PREFIX}${colour.id}`
    if (ranges.length > 0) CSS.highlights.set(name, new Highlight(...ranges))
    else CSS.highlights.delete(name)
  }
}

/** Les couleurs qui ne se peignent pas (voir `hidden` dans la table partagee). */
const HIDDEN = new Set(HIGHLIGHT_COLORS.filter((colour) => colour.hidden).map((colour) => colour.id))

/**
 * Ce qu'une page ou un document apporte. Remplace ce qu'elle apportait avant.
 *
 * Les couleurs cachees sont ecartees ici, a l'entree : ni peintes, ni
 * cliquables (`annotationAt` ne parcourt que ce qui est retenu), sans que les
 * pages aient a le savoir.
 */
export function contribute(source: string, painted: PaintedRange[]): void {
  const kept = painted.filter((entry) => !HIDDEN.has(entry.colour))
  if (kept.length === 0) sources.delete(source)
  else sources.set(source, kept)
  repaint()
}

/** Une page sortie du cadre, un document ferme : ce qu'il apportait s'en va. */
export function withdraw(source: string): void {
  if (!sources.delete(source)) return
  repaint()
}

/** Changement de cours : tout repart de zero. */
export function withdrawAll(): void {
  sources.clear()
  if (!available()) return

  for (const colour of HIGHLIGHT_COLORS) CSS.highlights.delete(`${NAME_PREFIX}${colour.id}`)
  CSS.highlights.delete(FOCUS)
}

/** Souligne brievement un passage rejoint depuis la liste, pour le situer. */
export function flashFocus(ranges: Range[]): void {
  if (!available() || ranges.length === 0) return

  CSS.highlights.set(FOCUS, new Highlight(...ranges))
  window.setTimeout(() => CSS.highlights.delete(FOCUS), 1400)
}

/**
 * Le surlignage sous un point de l'ecran, s'il y en a un.
 *
 * On teste les rectangles des etendues plutot que d'interroger le curseur de
 * texte : un clic tombe souvent entre deux glyphes de la couche de texte d'un
 * PDF, la ou le rectangle, lui, couvre toute la ligne.
 */
export function annotationAt(x: number, y: number): string | null {
  for (const painted of sources.values()) {
    for (const entry of painted) {
      for (const range of entry.ranges) {
        for (const rect of range.getClientRects()) {
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            return entry.id
          }
        }
      }
    }
  }
  return null
}
