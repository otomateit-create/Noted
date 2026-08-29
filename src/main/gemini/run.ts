/**
 * Une invocation headless du CLI Antigravity (agy), outillee par MCP.
 *
 * Chaque appel travaille dans un atelier stable du vault (.noted/atelier-
 * gemini) : agy range ses sessions par dossier de travail, et un dossier
 * jetable par fournee gonflerait sa liste de projets pour rien.
 *
 * Le serveur d'outils s'enregistre par « agy mcp add », et se retire par
 * « agy mcp remove » a la fin de la fournee — « add » ecrase l'entree
 * precedente, une fournee interrompue laisse donc au pire une adresse morte
 * que la suivante repare. La configuration MCP de workspace
 * (.agents/mcp_config.json), pourtant documentee, n'est pas lue par les
 * sessions headless de la 1.1.22 — verifie : outils invisibles, meme dossier
 * de confiance — d'ou le passage par la configuration globale.
 *
 * Les permissions sont ciblees, jamais contournees : agy refuse en silence
 * tout outil non approuve en headless, et l'approbation se donne par des
 * regles « mcp(serveur/outil) » dans son fichier de reglages global. On y
 * inscrit nos trois outils, rien d'autre — pas de --dangerously-skip-
 * permissions, qui ouvrirait aussi le shell et l'ecriture de fichiers.
 *
 * La consigne du generateur ne remplace pas le prompt systeme d'agy — le CLI
 * n'offre aucun equivalent de GEMINI_SYSTEM_MD — : elle ouvre le message,
 * au-dessus des surlignages. Deterministe, la ou le mecanisme d'agents
 * personnalises (--agent) retombe sans bruit sur l'agent par defaut quand la
 * definition ne se charge pas — et la consigne serait perdue sans erreur.
 *
 * Le resultat qui compte n'est pas la reponse texte : ce sont les appels
 * creer_carte, qui s'executent dans notre processus au fil de la session et
 * remplissent le tableau de brouillons de l'appelant. La sortie JSON ne sert
 * qu'a distinguer une session terminee (status SUCCESS) d'une session
 * interrompue — la meme distinction que fait la route Claude, et qui decide
 * si les surlignages sans carte sont consommes ou representes.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { vaultPaths } from '../vault'
import { serveTools } from './mcp'
import type { ServedTool } from './mcp'
import { geminiEnvironment } from './provider'

const run = promisify(execFile)

/** La reponse et ses statistiques tiennent large en deca. */
const MAX_OUTPUT = 32 * 1024 * 1024

/** Le nom sous lequel agy connait notre serveur — celui des regles d'approbation. */
const SERVER_NAME = 'noted'

/** Les regles d'approbation, une par outil servi : rien de plus n'est ouvert. */
const ALLOW_RULES = [
  `mcp(${SERVER_NAME}/creer_carte)`,
  `mcp(${SERVER_NAME}/rechercher)`,
  `mcp(${SERVER_NAME}/lire)`
]

export interface GeminiRunInput {
  executable: string
  model: string
  systemPrompt: string
  prompt: string
  tools: ServedTool[]
  /** Au-dela, le processus est tue — la file ne reste jamais bloquee. */
  timeout: number
}

/** Ce que l'appel rapporte : son echec eventuel. Les cartes sont deja chez l'appelant. */
export interface GeminiRunResult {
  failure: unknown
}

/** Ce qu'ecrit --output-format json, lu sans lui faire confiance. */
interface HeadlessOutput {
  status?: unknown
  response?: unknown
  error?: unknown
}

function parseOutput(stdout: string): HeadlessOutput | null {
  const text = stdout.trim()
  const attempts = [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const candidate of attempts) {
    if (!candidate.startsWith('{')) continue
    try {
      return JSON.parse(candidate) as HeadlessOutput
    } catch {
      // Essai suivant.
    }
  }
  return null
}

/**
 * La derniere ligne parlante de stderr, sans ses codes de couleur, pour dire
 * un echec sans le noyer.
 */
function lastLine(stderr: string): string {
  return (
    stderr
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line !== '{' && line !== '}')
      .pop() ?? ''
  )
}

/**
 * Inscrit nos regles d'approbation dans les reglages globaux d'agy
 * (~/.gemini/antigravity-cli/settings.json), sans toucher au reste du
 * fichier : il appartient a l'utilisateur, on n'y ajoute que ce qui manque.
 * Idempotent — le cout d'une relecture par fournee est nul devant celui
 * d'une fournee entiere refusee en silence.
 */
async function ensureAllowRules(): Promise<void> {
  const file = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json')
  let settings: { permissions?: { allow?: unknown } } = {}
  try {
    settings = JSON.parse(await fs.readFile(file, 'utf8')) as typeof settings
  } catch {
    // Fichier absent ou illisible : on repart d'un objet vide — agy sait
    // preserver les champs qu'il ne connait pas, nous aussi.
  }

  const current = Array.isArray(settings.permissions?.allow)
    ? settings.permissions.allow.filter((entry): entry is string => typeof entry === 'string')
    : []
  const missing = ALLOW_RULES.filter((rule) => !current.includes(rule))
  if (missing.length === 0) return

  settings.permissions = { ...settings.permissions, allow: [...current, ...missing] }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(settings, null, 2), 'utf8')
}

