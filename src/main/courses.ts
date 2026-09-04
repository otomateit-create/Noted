/**
 * Renommer, deplacer et supprimer un cours ou une matiere.
 *
 * Un cours n'est pas seulement un fichier. Son identifiant — son chemin relatif
 * sous Cours/ — sert de cle a six choses qui vivent ailleurs : sa note sous
 * Notes/, ses surlignages sous Annotations/, ses vecteurs dans .noted/vecteurs/,
 * son texte extrait dans .noted/extractions/, son index de recherche en memoire
 * et sa conversation avec Claude. Deplacer le seul document laisserait les six
 * autres derriere, sans que rien ne le signale : la note deviendrait
 * introuvable, les surlignages ne se raccrocheraient plus a rien, le cache se
 * remplirait de fichiers qu'aucun cours ne reclame, et l'assistant chercherait
 * dans un document qui n'existe plus.
 *
 * C'est pourquoi ces operations vivent ici plutot que dans vault.ts, qui ne
 * connait que la disposition des fichiers : il faut un endroit qui voie les
 * six a la fois.
 *
 * Ce qui part a la corbeille plutot que d'etre efface : le document, la note et
 * les surlignages, qui sont du travail. Les vecteurs, eux, sont du cache — ils
 * se recalculent.
 */

import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { deleteAnnotations, moveAnnotations } from './annotations'
import { forgetSession, renameSession } from './claude/session'
import { deleteFlashcards, moveFlashcards } from './flashcards/store'
import { deleteExtraction, renameExtraction } from './extraction-cache'
import { deletePreview, renamePreview } from './preview-cache'
import {
  deleteCourseMemory,
  deleteSubjectMemory,
  moveCourseMemory,
  moveSubjectMemory
} from './memory/entries'
import { invalidateMemoryIndex } from './memory/rag'
import { clearDraft, moveDraft } from './notes-draft'
import { deleteNoteBackup, moveNoteBackup } from './notes'
import { forgetCourse, renameCourse as renameIndexedCourse } from './rag/store'
import { deleteVectors, renameVectors } from './rag/vector-cache'
import {
  cleanName,
  exists,
  listSubjects,
  resolveCoursePath,
  resolveNotePath,
  resolveSubjectAnnotationsPath,
  resolveFolderPath,
  resolveSubjectFlashcardsPath,
  resolveSubjectNotesPath,
  resolveSubjectPath,
  vaultPaths
} from './vault'

/**
 * Deplace le document, sa note et ses vecteurs, puis suit l'identifiant dans
 * l'index et la conversation. Renvoie le nouvel identifiant.
 *
 * Le document est deplace en premier : c'est la seule etape qui peut echouer
 * pour une raison qui interesse l'utilisateur — destination occupee, fichier
 * disparu. Ce qui suit ne concerne plus que des annexes, dont l'echec ne doit
 * pas laisser le cours a moitie deplace.
 */
async function relocate(courseId: string, nextId: string): Promise<string> {
  if (nextId === courseId) return courseId

  const from = resolveCoursePath(courseId)
  const to = resolveCoursePath(nextId)

  if (!(await exists(from))) {
    throw new Error('Ce cours a disparu du dossier. Rafraîchis la bibliothèque.')
  }
  if (await exists(to)) {
    throw new Error(`Un cours porte déjà ce nom : ${path.basename(to)}.`)
  }

  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to)

  await moveCourseAnnexes(courseId, nextId)

  return nextId
}

/**
 * Retire les dossiers de classement que le depart du cours vient de vider.
 *
 * Ranger un cours dans « HEC » creuse un « HEC » dans les cinq arbres du vault
 * a la fois — Cours/, Notes/, Annotations/, Flashcards/, Memoire/ — puisque
 * tous se calquent sur le chemin du cours. Le dernier cours qui en sort doit
 * donc les defaire tous les cinq, sans quoi l'application ne montrerait plus le
 * dossier (elle ne les connait que par les cours qu'ils contiennent) mais le
 * Finder et Obsidian le garderaient sous les yeux, vide.
 *
 * Ne touche jamais au dossier d'une matiere : il faut au moins deux segments —
 * `matiere/dossier` — pour qu'il y ait un classement a defaire. Une matiere
 * sans cours reste une matiere, c'est ce qui permet d'en preparer une.
 */
async function pruneEmptyFolders(courseId: string): Promise<void> {
  const relative = path.posix.dirname(courseId)
  if (relative.split('/').length < 2) return

  const paths = vaultPaths()
  for (const root of [paths.courses, paths.notes, paths.annotations, paths.flashcards, paths.memory]) {
    // `rmdir` echoue de lui-meme sur un dossier non vide : c'est exactement la
    // condition voulue, et la verifier a part laisserait une course entre les deux.
    await fs.rmdir(path.join(root, relative)).catch(() => undefined)
  }
}

