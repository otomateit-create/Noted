/**
 * Cache des apercus de cours : la premiere page de chaque document, en image,
 * telle que la page de matiere la montre sur sa carte.
 *
 * Meme principe que le cache d'extraction. C'est le renderer qui fabrique
 * l'apercu — pdf.js pour un PDF, une page typographiee a partir du texte pour
 * les autres formats — parce que c'est lui qui sait deja ouvrir ces documents.
 * Le processus principal ne fait que garder l'image sur le disque, et dire si
 * elle vaut encore : l'empreinte du fichier — taille et date — change, et
 * l'apercu se refait. Un apercu qui manque ne coute qu'un rendu ; c'est du
 * cache, jamais du travail.
 *
 * Un seul fichier JSON par cours, l'image en base64 dedans : un apercu pese
 * quelques dizaines de kilo-octets, et une lecture vaut mieux que deux.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CoursePreview } from '../shared/types'
import { resolveCoursePath, vaultPaths } from './vault'

/** A incrementer si la disposition du fichier ou le dessin de l'apercu change. */
const FORMAT = 1

interface Cached {
  format: number
  cours: string
  empreinte: string
  ecrit: string
  pages?: number
  words?: number
  png: string
}

function directory(): string {
  return path.join(vaultPaths().internal, 'apercus')
}

/** Meme convention de nom que les extractions et les vecteurs. */
function fileFor(courseId: string): string {
  const readable = courseId
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  const unique = createHash('sha256').update(courseId).digest('hex').slice(0, 8)
  return path.join(directory(), `${readable}-${unique}.json`)
}

/** Taille et date plutot que contenu : voir extraction-cache.ts. */
async function fingerprint(courseId: string): Promise<string | null> {
  try {
    const stats = await fs.stat(resolveCoursePath(courseId))
    return createHash('sha256')
      .update(`${FORMAT} ${stats.size} ${Math.round(stats.mtimeMs)}`)
      .digest('hex')
  } catch {
    return null
  }
}

/** L'apercu deja dessine de ce cours, ou null s'il faut le refaire. */
export async function readPreview(courseId: string): Promise<CoursePreview | null> {
  const empreinte = await fingerprint(courseId)
  if (!empreinte) return null

  try {
    const cached = JSON.parse(await fs.readFile(fileFor(courseId), 'utf8')) as Cached
    if (cached.format !== FORMAT || cached.empreinte !== empreinte) return null
    if (typeof cached.png !== 'string' || cached.png.length === 0) return null

    return {
      png: new Uint8Array(Buffer.from(cached.png, 'base64')),
      ...(typeof cached.pages === 'number' ? { pages: cached.pages } : {}),
      ...(typeof cached.words === 'number' ? { words: cached.words } : {})
    }
  } catch {
    return null
  }
}

/** Garde l'apercu d'un cours. Ne leve jamais : un cache qui n'aboutit pas ne coute qu'un rendu. */
export async function savePreview(courseId: string, preview: CoursePreview): Promise<void> {
  const empreinte = await fingerprint(courseId)
  if (!empreinte) return

  const cached: Cached = {
    format: FORMAT,
    cours: courseId,
    empreinte,
    ecrit: new Date().toISOString(),
    ...(typeof preview.pages === 'number' ? { pages: preview.pages } : {}),
    ...(typeof preview.words === 'number' ? { words: preview.words } : {}),
    png: Buffer.from(preview.png).toString('base64')
  }

  const target = fileFor(courseId)
  const temporary = `${target}.${empreinte.slice(0, 12)}.tmp`

  try {
    await fs.mkdir(directory(), { recursive: true })
    await fs.writeFile(temporary, `${JSON.stringify(cached)}\n`)
    await fs.rename(temporary, target)
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Suit un cours renomme ou deplace : le nom du fichier derive de l'identifiant. */
export async function renamePreview(previousId: string, nextId: string): Promise<void> {
  try {
    await fs.rename(fileFor(previousId), fileFor(nextId))
  } catch {
    // Pas encore d'apercu : rien a faire suivre.
  }
}

/** Efface l'apercu d'un cours supprime. */
export async function deletePreview(courseId: string): Promise<void> {
  await fs.rm(fileFor(courseId), { force: true })
}
