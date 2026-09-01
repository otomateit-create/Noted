/**
 * Installation du moteur de lecture d'images.
 *
 * Deux choses a se procurer, et elles n'ont rien a voir l'une avec l'autre :
 * le programme qui execute le modele — llama.cpp, onze megaoctets — et les
 * poids du modele lui-meme, un gigaoctet et demi. Le premier arrive en quelques
 * secondes, le second peut demander une nuit entiere.
 *
 * Pourquoi llama.cpp plutot que MLX : c'est un binaire autonome, verifie ici
 * meme sur le Mac de l'utilisateur — il s'execute, il est signe ad-hoc, et rien
 * dans Gatekeeper ne s'y oppose. MLX aurait impose Python, `uv`, et deux
 * environnements separes a cause d'un conflit de versions de `transformers` :
 * intenable dans une application qu'on installe en double-cliquant.
 *
 * Tout ici est optionnel par construction. Sans moteur, sans poids, ou sans
 * reseau, l'application continue exactement comme avant : les images restent des
 * `[figure]`, et rien ne casse.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { OcrModelStatus } from '../../shared/types'
import { vaultPaths } from '../vault'

/**
 * Version figee de llama.cpp.
 *
 * Figee et non « la derniere » : une version qui bouge toute seule ferait
 * dependre la lecture des cours d'un depot distant qui change chaque jour. Le
 * jour ou l'on montera de version, ce sera un geste deliberé, verifie sur un
 * vrai document.
 */
const LLAMA_BUILD = 'b10453'

/**
 * Identite du modele, telle qu'elle est inscrite dans le cache des lectures.
 *
 * Meme role que `EMBEDDING_MODEL` pour les vecteurs : elle entre dans
 * l'empreinte, et changer de quantisation invalide donc tout ce qui a ete lu
 * avec la precedente. Sans cela, on relirait des resultats calcules par un autre
 * modele en les croyant comparables.
 *
 * **Le suffixe doit bouger a chaque fois que la lecture change**, et pas
 * seulement quand le modele change — c'est le point qui a failli faire passer
 * les correctifs pour inoperants. La clef du cache est l'empreinte des pixels
 * plus cette chaine : relever le plafond de jetons, ajouter la penalite de
 * repetition ou reformater le texte ne touche ni l'une ni l'autre, et tous les
 * cours deja convertis auraient continue de servir leurs anciennes lectures
 * tronquees.
 *
 * `pages200` : pages dessinees a deux cents points par pouce et non plus
 * soixante-douze, regions lues une par une, `max_tokens` a 8 192, penalite de
 * repetition a 1,1, et post-traitement du texte.
 */
export const OCR_MODEL = 'ggml-org/GLM-OCR-GGUF@Q8_0+pages200'

interface Asset {
  /** Nom du fichier une fois installe. */
  name: string
  url: string
  /**
   * Taille attendue, en octets.
   *
   * Elle sert a deux choses : afficher une progression des la premiere seconde,
   * sans attendre la reponse du serveur, et reconnaitre un fichier complet d'un
   * fichier interrompu. Une valeur approchee suffit pour la premiere, pas pour
   * la seconde — d'ou les tailles exactes, relevees sur le depot.
   */
  bytes: number
}

/**
 * L'archive du programme, selon la puce. Les Mac Intel restent servis : rien ne
 * justifie de refuser un document a quelqu'un qui n'a pas la derniere machine.
 */
