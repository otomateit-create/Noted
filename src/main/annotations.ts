/**
 * Les surlignages d'un cours : un fichier JSON par cours sous Annotations/,
 * meme arborescence que Cours/ et Notes/.
 *
 * Ils ne vont pas dans .noted/ parce qu'ils ne sont pas du cache : un passage
 * marque et la note qu'on y a accrochee sont du travail, au meme titre que la
 * note du cours. Ils se sauvegardent avec le reste du vault, et le JSON indente
 * se relit dans un editeur sans outil particulier.
 */

import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { HIGHLIGHT_COLORS } from '../shared/types'
import type { Annotation, HighlightColorId } from '../shared/types'
import { exists, resolveAnnotationsPath } from './vault'

const COLOURS = new Set<string>(HIGHLIGHT_COLORS.map((colour) => colour.id))

/**
 * Retient une entree si elle porte de quoi retrouver le passage : un
 * identifiant, une couleur connue, un texte. Le reste se reconstitue. Une
 * entree amputee de son texte, elle, ne se raccrochera jamais au document et
 * resterait une ligne fantome dans la legende.
 */
function validate(raw: unknown): Annotation | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>

  const { id, colour, text } = entry
  if (typeof id !== 'string' || !id) return null
  if (typeof colour !== 'string' || !COLOURS.has(colour)) return null
  if (typeof text !== 'string' || !text) return null

  const string = (value: unknown): string => (typeof value === 'string' ? value : '')

  return {
    id,
    colour: colour as HighlightColorId,
    page: typeof entry.page === 'number' ? entry.page : null,
    heading: typeof entry.heading === 'string' ? entry.heading : null,
    text,
    before: string(entry.before),
    after: string(entry.after),
    comment: string(entry.comment),
    createdAt: string(entry.createdAt) || new Date().toISOString()
  }
}

/**
 * Relit les surlignages d'un cours. Un fichier absent, tronque ou edite a la
 * main de travers rend une liste vide plutot qu'une erreur : perdre ses
 * surlignages est deja assez desagreable sans que le cours refuse en plus de
 * s'ouvrir.
 */
export async function readAnnotations(courseId: string): Promise<Annotation[]> {
  const target = resolveAnnotationsPath(courseId)

  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(target, 'utf8'))
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []
  return parsed
    .map(validate)
    .filter((annotation): annotation is Annotation => annotation !== null)
}

/**
 * Ecrit la liste entiere, par fichier temporaire puis rename atomique : une
 * sauvegarde interrompue ne peut pas laisser un JSON tronque, donc illisible.
 */
export async function writeAnnotations(courseId: string, list: Annotation[]): Promise<void> {
  const target = resolveAnnotationsPath(courseId)

  // Plus rien de surligne : le fichier disparait. Un « [] » abandonne dans le
  // vault laisse croire, en parcourant Annotations/ dans le Finder, qu'il reste
  // du travail dans un cours ou l'on a tout efface.
  if (list.length === 0) {
    await fs.rm(target, { force: true })
    return
  }

  const serialised = `${JSON.stringify(list, null, 2)}\n`

  // Meme precaution que pour les notes : le rename atomique donne au fichier un
  // inode neuf, que le Finder prend pour un fichier different et dont il
  // redemande une vignette. Reecrire un contenu identique le reveille pour rien.
  try {
    if ((await fs.readFile(target, 'utf8')) === serialised) return
  } catch {
    // Premier surlignage de ce cours : il n'y a rien a comparer.
  }

  await fs.mkdir(path.dirname(target), { recursive: true })

  const temporary = `${target}.tmp`
  await fs.writeFile(temporary, serialised, 'utf8')
  await fs.rename(temporary, target)
}

/** Suit un cours renomme ou deplace. Sans fichier, il n'y a rien a suivre. */
export async function moveAnnotations(previousId: string, nextId: string): Promise<void> {
  const from = resolveAnnotationsPath(previousId)
  if (!(await exists(from))) return

  const to = resolveAnnotationsPath(nextId)
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to)
}

/** Envoie les surlignages a la corbeille : c'est du travail, cela se recupere. */
export async function deleteAnnotations(courseId: string): Promise<void> {
  const target = resolveAnnotationsPath(courseId)
  if (await exists(target)) await shell.trashItem(target)
}
