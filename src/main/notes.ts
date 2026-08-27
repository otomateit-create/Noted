/**
 * Lecture et ecriture des notes. Une note est un fichier Markdown ordinaire
 * avec un frontmatter YAML — le format que comprend Obsidian sans plugin.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import type { Course, Note, NoteFrontmatter } from '../shared/types'
import { resolveNotePath, resolveNoteVersionPath, vaultPaths } from './vault'

function emptyNote(course: Course): { frontmatter: NoteFrontmatter; markdown: string } {
  const relative = path
    .relative(vaultPaths().root, course.path)
    .split(path.sep)
    .join('/')

  return {
    frontmatter: {
      cours: course.title,
      matiere: course.subject,
      source: relative,
      tags: [],
      modifie: new Date().toISOString()
    },
    // Une note neuve est vide, et l'invite « Prends tes notes ici… » s'affiche.
    // Le lien vers le document vivait ici auparavant : l'editeur l'affichait en
    // toutes lettres, « [[Cours/…|Ouvrir le document]] », en haut de chaque
    // note. Le chemin reste dans le frontmatter, qu'Obsidian sait suivre.
    markdown: ''
  }
}

/**
 * Lit la note d'un cours. Si elle n'existe pas encore, renvoie une note vide
 * en memoire — le fichier n'est cree qu'a la premiere sauvegarde, pour ne pas
 * joncher le vault de fichiers vides a chaque cours simplement ouvert.
 */
export async function readNote(course: Course): Promise<Note> {
  const notePath = resolveNotePath(course.id)

  let raw: string
  try {
    raw = await fs.readFile(notePath, 'utf8')
  } catch {
    const blank = emptyNote(course)
    return {
      courseId: course.id,
      path: notePath,
      markdown: blank.markdown,
      frontmatter: blank.frontmatter
    }
  }

  const parsed = matter(raw)
  const data = parsed.data as Partial<NoteFrontmatter>

  return {
    courseId: course.id,
    path: notePath,
    markdown: parsed.content.replace(/^\n+/, ''),
    frontmatter: {
      cours: data.cours ?? course.title,
      matiere: data.matiere ?? course.subject,
      source: data.source ?? '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      modifie: data.modifie ?? new Date().toISOString()
    }
  }
}

/**
 * Ecrit la note sur disque, frontmatter regenere. L'ecriture passe par un
 * fichier temporaire puis un rename atomique : une sauvegarde interrompue ne
 * peut pas laisser une note tronquee.
 */
export async function writeNote(course: Course, markdown: string): Promise<void> {
  const notePath = resolveNotePath(course.id)
  await fs.mkdir(path.dirname(notePath), { recursive: true })

  const existing = await readNote(course)

  // Rien de nouveau, rien a ecrire. Le rename atomique donne au fichier un
  // inode neuf : le Finder le prend pour un fichier different et redemande une
  // vignette a chaque fois. Reecrire un texte identique ne fait donc pas que
  // gaspiller une ecriture, cela reveille tout le systeme de fichiers pour
  // rien — et l'horodatage ci-dessous garantit que les octets different
  // toujours, meme quand le texte, lui, n'a pas bouge. On compare aussi le
  // nom et la matiere, qu'un cours renomme doit pouvoir rafraichir.
  const unchanged =
    existing.markdown.trimEnd() === markdown.trimEnd() &&
    existing.frontmatter.cours === course.title &&
    existing.frontmatter.matiere === course.subject
  if (unchanged) return

  const frontmatter: NoteFrontmatter = {
    ...existing.frontmatter,
    cours: course.title,
    matiere: course.subject,
    modifie: new Date().toISOString()
  }

  const serialised = matter.stringify(`${markdown.trimEnd()}\n`, frontmatter)
  const temporary = `${notePath}.tmp`

  await fs.writeFile(temporary, serialised, 'utf8')
  await fs.rename(temporary, notePath)
}

/**
 * Garde la note telle qu'elle etait avant qu'une proposition de l'assistant
 * soit appliquee. Un seul fichier par cours, ecrase a chaque application :
 * c'est le filet du dernier geste, pas un historique.
 */
export async function writeNoteBackup(courseId: string, markdown: string): Promise<void> {
  const file = resolveNoteVersionPath(courseId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, markdown, 'utf8')
}

/** La sauvegarde suit le cours renomme ou deplace, comme les vecteurs. */
export async function moveNoteBackup(previousId: string, nextId: string): Promise<void> {
  const from = resolveNoteVersionPath(previousId)
  const to = resolveNoteVersionPath(nextId)
  try {
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(from, to)
  } catch {
    // Pas de sauvegarde pour ce cours : rien a suivre.
  }
}

/** Efface la sauvegarde d'un cours supprime. C'est du filet, pas du travail. */
export async function deleteNoteBackup(courseId: string): Promise<void> {
  try {
    await fs.rm(resolveNoteVersionPath(courseId))
  } catch {
    // Deja absente.
  }
}
