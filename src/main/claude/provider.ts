/**
 * Resolution du binaire Claude Code et de l'authentification.
 *
 * Tout ce qui touche a « comment on parle a Claude » est isole ici. Si un jour
 * l'application doit passer sur une cle API plutot que sur l'abonnement, c'est
 * le seul fichier a reecrire.
 */

import { execFile } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AuthMode, ClaudeStatus } from '../../shared/types'

const run = promisify(execFile)

/**
 * Emplacements habituels du binaire claude. Une application lancee depuis le
 * Finder herite d'un PATH minimal (/usr/bin:/bin:/usr/sbin:/sbin) qui ne
 * contient aucun de ces dossiers : sans cette recherche explicite, l'app
 * marche en developpement et echoue une fois packagee.
 */
function candidatePaths(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Dernier recours : demander son PATH a un shell de login. Plus lent qu'une
 * simple lecture de fichier, mais c'est la seule facon de trouver une
 * installation dans un dossier non conventionnel.
 */
async function findViaLoginShell(): Promise<string | null> {
  const shell = process.env['SHELL'] ?? '/bin/zsh'
  try {
    const { stdout } = await run(shell, ['-lic', 'command -v claude'], {
      timeout: 5000,
      encoding: 'utf8'
    })
    const resolved = stdout.trim().split('\n').pop()?.trim()
    return resolved && resolved.startsWith('/') ? resolved : null
  } catch {
    return null
  }
}

let cachedExecutable: string | null | undefined

/** Chemin absolu du binaire claude, ou null s'il est introuvable. */
export async function resolveExecutable(): Promise<string | null> {
  if (cachedExecutable !== undefined) return cachedExecutable

  for (const candidate of candidatePaths()) {
    if (await isExecutable(candidate)) {
      cachedExecutable = candidate
      return candidate
    }
  }

  cachedExecutable = await findViaLoginShell()
  return cachedExecutable
}

/**
 * Environnement transmis au sous-processus Claude Code.
 *
 * ANTHROPIC_API_KEY est retire volontairement : s'il est present, il prend le
 * pas sur les identifiants de l'abonnement et la consommation part sur la
 * facturation a l'usage — exactement ce qu'on veut eviter ici.
 */
export function childEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env }
  delete environment['ANTHROPIC_API_KEY']
  delete environment['ANTHROPIC_AUTH_TOKEN']

  // Identifie l'application aupres du SDK, utile au debogage cote Anthropic.
  environment['CLAUDE_AGENT_SDK_CLIENT_APP'] = 'noted/0.1.0'
  return environment
}

export function authMode(): AuthMode {
  return process.env['ANTHROPIC_API_KEY'] ? 'api-key' : 'subscription'
}

/**
 * Etat de la connexion a Claude, tel qu'affiche dans l'interface.
 *
 * On ne lance volontairement aucune requete de test : verifier l'authentification
 * couterait des tokens a chaque demarrage. On controle ce qui est verifiable
 * sans effet de bord, et une eventuelle erreur d'authentification remontera
 * avec un message clair au premier message envoye.
 */
export async function claudeStatus(): Promise<ClaudeStatus> {
  const executablePath = await resolveExecutable()

  if (!executablePath) {
    return {
      ready: false,
      mode: authMode(),
      executablePath: null,
      detail:
        "Claude Code est introuvable. Installe-le avec « npm install -g @anthropic-ai/claude-code », puis relance Noted."
    }
  }

  const configDirectory = path.join(os.homedir(), '.claude')
  const configured = await fs
    .access(configDirectory)
    .then(() => true)
    .catch(() => false)

  if (!configured) {
    return {
      ready: false,
      mode: authMode(),
      executablePath,
      detail:
        "Claude Code n'a jamais été lancé. Ouvre un terminal, tape « claude », connecte-toi avec ton abonnement, puis relance Noted."
    }
  }

  if (authMode() === 'api-key') {
    return {
      ready: true,
      mode: 'api-key',
      executablePath,
      detail:
        'ANTHROPIC_API_KEY est définie dans ton environnement. Noted l\'ignore et utilise ton abonnement.'
    }
  }

  return {
    ready: true,
    mode: 'subscription',
    executablePath,
    detail: 'Connecté via ton abonnement Claude.'
  }
}
