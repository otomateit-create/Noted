/**
 * Les titres d'une note, reconnus a leur taille.
 *
 * Deux mains en posent : l'assistant ecrit de vrais titres (`##`),
 * l'utilisateur agrandit une ligne avec le « + » de la barre d'outils, qui
 * pose une taille sur le texte et non un titre. Les deux se valent : une ligne
 * entierement en 20 px est un titre de 20 px, comme a l'oeil.
 *
 * Le sommaire et le repli des parties lisent la meme liste : une partie qu'on
 * replie est exactement une entree du sommaire, avec tout ce qu'elle couvre.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export interface NoteTitle {
  /** Le rang du bloc parmi ceux de premier niveau. */
  index: number
  /** Sa position dans le document. */
  pos: number
  text: string
  size: number
  /**
   * Le rang de sa taille parmi celles que la note emploie : 0 pour les grandes
   * parties, 1 pour ce qu'elles contiennent. Null pour le titre de la page.
   */
  level: number | null
}

/** La taille d'affichage des titres, accordee a notes.css (h1, h2, h3). */
const HEADING_SIZES: Record<number, number> = { 1: 24, 2: 20, 3: 18 }

/** Le premier palier au-dessus du corps du texte dans la barre d'outils. */
const TITLE_MIN_SIZE = 18

/**
 * Une ligne agrandie plus longue que cela est un passage mis en avant, pas un
 * titre. Les vrais titres n'y sont pas soumis : ils le sont par construction.
 */
const TITLE_MAX_LENGTH = 120

/**
 * La taille a laquelle un bloc s'affiche, s'il peut etre un titre.
 *
 * Une taille posee sur tout le texte l'emporte sur celle du bloc : un titre
 * de niveau 3 agrandi a 24 px se lit comme un titre de 24 px. Posee sur une
 * partie seulement, elle ne fait pas de la ligne un titre — c'est un mot mis
 * en valeur.
 */
function displaySize(node: ProseMirrorNode): number | null {
  const base =
    node.type.name === 'heading' ? (HEADING_SIZES[node.attrs.level as number] ?? null) : null
  if (!base && node.type.name !== 'paragraph') return null

  // Le plus petit des corps poses sur le texte, ou le corps du bloc des qu'un
  // morceau n'en porte pas. Les blancs ne comptent pas : une espace finale
  // reste souvent hors de la selection qu'on a agrandie.
  let marked: number | null = null
  for (let at = 0; at < node.childCount; at += 1) {
    const child = node.child(at)
    if (!child.isText || !child.text?.trim()) continue
    const size = child.marks.find((mark) => mark.type.name === 'textStyle')?.attrs.fontSize
    const px = typeof size === 'string' ? Number.parseFloat(size) : Number.NaN
    if (Number.isNaN(px)) return base
    marked = marked === null ? px : Math.min(marked, px)
  }

  return marked ?? base
}

/** Les titres de la note, dans l'ordre. */
export function noteTitles(doc: ProseMirrorNode): NoteTitle[] {
  const found: Omit<NoteTitle, 'level'>[] = []

  doc.forEach((node, pos, index) => {
    const size = displaySize(node)
    if (size === null || size < TITLE_MIN_SIZE) return
    const text = node.textContent.replace(/\s+/g, ' ').trim()
    if (!text) return
    if (node.type.name === 'paragraph' && text.length > TITLE_MAX_LENGTH) return
    found.push({ index, pos, text, size })
  })

  // Un titre seul a sa taille, en tete de note, est le titre de la page — le
  // « # Resume — Anatomie des titres financiers » que l'assistant pose avant
  // ses parties. Il coiffe tout le reste : le garder ferait du sommaire une
  // seule entree suivie de ses enfants, et le replier cacherait la note.
  const largest = Math.max(...found.map((title) => title.size))
  const pageTitle =
    found.length > 1 &&
    found[0].size === largest &&
    found.filter((title) => title.size === largest).length === 1

  // Le niveau est le rang de la taille parmi celles que la note emploie : une
  // note qui ne connait que 20 et 18 px commence au 20.
  const sizes = [...new Set(found.slice(pageTitle ? 1 : 0).map((title) => title.size))].sort(
    (a, b) => b - a
  )
  return found.map((title, at) => ({
    ...title,
    level: pageTitle && at === 0 ? null : sizes.indexOf(title.size)
  }))
}

/**
 * Le premier bloc qui n'appartient plus a la partie de ce titre : le titre
 * suivant d'une taille au moins egale, ou la fin de la note.
 */
export function sectionEnd(titles: NoteTitle[], title: NoteTitle, childCount: number): number {
  return (
    titles.find((other) => other.index > title.index && other.size >= title.size)?.index ??
    childCount
  )
}
