/**
 * Liste des modeles proposes dans la barre de chat.
 *
 * Elle n'est pas ecrite en dur : c'est Claude Code qui la declare, en fonction
 * de l'abonnement de l'utilisateur. Une nouvelle version de modele apparait donc
 * dans le selecteur sans qu'on ait a toucher au code.
 *
 * La decouverte demande d'ouvrir une session, uniquement pour lire ce que le CLI
 * annonce en se presentant. Aucun message n'est envoye et aucun token n'est
 * consomme : le prompt fourni est un flux qui ne produit jamais rien.
 */

import type { ChatEffort, ChatModel } from '../../shared/types'
import { childEnvironment, resolveExecutable } from './provider'
import { loadSdk } from './sdk'

/** Au-dela, on renonce et on affiche la liste de secours. */
const DISCOVERY_TIMEOUT = 20_000

/** Niveaux courants, pour les entrees de la liste de secours. */
const USUAL_LEVELS: ChatEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Liste de secours, si la decouverte echoue. Elle utilise les alias plutot que
 * des identifiants precis : « opus » suivra les versions sans qu'on y revienne.
 *
 * L'entree « default » a le meme sens que dans la liste declaree par Claude
 * Code : ne rien imposer, et laisser jouer le reglage par defaut.
 */
const FALLBACK: ChatModel[] = [
  {
    value: 'default',
    displayName: 'Par défaut',
    description: 'Le modèle que ton Claude Code utilise déjà.',
    supportedEffortLevels: USUAL_LEVELS
  },
  {
    value: 'opus',
    displayName: 'Opus',
    description: 'Le plus capable. Pour un raisonnement long ou une notion difficile.',
    supportedEffortLevels: USUAL_LEVELS
  },
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    description: 'Équilibré. Convient à la plupart des questions sur un cours.',
    supportedEffortLevels: USUAL_LEVELS
  },
  {
    value: 'haiku',
    displayName: 'Haiku',
    description: 'Le plus rapide. Pour une définition ou une vérification courte.'
  }
]

let cached: ChatModel[] | null = null

async function discover(): Promise<ChatModel[] | null> {
  const executable = await resolveExecutable()
  if (!executable) return null

  const sdk = await loadSdk()

  // Un flux de prompt qui se termine sans rien produire : le CLI demarre,
  // repond a l'initialisation, et n'a aucun message a traiter.
  const silent = (async function* () {})()

  const query = sdk.query({
    prompt: silent,
    options: {
      pathToClaudeCodeExecutable: executable,
      env: childEnvironment(),
      // Les reglages personnels de l'utilisateur ne doivent pas influer sur la
      // liste, pas plus que sur le reste de l'application.
      settingSources: []
    }
  })

  try {
    const initialisation = await Promise.race([
      query.initializationResult(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('delai depasse')), DISCOVERY_TIMEOUT)
      )
    ])

    const models = initialisation.models
      .filter((model) => typeof model.value === 'string' && model.value.length > 0)
      .map<ChatModel>((model) => ({
        value: model.value,
        displayName: model.displayName || model.value,
        description: model.description ?? '',
        supportsEffort: model.supportsEffort,
        supportedEffortLevels: model.supportedEffortLevels
      }))

    return models.length > 0 ? models : null
  } catch {
    return null
  } finally {
    // Sans cela le sous-processus survivrait a la decouverte.
    try {
      query.close()
    } catch {
      // Deja ferme.
    }
  }
}

/**
 * Modeles disponibles. La decouverte n'a lieu qu'une fois par lancement ; si
 * elle echoue, la liste de secours prend le relais et le selecteur reste
 * utilisable.
 */
export async function supportedModels(): Promise<ChatModel[]> {
  if (cached) return cached
  cached = (await discover()) ?? FALLBACK
  return cached
}
