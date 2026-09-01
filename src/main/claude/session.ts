/**
 * Une conversation Claude par cours ouvert.
 *
 * Le cours n'est pas verse dans le prompt : il est indexe a l'ouverture, et
 * l'assistant va chercher lui-meme les passages utiles a chaque question. Un
 * support de deux cents pages coute alors le meme premier message qu'un support
 * de dix, et la conversation ne depend plus d'un cache dont la duree de vie est
 * courte.
 *
 * Le prompt ne porte que le cadre : la matiere du cours ouvert, le plan du
 * document, et la consigne d'aller chercher avant de repondre.
 */

import path from 'node:path'
import type { Options, Query, SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { HIGHLIGHT_COLORS } from '../../shared/types'
import type {
  ChatHistoryEntry,
  ChatMessage,
  ChatSendInput,
  ChatStreamEvent,
  CompactOutcome,
  Course,
  ExtractedCourse,
  NoteDraft
} from '../../shared/types'
import { hasMemoryInScope, recallSources } from '../memory/rag'
import { cancelProposals, endNoteDrafts, showNoteDraft } from '../notes-bridge'
import { postDraft } from '../notes-post'
import { cancelQuizzes } from '../quiz-bridge'
import { composePrompt } from '../prompts/store'
import { indexCourse, indexedCourse } from '../rag/store'
import { vaultPaths } from '../vault'
import { draftText, draftedTool } from './draft'
import { MEMORY_TOOL_NAMES, memoryTools } from './memory-tools'
import { childEnvironment, resolveExecutable } from './provider'
import { assistantPrefix, courseContext } from './prompt'
import { isNudgeTurn, nudgeBlock, recallBlock, userText } from './recall'
import { splitQuotedPrompt } from '@shared/chat-quotes'
import { loadSdk } from './sdk'
import { COURSE_TOOL_NAMES, courseTools } from './tools'

interface CourseSession {
  /** Identifiant de session Claude, pour enchainer les tours. */
  sessionId?: string
  /** Empreinte du contenu indexe, pour reperer un document qui a change. */
  contentKey?: string
  /** Tour en cours, s'il y en a un. */
  active?: { query: Query; abort: AbortController }
  /**
   * Rang du dernier message envoye dans cette conversation — ce qui cadence
   * l'invitation a noter. Repart de zero avec chaque nouvelle conversation,
   * et a la reprise d'une ancienne, dont on ne recompte pas les tours.
   */
  turns?: number
}

const sessions = new Map<string, CourseSession>()

function sessionFor(courseId: string): CourseSession {
  let session = sessions.get(courseId)
  if (!session) {
    session = {}
    sessions.set(courseId, session)
  }
  return session
}

/**
 * Recoit le texte extrait par le renderer et en construit l'index de recherche.
 * C'est le seul moment ou le cours est parcouru en entier ; ensuite, seuls les
 * passages utiles remontent, a la demande de l'assistant.
 */
export function cacheExtraction(extracted: ExtractedCourse): void {
  const session = sessionFor(extracted.courseId)
  // Nombre de pages et longueur du texte suffisent a reperer un document
  // remplace : deux versions differentes ne coincident pratiquement jamais sur
  // les deux a la fois.
  const key = `${extracted.pageCount}:${extracted.markdown.length}`

  // Le document a change sous la conversation : ce qui a ete dit avant portait
  // sur un autre contenu.
  if (session.contentKey && session.contentKey !== key) {
    session.sessionId = undefined
    session.turns = 0
  }
  session.contentKey = key

  indexCourse(extracted)
}

async function buildOptions(
  course: Course,
  session: CourseSession,
  choice: Pick<ChatSendInput, 'model' | 'effort'>
): Promise<Options> {
  const sdk = await loadSdk()
  const executable = await resolveExecutable()
  const hasMemory = await hasMemoryInScope(course)

  const options: Options = {
    // Le prompt systeme est un tableau : ce qui precede le marqueur est
    // identique pour tous les cours et beneficie du cache global, ce qui suit
    // est propre au document ouvert.
    systemPrompt: [
      await assistantPrefix(),
      sdk.SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      courseContext(course, indexedCourse(course.id), hasMemory)
    ],

    // Les outils de consultation du cours ouvert et de la memoire. Les
    // serveurs sont reconstruits a chaque tour autour du cours courant.
    mcpServers: {
      cours: courseTools(sdk, course.id),
      memoire: memoryTools(sdk, course)
    },

    // Claude travaille dans le vault : il peut lire les autres cours, les
    // notes et la memoire, et rien au-dela.
    cwd: vaultPaths().root,

    // Les seuls outils integres qui aient un sens ici. « allowedTools » ne fait
    // qu'autoriser sans demander : il ne retranche rien. Sans cette liste, le
    // moteur en chargeait trente-neuf — Task, Artifact, Cron, Workflow et une
    // vingtaine d'autres, tous inutilisables dans Noted et tous decrits en
    // entier dans le contexte de chaque message.
    tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],

    // Lecture seule. Les notes sont ecrites par l'application, pas par le
    // modele : aucun risque qu'une reponse ecrase le travail en cours. Le web
    // sert de repli quand le cours ne repond pas.
    allowedTools: [
      ...COURSE_TOOL_NAMES,
      ...MEMORY_TOOL_NAMES,
      'Read',
      'Grep',
      'Glob',
      'WebSearch',
      'WebFetch'
    ],
    disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit'],
    permissionMode: 'bypassPermissions',

    // Sans ceci, le CLAUDE.md personnel de l'utilisateur et les reglages de ses
    // autres projets s'appliqueraient a Noted et fausseraient son comportement.
    settingSources: [],

    // Necessaire pour recevoir le texte au fil de l'eau plutot qu'en bloc.
    includePartialMessages: true,

    // Deux outils rendent la main a l'utilisateur et attendent sa decision :
    // une proposition d'ecriture dans les notes, et un quiz a remplir. Le
    // delai par defaut des outils MCP couperait l'appel avant qu'il ait fini
    // de lire ou d'ecrire.
    //
    // Le plafond etait a onze minutes, taille pour la proposition de notes :
    // une de plus que le delai apres lequel son pont abandonne de lui-meme,
    // pour que l'expiration passe toujours par lui et son refus propre — a
    // egalite, c'etait parfois le moteur qui parlait le premier et le modele
    // recevait « timed out » a la place. Mais un quiz de neuf questions se
    // remplit en bien plus de onze minutes : le moteur coupait au milieu, et
    // l'envoi de la carte ne faisait plus rien. Le plafond passe donc a
    // vingt-quatre heures — hors d'atteinte, ce qui est le but : c'est aux
    // ponts de decider quand ils abandonnent, jamais au moteur. Celui des
    // notes garde ses dix minutes ; celui du quiz n'en a plus du tout, et se
    // termine par un geste (voir quiz-bridge).
    env: { ...childEnvironment(), MCP_TOOL_TIMEOUT: String(24 * 60 * 60_000) },

    // Une reponse documentee enchaine plusieurs recherches, parfois une lecture
    // de section et un detour par le web. Le plafond precedent, prevu pour une
    // reponse en un tour, coupait desormais la parole en pleine investigation.
    maxTurns: 24
  }

  if (executable) {
    // Indispensable une fois l'application packagee : lancee depuis le Finder,
    // elle n'a pas le PATH du terminal et ne trouverait pas le binaire.
    options.pathToClaudeCodeExecutable = executable
  }

  // Choix de la barre de chat. On ne pose la cle que si l'utilisateur a
  // reellement choisi : laisser le champ absent rend la main au reglage par
  // defaut de Claude Code, ce qui n'est pas la meme chose que de forcer une
  // valeur qui se trouverait coincider avec lui aujourd'hui.
  if (choice.model) {
    options.model = choice.model
  }
  if (choice.effort) {
    options.effort = choice.effort
  }

  if (session.sessionId) {
    options.resume = session.sessionId
  }

  return options
}

