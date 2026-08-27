/**
 * Le format des liens entre entrees de memoire, et leur resolution.
 *
 * Un lien est un wikilink Obsidian ordinaire visant un titre :
 * `[[Corporate Finance#WACC]]` — le chemin du fichier sous Memoire/, sans son
 * extension, puis le titre de l'entree visee. Les liens d'une entree vivent sur
 * une ligne dediee en fin d'entree (« Voir : … ») que le code tient a part : le
 * corps que manipulent les outils ne la contient jamais, et le texte vectorise
 * non plus — sans quoi lier deux entrees les ferait revectoriser toutes deux.
 *
 * Ce module ne connait ni le disque ni l'index : il dit seulement comment une
 * cible s'ecrit et comment on la retrouve. Le processus principal s'en sert
 * pour ecrire les liens, le renderer pour afficher les deux sens.
 */

import type { MemoryEntry } from './types'

/** Au-dela, une entree cesse d'etre un fait pour devenir un carrefour. */
export const MAX_LINKS = 5

/**
 * Ce qui ferait d'un titre un lien illisible : crochets, barre d'alias, diese
 * de section. Remplaces par une espace des l'ecriture, pour que la cible ecrite
 * et la cible cherchee restent toujours la meme chaine.
 */
function plain(text: string): string {
  return text.replace(/[[\]|#]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** La cible d'une entree : son fichier sans .md, un diese, son titre. */
export function linkTarget(file: string, title: string): string {
  return `${plain(file.replace(/\.md$/, ''))}#${plain(title)}`
}

/** La cible d'une entree deja lue. */
export function targetOf(entry: MemoryEntry): string {
  return linkTarget(entry.file, entry.title)
}

/**
 * La forme comparable d'une cible. Un lien ecrit a la main dans Obsidian n'aura
 * ni la meme casse ni les memes accents : il doit pointer quand meme.
 */
export function normaliseTarget(target: string): string {
  return target
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function sameTarget(a: string, b: string): boolean {
  return normaliseTarget(a) === normaliseTarget(b)
}

/** L'entree que vise ce lien, ou null — un lien mort s'ignore, sans erreur. */
export function resolveTarget(target: string, entries: MemoryEntry[]): MemoryEntry | null {
  const wanted = normaliseTarget(target)
  return entries.find((entry) => normaliseTarget(targetOf(entry)) === wanted) ?? null
}

/** Les entrees que celle-ci designe, dans l'ordre de ses liens. */
export function outgoingEntries(entry: MemoryEntry, entries: MemoryEntry[]): MemoryEntry[] {
  return entry.links
    .map((target) => resolveTarget(target, entries))
    .filter((found): found is MemoryEntry => Boolean(found))
}

/**
 * Les entrees qui designent celle-ci. Resolues a la volee : un lien n'est
 * stocke que du cote de sa source, jamais en double.
 */
export function incomingEntries(entry: MemoryEntry, entries: MemoryEntry[]): MemoryEntry[] {
  const self = normaliseTarget(targetOf(entry))
  return entries.filter(
    (other) =>
      other.id !== entry.id && other.links.some((target) => normaliseTarget(target) === self)
  )
}