/**
 * Fait suivre tout ce qui vit ailleurs mais porte l'identifiant du cours : sa
 * note, ses surlignages, ses vecteurs, sa place dans l'index et sa conversation.
 *
 * Separe du deplacement du document, qui l'appelle une fois le fichier arrive
 * a destination : c'est la seule etape qui peut echouer pour une raison qui
 * interesse l'utilisateur, et rien de ce qui suit ne doit laisser le cours a
 * moitie deplace.
 */
async function moveCourseAnnexes(courseId: string, nextId: string): Promise<void> {
  if (nextId === courseId) return

  // La note ne suit que si elle existe : un cours simplement ouvert n'en a pas
  // encore, le fichier n'etant cree qu'a la premiere sauvegarde.
  const noteFrom = resolveNotePath(courseId)
  const noteTo = resolveNotePath(nextId)
  if (await exists(noteFrom)) {
    await fs.mkdir(path.dirname(noteTo), { recursive: true })
    await fs.rename(noteFrom, noteTo)
  }

  await moveAnnotations(courseId, nextId)
  await moveFlashcards(courseId, nextId)
  await renameVectors(courseId, nextId)
  await renameExtraction(courseId, nextId)
  await renamePreview(courseId, nextId)
  await moveNoteBackup(courseId, nextId)
  await moveDraft(courseId, nextId)
  await moveCourseMemory(courseId, nextId)
  invalidateMemoryIndex()
  renameIndexedCourse(courseId, nextId)
  renameSession(courseId, nextId)

  // En dernier, quand tout a bouge : ce qui reste vide n'attend plus personne.
  await pruneEmptyFolders(courseId)
}

/** Renomme un cours sans changer de matiere. L'extension ne se touche pas. */
export async function renameCourse(courseId: string, title: string): Promise<string> {
  const clean = cleanName(title, 'au cours')
  const directory = path.posix.dirname(courseId)
  const extension = path.extname(courseId)
  const next = `${clean}${extension}`

  return relocate(courseId, directory === '.' ? next : `${directory}/${next}`)
}

/**
 * Range un cours : dans une autre matiere, dans un dossier de classement, ou
 * les deux. Tout ce qui porte son identifiant suit — c'est la difference entre
 * ce geste et le meme fait depuis le Finder, qui laisserait sa note, ses
 * surlignages, ses cartes et sa memoire a l'ancienne adresse.
 *
 * Sans dossier, le cours atterrit a la racine de la matiere, meme s'il vivait
 * dans un sous-dossier : recreer une arborescence de classement dans une
 * matiere ou elle n'existe pas produirait des dossiers a un seul cours.
 */
export async function moveCourse(
  courseId: string,
  subject: string,
  folder?: string | null
): Promise<string> {
  const clean = cleanName(subject, 'à la matière')
  if (!(await exists(resolveSubjectPath(clean)))) {
    throw new Error(`La matière « ${clean} » n'existe pas.`)
  }

  const name = path.posix.basename(courseId)
  if (!folder) return relocate(courseId, `${clean}/${name}`)

  // Le dossier peut ne pas exister encore : c'est le geste qui le cree, comme
  // a l'import. On ne demande pas de le preparer avant de s'en servir.
  const cleanFolder = cleanName(folder, 'au dossier')
  await fs.mkdir(resolveFolderPath(clean, cleanFolder), { recursive: true })

  return relocate(courseId, `${clean}/${cleanFolder}/${name}`)
}

/** Envoie a la corbeille le document, sa note et ses surlignages, et efface le reste. */
export async function deleteCourse(courseId: string): Promise<void> {
  const documentPath = resolveCoursePath(courseId)
  const notePath = resolveNotePath(courseId)

  if (await exists(documentPath)) await shell.trashItem(documentPath)
  if (await exists(notePath)) await shell.trashItem(notePath)

  await deleteAnnotations(courseId)
  await deleteFlashcards(courseId)
  await deleteVectors(courseId)
  await deleteExtraction(courseId)
  await deletePreview(courseId)
  await deleteNoteBackup(courseId)
  await clearDraft(courseId)
  await deleteCourseMemory(courseId)
  invalidateMemoryIndex()
  forgetCourse(courseId)
  forgetSession(courseId)
}

/** Un cours deplace : son identifiant d'avant, celui d'apres. */
export interface CourseMove {
  previousId: string
  nextId: string
}

/**
 * Renomme une matiere. Tous ses cours changent d'identifiant du meme coup,
 * puisque celui-ci commence par le nom de la matiere. Renvoie la
 * correspondance, pour que l'interface retrouve le cours qui etait ouvert.
 */