/**
 * Envoie un message et pousse la reponse au fur et a mesure via `emit`.
 * Ne rejette pas : les erreurs sont transmises comme evenement, pour que
 * l'interface puisse les afficher dans le fil de conversation.
 */
export async function send(
  input: ChatSendInput,
  course: Course,
  emit: (event: ChatStreamEvent) => void
): Promise<void> {
  const { courseId, messageId, prompt } = input
  const session = sessionFor(courseId)
  // Si cette conversation n'a pas encore d'identifiant, le tour va en creer
  // une nouvelle : elle devra etre etiquetee pour apparaitre dans
  // l'historique de ce cours (voir historyFor).
  const isNewSession = !session.sessionId

  // Un seul tour a la fois par cours.
  interrupt(courseId)

  session.turns = isNewSession ? 1 : (session.turns ?? 0) + 1

  const abort = new AbortController()

  try {
    const sdk = await loadSdk()
    const options = await buildOptions(course, session, input)
    options.abortController = abort

    const stream = sdk.query({
      prompt: await withAppBlocks(prompt, course, isNewSession, session.turns),
      options
    })
    session.active = { query: stream, abort }

    await pumpTurn(
      stream as AsyncIterable<SDKMessage>,
      messageId,
      emit,
      (id) => {
        session.sessionId = id
      },
      // Le texte d'une ecriture de notes part vers le panneau des notes
      // pendant qu'il se compose ; le tour fini, quoi qu'il en soit, rien
      // n'en reste a l'ecran (voir le `finally`).
      {
        write: (draft) => showNoteDraft({ ...draft, courseId }),
        end: (id) => endNoteDrafts(courseId, id)
      }
    )

    if (isNewSession && session.sessionId) {
      // Sans etiquette, la conversation resterait invisible dans son propre
      // historique — mais un echec ici ne doit pas faire echouer le tour.
      void sdk.tagSession(session.sessionId, courseId, {}).catch(() => undefined)
    }

    emit({ kind: 'done', messageId })
  } catch (error) {
    // Une interruption demandee par l'utilisateur n'est pas une erreur.
    if (abort.signal.aborted) {
      emit({ kind: 'done', messageId })
      return
    }
    emit({ kind: 'error', messageId, message: describeError(error) })
  } finally {
    endNoteDrafts(courseId, null)
    if (session.active?.abort === abort) {
      session.active = undefined
    }

    /**
     * Le brouillon oublie.
     *
     * L'assistant depose ses passages par `note_brouillon` et les pose par
     * `note_poser` ; rien ne garantit qu'il appelle le second. Un tour peut
     * finir sur une phrase de conclusion, sur une erreur du moteur, sur un
     * plafond de tokens — et le travail d'ecriture d'un tour ne doit pas
     * dependre de ce que le modele a pense a faire en dernier. On pose donc ce
     * qui reste, ici, ou l'on passe quoi qu'il arrive.
     *
     * Sauf sur interruption : l'utilisateur a demande l'arret, et lui ecrire
     * dans ses notes juste apres serait le contraire de ce qu'il a demande. Le
     * brouillon reste alors sur le disque, lisible dans `Brouillons/`.
     *
     * Sans `await` : le tour est termine, `done` est deja parti, et faire
     * attendre la fermeture du tour sur un aller-retour vers le panneau des
     * notes n'apporterait rien. Une erreur ici ne doit rien casser non plus —
     * le brouillon, lui, survit dans tous les cas.
     */
    if (!abort.signal.aborted) {
      void postDraft(courseId).catch((cause) => {
        console.warn(`[notes] pose du brouillon impossible pour ${courseId} :`, cause)
      })
    }
  }
}

