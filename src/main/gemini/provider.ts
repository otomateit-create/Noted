/**
 * Resolution du binaire Antigravity CLI (agy) et de sa configuration.
 *
 * L'acces aux modeles Gemini passe exclusivement par ce binaire officiel,
 * invoque en sous-processus : c'est lui qui porte l'authentification du compte
 * Google. Regle absolue : on ne lit, n'extrait ni ne transmet jamais son jeton
 * OAuth, et on n'appelle jamais directement le service qui est derriere. On
 * lance le binaire, on lui parle par arguments et flux standard, rien d'autre —
 * c'est la ligne que Google trace entre l'usage tolere et le bannissement.
 *
 * Pourquoi agy et non le CLI gemini : depuis le 18 juin 2026, Google ne sert
 * plus le CLI gemini aux comptes individuels (gratuits, Google One, AI Pro et
 * Ultra confondus — IneligibleTierError, verifie ici meme) et designe la suite
 * Antigravity comme successeur. agy est son CLI officiel : headless (--print),
 * sortie JSON, serveurs MCP (agy mcp add), permissions par outil.
 *
 * La configuration vit dans .noted/gemini.json, comme celle d'OpenRouter :
 * hors du code, modifiable sans reconstruire l'application. Fichier absent,
 * la route est active avec ses valeurs par defaut — c'est l'absence du
 * binaire, etat normal, qui la coupe en silence.
 *
 *     { "actif": true, "modele": "gemini-3.7-flash-high", "binaire": null }
 *
 * « modele » est un identifiant de « agy models » — l'effort de raisonnement
 * y est encode (suffixe -high/-medium/-low). « binaire » force un chemin quand
 * l'installation est ailleurs — et sert de prise pour eprouver le repli : le
 * pointer sur un faux binaire suffit.
 */

import { execFile } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { vaultPaths } from '../vault'

const run = promisify(execFile)

/**
 * Le modele demande quand le fichier n'en dit pas d'autre : le choix de
 * Raphael — Gemini 3.7 Flash avec l'effort de raisonnement au maximum.
 */
const DEFAULT_MODEL = 'gemini-3.7-flash-high'

export interface GeminiSetup {
  /** Chemin absolu du binaire agy. */
  executable: string
  /** Le modele a demander, tel que « agy models » le nomme. */
  model: string
}

/** Emplacement du fichier de configuration, dans le dossier interne du vault. */
export function configPath(): string {
  return path.join(vaultPaths().internal, 'gemini.json')
}

interface GeminiConfig {
  actif: boolean
  modele: string
  binaire: string | null
}

async function readConfig(): Promise<GeminiConfig> {
  let raw: string
  try {
    raw = await fs.readFile(configPath(), 'utf8')
  } catch {
    // Pas de fichier : la route vit avec ses valeurs par defaut.
    return { actif: true, modele: DEFAULT_MODEL, binaire: null }
  }

  let parsed: { actif?: unknown; modele?: unknown; binaire?: unknown }
  try {
    parsed = JSON.parse(raw) as { actif?: unknown; modele?: unknown; binaire?: unknown }
  } catch {
    // Le fichier a ete pose a la main : un JSON casse merite d'etre dit, et la
    // route se coupe plutot que de tourner sur des valeurs devinees.
    console.warn('[gemini] fichier illisible, route ignoree :', configPath())
    return { actif: false, modele: DEFAULT_MODEL, binaire: null }
  }

  return {
    actif: parsed.actif !== false,
    modele:
      typeof parsed.modele === 'string' && parsed.modele.trim()
        ? parsed.modele.trim()
        : DEFAULT_MODEL,
    binaire:
      typeof parsed.binaire === 'string' && parsed.binaire.trim() ? parsed.binaire.trim() : null
  }
}

/**
 * Emplacements habituels du binaire agy — memes raisons que pour claude :
 * une application lancee depuis le Finder herite d'un PATH minimal qui ne
 * contient aucun de ces dossiers. Le cask Homebrew lie « agy » dans son
 * prefixe ; les autres candidats couvrent les installations manuelles.
 */
function candidatePaths(): string[] {
  const home = os.homedir()
  return [
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    path.join(home, '.local', 'bin', 'agy')
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

async function findViaLoginShell(): Promise<string | null> {
  const shell = process.env['SHELL'] ?? '/bin/zsh'
  try {
    const { stdout } = await run(shell, ['-lic', 'command -v agy'], {
      timeout: 5000,
      encoding: 'utf8'
    })
    const resolved = stdout.trim().split('\n').pop()?.trim()
    return resolved && resolved.startsWith('/') ? resolved : null
  } catch {
    return null
  }
}

/**
 * Seule la trouvaille est memorisee : une absence se reverifie a chaque
 * fournee, pour qu'une installation faite en cours de session soit vue sans
 * redemarrer l'application. Le cout — quelques acces disque, au pire un shell
 * de login — est celui d'une tache de fond occasionnelle.
 */
let cachedExecutable: string | null = null

async function resolveGemini(explicit: string | null): Promise<string | null> {
  if (explicit) {
    if (await isExecutable(explicit)) return explicit
    console.warn('[gemini] binaire configure introuvable :', explicit)
    return null
  }

  if (cachedExecutable && (await isExecutable(cachedExecutable))) return cachedExecutable

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
 * La route Gemini si elle est utilisable : configuration active et binaire
 * present. Null sinon — binaire absent compris, qui est un etat normal et ne
 * merite aucun bruit : l'appelant passe simplement a la route suivante.
 */
export async function geminiRoute(): Promise<GeminiSetup | null> {
  const config = await readConfig()
  if (!config.actif) return null

  const executable = await resolveGemini(config.binaire)
  if (!executable) return null

  return { executable, model: config.modele }
}

/**
 * Environnement transmis au sous-processus agy.
 *
 * Les cles API sont retirees volontairement : agy sait aussi parler a l'API
 * Gemini par cle (« modelProvider »), et une cle qui traine dans le shell ne
 * doit jamais pouvoir detourner la generation vers la facturation a l'usage.
 * Tout passe par le compte connecte dans le CLI. Le PATH est complete pour
 * une application lancee depuis le Finder, qui n'herite que du minimum.
 */
export function geminiEnvironment(executable: string): Record<string, string | undefined> {
  const environment = { ...process.env }
  delete environment['GEMINI_API_KEY']
  delete environment['GOOGLE_API_KEY']
  delete environment['GOOGLE_APPLICATION_CREDENTIALS']
  environment['PATH'] = [
    path.dirname(executable),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env['PATH']
  ]
    .filter(Boolean)
    .join(':')
  return environment
}
