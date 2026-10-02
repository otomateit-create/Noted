/**
 * Mise a jour automatique du binaire Claude Code.
 *
 * La liste des modeles suit le binaire : un CLI gele, c'est un modele recent
 * absent du selecteur. Le CLI sait se mettre a jour seul, mais uniquement quand
 * on le lance dans un terminal — ce qui n'arrive presque jamais ici. C'est donc
 * Noted qui le fait : `claude update` au lancement, puis toutes les six heures
 * tant que l'application reste ouverte.
 *
 * Tout echec est silencieux : hors ligne, ou npm indisponible, la version
 * installee continue de servir.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { childEnvironment, resolveExecutable } from './provider'
import { resetSupportedModels } from './models'

const run = promisify(execFile)

const INTERVALLE = 6 * 60 * 60 * 1000
const DELAI_MAJ = 5 * 60 * 1000

async function version(executable: string): Promise<string | null> {
  try {
    const { stdout } = await run(executable, ['--version'], { timeout: 15_000, encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return null
  }
}

let enCours = false

async function mettreAJour(): Promise<void> {
  if (enCours) return
  enCours = true
  try {
    const executable = await resolveExecutable()
    if (!executable) return

    const avant = await version(executable)
    // npm est lance par le CLI : il lui faut le PATH complet, pas celui,
    // minimal, d'une application ouverte depuis le Finder.
    await run(executable, ['update'], {
      timeout: DELAI_MAJ,
      env: { ...childEnvironment(), PATH: cheminComplet() }
    })
    const apres = await version(executable)

    // Nouvelle version : la liste des modeles doit etre relue au prochain appel.
    if (avant && apres && avant !== apres) {
      console.log(`[Noted] Claude Code mis a jour : ${avant} -> ${apres}`)
      resetSupportedModels()
    }
  } catch (cause) {
    console.error('[Noted] mise a jour de Claude Code impossible :', cause)
  } finally {
    enCours = false
  }
}

function cheminComplet(): string {
  const existant = process.env['PATH'] ?? ''
  const usuels = ['/opt/homebrew/bin', '/usr/local/bin']
  return [...usuels, existant].filter(Boolean).join(':')
}

export function demarrerMiseAJourClaude(): void {
  void mettreAJour()
  setInterval(() => void mettreAJour(), INTERVALLE).unref()
}