/**
 * Ce que l'application joint au tour utilisateur, apres ses mots : le rappel
 * de memoire au premier message d'une conversation, l'invitation a noter tous
 * les huit echanges. Rien quand il n'y a rien a dire — le message part tel
 * quel — et rien non plus si la memoire ne repond pas : c'est un confort, il
 * ne retient pas le message.
 */
async function withAppBlocks(
  prompt: string,
  course: Course,
  isNewSession: boolean,
  turns: number
): Promise<string> {
  const blocks: string[] = []

  if (isNewSession) {
    try {
      const recall = recallBlock(await recallSources(course, prompt))
      if (recall) blocks.push(recall)
    } catch {
      // Memoire illisible ou moteur en panne : le message part sans rappel.
    }
  }

  if (isNudgeTurn(turns)) {
    try {
      blocks.push(nudgeBlock(turns, await composePrompt('memoire')))
    } catch {
      // Methode illisible : le message part sans le rappel, comme sans le
      // rappel de memoire — c'est un confort, il ne retient pas le message.
    }
  }

  return blocks.length === 0 ? prompt : `${prompt}\n\n${blocks.join('\n\n')}`
}

/**
 * Ou part le texte d'une ecriture de notes pendant qu'elle se compose. La
 * conversation d'un cours le donne ; le tuteur de flashcards, qui n'ecrit
 * pas dans les notes, s'en passe.
 */
