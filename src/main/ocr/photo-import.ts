/**
 * Des photos deposees ensemble deviennent un seul cours.
 *
 * Tout se passe ici, dans le processus principal : `sips` sait convertir un
 * HEIC d'iPhone en PNG, le moteur sait lire un PNG, et rien de tout cela ne
 * demande d'ecran. Le renderer n'a donc qu'a montrer l'avancement.
 *
 * **Les photos ne sont jamais des cours.** Elles sont deposees dans
 * `Originaux/` avant meme d'etre lues — pas copiees dans `Cours/` puis
 * deplacees — precisement pour qu'elles n'apparaissent a aucun moment dans la
 * bibliotheque. Ce qui apparait, c'est une ligne d'attente, puis le cours lu.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { PendingConversion, PhotoProposal } from '../../shared/types'
import { exists, vaultPaths } from '../vault'
import { cachedRead, keepRead } from './cache'
import { createCourseFromPhotos, type ConvertedPage } from './convert'
import { readPage } from './page'
import { imageFingerprint, ocrInstalled } from './model'
import { isPhoto, orderPhotoFiles, toPng } from './photos'

/** Les conversions en cours, dans l'ordre ou elles ont ete lancees. */
const pending = new Map<string, PendingConversion>()

let announce: () => void = () => {}

export function watchPendingConversions(handler: () => void): void {
  announce = handler
}

export function pendingConversions(): PendingConversion[] {
  return [...pending.values()]
}

function publish(entry: PendingConversion): void {
  pending.set(entry.id, entry)
  announce()
}

/**
 * Le nom du cours, tire de ce qu'on sait des photos.
 *
 * Le nom du premier fichier ne dit generalement rien — « IMG_2144 » — et
 * l'imposer obligerait a renommer chaque fois. La date de prise de vue, elle,
 * situe la seance, ce qui est exactement ce qu'on cherche en relisant.
 */
function titleFor(takenAt: number | null, count: number): string {
  if (takenAt === null) return `Cours photographié (${count} page${count > 1 ? 's' : ''})`

  const date = new Date(takenAt)
  const jour = date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
  return `Cours du ${jour}`
}

/**
 * Un nom de dossier sans rien qui puisse en faire autre chose qu'un enfant de
 * `Originaux/<matiere>/`. Les separateurs deviennent des tirets, et un nom fait
 * de points seuls — qui remonterait d'un cran — est refuse.
 */
function safeName(title: string): string {
  const clean = title.replace(/[/\\:]/g, '-').trim()
  return clean && !/^\.+$/.test(clean) ? clean : 'Cours photographié'
}

/**
 * Etablit l'ordre des photos et le nom du cours, sans rien ecrire.
 *
 * Rien n'est copie, rien n'est lu : c'est une proposition, faite pour etre
 * montree et pouvoir etre abandonnee. L'ordre est arrete ici et transmis tel
 * quel a l'import, pour que ce qui a ete accepte soit exactement ce qui tourne.
 */
export async function proposePhotos(
  paths: string[],
  subject: string
): Promise<PhotoProposal | null> {
  if (paths.length === 0) return null

  const ordered = await orderPhotoFiles(paths)
  const title = titleFor(ordered[0]?.takenAt ?? null, ordered.length)

  return {
    subject,
    title,
    photos: ordered.map((photo) => ({ path: photo.path, name: path.basename(photo.path) })),
    // La date n'a fait foi que si toutes les photos en portaient une : c'est la
    // regle d'`orderPhotos`, et c'est ce que l'ecran doit dire.
    byDate: ordered.every((photo) => photo.takenAt !== null)
  }
}

/**
 * Importe comme un seul cours des photos dont l'ordre a ete accepte, et rend la
 * main aussitot.
 *
 * La lecture continue en arriere-plan : c'est la ligne d'attente qui en rend
 * compte, et le cours n'apparait qu'une fois lisible. Attendre ici bloquerait
 * la fenetre pendant plusieurs minutes sur un cours de douze pages.
 */
