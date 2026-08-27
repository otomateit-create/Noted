/**
 * Le premier etage de la lecture : ou se trouve quoi sur la page.
 *
 * GLM-OCR n'a jamais ete concu pour regarder une page entiere. Son rapport
 * technique decrit une chaine en deux temps — un detecteur de mise en page
 * decoupe la page en regions, chaque region part ensuite avec la tache qui lui
 * convient — et donne la raison : un modele de cette taille « est tres sujet
 * aux hallucinations et a la generation repetitive sur les mises en page
 * complexes ». C'est mot pour mot la panne que `degenerate()` rattrapait apres
 * coup dans `engine.ts`. Ce fichier la fait disparaitre avant qu'elle arrive.
 *
 * **Un processus Node separe**, pour la meme raison que le calcul des vecteurs,
 * et elle est verifiee : sous Electron, l'inference ONNX ne rend jamais la
 * main. Voir `rag/embed-worker.cjs`, qui porte le constat.
 *
 * Mesures faites ici, sur les captures d'ecran du Mac, modele charge :
 *
 *   - **1,8 s par page** a deux fils (1,0 s a quatre, 3,4 s a un seul) ;
 *   - chargement du modele **0,5 s**, ce qui est peu au regard de la page ;
 *   - **586 Mo** au plus fort. C'est ce chiffre qui commande la minuterie
 *     ci-dessous : garder cela pendant les vingt secondes de reconnaissance
 *     ferait tenir deux gros modeles a la fois sur une machine de huit
 *     gigaoctets, alors que le detecteur n'a plus rien a y faire.
 *
 * Tout ici est optionnel : sans detecteur, sans Node, ou sur une image qui ne
 * se laisse pas analyser, on rend `null` et la lecture repart sur la page
 * entiere, exactement comme avant.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { layoutPath } from './model'

/** Une region de la page, en pixels de l'image d'origine. */
export interface Region {
  /** Classe rendue par le detecteur : `table`, `plain text`, `abandon`… */
  label: string
  score: number
  left: number
  top: number
  width: number
  height: number
}

export interface PageLayout {
  width: number
  height: number
  regions: Region[]
}

/**
 * Ou chercher un vrai Node. La meme liste que pour les vecteurs : c'est la
 * meme contrainte, et deux listes qui divergent seraient un piege.
 */
const NODE_CANDIDATES = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']

/**
 * Silence apres lequel le detecteur rend sa memoire.
 *
 * Quinze secondes, et c'est court exprès. Une page se detecte en deux
 * secondes puis se lit en quinze a vingt-cinq : la minuterie tombe donc
 * pendant la lecture, et les 586 Mo repartent au systeme au moment precis ou
 * le `llama-server` en reclame 1 370. Les reprendre a la page suivante coute
 * une demi-seconde, ce qui est le bon cote du marche.
 */
const IDLE_TIMEOUT = 15 * 1000

/**
 * Delai maximal d'une detection.
 *
 * Il couvre le chargement du modele au premier appel. Une page qui le depasse
 * n'est pas perdue : elle sera lue en entier, comme avant ce fichier.
 */
const TIMEOUT = 60 * 1000

let child: ChildProcessWithoutNullStreams | null = null
let idleTimer: NodeJS.Timeout | null = null
let nextId = 1

interface Pending {
  resolve: (layout: PageLayout | null) => void
  timer: NodeJS.Timeout
}

const pending = new Map<number, Pending>()

function workerPath(): string {
  // Le fichier est copie a cote du bundle du processus principal. Une fois
  // l'application packagee, ce bundle vit dans une archive asar que seul
  // Electron sait ouvrir : le detecteur tourne sous un node ordinaire, il lui
  // faut la copie laissee en clair a cote.
  return path
    .join(__dirname, 'layout-worker.cjs')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

function keepAlive(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (pending.size === 0) disposeLayout()
  }, IDLE_TIMEOUT)
}

/** Coupe court a tout ce qui attend, quand le processus disparait. */
function abandon(): void {
  for (const [, waiting] of pending) {
    clearTimeout(waiting.timer)
    waiting.resolve(null)
  }
  pending.clear()
}

function start(): ChildProcessWithoutNullStreams | null {
  // Un processus mort dont l'evenement de sortie n'est pas encore arrive reste
  // reference ici. Lui ecrire ne menerait nulle part.
  if (child && (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed)) {
    child = null
  }
  if (child) return child

  const node = NODE_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!node || !existsSync(workerPath())) return null

  const spawned = spawn(node, [workerPath()], { stdio: ['pipe', 'pipe', 'pipe'] })

  // Le tube d'erreur fait soixante-quatre kilo-octets et le moteur ONNX y
  // ecrit ses avertissements de chargement. Sans cette purge, le worker se
  // bloquerait en ecriture le jour ou il le remplit.
  spawned.stderr.resume()

  readline.createInterface({ input: spawned.stdout }).on('line', (line) => {
    // Un processus deja remplace continue de parler le temps de mourir : ce
    // qu'il raconte ne concerne plus personne.
    if (child !== spawned) return

    let message: { id?: number; error?: string; width?: number; height?: number; regions?: Region[] }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined
    if (!waiting) return

    pending.delete(message.id as number)
    clearTimeout(waiting.timer)

    if (message.error || !Array.isArray(message.regions)) {
      waiting.resolve(null)
      return
    }

    waiting.resolve({
      width: message.width ?? 0,
      height: message.height ?? 0,
      regions: message.regions
    })

    keepAlive()
  })

  const die = (): void => {
    if (child === spawned) child = null
    abandon()
  }
  spawned.on('exit', die)
  spawned.on('error', die)
  spawned.stdin.on('error', die)

  child = spawned
  return spawned
}

/**
 * Les regions d'une page. Rend `null` des que quoi que ce soit manque — c'est
 * la promesse de ce module, et c'est elle qui permet a l'appelant de repartir
 * sur la page entiere sans avoir a distinguer les causes.
 */
export function detectRegions(png: Buffer): Promise<PageLayout | null> {
  const model = layoutPath()
  if (!existsSync(model)) return Promise.resolve(null)

  const worker = start()
  if (!worker) return Promise.resolve(null)

  const id = nextId
  nextId += 1

  return new Promise<PageLayout | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, TIMEOUT)

    pending.set(id, { resolve, timer })
    keepAlive()

    try {
      worker.stdin.write(`${JSON.stringify({ id, model, png: png.toString('base64') })}\n`)
    } catch {
      pending.delete(id)
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/** Eteint le detecteur et rend ses 586 Mo. Sans effet s'il ne tourne pas. */
export function disposeLayout(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  const dying = child
  child = null
  dying?.kill()
  abandon()
}
