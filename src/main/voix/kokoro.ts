/**
 * Le moteur de voix, vu du processus principal.
 *
 * Il tient un processus Node separe (kokoro-worker.cjs) qui porte le modele,
 * et surtout il decide quand ce processus vit. Deux regles, et elles ne disent
 * pas la meme chose :
 *
 * - il est reveille a l'entree du mode voix, pour que la premiere question ne
 *   paie pas le chargement ;
 * - il s'endort apres une minute sans avoir eu a parler, **meme si le mode
 *   voix reste ouvert**. Un demi-gigaoctet qui dort pendant qu'on lit ses
 *   notes, c'est une machine de huit qui part en memoire virtuelle ; et une
 *   minute suffit a couvrir le temps de reflexion entre deux questions, qui
 *   est le seul moment ou le rechargement se verrait.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { VoixDisponible } from '../../shared/types'

/** Node ordinaire : l'inference ONNX ne rend jamais la main sous Electron. */
const NODE_CANDIDATES = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']

/** Le silence au bout duquel le modele rend sa memoire. */
const INACTIVITE_MS = 60 * 1000
/** Chargement du modele, telechargement compris au premier lancement. */
const CHAUFFE_MS = 10 * 60 * 1000
/** Une phrase ordinaire se calcule en deux secondes ; au-dela, quelque chose ne va pas. */
const SYNTHESE_MS = 60 * 1000

/** La voix francaise de Kokoro. Les autres timbres lisent le francais aussi. */
export const VOIX_PAR_DEFAUT = 'ff_siwis'

/**
 * Les timbres proposes.
 *
 * Dans Kokoro, le timbre et la langue sont deux choses separees : le timbre
 * est un vecteur de deux cent cinquante-six nombres, les phonemes viennent
 * d'ailleurs. Une voix entrainee sur de l'anglais lit donc le francais sans
 * difficulte — avec une couleur d'accent. Siwis est la seule voix francaise ;
 * les autres sont la pour qui la trouve trop plate. La note est celle du
 * modele, de A a D.
 */
export const VOIX: VoixDisponible[] = [
  { id: 'ff_siwis', nom: 'Siwis — française', langue: 'fr-FR', qualite: 2 },
  { id: 'af_heart', nom: 'Heart', langue: 'en-US', qualite: 3 },
  { id: 'af_bella', nom: 'Bella', langue: 'en-US', qualite: 3 },
  { id: 'bf_emma', nom: 'Emma', langue: 'en-GB', qualite: 2 },
  { id: 'af_nicole', nom: 'Nicole', langue: 'en-US', qualite: 2 },
  { id: 'am_michael', nom: 'Michael', langue: 'en-US', qualite: 2 },
  { id: 'bm_fable', nom: 'Fable', langue: 'en-GB', qualite: 2 },
  { id: 'am_puck', nom: 'Puck', langue: 'en-US', qualite: 2 }
]

export interface Jalon {
  /** Ou commence le mot dans le texte donne a dire. */
  position: number
  longueur: number
  /** Quand il se prononce, en millisecondes depuis le debut de l'audio. */
  quand: number
}

export interface Parole {
  chemin: string
  duree: number
  jalons: Jalon[]
}

interface Attente {
  resolve: (reponse: Record<string, unknown>) => void
  reject: (erreur: Error) => void
  minuteur: NodeJS.Timeout
}

let processus: ChildProcessWithoutNullStreams | null = null
let dossier: string | null = null
let inactivite: NodeJS.Timeout | null = null
let compteur = 0
const attentes = new Map<string, Attente>()

function node(): string | null {
  return NODE_CANDIDATES.find((chemin) => existsSync(chemin)) ?? null
}