export async function importPhotos(proposal: PhotoProposal): Promise<void> {
  const { subject } = proposal
  // Le dossier est recalcule plutot que repris : la proposition a fait
  // l'aller-retour par l'ecran, et ce qui decide d'un chemin dans le vault ne
  // doit pas venir de la. Meme raison pour les chemins, qui ne peuvent designer
  // que ce que le selecteur de fichiers savait rendre.
  //
  // **Un lot, un cours.** Deux imports le meme jour portent le meme titre —
  // « Cours du 17 aout 2026 » — et partageraient sans cela le meme dossier
  // d'archive et la meme ligne d'attente : photos entremelees dans
  // `Originaux/`, compteurs qui s'ecrasent. Le second lot prend donc un
  // suffixe, arrete ici une fois pour toutes : le titre du cours, le dossier
  // d'archive et la ligne d'attente racontent le meme import.
  let title = proposal.title
  let folder = safeName(title)
  for (
    let suffix = 2;
    (await exists(path.join(vaultPaths().originals, subject, folder))) ||
    pending.has(`${subject}/${folder}`);
    suffix += 1
  ) {
    title = `${proposal.title} (${suffix})`
    folder = `${safeName(proposal.title)} (${suffix})`
  }

  const photos = proposal.photos.filter((photo) => isPhoto(photo.path))
  if (photos.length === 0) return

  // Les originaux sont ranges avant toute lecture. Si l'application s'arrete au
  // milieu, les photos sont deja a l'abri dans le vault et rien n'est perdu.
  const archive = path.join(vaultPaths().originals, subject, folder)
  await fs.mkdir(archive, { recursive: true })

  const archived: string[] = []
  for (const [index, photo] of photos.entries()) {
    // Le numero prefixe le nom : l'ordre de lecture reste lisible dans le
    // Finder, meme des mois plus tard, meme si les dates se perdent.
    const name = `${String(index + 1).padStart(2, '0')} ${path.basename(photo.path)}`
    const target = path.join(archive, name)

    if (!(await exists(target))) await fs.copyFile(photo.path, target)
    archived.push(target)
  }

  const id = `${subject}/${folder}`
  publish({ id, subject, title, done: 0, total: archived.length })

  void convert(id, subject, title, `${subject}/${folder}`, archived)
}

async function convert(
  id: string,
  subject: string,
  title: string,
  original: string,
  files: string[]
): Promise<void> {
  const entry = pending.get(id)
  if (!entry) return

  try {
    if (!(await ocrInstalled())) {
      publish({ ...entry, failed: 'Le moteur de lecture n’est pas installé.' })
      return
    }

    const pages: ConvertedPage[] = []

    for (const [index, file] of files.entries()) {
      const png = await toPng(file)

      if (png) {
        const fingerprint = imageFingerprint(png)

        // Le cache d'abord : une photo deja lue — un import refait apres une
        // interruption — ne coute rien.
        const known = await cachedRead(fingerprint)
        // `keepFigures` : une photo de cours est la seule trace de ses schemas.
        // Un schema qui n'est pas garde comme image est perdu pour de bon.
        const read = known ?? (await readPage(png, { keepFigures: true }))

        if (read) {
          if (!known) await keepRead(fingerprint, read)
          // Une photo dont rien n'est sorti ne devient pas une page vide : elle
          // n'entre pas dans le cours, et les suivantes gardent leur ordre.
          if (read.markdown) pages.push({ page: index + 1, markdown: read.markdown })
        }
      }

      publish({ ...entry, done: index + 1, total: files.length })
    }

    if (pages.length === 0) {
      publish({ ...entry, failed: 'Aucune de ces photos n’a pu être lue.' })
      return
    }

    await createCourseFromPhotos(subject, title, original, pages)

    pending.delete(id)
    announce()
  } catch (cause) {
    publish({
      ...entry,
      failed: cause instanceof Error ? cause.message : String(cause)
    })
  }
}

/** Retire une ligne d'attente en echec, quand l'utilisateur l'ecarte. */
export function dismissConversion(id: string): void {
  pending.delete(id)
  announce()
}
