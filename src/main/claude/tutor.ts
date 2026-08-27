/**
 * Le tuteur de flashcards : une conversation Claude par carte revisee.
 *
 * Ouvert depuis la session de revision, il explique comment retenir la carte
 * — la logique d'abord, les connexions ensuite — selon la methode calibree
 * avec Raphael, puis repond a ses questions de suivi. Une seule conversation
 * a la fois : changer de carte la remet a zero.
 *
 * La methode elle-meme n'est pas ici : elle vit dans le vault, en clair, sous
 * Prompts/tuteur.md. Ce fichier ne porte que ce que l'application y ajoute.
 *
 * Outils : la recherche web toujours ; la consultation du cours seulement si
 * la carte vient d'un cours dont le texte extrait est disponible. Jamais la
 * memoire, jamais les notes.
 */

import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { GENERAL_SET_BASENAME, isGeneralSetId } from '../../shared/flashcards'
import type { ChatStreamEvent, PromptAnnexe, TutorSendInput } from '../../shared/types'
import { readExtraction } from '../extraction-cache'
import { composePrompt } from '../prompts/store'
import { indexCourse, indexedCourse } from '../rag/store'
import { findCourse, vaultPaths } from '../vault'
import { childEnvironment, resolveExecutable } from './provider'
import { loadSdk } from './sdk'
import { describeError, pumpTurn } from './session'
import { CONSULT_TOOL_NAMES, courseConsultTools } from './tools'

interface TutorSession {
  sessionId?: string
  active?: { query: Query; abort: AbortController }
}

// Une seule conversation de tuteur a la fois : le panneau n'existe qu'en un
// exemplaire, et il se reinitialise a chaque carte.
const tutor: TutorSession = {}

/** Ce que le tuteur sait de la carte, resolu avant de construire le prompt. */
interface CardContext {
  subject: string
  /** Titre du cours d'origine — null pour une carte generale de matiere. */
  courseTitle: string | null
  /** Le support du cours est indexe et consultable par les outils. */
  searchable: boolean
}

/**
 * Resout la matiere, le cours et la disponibilite du support. Pour une carte
 * de cours, l'index de recherche est reconstruit au besoin depuis le texte
 * extrait en cache — le cours n'est pas ouvert pendant une revision.
 */
async function resolveCard(setId: string): Promise<CardContext> {
  if (isGeneralSetId(setId)) {
    return {
      subject: setId.slice(0, -(GENERAL_SET_BASENAME.length + 1)),
      courseTitle: null,
      searchable: false
    }
  }

  const course = await findCourse(setId)

  if (!indexedCourse(setId)) {
    const extracted = await readExtraction(setId)
    if (extracted) indexCourse(extracted)
  }

  return {
    subject: course.subject,
    courseTitle: course.title,
    searchable: indexedCourse(setId) !== null
  }
}

/**
 * Ce que l'application ajoute sous la methode : la disponibilite du support,
 * puis la carte revisee. Ce sont des donnees du moment, pas une consigne —
 * elles viennent en dessous quel que soit le texte du fichier.
 */
function tutorAnnexe(card: TutorSendInput['card'], context: CardContext): string {
  const sourceNote = context.searchable
    ? `- Le cours dont vient la carte est consultable : « rechercher » localise les
  passages, « lire » ouvre une page ou une section. Sers-t'en pour coller au
  vocabulaire et aux notations du cours, et pour nourrir le bloc
  « Connexions » : les meilleures connexions sont celles que son cours fait
  déjà.`
    : context.courseTitle
      ? `- Le support du cours n'est pas consultable pour l'instant : appuie-toi sur
  ta connaissance du domaine et sur le web.`
      : `- La carte est une carte générale de la matière, sans support de cours
  derrière : appuie-toi sur ta connaissance du domaine et sur le web.`

  return `${sourceNote}

## La carte qu'il révise

Matière : ${context.subject}
${context.courseTitle ? `Cours : ${context.courseTitle}` : 'Carte générale de la matière, sans cours associé.'}
Question : ${card.recto}
Réponse : ${card.verso}

Réponds toujours en français. Après la première explication, ses messages
sont des questions de suivi : réponds-y directement, avec la même méthode,
sans reposer de question de vérification.`
}

