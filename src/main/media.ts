/**
 * Les images des documents, sorties du document et posees sur le disque.
 *
 * **Pourquoi ce detour.** Un .docx de cours porte ses images a l'interieur. Le
 * convertisseur, laisse a lui-meme, les rend en base64 dans le HTML : un cours
 * d'intelligence artificielle de dix-neuf megaoctets, dont vingt d'images,
 * produisait ainsi vingt-sept megaoctets de texte a serialiser, a faire passer
 * d'un processus a l'autre, a analyser puis a nettoyer — le tout avant qu'un
 * seul pixel n'atteigne l'ecran. C'est la cause des quelques secondes d'attente
 * constatees a l'ouverture de ce cours-la.
 *
 * Ecrites sur le disque, les images ne traversent plus rien : le HTML ne porte
 * qu'une adresse de quelques dizaines de caracteres, l'affichage est immediat,
 * et le navigateur va chercher chaque image quand il en a besoin.
 *
 * Le second benefice n'est pas moindre : la lecture par OCR a besoin de fichiers
 * d'images, precisement. Elles sont desormais la, nommees par leur empreinte,
 * donc partageables entre deux cours qui contiendraient la meme capture et
 * reconnaissables d'une ouverture a l'autre sans rien relire.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { net, protocol } from 'electron'
import { vaultPaths } from './vault'

/**
 * Le protocole sous lequel le renderer atteint ces images.
 *
 * Un schema a nous plutot que `file://` : le renderer n'a alors aucun moyen de
 * demander un fichier quelconque du disque, et la politique de securite de la
 * page peut n'ouvrir que celui-la.
 */
export const MEDIA_SCHEME = 'noted-media'

function directory(): string {
  return path.join(vaultPaths().internal, 'media')
}

/** Extensions servies, et le type que le renderer recevra. */
const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.emf': 'image/emf',
  '.wmf': 'image/wmf'
}

function extensionFor(contentType: string): string {
  const known = Object.entries(TYPES).find(([, type]) => type === contentType)
  return known ? known[0] : '.png'
}

/**
 * Ecrit une image et rend son nom.
 *
 * Le nom est l'empreinte du contenu : la meme capture collee dans deux cours
 * n'occupe le disque qu'une fois, et une ecriture deja faite ne se refait pas.
 */
export async function keepImage(bytes: Buffer, contentType: string): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  const name = `${digest}${extensionFor(contentType)}`
  const target = path.join(directory(), name)

  await fs.mkdir(directory(), { recursive: true })

  try {
    await fs.access(target)
  } catch {
    // Ecriture atomique : une fermeture pendant l'ecriture laisserait sinon une
    // image tronquee sous un nom qui promet le contraire, et elle serait relue
    // comme valide pour toujours — l'empreinte, elle, ne serait pas recalculee.
    const temporary = `${target}.tmp`
    await fs.writeFile(temporary, bytes)
    await fs.rename(temporary, target)
  }

  return name
}

/** Chemin absolu d'une image gardee, ou null si le nom ne designe rien de sain. */
export function mediaPath(name: string): string | null {
  // Le nom vient d'un attribut de document, donc d'une source qu'on ne controle
  // pas entierement. On n'accepte que la forme exacte qu'on produit soi-meme.
  if (!/^[a-f0-9]{32}\.[a-z]{3,4}$/.test(name)) return null
  return path.join(directory(), name)
}

/** Octets d'une image gardee, pour la lecture par OCR. */
export async function readMedia(name: string): Promise<Buffer | null> {
  const target = mediaPath(name)
  if (!target) return null

  try {
    return await fs.readFile(target)
  } catch {
    return null
  }
}

/**
 * Declare le schema avant que l'application ne soit prete.
 *
 * Cet appel doit precede `app.whenReady`, faute de quoi le schema n'est pas
 * enregistre a temps et toutes les images restent vides — sans erreur visible.
 */
export function declareMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        // Traite comme une origine ordinaire : le navigateur peut mettre les
        // images en cache et les charger paresseusement, ce qui est tout
        // l'interet de l'operation.
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false
      }
    }
  ])
}

/** Branche le service des images. A appeler une fois l'application prete. */
export function serveMedia(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    // « noted-media://abc123.png » — l'hote porte le nom, le chemin est vide.
    const name = decodeURIComponent(new URL(request.url).hostname)
    const target = mediaPath(name)

    if (!target) return new Response('Nom d’image invalide', { status: 400 })

    const response = await net.fetch(`file://${target}`)
    if (!response.ok) return new Response('Image introuvable', { status: 404 })

    return new Response(response.body, {
      headers: {
        'Content-Type': TYPES[path.extname(name)] ?? 'application/octet-stream',
        // Le contenu ne change jamais : le nom est son empreinte.
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    })
  })
}