export interface DraftSink {
  write(draft: Omit<NoteDraft, 'courseId'>): void
  end(id: string): void
}

interface Composing {
  id: string
  kind: NoteDraft['kind']
  key: string
  json: string
  shownAt: number
}

/** Au plus un rendu du brouillon par ce laps de temps. */
const DRAFT_INTERVAL = 150

/**
 * Fait defiler un tour : deltas de texte et de reflexion, appels d'outils et
 * leurs resultats, compteur de tokens, echec eventuel. Partage entre la
 * conversation d'un cours et le tuteur de flashcards — seul le cadre (prompt,
 * outils, session) change, jamais la maniere de retransmettre.
 */
export async function pumpTurn(
  stream: AsyncIterable<SDKMessage>,
  messageId: string,
  emit: (event: ChatStreamEvent) => void,
  onSessionId: (sessionId: string) => void,
  drafts?: DraftSink
): Promise<void> {
  // Un tour peut enchainer plusieurs reponses du modele, entrecoupees
  // d'appels d'outils. Chacune repart de zero : on cumule les precedentes
  // pour que le compteur affiche ne recule jamais.
  let tokensCommitted = 0
  let tokensCurrent = 0

  // Les ecritures de notes en cours de composition, par rang de bloc dans la
  // reponse en cours : le JSON recu jusqu'ici, et quand on l'a montre.
  const composing = new Map<number, Composing>()

  for await (const message of stream) {
    // Le premier message porte l'identifiant de session : on le garde pour
    // enchainer le tour suivant sans renvoyer tout le cours.
    const withSession = message as { session_id?: string }
    if (withSession.session_id) {
      onSessionId(withSession.session_id)
    }

    if (message.type === 'stream_event') {
      const event = message.event

      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta' && event.delta.text) {
          emit({ kind: 'text', messageId, delta: event.delta.text })
        } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
          emit({ kind: 'thinking', messageId, delta: event.delta.thinking })
        } else if (event.delta.type === 'input_json_delta') {
          const draft = composing.get(event.index)
          if (draft && drafts) {
            draft.json += event.delta.partial_json
            // Pas a chaque morceau : le panneau rend le Markdown a chaque
            // fois, et l'oeil ne suit pas plus vite que quelques fois par
            // seconde.
            const now = Date.now()
            if (now - draft.shownAt >= DRAFT_INTERVAL) {
              draft.shownAt = now
              drafts.write({ id: draft.id, kind: draft.kind, text: draftText(draft.json, draft.key) })
            }
          }
        }
        continue
      }

      // Un appel d'outil qui ecrit dans les notes commence : on suivra son
      // texte pour le montrer avant meme qu'il ne soit appele.
      if (event.type === 'content_block_start') {
        const block = event.content_block
        if (block.type === 'tool_use' && drafts) {
          const drafted = draftedTool(block.name)
          if (drafted) {
            composing.set(event.index, { id: block.id, ...drafted, json: '', shownAt: 0 })
          }
        }
        continue
      }

      // Le texte est complet : un dernier rendu, entier, juste avant que
      // l'outil ne soit appele.
      if (event.type === 'content_block_stop') {
        const draft = composing.get(event.index)
        if (draft && drafts) {
          composing.delete(event.index)
          drafts.write({ id: draft.id, kind: draft.kind, text: draftText(draft.json, draft.key) })
        }
        continue
      }

      // Une nouvelle reponse commence : ce qui precede est acquis.
      if (event.type === 'message_start') {
        tokensCommitted += tokensCurrent
        tokensCurrent = 0
        composing.clear()
        continue
      }

      if (event.type === 'message_delta') {
        const produced = event.usage?.output_tokens
        if (typeof produced === 'number') {
          tokensCurrent = produced
          emit({
            kind: 'tokens',
            messageId,
            tokens: tokensCommitted + tokensCurrent
          })
        }
      }
      continue
    }

    // Les resultats d'outils reviennent sous forme de message utilisateur :
    // c'est ainsi que le modele les recoit, et c'est la seule occasion de les
    // capturer pour les montrer.
    if (message.type === 'user') {
      const blocks = message.message.content
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            // L'outil a rendu : s'il a affiche une proposition, elle a deja
            // remplace le brouillon ; sinon, celui-ci n'a plus rien a montrer.
            drafts?.end(block.tool_use_id)
            emit({
              kind: 'tool-result',
              messageId,
              toolId: block.tool_use_id,
              result: renderToolResult(block.content)
            })
          }
        }
      }
      continue
    }

    // Le texte arrive deja par les deltas ci-dessus ; on ne lit ici que les
    // appels d'outils, pour les afficher discretement dans l'interface.
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          emit({
            kind: 'tool',
            messageId,
            call: {
              id: block.id,
              name: block.name,
              summary: summariseToolCall(block.name, block.input),
              detail: describeToolInput(block.input),
              running: true
            }
          })
        }
      }
      continue
    }

    if (message.type === 'result') {
      if (message.subtype !== 'success') {
        emit({
          kind: 'error',
          messageId,
          message: describeResultFailure(message.subtype)
        })
      }
      break
    }
  }
}

