/**
 * Les photos, avant qu'elles ne deviennent un cours.
 *
 * Deux services, et un seul outil pour les rendre : `sips`, livre avec macOS.
 * Il lit la date de prise de vue inscrite par l'appareil, et il convertit en PNG
 * ce que le moteur de lecture sait regarder — y compris le HEIC de l'iPhone, que
 * presque aucune bibliotheque JavaScript ne sait ouvrir. Ajouter une dependance
 * native pour refaire moins bien ce que le systeme fait deja n'aurait pas de sens
 * dans une application qui ne tourne que sur Mac.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fitToPageBudget } from '../../shared/types'

const run = promisify(execFile)

/** Ce que l'application accepte comme photo de cours. */
export const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tiff', '.tif'])

export function isPhoto(file: string): boolean {
  return PHOTO_EXTENSIONS.has(path.extname(file).toLowerCase())
}

/**
 * La date de prise de vue, en millisecondes, ou null si l'image n'en porte pas.
 *
 * Une capture d'ecran, un scan, une image telechargee n'ont pas de date de prise
 * de vue — `sips` rend alors `<nil>`, et c'est une information, pas un echec :
 * c'est elle qui fait basculer le classement sur les noms de fichiers.
 */
export async function captureDate(file: string): Promise<number | null> {
  try {
    const { stdout } = await run('/usr/bin/sips', ['-g', 'creation', file])
    const match = stdout.match(/creation:\s*(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/)
    if (!match) return null

    const [, year, month, day, hour, minute, second] = match
    // Les champs EXIF sont dans l'heure locale de l'appareil, sans fuseau. On
    // les relit tels quels : ce qui compte ici est l'ordre entre deux photos
    // prises a la suite, pas l'instant absolu.
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ).getTime()
  } catch {
    return null
  }
}

/** Comparaison de noms qui compte les nombres : « photo 2 » avant « photo 10 ». */
const byName = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

export interface OrderedPhoto {
  path: string
  /** Null quand l'image ne porte pas de date de prise de vue. */
  takenAt: number | null
}

/**
 * Met des photos dans l'ordre ou elles ont ete prises.
 *
 * La regle est en deux temps, et le second n'est pas un repli honteux : il est
 * la seule reponse correcte a un lot heterogene. Si toutes les images portent une
 * date de prise de vue, elle fait foi — c'est l'ordre reel, meme quand les noms
 * de fichiers ont ete brouilles par un transfert. Des qu'une seule n'en a pas,
 * on classe tout par nom : melanger deux criteres reviendrait a placer les
 * images datees entre elles et les autres n'importe ou, ce qui n'est plus un
 * ordre mais un tirage.
 */
export function orderPhotos(photos: OrderedPhoto[]): OrderedPhoto[] {
  const ordered = [...photos]
  const allDated = ordered.every((photo) => photo.takenAt !== null)

  ordered.sort((a, b) =>
    allDated
      ? (a.takenAt ?? 0) - (b.takenAt ?? 0)
      : byName.compare(path.basename(a.path), path.basename(b.path))
  )

  return ordered
}

/** Lit les dates puis classe. Le detour par `orderPhotos` garde le tri testable seul. */
export async function orderPhotoFiles(paths: string[]): Promise<OrderedPhoto[]> {
  const dated = await Promise.all(
    paths.map(async (file) => ({ path: file, takenAt: await captureDate(file) }))
  )
  return orderPhotos(dated)
}

/**
 * Convertit une image en PNG a la taille utile, et rend ses octets.
 *
 * « Utile » a change de sens avec l'etage de mise en page : cette image n'est
 * plus celle qu'on envoie au modele, c'est celle qu'on **decoupe**. Elle garde
 * donc le budget de page, deux fois celui d'une image seule — la reduire ici au
 * plafond du modele reviendrait a decouper dans une image deja perdue, et tout
 * le benefice du decoupage disparaitrait. C'est `page.ts` qui ramene ensuite
 * chaque region sous le plafond.
 *
 * `sips` reste l'outil de la conversion, et pas `sharp` qui est pourtant
 * embarque : lui seul ouvre le HEIC de l'iPhone sans dependance
 * supplementaire. Le passage par un fichier temporaire est ce qu'il impose,
 * ne sachant pas ecrire sur sa sortie standard. Il est efface aussitot.
 */
export async function toPng(file: string): Promise<Buffer | null> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-ocr-'))
  const target = path.join(scratch, 'page.png')

  try {
    // Les dimensions d'abord : le budget porte sur la surface, et `sips` ne sait
    // pas raisonner autrement qu'en cotes. Il faut donc les lui calculer.
    const { stdout } = await run('/usr/bin/sips', [
      '-g', 'pixelWidth', '-g', 'pixelHeight', file
    ])
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0)
    const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1] ?? 0)
    const fitted = fitToPageBudget(width, height)

    const resize =
      width > 0 && height > 0
        ? ['--resampleHeightWidth', String(fitted.height), String(fitted.width)]
        : // Dimensions inconnues : on se rabat sur un plafond de cote, plus
          // grossier mais toujours preferable a envoyer l'image telle quelle.
          ['--resampleHeightWidthMax', '1448']

    await run('/usr/bin/sips', ['-s', 'format', 'png', ...resize, file, '--out', target])
    return await fs.readFile(target)
  } catch {
    return null
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}