/**
 * Le meme bloc, sur une carte d'exemple, pour l'ecran Parametres. Produit par
 * la fonction qui l'ajoute reellement : une description a la main mentirait
 * des la premiere evolution.
 */
export function tutorAnnexes(): PromptAnnexe[] {
  return [
    {
      titre: 'Ajoute sous le prompt, à chaque carte ouverte',
      texte: tutorAnnexe(
        {
          setId: 'Private Equity/cours-lbo.pdf',
          recto: 'Que mesure le TRI d\'un fonds ?',
          verso: 'Le taux d\'actualisation qui annule la VAN de ses flux.'
        },
        { subject: 'Private Equity', courseTitle: 'cours lbo', searchable: true }
      )
    }
  ]
}

/**
 * La methode d'apprentissage, lue dans Prompts/tuteur.md, suivie de ce que
 * l'application ajoute d'elle-meme.
 */
async function tutorPrompt(
  card: TutorSendInput['card'],
  context: CardContext
): Promise<string> {
  return `${await composePrompt('tuteur')}
${tutorAnnexe(card, context)}`
}

async function buildOptions(card: TutorSendInput['card']): Promise<Options> {
  const sdk = await loadSdk()
  const executable = await resolveExecutable()
  const context = await resolveCard(card.setId)

  const options: Options = {
    systemPrompt: await tutorPrompt(card, context),

    // Le web toujours ; le support du cours quand il est la. Ni la memoire,
    // ni le vault : le tuteur explique une carte, il ne fouille pas le bureau.
    tools: ['WebSearch', 'WebFetch'],
    allowedTools: context.searchable
      ? [...CONSULT_TOOL_NAMES, 'WebSearch', 'WebFetch']
      : ['WebSearch', 'WebFetch'],
    disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Grep', 'Glob'],
    permissionMode: 'bypassPermissions',

    cwd: vaultPaths().root,
    settingSources: [],
    includePartialMessages: true,
    env: childEnvironment(),

    // Le choix de Raphael pour le tuteur : Sonnet, reflexion elevee — fixe,
    // independant du reglage de la barre de chat de l'assistant.
    model: 'sonnet',
    effort: 'high',

    // Une explication enchaine au plus quelques recherches ; bien moins que
    // l'assistant du cours et ses allers-retours documentes.
    maxTurns: 12
  }

  if (context.searchable) {
    options.mcpServers = { cours: courseConsultTools(sdk, card.setId) }
  }

  if (executable) {
    options.pathToClaudeCodeExecutable = executable
  }

  if (tutor.sessionId) {
    options.resume = tutor.sessionId
  }

  return options
}

/**
 * Envoie un message au tuteur et pousse la reponse via `emit`. Ne rejette
 * pas : les erreurs partent en evenement, affichees dans le fil du panneau.
 */
export async function tutorSend(
  input: TutorSendInput,
  emit: (event: ChatStreamEvent) => void
): Promise<void> {
  const { messageId, prompt, card } = input

  tutorInterrupt()
  const abort = new AbortController()

  try {
    const sdk = await loadSdk()
    const options = await buildOptions(card)
    options.abortController = abort

    const stream = sdk.query({ prompt, options })
    tutor.active = { query: stream, abort }

    await pumpTurn(stream as AsyncIterable<SDKMessage>, messageId, emit, (id) => {
      tutor.sessionId = id
    })

    emit({ kind: 'done', messageId })
  } catch (error) {
    if (abort.signal.aborted) {
      emit({ kind: 'done', messageId })
      return
    }
    emit({ kind: 'error', messageId, message: describeError(error) })
  } finally {
    if (tutor.active?.abort === abort) {
      tutor.active = undefined
    }
  }
}

/** Arrete la reponse en cours du tuteur, s'il y en a une. */
export function tutorInterrupt(): void {
  if (!tutor.active) return
  tutor.active.abort.abort()
  try {
    tutor.active.query.close()
  } catch {
    // La requete etait deja terminee : rien a fermer.
  }
  tutor.active = undefined
}

/** Oublie la conversation — appele quand la carte change ou que le panneau se rouvre. */
export function tutorReset(): void {
  tutorInterrupt()
  tutor.sessionId = undefined
}
