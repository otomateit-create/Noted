/**
 * Cache du texte extrait des documents, sur le meme principe que celui des
 * vecteurs.
 *
 * **Ce que cela coute aujourd'hui.** Lire un PDF, ce n'est pas lire un fichier
 * texte : chaque page est parcourue glyphe par glyphe, ses fragments sont
 * regroupes en lignes puis en paragraphes, ses en-tetes courants reperes, ses
 * images decodees une a une pour etre posees sur le disque. Sur un cours de
 * cinq cents pages, cela se compte en dizaines de secondes — et c'etait refait
 * a l'identique a chaque ouverture, alors que le fichier n'avait pas bouge d'un
 * octet. La barre de lecture qui defile a l'ouverture d'un cours deja lu la
 * veille ne mesure rien d'autre que ce gachis.
 *
 * **Ce qui est garde.** Le texte tel que l'extraction l'a rendu, marqueurs
 * `[figure]` compris, et la liste des images qu'ils designent.
 *
 * **Seuls les PDF.** Un Word ou un PowerPoint doit de toute facon etre converti
 * pour etre affiche, et le texte envoye a l'IA est tire de cette conversion :
 * le mettre en cache n'economiserait rien du tout, et ferait un second endroit
 * ou la meme verite pourrait diverger.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EXTRACTION_VERSION, type ExtractedCourse } from '../shared/types'
import { resolveCoursePath, vaultPaths } from './vault'

/** A incrementer si la disposition du fichier change. */
const FORMAT = 1

interface Cached {
  format: number
  cours: string
  empreinte: string
  ecrit: string
  extrait: ExtractedCourse
}

function directory(): string {
  return path.join(vaultPaths().internal, 'extractions')
}

/**
 * Nom du fichier de cache. Meme convention que pour les vecteurs : un debut
 * lisible dans le Finder, une fin qui distingue deux cours de meme nom dans
 * deux matieres differentes.
 */
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

/** Les formats dont l'extraction coute assez cher pour meriter le disque. */
function cacheable(courseId: string): boolean {
  return path.extname(courseId).toLowerCase() === '.pdf'
}

/**
 * Empreinte du travail a faire. Elle couvre les deux seules raisons de devoir
 * relire : le fichier a change, ou l'extraction elle-meme a change.
 *
 * La taille et la date de modification plutot que le contenu : hacher cinquante
 * megaoctets a chaque ouverture couterait une part de ce qu'on cherche a
 * economiser. Une date qui bouge sans que le contenu change — une copie, une
 * restauration de sauvegarde — ne fait perdre qu'une relecture.
 *
 * `EXTRACTION_VERSION` n'est pas une precaution decorative : sans elle, le jour
 * ou le decoupage en paragraphes ou la detection des sommaires s'ameliore, tous
 * les cours deja lus garderaient leur ancien texte pour toujours, sans que rien
 * ne le signale.
 */
async function fingerprint(courseId: string): Promise<string | null> {
  try {
    const stats = await fs.stat(resolveCoursePath(courseId))
    return createHash('sha256')
      .update(`${FORMAT} ${EXTRACTION_VERSION} ${stats.size} ${Math.round(stats.mtimeMs)}`)
      .digest('hex')
  } catch {
    // Le fichier a disparu du dossier : il n'y a plus rien a mettre en cache ni
    // a relire.
    return null
  }
}

/**
 * Ce qui est deja sur le disque, par cours.
 *
 * Le panneau renvoie au processus principal, a chaque ouverture, le texte qu'il
 * vient de lire — y compris quand il le tient de ce cache. Sans cette memoire,
 * chaque ouverture reecrirait a l'identique un fichier de plusieurs centaines de
 * kilo-octets.
 */
const written = new Map<string, string>()

/** Le texte deja extrait de ce cours, ou null s'il faut le relire. */
export async function readExtraction(courseId: string): Promise<ExtractedCourse | null> {
  if (!cacheable(courseId)) return null

  const empreinte = await fingerprint(courseId)
  if (!empreinte) return null

  try {
    const cached = JSON.parse(await fs.readFile(fileFor(courseId), 'utf8')) as Cached

    if (cached.format !== FORMAT) return null
    if (cached.empreinte !== empreinte) return null

    // Un fichier tronque ou ecrit par une version qui ne s'annonce pas se
    // relirait sinon comme un cours vide, et le cours passerait pour illisible.
    const extrait = cached.extrait
    if (!extrait || typeof extrait.markdown !== 'string' || !Array.isArray(extrait.pages)) {
      return null
    }

    written.set(courseId, empreinte)

    // L'identifiant vient de l'appelant, jamais du fichier : le cours a pu etre
    // renomme depuis, auquel cas le cache l'a suivi mais porte encore l'ancien
    // nom a l'interieur.
    return { ...extrait, courseId }
  } catch {
    // Pas de cache, ou illisible : on relit le document, c'est tout.
    return null
  }
}

/**
 * Garde le texte extrait d'un cours. Ne leve jamais : le cache est un confort,
 * et une ouverture ne doit pas echouer parce que le disque est plein.
 */
export async function saveExtraction(extracted: ExtractedCourse): Promise<void> {
  const courseId = extracted.courseId
  if (!cacheable(courseId)) return

  const empreinte = await fingerprint(courseId)
  if (!empreinte) return
  if (written.get(courseId) === empreinte) return

  const cached: Cached = {
    format: FORMAT,
    cours: courseId,
    empreinte,
    ecrit: new Date().toISOString(),
    extrait: extracted
  }

  const target = fileFor(courseId)
  // Le fichier temporaire porte l'empreinte : deux ecritures concurrentes sur
  // le meme cours — un document remplace pendant qu'on le lisait — ne peuvent
  // pas s'entrelacer dans un fichier que la relecture accepterait ensuite.
  const temporary = `${target}.${empreinte.slice(0, 12)}.tmp`

  try {
    await fs.mkdir(directory(), { recursive: true })
    await fs.writeFile(temporary, `${JSON.stringify(cached)}\n`)
    await fs.rename(temporary, target)
    written.set(courseId, empreinte)
  } catch {
    // Disque plein, dossier en lecture seule : la prochaine ouverture relira le
    // document, comme avant ce cache.
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

/**
 * Suit un cours renomme ou deplace. Le nom du fichier derive de l'identifiant :
 * sans ce deplacement, l'ancien resterait sur le disque sans qu'aucun cours ne
 * le reclame, et le cours deplace serait relu entierement.
 */
export async function renameExtraction(previousId: string, nextId: string): Promise<void> {
  // Un cours qui change de format n'a plus de cache : l'ancien texte ne decrit
  // plus rien de ce qui porte ce nom. Il part plutot que de suivre.
  if (!cacheable(nextId)) {
    await deleteExtraction(previousId)
    return
  }

  const empreinte = written.get(previousId)
  written.delete(previousId)

  try {
    await fs.rename(fileFor(previousId), fileFor(nextId))
    if (empreinte) written.set(nextId, empreinte)
  } catch {
    // Le cours n'avait pas encore ete lu : il n'y a rien a faire suivre.
  }
}

/** Efface le texte garde d'un cours supprime. C'est du cache : rien a conserver. */
export async function deleteExtraction(courseId: string): Promise<void> {
  written.delete(courseId)
  await fs.rm(fileFor(courseId), { force: true })
}
