/**
 * La generation des flashcards, en tache de fond.
 *
 * Un agent dedie — jamais l'assistant de conversation — recoit les surlignages
 * jaunes, verts et bleus qui n'ont pas encore de cartes, et appelle un outil
 * minimal, « creer_carte » : un recto, un verso, l'identifiant du surlignage.
 * Toute la structure (identifiants, etat de repetition, fichier) est posee par
 * l'application ; l'agent n'ecrit que le contenu.
 *
 * Rien n'apparait dans le fil de conversation : le declenchement part d'une
 * ecriture de surlignages (avec un delai, le temps de finir de surligner) ou
 * du demarrage de l'application, une seule generation tourne a la fois, et le
 * resultat se voit sur la page Flashcards.
 *
 * Le modele est Haiku par defaut (voir GENERATION_MODEL) : la tache est
 * mecanique — un decoupage recto/verso a partir d'un passage deja choisi par
 * le surlignage — et n'a pas besoin du raisonnement d'un modele plus lourd.
 *
 * C'est aussi la seule tache confiee a OpenRouter quand une cle y est posee
 * (voir claude/openrouter.ts) : elle tourne en fond, ne rend rien a l'ecran
 * qu'un lot de cartes, et la sortir de l'abonnement rend son quota a ce qui
 * s'en sert vraiment — l'assistant du cours et le tuteur. Sans cle, rien ne
 * change : la generation repart sur l'abonnement et sur Haiku.
 *
 * Les routes se tentent dans un ordre fixe : Gemini d'abord — le CLI officiel
 * Antigravity en sous-processus, sur le quota du compte Google (voir gemini/)
 * —, OpenRouter ensuite, l'abonnement Claude en dernier. Une route qui ne rend
 * aucune carte passe la main a la suivante : une fournee consommee sans carte
 * perdrait ses surlignages pour de bon, ils ne sont proposes qu'une fois.
 * L'abonnement ne pouvait pas etre un modele de plus dans la liste OpenRouter
 * (il demande un autre environnement) ; Gemini ne parle meme pas le protocole
 * Anthropic — sa route a son propre moteur, mais sert les memes outils aux
 * memes handlers, par un serveur MCP ephemere (gemini/mcp.ts).
 *
 * Le passage n'arrive qu'avec un peu de contexte immediat (avant/apres, une
 * quarantaine de caracteres — voir CONTEXT dans lib/annotate.ts, pense pour
 * raccrocher un surlignage deplace, pas pour l'expliquer). Ca ne suffit pas
 * toujours : un « ce » qui renvoie a une comparaison faite plus haut, un terme
 * defini dans une section precedente. Le meme outil de consultation que le
 * tuteur de flashcards (`courseConsultTools`, lecture seule) est donc offert
 * quand le cours est indexe.
 *
 * La consigne qui l'accompagne differe selon la route, parce que les modeles
 * n'y repondent pas pareil. Sur l'abonnement, Haiku sait juger quand le
 * passage ne se suffit pas : on lui demande de ne consulter qu'alors, et pas
 * en reflexe. Sur la passerelle, la meme consigne mesuree a l'usage se lit
 * comme une permission — les cartes sortaient avec un « ce ratio » non
 * resolu ; on y demande donc une consultation par surlignage, sans exception.
 * D'ou le budget de tours qui suit la taille de la fournee sur cette route,
 * la ou douze suffisaient a l'autre.
 */

import { z } from 'zod'
import { HIGHLIGHT_COLORS } from '../../shared/types'
import type { PromptAnnexe } from '../../shared/types'
import { CONSULT_TOOL_NAMES, consultToolDefinitions, courseConsultTools } from '../claude/tools'
import { childEnvironment, resolveExecutable } from '../claude/provider'
import { openRouter } from '../claude/openrouter'
import { loadSdk } from '../claude/sdk'
import { geminiRoute } from '../gemini/provider'
import type { GeminiSetup } from '../gemini/provider'
import { runGemini } from '../gemini/run'
import { readExtraction } from '../extraction-cache'
import { composePrompt } from '../prompts/store'
import { indexCourse, indexedCourse } from '../rag/store'
import { findCourse, listSubjects } from '../vault'
import { appendCards, notifyFlashcardsChanged, pendingAnnotations } from './store'
import type { DraftCard } from './store'