/**
 * Ce que l'utilisateur voit passer sous la reponse. L'interet n'est pas de
 * tracer un appel de fonction mais de rendre visible la demarche : chercher
 * dans le cours, ouvrir une page, aller voir sur le web.
 *
 * Le SDK ne type pas les entrees d'outil : on les inspecte avec precaution.
 */
function summariseToolCall(name: string, input: unknown): string {
  const fields = (input ?? {}) as Record<string, unknown>
  const text = (key: string): string =>
    typeof fields[key] === 'string' ? (fields[key] as string) : ''

  switch (name) {
    case 'mcp__cours__rechercher':
      return `Recherche dans le cours · « ${text('requete')} »`
    case 'mcp__cours__lire':
      return `Lecture du cours · ${text('reference')}`
    case 'mcp__cours__mes_surlignages': {
      // La couleur est filtree par identifiant ; c'est son nom que l'utilisateur
      // reconnait, celui de sa legende.
      const colour = HIGHLIGHT_COLORS.find((entry) => entry.id === text('couleur'))
      return colour ? `Mes surlignages · ${colour.label}` : 'Mes surlignages'
    }
    case 'mcp__cours__cartes_creer': {
      const cards = fields['cartes']
      const count = Array.isArray(cards) ? cards.length : 0
      return count > 0
        ? `Flashcards · ${count} carte${count > 1 ? 's' : ''} créée${count > 1 ? 's' : ''}`
        : 'Flashcards · création'
    }
    case 'mcp__cours__quiz': {
      const questions = fields['questions']
      const count = Array.isArray(questions) ? questions.length : 0
      return count > 0 ? `Quiz · ${count} question${count > 1 ? 's' : ''}` : 'Quiz'
    }
    case 'mcp__cours__note_lire': {
      const section = text('section')
      return section ? `Lecture des notes · ${section}` : 'Lecture des notes'
    }
    case 'mcp__cours__note_brouillon': {
      const passages = fields['passages']
      const count = Array.isArray(passages) ? passages.length : 0
      return count > 1 ? `Écriture de notes · ${count} passages` : 'Écriture de notes'
    }
    case 'mcp__cours__note_poser':
      return 'Ancrage et pose des notes'
    case 'mcp__cours__note_remplacer':
      return 'Proposition de retouche des notes'
    case 'mcp__cours__note_reecrire':
      return 'Proposition de réécriture des notes'
    case 'mcp__memoire__se_souvenir':
      return `Mémoire · « ${text('requete')} »`
    // Les gestes d'ecriture ont leur propre trace, plus riche et annulable ;
    // leur ligne d'outil n'est pas affichee (voir ChatPanel).
    case 'mcp__memoire__memoire_noter':
      return `Mémoire · retenir « ${text('titre')} »`
    case 'mcp__memoire__memoire_corriger':
      return 'Mémoire · correction'
    case 'mcp__memoire__memoire_oublier':
      return 'Mémoire · oubli'
    case 'mcp__memoire__memoire_lier':
      return 'Mémoire · lien'
    case 'Read': {
      // Une page du cours regardee telle qu'imprimee : c'est le geste qui
      // interesse l'utilisateur, pas le nom de l'outil.
      const pages = text('pages')
      if (pages) return `Regarde la page ${pages} · ${path.basename(text('file_path'))}`
      break
    }
    case 'WebSearch':
      return `Recherche web · « ${text('query')} »`
    case 'WebFetch':
      return `Page web · ${text('url')}`
  }

  const target = text('file_path') || text('pattern') || text('path')
  if (!target) return name

  // Le chemin complet du vault n'apprend rien a l'utilisateur : on ne garde
  // que la partie qui l'interesse.
  return `${name} · ${target.replace(`${vaultPaths().root}/`, '')}`
}