/** L'atelier : le dossier de travail stable des fournees. */
async function prepareWorkshop(): Promise<string> {
  const workshop = path.join(vaultPaths().internal, 'atelier-gemini')
  await fs.mkdir(workshop, { recursive: true })
  return workshop
}

/** Enregistre le serveur du moment dans la configuration globale d'agy. */
async function registerServer(
  executable: string,
  environment: Record<string, string | undefined>,
  serverUrl: string
): Promise<void> {
  await run(executable, ['mcp', 'add', '--type', 'http', SERVER_NAME, serverUrl], {
    env: environment,
    timeout: 15_000,
    encoding: 'utf8'
  })
}

/** Retire le serveur : rien ne doit rester branche entre deux fournees. */
async function unregisterServer(
  executable: string,
  environment: Record<string, string | undefined>
): Promise<void> {
  try {
    await run(executable, ['mcp', 'remove', SERVER_NAME], {
      env: environment,
      timeout: 15_000,
      encoding: 'utf8'
    })
  } catch (error) {
    // L'entree restera : une adresse morte, que le prochain « add » ecrase.
    console.warn('[gemini] agy mcp remove a echoue :', error)
  }
}

/**
 * Lance une session headless complete : sert les outils, invoque le binaire,
 * attend la fin, nettoie. Ne jette pas — l'echec est une valeur, comme pour
 * les tentatives de la route Claude.
 */
export async function runGemini(input: GeminiRunInput): Promise<GeminiRunResult> {
  const server = await serveTools(input.tools)
  const environment = geminiEnvironment(input.executable)
  let registered = false

  try {
    await ensureAllowRules()
    const workshop = await prepareWorkshop()
    await registerServer(input.executable, environment, server.url)
    registered = true

    // La consigne ouvre le message : agy n'a pas de prise sur son prompt
    // systeme, et c'est la forme qui ne peut pas se perdre en route.
    const prompt = `${input.systemPrompt}\n\n---\n\n${input.prompt}`

    try {
      const pending = run(
        input.executable,
        [
          '--model',
          input.model,
          '--output-format',
          'json',
          '--print-timeout',
          `${Math.ceil(input.timeout / 1000)}s`,
          '-p',
          prompt
        ],
        {
          cwd: workshop,
          env: environment,
          // La minuterie d'agy (--print-timeout) doit sonner la premiere :
          // elle rend un statut propre. La notre n'est que le filet.
          timeout: input.timeout + 30_000,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_OUTPUT,
          encoding: 'utf8'
        }
      )
      // Rien n'arrive par stdin : ferme, pour qu'agy n'attende jamais dessus.
      pending.child.stdin?.end()
      const { stdout, stderr } = await pending

      const output = parseOutput(stdout)
      const status = typeof output?.status === 'string' ? output.status : null
      if (status !== null && status !== 'SUCCESS') {
        const detail =
          (typeof output?.error === 'string' && output.error) ||
          (output?.error && typeof output.error === 'object' && 'message' in output.error
            ? String((output.error as { message?: unknown }).message)
            : '') ||
          lastLine(stderr) ||
          (typeof output?.response === 'string' ? output.response.slice(0, 200) : '')
        return {
          failure: new Error(
            `gemini : session ${status.toLowerCase()}${detail ? ` — ${detail}` : ''}`
          )
        }
      }
      // Un outil refuse par les permissions ne fait pas echouer la session :
      // agy le dit sur stderr. La fournee rendra zero carte et passera a la
      // route suivante ; le dire ici evite de chercher pourquoi.
      if (stderr.includes('permissions.allow')) {
        console.warn('[gemini] agy a refuse un outil :', lastLine(stderr))
      }
      return { failure: null }
    } catch (error) {
      // Timeout, binaire casse, non connecte, quota epuise : l'enveloppe JSON
      // peut porter l'erreur sur l'un ou l'autre flux, stderr le reste.
      const raw = error as { killed?: boolean; stdout?: string; stderr?: string }
      if (raw.killed) return { failure: new Error('gemini : delai depasse, processus arrete') }

      const structured =
        (raw.stdout ? parseOutput(raw.stdout) : null) ??
        (raw.stderr ? parseOutput(raw.stderr) : null)
      const status = typeof structured?.status === 'string' ? structured.status : null
      const message =
        status && status !== 'SUCCESS'
          ? `session ${status.toLowerCase()}`
          : lastLine(raw.stderr ?? '') || (error instanceof Error ? error.message : String(error))
      return { failure: new Error(`gemini : ${message}`) }
    }
  } finally {
    if (registered) await unregisterServer(input.executable, environment)
    await server.close()
  }
}