type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk')

/**
 * Delai entre le dernier surlignage et la generation : assez long pour ne pas
 * partir pendant qu'on surligne encore la meme page, assez court pour que les
 * cartes arrivent dans la seance de travail.
 */
const SETTLE_DELAY = 90_000

/** Au demarrage, on laisse d'abord l'application s'installer. */
const STARTUP_DELAY = 15_000

/** Au-dela, la fournee est coupee en plusieurs generations successives. */
const BATCH_LIMIT = 24

/**
 * Haiku, choisi par Raphael : le plus rapide, suffisant pour cette tache.
 * L'alias suit les versions sans qu'on y revienne. Sert quand aucune cle
 * OpenRouter n'est posee, et de repli si celle-ci devient illisible.
 */
const GENERATION_MODEL = 'haiku'

/** Une generation qui deraille ne doit pas tourner sans fin. */
const GENERATION_TIMEOUT = 180_000

/**
 * La route Gemini raisonne longuement et consulte le cours : son plafond est
 * plus large que celui des routes Claude, sans etre infini — la file de
 * generation doit toujours finir par se liberer, meme sur un processus muet.
 */
const GEMINI_TIMEOUT = 480_000

// ---------------------------------------------------------------------------
// Etat : les cours en attente, la generation en cours
// ---------------------------------------------------------------------------

const timers = new Map<string, NodeJS.Timeout>()
const queue: string[] = []
let running = false

/** Ce que le tableau de bord affiche : ca tourne, et combien de cours attendent. */
export async function generationStatus(): Promise<{ generating: boolean; pending: number }> {
  // Un delai en cours ne veut pas dire qu'il y a du travail : l'ecriture qui
  // l'a pose peut n'avoir touche que des surlignages rouges ou des
  // suppressions. On ne compte que les cours qui ont reellement des
  // surlignages eligibles sans cartes.
  const candidates = new Set([...queue, ...timers.keys()])
  let pending = 0
  for (const courseId of candidates) {
    try {
      if ((await pendingAnnotations(courseId)).length > 0) pending += 1
    } catch {
      // Cours disparu entre-temps : rien a compter.
    }
  }
  return { generating: running, pending: pending + (running ? 1 : 0) }
}

/**
 * A appeler apres chaque ecriture de surlignages : (re)pose le delai du cours.
 * Le fichier est relu au declenchement — inutile de transporter la liste.
 */
export function scheduleGeneration(courseId: string, delay = SETTLE_DELAY): void {
  const existing = timers.get(courseId)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    timers.delete(courseId)
    enqueue(courseId)
  }, delay)
  // Un timer en attente ne doit pas retenir l'application a la fermeture.
  timer.unref?.()
  timers.set(courseId, timer)
}

/**
 * Au demarrage : repere les cours dont des surlignages attendent encore leurs
 * cartes — l'application etait fermee quand ils ont ete poses, ou une
 * generation a echoue faute de reseau.
 */
export async function scanForGeneration(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, STARTUP_DELAY).unref?.())
  try {
    const subjects = await listSubjects()
    for (const subject of subjects) {
      for (const course of subject.courses) {
        const pending = await pendingAnnotations(course.id)
        if (pending.length > 0) enqueue(course.id)
      }
    }
  } catch (error) {
    console.warn('[flashcards] balayage au demarrage impossible :', error)
  }
}

function enqueue(courseId: string): void {
  if (!queue.includes(courseId)) {
    queue.push(courseId)
    notifyFlashcardsChanged()
  }
  void drain()
}

/** Une generation a la fois, comme la vectorisation : la machine reste douce. */
async function drain(): Promise<void> {
  if (running) return
  running = true

  try {
    while (queue.length > 0) {
      const courseId = queue.shift()!
      try {
        await generateFor(courseId)
      } catch (error) {
        // Hors ligne, authentification, cours disparu : on n'insiste pas, le
        // prochain declencheur (surlignage ou demarrage) retentera.
        console.warn(`[flashcards] generation impossible pour ${courseId} :`, error)
      }
      notifyFlashcardsChanged()
    }
  } finally {
    running = false
    notifyFlashcardsChanged()
  }
}

