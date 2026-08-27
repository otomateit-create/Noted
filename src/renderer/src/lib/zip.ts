/**
 * Lecture d'une archive ZIP, reduite a ce qu'un fichier Office demande.
 *
 * Un .pptx n'est pas un format : c'est un dossier compresse, dont les fichiers
 * sont du XML. Pour l'ouvrir il faut donc d'abord savoir lire un ZIP — et le
 * navigateur sait deja decompresser (`DecompressionStream`), mais ignore
 * totalement la table des matieres d'une archive. C'est elle qu'on lit ici, et
 * rien d'autre : de quoi retrouver un fichier par son nom et en sortir les
 * octets.
 *
 * **Pourquoi pas une bibliotheque.** Il en faudrait deux — une pour le ZIP, une
 * pour le XML — la ou le renderer possede deja tout : `DecompressionStream` pour
 * l'un, `DOMParser` pour l'autre. Cent lignes ici valent mieux que deux
 * dependances a suivre dans une application qui doit tourner hors ligne pendant
 * des annees.
 *
 * Ce qui n'est pas gere, volontairement : le chiffrement, les archives
 * decoupees en plusieurs fichiers, et le format Zip64 — reserve aux archives de
 * plus de quatre gigaoctets, qu'aucun support de cours n'atteint. Chacun de ces
 * cas s'annonce par une erreur explicite plutot que par des octets aberrants.
 */

/** « PK\5\6 », « PK\1\2 », « PK\3\4 » : les trois signatures qu'on cherche. */
const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50

/** Taille maximale du commentaire final, donc de la zone ou chercher la fin. */
const MAX_COMMENT = 0xffff

/** Valeur qui, dans un champ de taille, signale un renvoi au format Zip64. */
const ZIP64_MARK = 0xffffffff

interface Entry {
  /** Ou commence l'en-tete local, qui precede les octets compresses. */
  offset: number
  /** 0 : tel quel. 8 : deflate. Rien d'autre en pratique. */
  method: number
  compressedSize: number
}

export class ZipArchive {
  private constructor(
    private readonly bytes: Uint8Array,
    private readonly entries: Map<string, Entry>
  ) {}

  /**
   * Lit la table des matieres de l'archive. Rien n'est decompresse ici : ouvrir
   * un cours de quarante megaoctets ne coute qu'un parcours de sa liste de
   * fichiers.
   */
  static open(bytes: Uint8Array): ZipArchive {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const end = findEndOfDirectory(view)

    const count = view.getUint16(end + 10, true)
    let at = view.getUint32(end + 16, true)

    const entries = new Map<string, Entry>()

    for (let index = 0; index < count; index += 1) {
      if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== DIRECTORY_ENTRY) {
        throw new Error('Archive abimee : la liste des fichiers est incomplete.')
      }

      const method = view.getUint16(at + 10, true)
      const compressedSize = view.getUint32(at + 20, true)
      const nameLength = view.getUint16(at + 28, true)
      const extraLength = view.getUint16(at + 30, true)
      const commentLength = view.getUint16(at + 32, true)
      const offset = view.getUint32(at + 42, true)

      if (compressedSize === ZIP64_MARK || offset === ZIP64_MARK) {
        throw new Error('Ce fichier est trop volumineux pour etre ouvert (format Zip64).')
      }

      const name = new TextDecoder().decode(
        bytes.subarray(at + 46, at + 46 + nameLength)
      )
      entries.set(name, { offset, method, compressedSize })

      at += 46 + nameLength + extraLength + commentLength
    }

    return new ZipArchive(bytes, entries)
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  /** Les noms presents, dans l'ordre de la table des matieres. */
  names(): string[] {
    return [...this.entries.keys()]
  }

  /** Les octets d'un fichier de l'archive, ou null s'il n'y est pas. */
  async read(name: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(name)
    if (!entry) return null

    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength
    )

    if (view.getUint32(entry.offset, true) !== LOCAL_HEADER) {
      throw new Error(`Archive abimee : « ${name} » n'est pas la ou elle est annoncee.`)
    }

    // Les longueurs de l'en-tete local ne sont pas celles de la table des
    // matieres : le nom peut y etre ecrit differemment, et le champ « extra »
    // porte souvent un horodatage supplementaire. Ce sont donc celles-ci qui
    // disent ou commencent les octets, et la table qui dit combien il y en a.
    const nameLength = view.getUint16(entry.offset + 26, true)
    const extraLength = view.getUint16(entry.offset + 28, true)
    const start = entry.offset + 30 + nameLength + extraLength
    const raw = this.bytes.subarray(start, start + entry.compressedSize)

    if (entry.method === 0) return raw
    if (entry.method !== 8) {
      throw new Error(`Compression inconnue dans l'archive (methode ${entry.method}).`)
    }

    return inflate(raw)
  }

  /** Le contenu d'un fichier de l'archive en texte, ou null s'il n'y est pas. */
  async text(name: string): Promise<string | null> {
    const bytes = await this.read(name)
    return bytes ? new TextDecoder().decode(bytes) : null
  }
}

/**
 * Remonte depuis la fin jusqu'a la marque de fin de table.
 *
 * Elle est presque toujours sur les vingt-deux derniers octets, mais un
 * commentaire d'archive s'intercale apres elle — d'ou la recherche a reculons
 * plutot qu'une lecture a position fixe.
 */
function findEndOfDirectory(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - MAX_COMMENT - 22)

  for (let at = view.byteLength - 22; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) return at
  }

  throw new Error("Ce fichier n'est pas une archive lisible.")
}

/** Decompresse un bloc deflate brut, par le moteur du navigateur. */
async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))

  return new Uint8Array(await new Response(stream).arrayBuffer())
}