function runtimeAsset(): Asset {
  const arch = process.arch === 'x64' ? 'x64' : 'arm64'
  const name = `llama-${LLAMA_BUILD}-bin-macos-${arch}.tar.gz`

  return {
    name,
    url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${name}`,
    bytes: 11_100_000
  }
}

const BASE = 'https://huggingface.co/ggml-org/GLM-OCR-GGUF/resolve/main'

/**
 * Le detecteur de mise en page, premier etage de la lecture.
 *
 * GLM-OCR n'est pas fait pour lire une page entiere : son rapport technique
 * decrit une chaine en deux temps — reperer les regions, puis lire chacune avec
 * la tache qui lui convient — et explique pourquoi. Un modele de cette taille
 * « est tres sujet aux hallucinations et a la generation repetitive sur les
 * mises en page complexes ». C'est exactement la panne que `untangle()`
 * rattrape apres coup ; ce fichier la fait disparaitre avant.
 *
 * DocLayout-YOLO plutot que PP-DocLayout-V3, qui est le detecteur officiel de
 * la chaine GLM-OCR : celui-ci vit dans PaddlePaddle, quand celui-la est publie
 * en ONNX, format que l'application sait deja executer — `onnxruntime-node` est
 * embarque depuis le moteur de vecteurs. Ses dix classes couvrent ce dont on a
 * besoin, tableaux et formules isolees comprises.
 *
 * Soixante-quinze megaoctets a cote du gigaoctet et demi deja telecharge : il
 * entre dans la meme liste, la meme barre de progression, la meme reprise.
 */
const LAYOUT: Asset = {
  name: 'mise-en-page.onnx',
  url: 'https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/doclayout_yolo_docstructbench_imgsz1024.onnx',
  bytes: 75_300_000
}

/**
 * Les deux moities du modele.
 *
 * Le decodeur ecrit le texte ; le `mmproj` est l'encodeur visuel, celui qui
 * regarde reellement l'image. C'est lui qui fait la qualite de lecture, et c'est
 * pourquoi il reste en Q8 meme si l'on venait a alleger le decodeur : le depot
 * officiel ne publie d'ailleurs pas d'autre quantisation pour lui.
 */
const WEIGHTS: Asset[] = [
  { name: 'decodeur.gguf', url: `${BASE}/GLM-OCR-Q8_0.gguf`, bytes: 950_000_000 },
  { name: 'vision.gguf', url: `${BASE}/mmproj-GLM-OCR-Q8_0.gguf`, bytes: 484_000_000 },
  LAYOUT
]

function directory(): string {
  return path.join(vaultPaths().internal, 'modeles', 'ocr')
}

/** Le programme, une fois l'archive depliee. */
export function enginePath(): string {
  return path.join(directory(), 'moteur', 'llama-mtmd-cli')
}

/**
 * Le serveur, qui est ce qui execute reellement les lectures.
 *
 * Il sort de la meme archive que `llama-mtmd-cli` — voir `unpack` — et c'est
 * lui qui tient le modele charge entre deux pages. L'outil en ligne de commande
 * reste installe : la documentation de llama.cpp le reserve aux essais, et il
 * rend service pour diagnostiquer a la main.
 */
export function serverPath(): string {
  return path.join(directory(), 'moteur', 'llama-server')
}

function weightPath(asset: Asset): string {
  return path.join(directory(), asset.name)
}

/** Les deux fichiers de poids, tels que le moteur les recoit en ligne de commande. */
export function modelFiles(): { decoder: string; vision: string } {
  return {
    decoder: weightPath(WEIGHTS[0]),
    vision: weightPath(WEIGHTS[1])
  }
}

/** Le detecteur de mise en page, tel que le worker ONNX le recoit. */
export function layoutPath(): string {
  return weightPath(LAYOUT)
}

async function sizeOf(target: string): Promise<number> {
  try {
    return (await fs.stat(target)).size
  } catch {
    return 0
  }
}

/**
 * Un fichier n'est complet que s'il fait au moins la taille annoncee.
 *
 * « Au moins » et non « exactement » : les tailles inscrites plus haut sont
 * relevees a la main et pourraient etre legerement sous-estimees, alors qu'un
 * telechargement interrompu manque toujours de beaucoup. La marge de securite se
 * prend donc du bon cote — un fichier tronque ne peut pas passer pour complet.
 */
async function complete(asset: Asset, target: string): Promise<boolean> {
  return (await sizeOf(target)) >= asset.bytes
}

/** Le moteur et les poids sont-ils tous les deux en place ? */
export async function ocrInstalled(): Promise<boolean> {
  try {
    // Les deux binaires, et non le seul `llama-mtmd-cli` : c'est le serveur qui
    // travaille, et une installation ou il manquerait n'est pas une
    // installation.
    await fs.access(enginePath())
    await fs.access(serverPath())
  } catch {
    return false
  }

  for (const asset of WEIGHTS) {
    if (!(await complete(asset, weightPath(asset)))) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Etat, publie a l'interface
// ---------------------------------------------------------------------------

let status: OcrModelStatus = {
  phase: 'absent',
  received: 0,
  total: 0,
  speed: 0,
  eta: null
}

let announce: (status: OcrModelStatus) => void = () => {}

export function watchOcrModel(handler: (status: OcrModelStatus) => void): void {
  announce = handler
}

/**
 * L'etat de l'installation, apres s'etre assure qu'un moteur deja installe se
 * reconnaisse.
 *
 * Cet etat vit en memoire et repart a « absent » a chaque demarrage : il decrit
 * un telechargement, et il n'y en a pas eu. Sans cette confrontation au disque,
 * un moteur installe hier resterait invisible jusqu'a ce qu'on relance une
 * installation — et la conversion d'un document scanne, qui refuse de demarrer
 * sans moteur, attendrait indefiniment un modele pourtant present.
 */
export async function ocrModelStatus(): Promise<OcrModelStatus> {
  if (status.phase === 'absent' && (await ocrInstalled())) {
    publish({ phase: 'pret', speed: 0, eta: null, reason: undefined })
  }
  return status
}

function publish(patch: Partial<OcrModelStatus>): void {
  status = { ...status, ...patch }
  announce(status)
}

// ---------------------------------------------------------------------------
// Telechargement
// ---------------------------------------------------------------------------

/**
 * Silence tolere avant de considerer la liaison comme perdue.
 *
 * Ce n'est pas une duree maximale de telechargement : un gigaoctet a soixante
 * kilo-octets par seconde demande des heures parfaitement normales. C'est le
 * temps sans le moindre octet recu, ce qui est autre chose — et c'est le seul
 * symptome fiable d'une connexion qui a lache sans le dire.
 */
const STALL = 60 * 1000

/**
 * Pause entre deux tentatives, puis le double, puis le quadruple, jusqu'a une
 * minute. Une liaison qui vient de tomber ne se releve pas dans la seconde, et
 * la harceler ne fait qu'epuiser les tentatives sans qu'aucune ait sa chance.
 */
const FIRST_PAUSE = 3 * 1000
const MAX_PAUSE = 60 * 1000

/**
 * Nombre de reprises avant d'abandonner.
 *
 * Genereux, et volontairement : chaque reprise repart de l'octet ou la
 * precedente s'est arretee, donc insister ne recommence jamais rien. Sur la
 * liaison mesuree ici — soixante kilo-octets par seconde, avec des ruptures du
 * cadrage HTTP/2 au bout de quelques minutes — un gigaoctet demande plusieurs
 * dizaines de reprises et les obtient sans que personne n'ait a s'en occuper.
 */
const ATTEMPTS = 200

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Debit lisse et temps restant, pour que l'affichage ne saute pas a chaque paquet. */
class Rate {
  private marks: { at: number; bytes: number }[] = []

  note(bytes: number): void {
    const at = Date.now()
    this.marks.push({ at, bytes })
    // Une fenetre de trente secondes : assez longue pour absorber les a-coups
    // d'une liaison mediocre, assez courte pour que l'arret se voie vite.
    while (this.marks.length > 1 && at - this.marks[0].at > 30_000) this.marks.shift()
  }

  speed(): number {
    if (this.marks.length < 2) return 0
    const first = this.marks[0]
    const last = this.marks[this.marks.length - 1]
    const seconds = (last.at - first.at) / 1000
    if (seconds <= 0) return 0
    return Math.max(0, (last.bytes - first.bytes) / seconds)
  }
}

/**
 * Recupere un fichier, en reprenant ou l'on s'etait arrete.
 *
 * La reprise n'est pas un raffinement : a ce debit, sans elle, une coupure au
 * bout de vingt minutes rendrait le telechargement impossible a terminer, quel
 * que soit le nombre de tentatives.
 */
async function fetchAsset(
  asset: Asset,
  target: string,
  onBytes: (received: number) => void
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })

  // Le fichier se construit sous un nom provisoire. Sans cela, un fichier a
  // moitie recu porterait deja son nom definitif, et le prochain lancement le
  // prendrait pour un modele installe — le moteur echouerait alors a le lire,
  // sans que rien n'explique pourquoi.
  const partial = `${target}.part`
  let pause = FIRST_PAUSE

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const already = await sizeOf(partial)
    if (already >= asset.bytes) break

    // Une minuterie de silence, et non un delai global : voir STALL.
    const guard = new AbortController()
    let lastSeen = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > STALL) guard.abort()
    }, 5_000)

    try {
      const response = await fetch(asset.url, {
        signal: guard.signal,
        headers: already > 0 ? { Range: `bytes=${already}-` } : {}
      })

      // 206 : le serveur accepte de reprendre. 200 avec une reprise demandee
      // signifie qu'il renvoie le fichier entier — il faut alors repartir de
      // zero, sous peine de coller le debut du fichier a sa propre moitie.
      const resuming = response.status === 206
      if (!response.ok) throw new Error(`Réponse ${response.status} du serveur.`)
      if (!response.body) throw new Error('Réponse vide du serveur.')

      const base = resuming ? already : 0
      if (!resuming && already > 0) await fs.rm(partial, { force: true })

      let received = base
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      source.on('data', (chunk: Buffer) => {
        received += chunk.length
        lastSeen = Date.now()
        onBytes(received)
      })

      await pipeline(source, createWriteStream(partial, { flags: resuming ? 'a' : 'w' }))
    } catch (cause) {
      clearInterval(watchdog)

      // Le dernier essai a le droit de se plaindre ; les precedents non — une
      // coupure au milieu d'un telechargement de plusieurs heures est un
      // incident ordinaire, pas une panne a rapporter.
      if (attempt === ATTEMPTS) {
        throw new Error(
          `${asset.name} : ${cause instanceof Error ? cause.message : String(cause)}`
        )
      }

      await wait(pause)
      pause = Math.min(pause * 2, MAX_PAUSE)
      continue
    }

    clearInterval(watchdog)
    pause = FIRST_PAUSE
  }

  if (!(await complete(asset, partial))) {
    throw new Error(`${asset.name} : fichier incomplet après ${ATTEMPTS} tentatives.`)
  }

  await fs.rename(partial, target)
}

/**
 * Deplie l'archive du programme et ne garde que ce qui sert.
 *
 * `tar` plutot qu'une bibliotheque : macOS en fournit un, l'archive vient d'un
 * depot officiel, et ajouter une dependance native pour depaqueter onze
 * megaoctets une fois dans la vie de l'application serait disproportionne.
 */
async function unpack(archive: string, into: string): Promise<void> {
  await fs.mkdir(into, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/tar', ['xzf', archive, '-C', into], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar a rendu le code ${code}.`))
    )
  })

  // L'archive contient un dossier `llama-b10453/` avec le programme et ses
  // bibliotheques. On remonte son contenu d'un cran, pour que le chemin du
  // programme ne depende pas du numero de version.
  const entries = await fs.readdir(into, { withFileTypes: true })
  const inner = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('llama-'))
  if (!inner) return

  const from = path.join(into, inner.name)
  for (const file of await fs.readdir(from)) {
    await fs.rename(path.join(from, file), path.join(into, file))
  }
  await fs.rm(from, { recursive: true, force: true })
}