export async function renameSubject(name: string, title: string): Promise<{
  name: string
  moved: CourseMove[]
}> {
  const clean = cleanName(title, 'à la matière')
  const from = resolveSubjectPath(name)
  const to = resolveSubjectPath(clean)

  if (clean === name) return { name, moved: [] }
  if (!(await exists(from))) throw new Error(`La matière « ${name} » n'existe pas.`)
  if (await exists(to)) throw new Error(`La matière « ${clean} » existe déjà.`)

  // La liste est prise avant le deplacement : apres, plus aucun de ces cours
  // n'est la ou on le cherchait.
  const before = await listSubjects()
  const courses = before.find((subject) => subject.name === name)?.courses ?? []

  await fs.rename(from, to)

  const notesFrom = resolveSubjectNotesPath(name)
  const notesTo = resolveSubjectNotesPath(clean)
  if (await exists(notesFrom)) {
    if (await exists(notesTo)) {
      // Deux dossiers de notes a fusionner : on deplace fichier par fichier
      // plutot que d'ecraser tout un dossier de travail.
      await mergeInto(notesFrom, notesTo)
    } else {
      await fs.rename(notesFrom, notesTo)
    }
  }

  const annotationsFrom = resolveSubjectAnnotationsPath(name)
  const annotationsTo = resolveSubjectAnnotationsPath(clean)
  if (await exists(annotationsFrom)) {
    if (await exists(annotationsTo)) {
      await mergeInto(annotationsFrom, annotationsTo)
    } else {
      await fs.rename(annotationsFrom, annotationsTo)
    }
  }

  const flashcardsFrom = resolveSubjectFlashcardsPath(name)
  const flashcardsTo = resolveSubjectFlashcardsPath(clean)
  if (await exists(flashcardsFrom)) {
    if (await exists(flashcardsTo)) {
      await mergeInto(flashcardsFrom, flashcardsTo)
    } else {
      await fs.rename(flashcardsFrom, flashcardsTo)
    }
  }

  // La memoire de la matiere — son fichier et son dossier de cours — suit le
  // nouveau nom, comme les notes.
  await moveSubjectMemory(name, clean)
  invalidateMemoryIndex()

  const moved: CourseMove[] = []
  for (const course of courses) {
    const nextId = `${clean}/${course.id.slice(name.length + 1)}`
    // Les fichiers ont deja suivi le dossier : il ne reste que les annexes
    // reperees par l'identifiant.
    await renameVectors(course.id, nextId)
    await renameExtraction(course.id, nextId)
    await renamePreview(course.id, nextId)
    await moveNoteBackup(course.id, nextId)
    renameIndexedCourse(course.id, nextId)
    renameSession(course.id, nextId)
    moved.push({ previousId: course.id, nextId })
  }

  return { name: clean, moved }
}

/** Deplace le contenu d'un dossier dans un autre, sans ecraser ce qui s'y trouve. */
async function mergeInto(from: string, to: string): Promise<void> {
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const destination = path.join(to, entry.name)

    if (entry.isDirectory()) {
      await fs.mkdir(destination, { recursive: true })
      await mergeInto(source, destination)
      continue
    }
    if (!(await exists(destination))) await fs.rename(source, destination)
  }
}

/**
 * Supprime une matiere et tout ce qu'elle contient. Chaque cours passe par la
 * suppression individuelle : c'est elle qui sait effacer les vecteurs et fermer
 * les conversations, et on ne veut pas de deuxieme version de cette liste.
 */
export async function deleteSubject(name: string): Promise<void> {
  const folder = resolveSubjectPath(name)
  if (!(await exists(folder))) throw new Error(`La matière « ${name} » n'existe pas.`)

  const subjects = await listSubjects()
  const courses = subjects.find((subject) => subject.name === name)?.courses ?? []

  for (const course of courses) {
    await deleteVectors(course.id)
    await deleteExtraction(course.id)
    await deletePreview(course.id)
    await deleteNoteBackup(course.id)
    forgetCourse(course.id)
    forgetSession(course.id)
  }

  // Les dossiers partent entiers, ce qui emporte aussi les fichiers d'un
  // format que l'application n'ouvre pas — un .pptx depose la en attendant.
  await shell.trashItem(folder)

  const notes = resolveSubjectNotesPath(name)
  if (await exists(notes)) await shell.trashItem(notes)

  const annotations = resolveSubjectAnnotationsPath(name)
  if (await exists(annotations)) await shell.trashItem(annotations)

  const flashcards = resolveSubjectFlashcardsPath(name)
  if (await exists(flashcards)) await shell.trashItem(flashcards)

  await deleteSubjectMemory(name)
  invalidateMemoryIndex()
}