/**
 * Ce que l'IA a demande, mis a plat pour etre lu. Le detail sert a comprendre
 * une reponse, pas a deboguer : une valeur par ligne, sans accolades.
 */
function describeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined

  const lines = Object.entries(input as Record<string, unknown>).map(([key, value]) => {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value)
    return `${key} : ${rendered}`
  })

  return lines.length > 0 ? lines.join('\n') : undefined
}

/**
 * Au-dela, l'interet du detail est passe : on montre de quoi juger la
 * pertinence d'une recherche, pas de relire le cours entier.
 */
const RESULT_LIMIT = 12_000

/** Le contenu d'un resultat d'outil est soit du texte, soit une liste de blocs. */
function renderToolResult(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              block && typeof block === 'object' && 'text' in block
                ? String((block as { text: unknown }).text)
                : ''
            )
            .filter(Boolean)
            .join('\n')
        : ''

  return text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}\n\n… (suite tronquée)` : text
}

/**
 * Reconstruit un fil affichable a partir du transcript stocke par le CLI —
 * pour rouvrir une conversation passee, ou la retrouver apres un redemarrage.
 * Miroir statique de `pumpTurn` : meme regroupement (un message par tour,
 * outils et reflexion inclus), mais sur un tableau au lieu d'un flux, et sans
 * les evenements intermediaires puisque tout est deja arrive.
 *
 * `getSessionMessages` rend l'etat courant de la session, deja recompose
 * apres une eventuelle compaction : le repere qu'on affiche ici est donc
 * fidele a ce que Claude sait reellement au moment de la reprise.
 */
/**
 * Un tour de l'utilisateur relu depuis le disque : ses mots, et les passages de
 * la reponse precedente qu'il citait. Le bloc de citations repart en pastilles
 * plutot qu'en deux lignes de « > [1] » laissees dans la bulle.
 */
function userTurn(content: string): Pick<ChatMessage, 'text' | 'quotes'> {
  const { quotes, question } = splitQuotedPrompt(userText(content))
  return quotes.length > 0 ? { text: question, quotes } : { text: question }
}

function convertHistory(raw: SessionMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  let counter = 0
  const nextId = (prefix: string): string => `${prefix}-${counter++}`

  let current: ChatMessage | null = null

  for (const entry of raw) {
    // Un repere « system » stocke (compact_boundary, init...) ne porte plus
    // son sous-type une fois relu depuis le disque : seul le resume injecte
    // juste apres, reconnu ci-dessous, dit qu'une compaction a eu lieu ici.
    if (entry.type === 'system') continue

    const message = entry.message as
      | { role: 'user'; content: string | Array<Record<string, unknown>> }
      | { role: 'assistant'; model?: string; content: Array<Record<string, unknown>> }
      | undefined
    if (!message) continue

    if (entry.type === 'user') {
      const content = message.content

      if (typeof content === 'string') {
        // Resume injecte par la compaction : pas un message de l'utilisateur,
        // mais le signe qu'une compaction a eu lieu — on le montre comme tel,
        // sans le detail des tokens (perdu a la relecture depuis le disque ;
        // seule une compaction lancee dans cette session meme, voir
        // compactSession, connait ce chiffre).
        if (content.startsWith('This session is being continued')) {
          result.push({ id: nextId('h-c'), role: 'system', text: '' })
          current = null
          continue
        }
        // Echo interne de la commande /compact et de sa confirmation : deja
        // represente par le repere ci-dessus, pas un vrai message.
        if (content.startsWith('<local-command-stdout>') || content.startsWith('<command-name>')) {
          continue
        }
        // Sans ce que l'application avait joint au tour : ce sont ses mots a
        // lui qu'on lui remontre.
        result.push({ id: nextId('h-u'), role: 'user', ...userTurn(content) })
        current = null
        continue
      }

      if (Array.isArray(content)) {
        const toolResults = content.filter((block) => block.type === 'tool_result')
        if (toolResults.length > 0) {
          if (current) {
            for (const block of toolResults) {
              current.toolCalls = current.toolCalls?.map((call) =>
                call.id === block['tool_use_id']
                  ? { ...call, result: renderToolResult(block['content']), running: false }
                  : call
              )
            }
          }
          continue
        }

        const turn = userTurn(
          content
            .filter((block) => block.type === 'text')
            .map((block) => String(block['text'] ?? ''))
            .join('\n')
        )
        if (turn.text.trim()) {
          result.push({ id: nextId('h-u'), role: 'user', ...turn })
          current = null
        }
      }
      continue
    }

    // entry.type === 'assistant'
    if (message.role !== 'assistant' || message.model === '<synthetic>') continue
    if (!Array.isArray(message.content)) continue

    if (!current || current.role !== 'assistant') {
      current = { id: nextId('h-a'), role: 'assistant', text: '' }
      result.push(current)
    }

    for (const block of message.content) {
      if (block.type === 'text' && typeof block['text'] === 'string') {
        current.text += (current.text ? '\n\n' : '') + (block['text'] as string)
      } else if (block.type === 'thinking' && typeof block['thinking'] === 'string') {
        current.thinking = (current.thinking ?? '') + (block['thinking'] as string)
      } else if (block.type === 'tool_use') {
        current.toolCalls = [
          ...(current.toolCalls ?? []),
          {
            id: String(block['id']),
            name: String(block['name']),
            summary: summariseToolCall(String(block['name']), block['input']),
            detail: describeToolInput(block['input']),
            running: false
          }
        ]
      }
    }
  }

  return result
}

function describeResultFailure(subtype: string): string {
  if (subtype.includes('max_turns')) {
    return "La réponse s'est arrêtée : trop d'étapes enchaînées. Reformule en découpant ta demande."
  }
  return "La réponse s'est interrompue avant la fin."
}

/** Exportee : le tuteur de flashcards raconte ses echecs avec les memes mots. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)

  if (/ENOENT|not found|introuvable/i.test(raw)) {
    return "Claude Code est introuvable. Vérifie qu'il est installé, puis relance Noted."
  }
  if (/auth|credential|unauthor|401|403/i.test(raw)) {
    return 'Authentification refusée. Ouvre un terminal, tape « claude » et reconnecte-toi à ton abonnement.'
  }
  if (/rate.?limit|429|usage limit/i.test(raw)) {
    return "Limite d'usage atteinte sur ton abonnement Claude. Réessaie un peu plus tard."
  }
  return raw
}

/** Arrete le tour en cours pour ce cours, s'il y en a un. */
export function interrupt(courseId: string): void {
  // Une proposition d'ecriture ou un quiz encore a l'ecran appartiennent au
  // tour qu'on arrete : ils doivent disparaitre avec lui.
  cancelProposals(courseId)
  cancelQuizzes(courseId)

  const session = sessions.get(courseId)
  if (!session?.active) return

  session.active.abort.abort()
  try {
    session.active.query.close()
  } catch {
    // La requete etait deja terminee : rien a fermer.
  }
  session.active = undefined
}

/** Oublie la conversation d'un cours en gardant son texte extrait. */
export function reset(courseId: string): void {
  interrupt(courseId)
  const session = sessions.get(courseId)
  if (session) {
    session.sessionId = undefined
    session.turns = 0
  }
}

// ---------------------------------------------------------------------------
// Historique : conversations passees, stockees par le CLI lui-meme
// ---------------------------------------------------------------------------

/**
 * Les conversations passees de ce cours, la plus recente d'abord. Toutes les
 * sessions du vault partagent le meme dossier de travail (`cwd`) : seule
 * l'etiquette posee par `send` a la creation les rattache a leur cours.
 */
export async function historyFor(courseId: string): Promise<ChatHistoryEntry[]> {
  const sdk = await loadSdk()
  const all = await sdk.listSessions({ dir: vaultPaths().root, includeProgrammatic: true })
  const activeId = sessions.get(courseId)?.sessionId

  return all
    .filter((entry) => entry.tag === courseId)
    .sort((a, b) => b.lastModified - a.lastModified)
    .map((entry) => ({
      sessionId: entry.sessionId,
      title:
        entry.customTitle || entry.summary || userText(entry.firstPrompt ?? '') || 'Conversation',
      lastModified: entry.lastModified,
      active: entry.sessionId === activeId
    }))
}

/**
 * Reprend une conversation passee comme fil actif du cours — choisie dans le
 * picker d'historique — et rend son contenu pour l'afficher.
 */
export async function openSession(courseId: string, sessionId: string): Promise<ChatMessage[]> {
  interrupt(courseId)
  const session = sessionFor(courseId)
  session.sessionId = sessionId
  session.turns = 0

  const sdk = await loadSdk()
  const raw = await sdk.getSessionMessages(sessionId, { includeSystemMessages: true })
  return convertHistory(raw)
}

/**
 * A la premiere ouverture d'un cours dans cette session de l'application (rien
 * en memoire encore), reprend sa derniere conversation si le CLI en a garde
 * une — sinon rend null, et le panneau part d'un fil vide comme aujourd'hui.
 */
export async function hydrate(
  courseId: string
): Promise<{ sessionId: string; messages: ChatMessage[] } | null> {
  const session = sessionFor(courseId)

  if (session.sessionId) {
    const sdk = await loadSdk()
    const raw = await sdk.getSessionMessages(session.sessionId, { includeSystemMessages: true })
    return { sessionId: session.sessionId, messages: convertHistory(raw) }
  }

  const history = await historyFor(courseId)
  if (history.length === 0) return null

  const messages = await openSession(courseId, history[0].sessionId)
  return { sessionId: history[0].sessionId, messages }
}

/**
 * Compacte la conversation en cours d'un cours — l'equivalent de `/compact`
 * dans Claude Code. Le resume remplace l'essentiel de l'echange precedent
 * dans ce que la session renvoie desormais au modele a chaque tour : le
 * prochain message paie une fois le cout d'un nouveau cache, les suivants
 * profitent du fil redevenu court.
 */
export async function compactSession(courseId: string, course: Course): Promise<CompactOutcome> {
  const session = sessionFor(courseId)
  if (!session.sessionId) {
    return { ok: false, error: 'Aucune conversation à compacter pour ce cours.' }
  }

  // Un seul tour a la fois par cours, comme pour un message ordinaire.
  interrupt(courseId)
  const abort = new AbortController()

  try {
    const sdk = await loadSdk()
    const options = await buildOptions(course, session, {})
    options.abortController = abort

    const stream = sdk.query({ prompt: '/compact', options })
    session.active = { query: stream, abort }

    let dropped: number | undefined
    let failure: string | undefined

    for await (const message of stream) {
      const withSession = message as { session_id?: string }
      if (withSession.session_id) session.sessionId = withSession.session_id

      if (message.type === 'system' && message.subtype === 'status' && message.compact_result === 'failed') {
        failure = message.compact_error ?? 'Compaction impossible.'
      }
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        const metadata = message.compact_metadata as { pre_tokens: number; post_tokens?: number }
        dropped = metadata.pre_tokens - (metadata.post_tokens ?? 0)
      }
    }

    if (failure) return { ok: false, error: failure }
    return { ok: true, droppedTokens: dropped }
  } catch (error) {
    if (abort.signal.aborted) return { ok: false, error: 'Compaction interrompue.' }
    return { ok: false, error: describeError(error) }
  } finally {
    if (session.active?.abort === abort) session.active = undefined
  }
}

/**
 * Suit un cours renomme ou deplace. La conversation porte sur le contenu du
 * document, qui n'a pas change : la perdre au motif que le fichier a change de
 * nom obligerait a tout reexpliquer a l'assistant.
 */
export function renameSession(previousId: string, nextId: string): void {
  const session = sessions.get(previousId)
  if (!session) return

  // Un tour en cours cite l'ancien identifiant dans ses outils : on l'arrete
  // plutot que de le laisser chercher dans un cours qui n'existe plus.
  interrupt(previousId)
  sessions.delete(previousId)
  sessions.set(nextId, session)
}

/** Ferme et oublie la conversation d'un cours supprime. */
export function forgetSession(courseId: string): void {
  interrupt(courseId)
  sessions.delete(courseId)
}

/** Ferme tous les sous-processus. Appele a la fermeture de l'application. */
export function disposeAllSessions(): void {
  for (const courseId of sessions.keys()) {
    interrupt(courseId)
  }
  sessions.clear()
}
