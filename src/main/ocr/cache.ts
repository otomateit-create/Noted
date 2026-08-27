/**
 * Cache des lectures d'images.
 *
 * Lire une image demande une vingtaine de secondes de calcul soutenu. Or ce
 * calcul ne depend que de deux choses : les pixels de l'image, et le modele qui
 * les regarde. Tant que ni l'un ni l'autre ne bouge, le resultat est le meme —
 * autant l'ecrire une fois.
 *
 * La clef est l'empreinte du contenu de l'image, jamais son chemin ni sa
 * position. Cela rend trois services d'un seul geste :
 *
 *   - la meme capture collee dans deux cours n'est lue qu'une fois ;
 *   - un cours renomme ne fait rien relire ;
 *   - une conversion interrompue reprend ou elle s'etait arretee, sans qu'aucun
 *     code de reprise n'ait a exister. Une page de PDF rendue deux fois a la
 *     meme resolution donne les memes octets, donc la meme empreinte, donc la
 *     lecture deja faite.
 *
 * Un fichier par image plutot qu'un gros index : l'ecriture reste atomique, une
 * fermeture brutale ne peut pas corrompre les lectures precedentes, et le
 * dossier se vide a la main sans ceremonie.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { OcrRead } from '../../shared/types'
import { vaultPaths } from '../vault'

function directory(): string {
  return path.join(vaultPaths().internal, 'ocr', 'images')
}

/**
 * L'empreinte porte deja l'identite du modele — voir `imageFingerprint`. Changer
 * de modele ou de quantisation change donc toutes les clefs, et les anciennes
 * lectures cessent d'etre trouvees sans qu'il faille effacer quoi que ce soit.
 */
function entryPath(fingerprint: string): string {
  return path.join(directory(), `${fingerprint}.json`)
}

/** La lecture deja faite de cette image, ou null si elle n'a jamais ete lue. */
export async function cachedRead(fingerprint: string): Promise<OcrRead | null> {
  try {
    const raw = await fs.readFile(entryPath(fingerprint), 'utf8')
    const parsed = JSON.parse(raw) as Partial<OcrRead>

    if (typeof parsed.markdown !== 'string') return null

    return { markdown: parsed.markdown }
  } catch {
    // Absent, illisible, tronque par une coupure de courant : dans tous les cas
    // il n'y a rien a relire, et l'image sera lue a nouveau.
    return null
  }
}

/**
 * Garde une lecture. Un echec d'ecriture n'est pas rapporte : perdre le cache
 * coute du temps a la prochaine ouverture, jamais un resultat.
 */
export async function keepRead(fingerprint: string, read: OcrRead): Promise<void> {
  try {
    await fs.mkdir(directory(), { recursive: true })

    // Ecriture atomique. Sans elle, une fermeture pendant l'ecriture laisserait
    // un JSON tronque qui serait relu comme une lecture valide et amputee.
    const target = entryPath(fingerprint)
    const temporary = `${target}.tmp`
    await fs.writeFile(temporary, JSON.stringify(read), 'utf8')
    await fs.rename(temporary, target)
  } catch {
    // Sans effet sur le resultat rendu a l'appelant.
  }
}