// ---------------------------------------------------------------------------
// La generation d'un cours
// ---------------------------------------------------------------------------

/** Le sens de chaque couleur, dit avec les mots de la legende. */
function colourMeaning(colourId: string): string {
  const colour = HIGHLIGHT_COLORS.find((entry) => entry.id === colourId)
  return colour ? colour.label : colourId
}

/**
 * L'outil d'ecriture, seul geste de l'agent — extrait de son serveur pour que
 * la route Gemini serve exactement la meme definition (memes schema et
 * handler) par son propre serveur MCP.
 */
function creerCarteTool(sdk: AgentSdk, drafts: DraftCard[], validIds: Set<string>) {
  return sdk.tool(
    'creer_carte',
    "Enregistre une flashcard. Donne uniquement le contenu — recto, verso — et l'identifiant du surlignage d'origine : la structure, l'apparence et la planification de revision sont l'affaire de l'application.",
    {
      surlignage: z
        .string()
        .describe('Identifiant du surlignage dont la carte est tiree, tel que fourni dans la liste.'),
      recto: z
        .string()
        .min(1)
        .describe(
          'La question, en Markdown. Autonome : comprehensible sans le cours sous les yeux. Formules en $…$.'
        ),
      verso: z
        .string()
        .min(1)
        .describe('La reponse, en Markdown. Complete mais compacte. Formules en $…$.')
    },
    async ({ surlignage, recto, verso }) => {
      if (!validIds.has(surlignage)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Identifiant inconnu : ${surlignage}. Reprends un identifiant de la liste fournie.`
            }
          ]
        }
      }
      drafts.push({ annotationId: surlignage, recto: recto.trim(), verso: verso.trim() })
      return { content: [{ type: 'text' as const, text: 'Carte enregistree.' }] }
    }
  )
}

function cardTools(sdk: AgentSdk, drafts: DraftCard[], validIds: Set<string>) {
  return sdk.createSdkMcpServer({
    name: 'cartes',
    version: '1.0.0',
    tools: [creerCarteTool(sdk, drafts, validIds)]
  })
}

/**
 * La consigne vient de Prompts/generateur.md dans le vault ; ce qui suit ne
 * fait que lui ajouter la regle de consultation.
 *
 * Statique quand le cours n'est pas indexe (rare : un cours jamais ouvert
 * depuis un redemarrage, ou un format sans cache d'extraction — voir
 * extraction-cache.ts). Sinon, une regle de plus sur le seul outil qui
 * change reellement de comportement selon le cas : ne pas la mentionner
 * quand il n'est pas la eviterait un outil promis et absent.
 */
function systemPrompt(base: string, searchable: boolean, insistant: boolean): string {
  return `${base}${searchRule(searchable, insistant)}`
}

/**
 * La regle de consultation, ajoutee sous la consigne quand le cours est
 * indexe. Vide sinon : ne pas mentionner un outil absent evite de le promettre.
 *
 * Mesure faite sur un surlignage construit pour ca (« ce ratio ne doit jamais
 * franchir ce seuil », son referent trois sections plus haut) : Haiku appelle
 * rechercher puis lire et nomme le ratio ; Nemotron ne consulte pas et rend
 * « un ratio de covenant ». La consigne d'origine dit quand s'abstenir avant
 * de dire quand chercher, et les modeles gratuits la lisent comme une
 * permission la ou Haiku y lit un devoir. La version insistante inverse
 * l'ordre et donne le test a faire, sans lever le frein : une consultation par
 * surlignage couterait des requetes que le palier gratuit compte.
 */
function searchRule(searchable: boolean, insistant: boolean): string {
  return !searchable
    ? ''
    : insistant
      ? `\n- **Consulte le cours pour chaque surlignage, sans exception.** Ce qu'on te donne est un extrait : quelques dizaines de caractères avant et après, jamais de quoi savoir dans quoi il s'inscrit. Avant d'écrire la moindre carte, appelle rechercher sur le sujet du passage pour retrouver la section dont il est tiré ; enchaîne avec lire quand la recherche ne suffit pas à lever une référence. Fais-le même quand le passage te semble clair : tant que tu n'as pas regardé, tu ne peux pas savoir ce qu'il te manque.\n- C'est ce qui te permet de nommer ce que le passage désigne par « ce ratio », « cette méthode », « ce seuil », de développer les sigles à leur première apparition, et de reprendre le vocabulaire exact du support plutôt que le tien.\n- Une carte qui recopie un démonstratif sans le résoudre est inutilisable : elle est révisée sans le cours sous les yeux.`
      : `\n- Le passage arrive avec un peu de contexte immédiat, pas plus. Quand ça ne suffit pas pour comprendre de quoi il parle — un « ce » ou « cela » qui renvoie à une comparaison faite plus haut, un terme défini dans une section précédente — utilise rechercher puis lire pour retrouver ce contexte avant d'écrire la carte. Ne les appelle jamais quand le passage se suffit déjà à lui-même : la plupart le font, et un détour inutile ne fait que ralentir la fournée.`
}

/**
 * Les deux blocs que l'application ajoute, pour l'ecran Parametres : la regle
 * de consultation sous la consigne, et le message qui porte les surlignages.
 * Produits par les fonctions qui les ajoutent reellement, sur un exemple.
 */
export function generationAnnexes(): PromptAnnexe[] {
  return [
    {
      titre: 'Ajoute sous le prompt quand le support du cours est indexé',
      texte: searchRule(true, false).trimStart()
    },
    {
      titre: 'Puis, dans le message : le cours et chaque surlignage',
      texte: buildPrompt('Private Equity', 'cours lbo', [
        {
          id: 'a3f9c1',
          colour: 'definition',
          page: 12,
          heading: null,
          text: 'Le WACC est le coût moyen pondéré du capital.',
          before: 'On actualise les flux au WACC. ',
          after: " Il sert de taux d'actualisation de référence."
        }
      ])
    }
  ]
}

/** Construit le message : le cours, puis chaque surlignage avec son contexte. */
function buildPrompt(
  subject: string,
  title: string,
  batch: { id: string; colour: string; page: number | null; heading: string | null; text: string; before: string; after: string }[]
): string {
  const lines = [
    `Cours : « ${title} » (matière : ${subject}).`,
    `Surlignages à transformer en cartes — appelle creer_carte pour chaque carte, avec l'identifiant exact :`,
    ''
  ]

  for (const annotation of batch) {
    const where = annotation.page
      ? `p. ${annotation.page}`
      : annotation.heading || 'sans référence'
    lines.push(
      `### ${annotation.id} — ${colourMeaning(annotation.colour)} (${where})`,
      annotation.before ? `…${annotation.before}` : '',
      `>>> ${annotation.text} <<<`,
      annotation.after ? `${annotation.after}…` : '',
      ''
    )
  }

  return lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')
}

/**
 * Ce qui distingue une tentative d'une autre : a qui on parle, avec quel
 * modele, et si la consigne de consultation doit insister.
 */
interface Route {
  model: string
  fallbackModel?: string
  env: Record<string, string | undefined>
  insistant: boolean
}

/** Ce qu'une tentative rapporte : ses cartes, et son echec eventuel. */
interface Attempt {
  drafts: DraftCard[]
  failure: unknown
}

/** Genere les cartes manquantes d'un cours, une fournee a la fois. */
async function generateFor(courseId: string): Promise<void> {
  const pending = await pendingAnnotations(courseId)
  if (pending.length === 0) return

  const batch = pending.slice(0, BATCH_LIMIT)
  const course = await findCourse(courseId)

  const sdk = await loadSdk()
  const executable = await resolveExecutable()
  if (!executable) throw new Error('binaire claude introuvable')

  // Le binaire reste le meme : seule change la passerelle a laquelle il parle,
  // et donc le modele qu'on peut lui demander. Null quand aucune cle n'est
  // posee, et tout ce qui suit se comporte comme avant.
  const gateway = await openRouter()

  // Le cours peut deja etre indexe (ouvert plus tot dans la session) ; sinon,
  // on tente depuis le cache d'extraction sur le disque — jamais une lecture
  // fraiche du document, que seule l'ouverture du cours declenche. Un cours
  // jamais ouvert depuis un redemarrage, ou un format sans cache, generera
  // sans l'outil de consultation : le contexte immediat du surlignage reste
  // la base, la consultation n'est qu'un complement.
  if (!indexedCourse(courseId)) {
    const extracted = await readExtraction(courseId)
    if (extracted) indexCourse(extracted)
  }
  const searchable = indexedCourse(courseId) !== null

  const validIds = new Set(batch.map((annotation) => annotation.id))
  const prompt = buildPrompt(course.subject, course.title, batch)

  // Lue une fois pour la fournee, et non a chaque tentative : les deux routes
  // partent de la meme consigne, seule la regle de consultation les separe.
  const rules = await composePrompt('generateur')

  /**
   * Une tentative complete sur une route donnee. Chacune a ses propres
   * brouillons et sa propre minuterie : la seconde ne doit rien heriter de la
   * premiere, ni ses cartes ni son delai deja consomme.
   */
  const attempt = async (route: Route): Promise<Attempt> => {
    const drafts: DraftCard[] = []
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), GENERATION_TIMEOUT)
    timeout.unref?.()

    const query = sdk.query({
      prompt,
      options: {
        systemPrompt: systemPrompt(rules, searchable, route.insistant),
        mcpServers: searchable
          ? { cartes: cardTools(sdk, drafts, validIds), cours: courseConsultTools(sdk, courseId) }
          : { cartes: cardTools(sdk, drafts, validIds) },
        tools: [],
        allowedTools: searchable
          ? ['mcp__cartes__creer_carte', ...CONSULT_TOOL_NAMES]
          : ['mcp__cartes__creer_carte'],
        disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch'],
        permissionMode: 'bypassPermissions',
        settingSources: [],
        model: route.model,
        // Les modeles suivants de la liste, essayes dans l'ordre si le premier
        // est indisponible. Sans passerelle, il n'y a rien a replier : Haiku
        // fait partie de l'abonnement.
        fallbackModel: route.fallbackModel,
        // Sans consultation, les cartes du lot tiennent presque toujours en un
        // ou deux tours. Avec, quelques surlignages ambigus peuvent chacun
        // couter une recherche puis une lecture — d'ou la marge, sans l'ouvrir
        // en grand comme pour l'assistant du cours (24) qui documente chaque
        // reponse.
        //
        // La consigne insistante change l'echelle : elle demande une
        // consultation par surlignage, la ou les douze tours etaient calibres
        // pour quelques-unes. Mesure faite, un surlignage consulte coute
        // jusqu'a trois tours (rechercher, lire, creer_carte) ; le budget suit
        // donc la taille de la fournee au lieu d'etre fixe. Sans cette marge,
        // le plafond tomberait en plein milieu du lot — et la fournee serait
        // consommee avec la moitie de ses cartes.
        maxTurns: !searchable
          ? 6
          : route.insistant
            ? Math.min(3 * batch.length + 6, 90)
            : 12,
        pathToClaudeCodeExecutable: executable,
        env: route.env,
        abortController: abort
      }
    })

    let failure: unknown = null
    try {
      for await (const message of query) {
        if (message.type === 'result') {
          // Une session qui s'arrete d'elle-meme — plafond de tours atteint,
          // erreur du moteur — n'a pas fini le lot. Sans ce releve, elle
          // passait pour complete : la fournee entiere etait marquee traitee
          // alors que seuls les premiers surlignages avaient leur carte, et
          // les autres etaient perdus. Le releve les renvoie a la fournee
          // suivante. La consigne insistante rend ce cas moins theorique :
          // elle multiplie les tours, donc les occasions de toucher le
          // plafond.
          if (message.subtype !== 'success') {
            failure = new Error(`session interrompue (${message.subtype})`)
          }
          break
        }
      }
    } catch (error) {
      failure = error
    } finally {
      clearTimeout(timeout)
      try {
        query.close()
      } catch {
        // Deja fermee.
      }
    }

    return { drafts, failure }
  }

  /** La route de l'abonnement : celle d'avant les passerelles, mot pour mot. */
  const abonnement: Route = {
    model: GENERATION_MODEL,
    env: childEnvironment(),
    insistant: false
  }

  /**
   * La tentative Gemini : meme contrat que les autres — ses cartes, son echec
   * eventuel — mais un autre moteur : le CLI officiel Antigravity (agy) en
   * sous-processus, nos outils servis par un serveur MCP ephemere
   * (gemini/run.ts). Les handlers s'executent ici meme, au fil de la session :
   * une session interrompue a mi-lot garde ses cartes deja creees, exactement
   * comme sur les routes Claude. La consigne de consultation est la mesuree,
   * pas l'insistante : le modele demande a cette route raisonne a fond
   * (suffixe -high) et sait juger quand le passage ne se suffit pas — a
   * regler a l'usage si les cartes disent le contraire. Pas de plafond de
   * tours : agy n'en expose pas en headless, c'est sa minuterie qui borne.
   */
  const attemptGemini = async (setup: GeminiSetup): Promise<Attempt> => {
    const drafts: DraftCard[] = []
    const tools = [
      creerCarteTool(sdk, drafts, validIds),
      ...(searchable ? consultToolDefinitions(sdk, courseId) : [])
    ]
    const { failure } = await runGemini({
      executable: setup.executable,
      model: setup.model,
      systemPrompt: systemPrompt(rules, searchable, false),
      prompt,
      tools,
      timeout: GEMINI_TIMEOUT
    })
    return { drafts, failure }
  }

  /**
   * Les routes, dans l'ordre choisi : Gemini (raisonnement approfondi, quota
   * Google), la passerelle OpenRouter, l'abonnement. Une route qui ne rend
   * aucune carte passe la main a la suivante — une passerelle rend certaines
   * de ses erreurs dans le fil (modele sature, quota de la journee epuise)
   * sans faire echouer la session, qui se dirait complete et consommerait la
   * fournee sans qu'aucune carte ait ete ecrite. Les surlignages seraient
   * alors perdus pour de bon, puisqu'ils ne sont proposes qu'une fois.
   *
   * Le dernier cran reste l'abonnement : le repli d'OpenRouter s'arrete au
   * dernier modele de sa liste, celui de Claude Code ne se declenche pas sur
   * un quota depasse (mesure : un modele rate-limite occupe la minuterie
   * entiere sans qu'aucun repli parte), et l'abonnement ne peut pas etre un
   * modele de plus dans ces listes — il demande un autre environnement.
   */
  const routes: { nom: string; tenter: () => Promise<Attempt> }[] = []
  const gemini = await geminiRoute()
  if (gemini) {
    routes.push({ nom: `gemini (${gemini.model})`, tenter: () => attemptGemini(gemini) })
  }
  if (gateway) {
    routes.push({
      nom: gateway.model,
      tenter: () =>
        attempt({
          model: gateway.model,
          fallbackModel: gateway.fallbackModel,
          env: gateway.env,
          insistant: true
        })
    })
  }
  routes.push({ nom: `abonnement (${GENERATION_MODEL})`, tenter: () => attempt(abonnement) })

  let { drafts, failure } = await routes[0].tenter()
  for (let index = 1; index < routes.length && drafts.length === 0; index += 1) {
    console.warn(
      `[flashcards] ${routes[index - 1].nom} n'a rien rendu pour ${courseId} — reprise sur ${routes[index].nom}.`
    )
    ;({ drafts, failure } = await routes[index].tenter())
  }

  // Session interrompue sans la moindre carte : rien a garder, on laisse le
  // prochain declencheur reprendre tout.
  if (failure && drafts.length === 0) throw failure

  // Plusieurs routes ont echoue en silence : la fournee n'est pas consommee.
  // Quand seul l'abonnement a tourne, rien ne change : une fournee sans carte
  // y reste un jugement de l'agent, et les surlignages sans contenu testable
  // sont marques traites comme avant.
  if (routes.length > 1 && drafts.length === 0) {
    throw new Error('aucune carte rendue par aucune des routes')
  }

  // Session complete : tous les surlignages soumis sont traites, meme ceux
  // dont l'agent n'a rien tire. Session interrompue en chemin : seuls ceux
  // qui ont recu leurs cartes le sont, les autres repasseront.
  const done = failure
    ? batch.filter((annotation) => drafts.some((draft) => draft.annotationId === annotation.id))
    : batch

  await appendCards(
    courseId,
    drafts,
    done.map(({ id, colour, page, heading }) => ({ id, colour, page, heading }))
  )

  // Il en restait plus que la fournee : on repart aussitot sur le meme cours.
  if (pending.length > batch.length) enqueue(courseId)
}