function cheminWorker(): string {
  // Copie a cote du bundle du processus principal, et laissee en clair hors de
  // l'archive asar : ce worker tourne sous un node ordinaire, qui ne sait pas
  // l'ouvrir.
  return path
    .join(__dirname, 'kokoro-worker.cjs')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

/** Repousse l'echeance : on vient de parler, le modele reste encore un moment. */
function repousser(): void {
  if (inactivite) clearTimeout(inactivite)
  inactivite = setTimeout(() => {
    inactivite = null
    if (attentes.size > 0) {
      repousser()
      return
    }
    endormir()
  }, INACTIVITE_MS)
}

function lancer(): ChildProcessWithoutNullStreams {
  if (processus && processus.exitCode === null && !processus.stdin.destroyed) return processus

  const binaire = node()
  if (!binaire) throw new Error(`Node introuvable (cherche dans ${NODE_CANDIDATES.join(', ')}).`)
  const worker = cheminWorker()
  if (!existsSync(worker)) throw new Error(`Moteur de voix introuvable : ${worker}`)

  dossier = mkdtempSync(path.join(os.tmpdir(), 'noted-voix-'))
  const lance = spawn(binaire, [worker], { stdio: ['pipe', 'pipe', 'pipe'] })
  processus = lance

  // Le moteur ONNX est bavard sur sa sortie d'erreur ; personne ne la lit, et
  // un tube plein bloquerait le processus pour de bon.
  lance.stderr.resume()

  readline.createInterface({ input: lance.stdout }).on('line', (ligne) => {
    if (processus !== lance) return
    let reponse: Record<string, unknown>
    try {
      reponse = JSON.parse(ligne) as Record<string, unknown>
    } catch {
      return
    }
    const attente = attentes.get(String(reponse.id))
    if (!attente) return
    attentes.delete(String(reponse.id))
    clearTimeout(attente.minuteur)
    if (typeof reponse.erreur === 'string') attente.reject(new Error(reponse.erreur))
    else attente.resolve(reponse)
  })

  const partir = (raison: string): void => {
    if (processus !== lance) return
    processus = null
    for (const [, attente] of attentes) {
      clearTimeout(attente.minuteur)
      attente.reject(new Error(raison))
    }
    attentes.clear()
  }
  lance.on('error', (cause) => partir(`Le moteur de voix n'a pas pu démarrer : ${cause.message}`))
  lance.on('exit', () => partir("Le moteur de voix s'est arrêté."))

  return lance
}

function demander(
  requete: Record<string, unknown>,
  id: string,
  delai: number
): Promise<Record<string, unknown>> {
  const lance = lancer()
  repousser()
  return new Promise((resolve, reject) => {
    const minuteur = setTimeout(() => {
      attentes.delete(id)
      reject(new Error('Le moteur de voix ne répond plus.'))
    }, delai)
    attentes.set(id, { resolve, reject, minuteur })
    // Le dossier n'est ajoute qu'ici : il nait avec le processus, et une
    // requete preparee avant le reveil l'aurait lu encore vide.
    lance.stdin.write(`${JSON.stringify({ ...requete, id, dossier })}\n`)
  })
}

/** Charge le modele sans rien dire, pour que la premiere phrase parte vite. */
export async function reveiller(voix: string): Promise<void> {
  await demander({ cmd: 'chauffer', voix }, 'chauffe', CHAUFFE_MS)
}

/** Le texte, dit : un fichier audio et l'instant de chacun de ses mots. */
export async function synthetiser(texte: string, voix: string, vitesse: number): Promise<Parole | null> {
  compteur += 1
  const id = `p${compteur}`
  const reponse = await demander({ cmd: 'dire', texte, voix, vitesse }, id, SYNTHESE_MS)
  if (reponse.vide) return null
  return {
    chemin: String(reponse.chemin),
    duree: Number(reponse.duree),
    jalons: (reponse.jalons ?? []) as Jalon[]
  }
}

/** Rend la memoire tout de suite : sortie du mode voix, ou fermeture. */
export function endormir(): void {
  if (inactivite) clearTimeout(inactivite)
  inactivite = null
  const lance = processus
  processus = null
  for (const [, attente] of attentes) {
    clearTimeout(attente.minuteur)
    attente.reject(new Error('Le moteur de voix a été arrêté.'))
  }
  attentes.clear()
  if (lance) {
    try {
      lance.stdin.write(`${JSON.stringify({ cmd: 'quitter' })}\n`)
      lance.stdin.end()
    } catch {
      // Deja parti.
    }
    const coup = setTimeout(() => {
      if (lance.exitCode === null) lance.kill('SIGKILL')
    }, 500)
    coup.unref()
  }
  if (dossier) {
    rmSync(dossier, { recursive: true, force: true })
    dossier = null
  }
}