/**
 * Vrai pendant qu'une installation est en cours. C'est la promesse qui est
 * retenue, et non un simple drapeau : deux cours ouverts ensemble demanderaient
 * sinon deux fois le meme gigaoctet et demi, en parallele, sur la meme liaison.
 */
let running: Promise<boolean> | null = null

/**
 * Installe ce qui manque. Rend vrai quand tout est en place.
 *
 * L'appel est sans effet et immediat si l'installation est deja faite : c'est
 * lui qu'on appelle avant chaque lecture, sans avoir a se demander ou l'on en
 * est.
 */
export function ensureOcrModel(): Promise<boolean> {
  if (!running) {
    running = install().finally(() => {
      running = null
    })
  }
  return running
}

async function install(): Promise<boolean> {
  if (await ocrInstalled()) {
    publish({ phase: 'pret', speed: 0, eta: null, reason: undefined })
    return true
  }

  const runtime = runtimeAsset()
  const engine = enginePath()

  // Ce qui reste a faire, et lui seul : relancer une installation a moitie
  // achevee ne doit pas retelecharger ce qui est deja la.
  const todo: { asset: Asset; target: string; kind: 'moteur' | 'poids' }[] = []

  let installed = true
  try {
    await fs.access(engine)
  } catch {
    installed = false
  }
  if (!installed) {
    todo.push({
      asset: runtime,
      target: path.join(directory(), runtime.name),
      kind: 'moteur'
    })
  }

  for (const asset of WEIGHTS) {
    if (!(await complete(asset, weightPath(asset)))) {
      todo.push({ asset, target: weightPath(asset), kind: 'poids' })
    }
  }

  if (todo.length === 0) {
    publish({ phase: 'pret', speed: 0, eta: null, reason: undefined })
    return true
  }

  const total = todo.reduce((sum, item) => sum + item.asset.bytes, 0)

  // Ce qui est deja sur le disque compte comme recu : sans cela, reprendre un
  // telechargement a 90 % ferait retomber la barre a zero, et l'utilisateur
  // croirait tout perdu.
  let done = 0
  for (const item of todo) done += await sizeOf(`${item.target}.part`)

  const rate = new Rate()
  publish({ phase: 'telechargement', received: done, total, speed: 0, eta: null })

  let base = done
  const tick = (received: number): void => {
    const overall = base + received
    rate.note(overall)
    const speed = rate.speed()
    publish({
      received: overall,
      total,
      speed,
      eta: speed > 0 ? Math.round((total - overall) / speed) : null
    })
  }

  try {
    for (const item of todo) {
      const already = await sizeOf(`${item.target}.part`)
      base -= already

      await fetchAsset(item.asset, item.target, tick)

      base += item.asset.bytes

      if (item.kind === 'moteur') {
        await unpack(item.target, path.join(directory(), 'moteur'))
        await fs.rm(item.target, { force: true })
        // `tar` preserve deja le mode, mais on ne fait pas dependre le
        // fonctionnement de l'application d'une propriete de l'archive.
        await fs.chmod(enginePath(), 0o755)
        await fs.chmod(serverPath(), 0o755)
      }
    }
  } catch (cause) {
    publish({
      phase: 'echec',
      speed: 0,
      eta: null,
      reason: cause instanceof Error ? cause.message : String(cause)
    })
    return false
  }

  publish({ phase: 'pret', received: total, total, speed: 0, eta: null, reason: undefined })
  return true
}

/**
 * Empreinte d'une image, qui sert de clef au cache des lectures.
 *
 * Sur le contenu et non sur le chemin : la meme capture collee dans deux cours
 * n'est lue qu'une fois, et un document renomme ne fait rien relire.
 */
export function imageFingerprint(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).update(OCR_MODEL).digest('hex').slice(0, 32)
}
