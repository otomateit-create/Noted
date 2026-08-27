/**
 * OpenRouter, pour la generation de flashcards uniquement.
 *
 * Claude Code sait parler a n'importe quelle passerelle qui repond au
 * protocole Anthropic : il suffit de lui donner une autre adresse et un autre
 * jeton dans son environnement. OpenRouter en expose une, et c'est tout ce
 * qu'il faut ici. Le reste de l'application — l'assistant du cours, le tuteur
 * de flashcards — continue de passer par l'abonnement, sans rien changer.
 *
 * La cle n'est pas dans le code : elle est lue dans .noted/openrouter.json,
 * a l'interieur du vault. Fichier absent, illisible ou incomplet, la
 * generation repart sur l'abonnement comme avant : c'est un supplement, jamais
 * un passage oblige.
 *
 * Les modeles sont dans ce meme fichier plutot que dans le code : en changer ne
 * demande alors pas de reconstruire l'application, ce qui compte quand la
 * liste des modeles gratuits d'OpenRouter bouge d'un mois a l'autre.
 *
 * Ils sont donnes par ordre de preference. Le premier est essaye, les suivants
 * prennent le relais s'il est indisponible. Le repli est celui de Claude Code
 * (« fallbackModel »), pas le parametre « fallbacks » d'OpenRouter : ce dernier
 * se place dans le corps de la requete, que le CLI construit lui-meme et qu'on
 * ne peut pas completer d'ici.
 *
 * Pour obtenir le repli d'OpenRouter lui-meme — celui qui se declenche sur
 * n'importe quelle erreur, quota de la journee compris — il faut passer par un
 * preset : on le cree une fois sur openrouter.ai avec sa liste de modeles, et
 * on ecrit ici « ["@preset/son-nom"] ». Aucun code a changer : le champ n'est
 * qu'une chaine transmise telle quelle, et la passerelle reconnait cette forme.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { vaultPaths } from '../vault'
import { childEnvironment } from './provider'

/** L'adresse de la passerelle OpenRouter qui parle le protocole Anthropic. */
const BASE_URL = 'https://openrouter.ai/api'

export interface OpenRouterSetup {
  /** Le modele prefere, tel qu'OpenRouter le nomme. */
  model: string
  /** Les suivants, essayes dans l'ordre. Absent s'il n'y en a qu'un. */
  fallbackModel?: string
  /** Environnement a passer au sous-processus, jeton compris. */
  env: Record<string, string | undefined>
}

/** Emplacement du fichier de configuration, dans le dossier interne du vault. */
export function configPath(): string {
  return path.join(vaultPaths().internal, 'openrouter.json')
}

/**
 * La configuration OpenRouter, ou null s'il n'y en a pas d'utilisable —
 * auquel cas l'appelant garde son comportement d'origine.
 */
export async function openRouter(): Promise<OpenRouterSetup | null> {
  let raw: string
  try {
    raw = await fs.readFile(configPath(), 'utf8')
  } catch {
    // Pas de fichier : cas normal, l'abonnement suffit.
    return null
  }

  let parsed: { cle?: unknown; modeles?: unknown }
  try {
    parsed = JSON.parse(raw) as { cle?: unknown; modeles?: unknown }
  } catch {
    // La cle a ete posee a la main : un JSON casse merite d'etre dit, sinon la
    // generation repartirait en silence sur l'abonnement sans qu'on comprenne.
    console.warn('[openrouter] fichier illisible, on garde l\'abonnement :', configPath())
    return null
  }

  const cle = typeof parsed.cle === 'string' ? parsed.cle.trim() : ''
  const modeles = Array.isArray(parsed.modeles)
    ? parsed.modeles
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : []

  if (!cle || modeles.length === 0) {
    console.warn('[openrouter] « cle » ou « modeles » manquant, on garde l\'abonnement.')
    return null
  }

  const [prefere, ...replis] = modeles

  return {
    model: prefere,
    // Le CLI attend une liste separee par des virgules ; absente s'il n'y a
    // rien derriere le premier modele.
    fallbackModel: replis.length > 0 ? replis.join(',') : undefined,
    env: {
      // childEnvironment retire ANTHROPIC_API_KEY et ANTHROPIC_AUTH_TOKEN de
      // l'environnement herite ; on repose ensuite les notres par-dessus, sans
      // risque qu'une variable du shell de l'utilisateur prenne le pas.
      ...childEnvironment(),
      ANTHROPIC_BASE_URL: BASE_URL,
      ANTHROPIC_AUTH_TOKEN: cle
    }
  }
}
