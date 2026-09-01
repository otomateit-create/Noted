/**
 * Les outils par lesquels l'assistant consulte le cours ouvert.
 *
 * Le cours n'est plus verse en entier dans le prompt : l'assistant va chercher
 * lui-meme les passages dont il a besoin. C'est ce qui rend une reponse rapide
 * meme sur un support de deux cents pages, et ce qui evite de dependre d'un
 * cache dont la duree de vie est courte.
 *
 * Deux outils, deux gestes distincts : chercher pour localiser, lire pour
 * approfondir une fois qu'on sait ou regarder. Le second compte autant que le
 * premier — un passage trouve est souvent la moitie d'une reponse, et il faut
 * pouvoir en lire le voisinage.
 *
 * Un troisieme donne acces aux surlignages. Les verser dans le prompt aurait
 * couche dans chaque conversation une liste qui vieillit des le premier
 * surlignage suivant ; en outil, elle est toujours a jour, ne coute rien quand
 * l'assistant n'en a pas besoin, et tient meme a deux cents passages marques.
 *
 * Viennent enfin les notes de l'utilisateur : une lecture qui voit ce qui est
 * a l'ecran plutot que le dernier fichier enregistre, et trois formes
 * d'ecriture — inserer, remplacer, reecrire — qui ne sont jamais appliquees
 * directement. Chacune devient un apercu dans le panneau des notes, que
 * l'utilisateur accepte ou refuse ; l'outil attend sa decision et la rapporte.
 */

import path from 'node:path'
import { z } from 'zod'
import { QUIZ_CORRECTION_BRIEF, formatQuizCopy } from '../../shared/quiz-copy'
import {
  HIGHLIGHT_COLORS,
  TABLE_ACCENTS,
  TABLE_DESIGNS,
  TABLE_MARKER,
  bareLine,
  parseTableMarker as parseTableMarkerSafe,
  tableMarker
} from '../../shared/types'
import type {
  Annotation,
  HighlightColorId,
  NoteProposalOutcome,
  QuizQuestion,
  TableAccent,
  TableDesign
} from '../../shared/types'
import { readAnnotations } from '../annotations'
import { appendManualCards } from '../flashcards/store'
import { listNoteObjects, uniqueTarget } from '../note-objects'
import type { NoteObject } from '../note-objects'
import { readNote } from '../notes'
import { proposeNoteChange, readLiveNote } from '../notes-bridge'
import { appendDraft, readDraft } from '../notes-draft'
import { postDraft } from '../notes-post'
import { askQuiz } from '../quiz-bridge'
import {
  ANCHOR_LINES,
  HEADING_PATTERN,
  anchorable,
  anchoringText,
  announces,
  assembleAnchored,
  citedPages,
  rawSpanOf,
  reattachAnchors,
  splitBlocks,
  stripAnchorLines,
  viewOf,
  widenToUnique
} from '../notes-view'
import type { NoteView, RawSpan } from '../notes-view'
import { declaredScope, resolveAnchorSequence, unitKeysForAnchors } from '../rag/auto-anchor'
import type { AnchorSlot } from '../rag/auto-anchor'
import type { Chunk } from '../rag/chunk'
import { embed } from '../rag/embedder'
import { MAX_PAGES_PER_READ, parsePageReference } from '../rag/page-range'
import { indexedCourse } from '../rag/store'
import type { IndexedCourse } from '../rag/store'
import { findCourse, vaultPaths } from '../vault'

/**
 * Le SDK est ESM-only et ce module est compile en CommonJS : il ne peut donc
 * pas etre importe ici. La session, qui le charge deja dynamiquement, nous le
 * passe. Un import statique compilerait en require() et l'application
 * echouerait au premier message.
 */
type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk')

/** Nombre de passages remontes par defaut. */
const DEFAULT_RESULTS = 8

/** Plafond : au-dela, on reverse le cours entier, ce qu'on cherche a eviter. */
const MAX_RESULTS = 25

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
}

function say(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function renderOne(chunk: Chunk): string {
  const heading = chunk.heading && chunk.heading !== chunk.anchor ? ` — ${chunk.heading}` : ''
  return `### [${chunk.anchor}]${heading}\n\n${chunk.text}`
}

function render(chunks: Chunk[]): string {
  return chunks.map(renderOne).join('\n\n---\n\n')
}

/**
 * Ce que l'assistant a deja vu du cours depuis le debut du tour.
 *
 * `cited` retient les endroits. Le lecteur humain a un ecran, et l'ancrage de
 * ses notes restreint ses candidats a ce qu'il y voit. L'assistant ne fait
 * defiler aucune interface : son equivalent est ceci, les endroits du cours
 * qu'il est lui-meme alle chercher dans le tour en cours. Une note qu'il ecrit
 * ensuite parle presque toujours de l'un d'eux, et le dire a l'ancrage vaut
 * mieux que de le laisser comparer la note aux deux mille passages du document.
 *
 * Ce qu'on garde est l'ancre lisible — « p. 12 », « 2. Les covenants » — et non
 * l'unite de document que l'ancrage attend. Ce n'est pas un raccourci : un
 * passage du decoupage large porte bien son titre de section, mais jamais
 * l'ordinal de celle-ci, et il n'a donc pas de quoi fabriquer « section:7 ».
 * `unitKeysForAnchors` fait la traduction au moment d'ancrer, en consultant le
 * decoupage fin, seul endroit ou les deux formes cohabitent.
 *
 * `shown` retient les passages eux-memes, par identifiant. Un passage deja
 * rendu en entier dans ce tour est deja dans le contexte : une recherche qui
 * le retrouve n'en redonne que la reference, au lieu de le repayer en entier.
 *
 * L'enregistrement se fait ici et non dans `render`, qui recoit pourtant
 * exactement la meme liste : `render` sert aussi le tuteur de flashcards, qui
 * lit le cours et n'ecrit jamais dans les notes, et un formateur qui modifie
 * un etat au passage obligerait chacun de ses appelants — celui d'aujourd'hui
 * comme ceux de demain — a se demander s'il doit en subir l'effet.
 */
interface TurnTrace {
  cited: Set<string>
  shown: Set<string>
}

function remember(turn: TurnTrace | undefined, chunks: Chunk[]): void {
  if (!turn) return
  for (const chunk of chunks) {
    turn.cited.add(chunk.anchor)
    turn.shown.add(chunk.id)
  }
}

/**
 * Les couleurs acceptees en filtre, prises a la table partagee : en ajouter une
 * a la legende doit suffire pour que l'assistant sache la filtrer.
 */
const COLOUR_IDS = HIGHLIGHT_COLORS.map((colour) => colour.id)

/** Le nom de la couleur tel que l'utilisateur le lit dans sa legende. */
function colourLabel(id: HighlightColorId): string {
  return HIGHLIGHT_COLORS.find((colour) => colour.id === id)?.label ?? id
}

/**
 * Les surlignages dans l'ordre du document, comme on relit les siens. La date
 * ne departage que les passages d'une meme page.
 */
function renderAnnotations(list: Annotation[]): string {
  return [...list]
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.createdAt.localeCompare(b.createdAt))
    .map((annotation) => {
      const reference = annotation.page
        ? `p. ${annotation.page}`
        : annotation.heading || 'sans référence'
      const comment = annotation.comment.trim()
        ? `\n\nNote accrochée par l'utilisateur : ${annotation.comment.trim()}`
        : ''

      return `### [${reference}] — ${colourLabel(annotation.colour)}\n\n${annotation.text}${comment}`
    })
    .join('\n\n---\n\n')
}

// ---------------------------------------------------------------------------
// Les notes de l'utilisateur
// ---------------------------------------------------------------------------

/**
 * La note telle qu'elle se lit maintenant : celle de l'ecran quand le panneau
 * des notes affiche ce cours, celle du disque sinon. La distinction est
 * annoncee a l'assistant — une note du disque peut avoir quelques secondes de
 * retard sur la frappe.
 */
async function currentNoteMarkdown(
  courseId: string
): Promise<{ markdown: string; live: boolean }> {
  const live = await readLiveNote(courseId)
  if (live !== null) return { markdown: live, live: true }

  const course = await findCourse(courseId)
  const note = await readNote(course)
  return { markdown: note.markdown, live: false }
}

/** Comparaison de titres tolerante : ni la casse ni les accents ne comptent. */
function normaliseHeading(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^#+\s*/, '')
    .trim()
}

/**
 * Une section = son titre et tout ce qui suit jusqu'au prochain titre de
 * niveau egal ou superieur. C'est la meme notion de section que dans le plan
 * d'un cours Markdown.
 */
function extractSection(markdown: string, section: string): string | null {
  const lines = markdown.split('\n')
  const wanted = normaliseHeading(section)
  if (!wanted) return null

  let start = -1
  let level = 0

  for (let index = 0; index < lines.length; index++) {
    const match = HEADING_PATTERN.exec(lines[index])
    if (!match) continue

    if (start === -1) {
      if (normaliseHeading(match[2]).includes(wanted)) {
        start = index
        level = match[1].length
      }
    } else if (match[1].length <= level) {
      return lines.slice(start, index).join('\n').trim()
    }
  }

  return start === -1 ? null : lines.slice(start).join('\n').trim()
}

/** Les titres presents dans la note, pour guider une lecture par section. */
function listHeadings(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => HEADING_PATTERN.test(line))
    .map((line) => line.trim())
}

/**
 * Les blocs d'un contenu, prets pour l'ancrage en suite.
 *
 * Chaque bloc porte le texte qu'on compare au cours et les pages qu'il cite
 * lui-meme. Un titre ne dit rien seul : il emprunte au bloc qu'il annonce son
 * texte (`anchoringText`) et ses citations, pour recevoir la meme ancre que
 * lui et rester colle a lui quand la note se range.
 */
function slotsOf(blocks: string[]): AnchorSlot[] {
  return blocks.map((block, index) => {
    const cited = citedPages(block)
    const next = blocks[index + 1]
    if (announces(block) && next !== undefined) cited.push(...citedPages(next))
    return { text: anchoringText(blocks, index), cited: [...new Set(cited)] }
  })
}

/**
 * Rattache chaque bloc d'un contenu insere au passage du cours dont il parle.
 *
 * C'est le pendant, cote assistant, de l'ancrage au fil de la frappe : la main
 * humaine ecrit bloc par bloc et chacun recoit son ancre au silence suivant ;
 * l'assistant, lui, livre plusieurs blocs d'un coup. Longtemps le contenu
 * entier n'a recu qu'une seule ancre — celle de son centre de gravite
 * vectoriel, qui n'est la page de personne quand une note resume trente pages
 * — et tous les blocs en heritaient : la marge entiere pointait le meme
 * passage. On vectorise donc chaque bloc, en un seul passage par le worker,
 * et on n'ecrit un marqueur qu'au changement d'ancre — la regle meme de
 * l'editeur, qui laisse la marge lisible et le fichier propre.
 *
 * Les blocs s'ancrent en suite et non chacun dans son coin : les pages qu'un
 * bloc cite bornent ses voisins, et l'ordre du cours departage les passages
 * qui se ressemblent (`resolveAnchorSequence`). C'est ce qui rend la suite
 * des ancres monotone, et donc le tri de la note fidele au texte.
 *
 * Le decoupage en blocs, le texte compare et la recomposition vivent dans
 * `notes-view.ts`, ou la reecriture s'en sert aussi : les deux gestes doivent
 * ancrer de la meme facon.
 */
async function anchorInsertedBlocks(
  courseId: string,
  contenu: string,
  unitKeys: string[]
): Promise<string> {
  // Un marqueur recopie depuis note_lire n'est pas du contenu : une ancre se
  // rederive, elle ne se transporte pas.
  const clean = stripAnchorLines(contenu)
  const blocks = splitBlocks(clean)
  if (blocks.length === 0) return clean

  const anchors = await resolveAnchorSequence(courseId, slotsOf(blocks), unitKeys)
  return assembleAnchored(blocks.map((block, index) => ({ block, anchor: anchors[index] ?? null })))
}

/**
 * Une reponse de l'assistant recopiee dans la note par le lecteur (« Inserer
 * dans mes notes ») : memes ancres que pour un ajout de l'assistant par
 * « note_brouillon ». Les pages que la reponse cite tiennent le role des
 * passages consultes dans le tour — c'est de celles-la qu'elle parle en
 * premier. La place, elle, se decide au tri de la note, cote panneau.
 */
export async function anchorBlocks(courseId: string, content: string): Promise<string> {
  const anchors = citedPages(content).map((page) => `p. ${page}`)
  return anchorInsertedBlocks(courseId, content, unitKeysForAnchors(courseId, anchors))
}

function countOccurrences(text: string, target: string): number {
  if (!target) return 0
  let count = 0
  let cursor = text.indexOf(target)
  while (cursor !== -1) {
    count += 1
    cursor = text.indexOf(target, cursor + 1)
  }
  return count
}

/**
 * Retrouve dans le fichier brut un passage que le modele a vise dans la vue.
 *
 * Le modele lit la vue — des reperes courts a la place des lignes d'ancre — et
 * recopie ses cibles depuis elle. L'unicite se juge donc sur la vue ; le passage
 * brut correspondant est ensuite elargi, s'il le faut, jusqu'a etre unique
 * dans le brut, que le renderer verifie de son cote. Rend le message a donner
 * au modele quand rien de tout cela n'est possible.
 */
function locate(
  view: NoteView,
  wanted: string,
  role: 'cible' | 'ancre'
): { target: string; prefix: string; span: RawSpan } | string {
  const occurrences = countOccurrences(view.text, wanted)
  const which = role === 'cible' ? 'la cible' : "l'ancre"

  if (occurrences === 0) {
    return (
      "Ce passage n'apparaît pas tel quel dans la note — elle a peut-être changé depuis ta lecture. " +
      (role === 'cible'
        ? 'Relis-la avec note_lire et recopie la cible exactement.'
        : "Relis-la avec note_lire et recopie l'ancre exactement, ou insère en fin de note.")
    )
  }
  if (occurrences > 1) {
    return `Ce passage apparaît ${occurrences} fois dans la note : élargis ${which} pour la rendre unique.`
  }

  const span = rawSpanOf(view, wanted)
  const unique = span ? widenToUnique(view.raw, span) : null
  if (!span || !unique) {
    return `Ce passage se confond avec le texte d'une ancre de la note : élargis ${which} d'une ligne ou deux vers le haut.`
  }
  return { ...unique, span }
}

/** Ce que l'assistant doit comprendre de la decision de l'utilisateur. */
function describeProposalStatus(outcome: NoteProposalOutcome): string {
  switch (outcome.status) {
    case 'applied':
      return 'Proposition appliquée : la note est à jour.'
    case 'refused':
      return "L'utilisateur a refusé la proposition. Ne la représente pas à l'identique : demande-lui plutôt ce qu'il voudrait changer."
    case 'stale':
      return "La note a changé pendant que la proposition attendait : rien n'a été appliqué. Relis la note avec note_lire, puis refais une proposition à jour."
    case 'not-open':
      return "Le panneau des notes de ce cours n'est pas affiché en ce moment : impossible de proposer une modification. Dis-le à l'utilisateur."
    case 'invalid':
      // La proposition n'a jamais atteint l'ecran : c'est une erreur de
      // syntaxe, corrigeable sans deranger l'utilisateur.
      return `Ta proposition n'a pas été présentée à l'utilisateur : ${
        outcome.detail ?? 'sa syntaxe est fautive'
      }. Corrige-la et refais une proposition — inutile de t'en excuser auprès de lui, il n'a rien vu.`
  }
}

/** Les outils de lecture ne modifient rien : le moteur peut les lancer ensemble. */
const READ_ONLY = { annotations: { readOnlyHint: true } }

/**
 * En deca, une page n'a presque pas de texte : c'est, presque toujours, une
 * figure — un exhibit, un graphique — que l'extraction ne sait pas rendre et
 * que « Read » sait montrer.
 */
const SPARSE_PAGE = 400

/** Le fichier du cours, tel que « Read » l'attend. */
function courseFile(courseId: string): string {
  return path.join(vaultPaths().courses, courseId)
}

/** Ce qu'on dit d'une page pauvre en texte : ou la voir. */
function sparseHint(courseId: string, page: number): string {
  return `(La p. ${page} rend peu ou pas de texte — sans doute une figure. Pour la voir telle qu'imprimée : Read « ${courseFile(courseId)} » avec pages: "${page}".)`
}

/**
 * Les passages d'une portee — des pages, ou une section —, ou le message a
 * rendre si la portee ne se lit pas. Null quand rien ne restreint.
 */
function scopeOf(
  course: IndexedCourse,
  pages: string | undefined,
  section: string | undefined
): Set<string> | null | string {
  if (pages?.trim()) {
    if (course.anchor !== 'page') return "Ce document n'a pas de pages : restreins avec « section »."
    const span = parsePageReference(pages)
    if (!span) return `Portée illisible : « ${pages} ». Écris « 40-115 » ou « 60 ».`
    const ids = new Set<string>()
    for (const chunk of course.index.all()) {
      if (chunk.page !== null && chunk.page >= span.from && chunk.page <= span.to) ids.add(chunk.id)
    }
    return ids
  }
  if (section?.trim()) {
    const chunks = course.index.section(section)
    if (chunks.length === 0) return `Aucune section « ${section} » dans le plan du document.`
    return new Set(chunks.map((chunk) => chunk.id))
  }
  return null
}

/**
 * Les deux outils de consultation du cours, extraits pour etre partages :
 * l'assistant du cours les recoit avec toute sa panoplie, le tuteur de
 * flashcards ne recoit qu'eux — il lit le support, il n'ecrit rien.
 */
function buildRechercher(sdk: AgentSdk, courseId: string, turn?: TurnTrace) {
  return sdk.tool(
    'rechercher',
    "Cherche dans le cours ouvert les passages lies a une question ou a des mots-cles. C'est le moyen normal d'acceder au contenu du cours : utilise-le avant de repondre. Chaque passage revient avec sa reference — numero de page ou titre de section — que « lire » accepte telle quelle pour ouvrir son contexte complet. Une seule recherche suffit rarement — enchaine plusieurs formulations : le terme technique, son synonyme, le mot anglais, un chiffre caracteristique — et demande les recherches independantes dans le meme message, elles partent ensemble. « pages » ou « section » restreignent la recherche a une partie du cours. Un passage deja rendu dans ce tour ne revient que par sa reference.",
    {
      requete: z
        .string()
        .describe(
          'Les mots a chercher. Prefere les termes techniques du cours aux mots de liaison : « covenant leverage seuil » plutot que « quel est le seuil du covenant ».'
        ),
      nombre_de_passages: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS)
        .optional()
        .describe(
          `Nombre de passages a remonter. Par defaut ${DEFAULT_RESULTS} ; monte jusqu'a ${MAX_RESULTS} quand le sujet est large.`
        ),
      pages: z
        .string()
        .optional()
        .describe('Document pagine : ne chercher que dans ces pages — « 40-115 » ou « 60 ».'),
      section: z
        .string()
        .optional()
        .describe(
          "Document a titres : ne chercher que dans cette section, par son titre tel que le plan l'ecrit."
        )
    },
    async ({ requete, nombre_de_passages, pages, section }) => {
      const course = indexedCourse(courseId)
      if (!course) {
        return say("Le cours n'est pas encore indexé. Demande à l'utilisateur de patienter quelques secondes.")
      }

      // La portee se lit avant de chercher : une portee illisible est une
      // reponse a elle seule.
      const scope = scopeOf(course, pages, section)
      if (typeof scope === 'string') return say(scope)

      // Le vecteur de la requete, quand le modele est disponible. S'il ne l'est
      // pas, la recherche se poursuit sur les seuls mots-cles.
      const { vectors: queryVectors } = await embed([requete], 'query')
      const limit = nombre_de_passages ?? DEFAULT_RESULTS

      // Avec une portee, on classe tout et on filtre apres : limiter d'abord
      // evincerait un passage du chapitre au profit d'un passage hors sujet
      // mieux classe ailleurs.
      const ranked = course.index.search(
        requete,
        scope ? course.index.size : limit,
        queryVectors?.[0] ?? null
      )
      const hits = (scope ? ranked.filter((hit) => scope.has(hit.chunk.id)) : ranked).slice(
        0,
        limit
      )

      if (hits.length === 0) {
        return say(
          `Aucun passage ne correspond à « ${requete} »${scope ? ' dans cette portée' : ' dans ce cours'}.\n\n` +
            "Essaie d'autres mots, consulte le plan du document, ou conclus que le cours ne traite pas ce point — auquel cas dis-le et cherche sur le web si la question le mérite."
        )
      }

      // Un passage deja rendu en entier dans ce tour est deja sous les yeux du
      // modele : sa reference suffit.
      const chunks = hits.map((hit) => hit.chunk)
      const rendered = chunks
        .map((chunk) =>
          turn?.shown.has(chunk.id)
            ? `### [${chunk.anchor}] — déjà rendu plus haut dans ce tour`
            : renderOne(chunk)
        )
        .join('\n\n---\n\n')
      remember(turn, chunks)

      return say(`${hits.length} passage(s) trouvé(s) pour « ${requete} » :\n\n${rendered}`)
    },
    READ_ONLY
  )
}

function buildLire(sdk: AgentSdk, courseId: string, turn?: TurnTrace) {
  return sdk.tool(
    'lire',
    "Renvoie l'integralite d'une page, d'une plage de pages ou d'une section du cours ouvert. A utiliser apres une recherche, quand un passage est prometteur mais qu'il faut son contexte complet — et quand le plan du document annonce une section qui traite le sujet, ouvre-la directement plutot que d'insister en recherche. Une plage (« 50-55 », dix pages au plus) vaut mieux que six appels ; et des lectures independantes se demandent dans le meme message, elles partent ensemble.",
    {
      reference: z
        .string()
        .describe(
          'Un numero de page (« 12 ») ou une plage (« 50-55 ») pour un document pagine ; un titre de section (« 2. Les covenants ») pour un document qui n\'a pas de pages.'
        )
    },
    async ({ reference }) => {
      const course = indexedCourse(courseId)
      if (!course) return say("Le cours n'est pas encore indexé.")

      if (course.anchor !== 'page') {
        const chunks = course.index.section(reference)
        if (chunks.length === 0) {
          return say(
            `Rien trouvé pour « ${reference} ». Vérifie le titre exact dans le plan du document.`
          )
        }
        remember(turn, chunks)
        return say(render(chunks))
      }

      const span = parsePageReference(reference)
      if (!span) {
        return say(
          `Référence illisible : « ${reference} ». Donne un numéro de page (« 12 ») ou une plage (« 50-55 »). Ce document compte ${course.pageCount} pages.`
        )
      }
      if (span.to - span.from + 1 > MAX_PAGES_PER_READ) {
        return say(
          `${MAX_PAGES_PER_READ} pages au plus par appel : demande « ${span.from}-${span.from + MAX_PAGES_PER_READ - 1} », puis la suite. Ce document compte ${course.pageCount} pages.`
        )
      }

      const parts: string[] = []
      const shown: Chunk[] = []
      for (let page = span.from; page <= Math.min(span.to, course.pageCount); page += 1) {
        const chunks = course.index.page(page)
        let part = chunks.length > 0 ? render(chunks) : `### [p. ${page}]\n\n(aucun texte extrait)`
        // Une page presque vide est presque toujours une figure : dire ou la voir.
        const text = chunks.map((chunk) => chunk.text).join('\n\n')
        if (text.length < SPARSE_PAGE) part += `\n\n${sparseHint(courseId, page)}`
        parts.push(part)
        shown.push(...chunks)
      }

      if (parts.length === 0) {
        return say(`Rien trouvé pour « ${reference} ». Ce document compte ${course.pageCount} pages.`)
      }

      remember(turn, shown)
      return say(parts.join('\n\n---\n\n'))
    },
    READ_ONLY
  )
}

/**
 * Serveur d'outils propre au cours ouvert. Il est reconstruit a chaque tour :
 * l'identifiant du cours est capture ici, donc aucun risque qu'une recherche
 * parte interroger le document precedent apres un changement de cours.
 */
export function courseTools(sdk: AgentSdk, courseId: string) {
  /**
   * Ce que l'assistant a consulte du cours depuis le debut du tour.
   *
   * Les endroits servent de candidats a l'ancrage de ce qu'il ecrit dans les
   * notes, les passages evitent de les repayer. Rien de plus n'a ete invente
   * pour les porter : `courseTools` est appele par `buildOptions`, lui-meme
   * appele une fois par message envoye — cette fermeture *est* donc l'etat du
   * tour, elle nait et meurt avec lui. Un registre range ailleurs, indexe par
   * cours, devrait etre vide a la main au bon moment, et se tromper de moment
   * signifierait ancrer une note d'un tour sur les pages consultees dans le
   * precedent.
   *
   * Un tour couvre bien plus qu'un aller-retour : l'assistant enchaine jusqu'a
   * vingt-quatre echanges d'outils avant de rendre la parole, et c'est
   * exactement la portee voulue — ce qu'il a lu pour repondre a cette
   * question-la, et rien de ce qui precede.
   */
  const turn: TurnTrace = { cited: new Set(), shown: new Set() }

  const rechercher = buildRechercher(sdk, courseId, turn)
  const lire = buildLire(sdk, courseId, turn)

  const mesSurlignages = sdk.tool(
    'mes_surlignages',
    "Renvoie les passages que l'utilisateur a surlignes dans le cours ouvert, avec leur reference, le sens de la couleur et la note qu'il y a eventuellement accrochee. A utiliser des qu'une demande porte sur ce qu'il a marque plutot que sur le cours entier — « revise ce que j'ai marque rouge », « fais des flashcards de mes definitions », « reprends tout ce que je n'ai pas compris » : c'est ce qu'il a juge important a la lecture, et cela vaut mieux qu'une recherche a l'aveugle.",
    {
      // Le sens de chaque couleur est dans le prompt systeme, une fois : le
      // repeter ici n'ajoute rien et fait deux endroits a corriger.
      couleur: z
        .enum(COLOUR_IDS)
        .optional()
        .describe(
          'Ne remonter que les surlignages de cette couleur. Sans ce parametre, tous les surlignages remontent.'
        )
    },
    async ({ couleur }) => {
      const all = await readAnnotations(courseId)

      if (all.length === 0) {
        return say(
          "L'utilisateur n'a encore rien surligné dans ce cours. Réponds à partir du cours lui-même, avec « rechercher »."
        )
      }

      if (couleur) {
        const kept = all.filter((annotation) => annotation.colour === couleur)
        if (kept.length === 0) {
          return say(
            `Aucun surlignage « ${colourLabel(couleur)} » dans ce cours, qui en compte ${all.length} au total dans les autres couleurs. Dis-le à l'utilisateur, et propose de reprendre l'ensemble ou une autre couleur.`
          )
        }

        return say(
          `${kept.length} surlignage(s) « ${colourLabel(couleur)} », dans l'ordre du document :\n\n${renderAnnotations(kept)}`
        )
      }

      return say(
        `${all.length} surlignage(s) dans ce cours, dans l'ordre du document :\n\n${renderAnnotations(all)}`
      )
    },
    READ_ONLY
  )

  const noteLire = sdk.tool(
    'note_lire',
    "Lit les notes que l'utilisateur prend sur le cours ouvert, telles qu'elles sont a l'ecran en ce moment — y compris ce qui vient d'etre tape et n'est pas encore enregistre. A appeler avant de commenter, completer ou modifier les notes : jamais de memoire. Les lignes « <!-- ancre p. 12 --> » disent en face de quel endroit du cours chaque bloc a ete ecrit ; elles appartiennent a l'application, ne les recopie pas.",
    {
      section: z
        .string()
        .optional()
        .describe(
          "Titre d'une section de la note (« Covenants ») pour ne lire qu'elle. Sans ce parametre, la note entiere."
        )
    },
    async ({ section }) => {
      const { markdown, live } = await currentNoteMarkdown(courseId)

      if (!markdown.trim()) {
        return say(
          "La note de ce cours est encore vide. Tu peux y écrire avec note_brouillon puis note_poser si l'utilisateur le demande."
        )
      }

      // La vue : les lignes d'ancre reduites a leur repere. Le modele n'a pas
      // besoin du passage qu'elles portent, et il ne doit pas le recopier.
      const view = viewOf(markdown).text

      const origin = live
        ? "telle qu'affichée à l'écran"
        : "telle qu'enregistrée sur le disque — le panneau des notes n'affiche pas ce cours en ce moment"

      if (section) {
        const found = extractSection(view, section)
        if (!found) {
          const headings = listHeadings(view)
          return say(
            `Aucune section « ${section} » dans la note.` +
              (headings.length > 0
                ? ` Sections présentes :\n${headings.join('\n')}`
                : " La note n'a pas de titres : lis-la en entier.")
          )
        }
        return say(`Section de la note (${origin}) :\n\n${found}`)
      }

      return say(`Note du cours (${origin}) :\n\n${view}`)
    },
    READ_ONLY
  )

  const noteBrouillon = sdk.tool(
    'note_brouillon',
    "Depose des passages dans le brouillon de notes du cours ouvert. C'est le seul moyen d'ajouter du contenu aux notes : tu ecris ici, l'application ancre et insere. Chaque passage doit dire, dans « source », la page ou la section du cours sur laquelle il s'appuie — c'est cette declaration, et non une devinette de l'application, qui place la note en face du bon endroit du cours. Un passage regroupe tout ce qui parle du meme endroit : plusieurs paragraphes, un titre et sa liste, un tableau ; ce qui parle d'ailleurs fait un passage separe. Appelle-le autant de fois que tu veux dans un tour — les passages s'accumulent —, puis « note_poser » quand tu as fini. Rien n'atteint la note avant.",
    {
      passages: z
        .array(
          z.object({
            source: z
              .string()
              .min(1)
              .describe(
                "L'endroit du cours sur lequel ce passage s'appuie, ecrit comme « rechercher » et « lire » te le rendent : « p. 54 » ou « p. 60-61 » pour un document pagine, le titre exact de la section pour un document a titres. Obligatoire, meme quand le passage apporte une information que le cours n'a pas : la source dit ou la note s'accroche dans le cours, pas d'ou elle est tiree. Lis avant d'ecrire — c'est ce qui rend le reperage juste."
              ),
            contenu: z
              .string()
              .min(1)
              .describe(
                "Le texte du passage, en Markdown — memes conventions que dans le prompt systeme (formules $…$, surlignages ==texte=={couleur}). Tout ce qui est ici partagera une seule ancre : n'y mets que ce qui parle de la meme source."
              )
          })
        )
        .min(1)
        .describe('Les passages a ajouter au brouillon, dans l\'ordre ou tu les ecris.')
    },
    async ({ passages }) => {
      /**
       * Les sources se verifient a l'ecriture et non a la pose, parce que
       * l'assistant est encore la pour corriger. Une source refusee dix
       * passages plus tard le forcerait a retrouver lequel, dans un texte
       * qu'il a cesse de tenir en tete.
       *
       * Le schema d'outil garantit qu'une source est presente et non vide ;
       * il ne peut rien dire de son existence dans ce cours-ci. C'est ici que
       * la question se pose, et rien n'est ecrit tant qu'une seule reponse
       * manque : un brouillon a moitie depose, dont le modele croirait la
       * moitie refusee, se reecrirait en double.
       */
      const problems = passages
        .map((passage, index) => {
          const scope = declaredScope(courseId, passage.source)
          return typeof scope === 'string'
            ? `Passage ${index + 1} (« ${passage.source} ») : ${scope}`
            : null
        })
        .filter((problem): problem is string => problem !== null)

      if (problems.length > 0) {
        return say(
          `${problems.join('\n')}\n\nRien n'a été déposé. Corrige la ou les sources et rappelle note_brouillon avec tous les passages.`
        )
      }

      const all = await appendDraft(courseId, passages)
      const total = all.length
      return say(
        `${passages.length} passage${passages.length > 1 ? 's' : ''} déposé${passages.length > 1 ? 's' : ''} au brouillon (${total} en attente au total). Continue, ou appelle note_poser quand tu as fini d'écrire.`
      )
    }
  )

  const notePoser = sdk.tool(
    'note_poser',
    "Ancre le brouillon et l'ecrit dans les notes du cours ouvert. L'application rattache chaque passage au passage precis du cours dont il parle — a l'interieur de la source que tu as declaree —, range le tout dans l'ordre du cours, et l'insere. Appelle-le une fois, quand tu as fini d'ecrire ; le brouillon est vide ensuite. L'ecriture est directe : l'utilisateur n'a rien a valider.",
    {},
    async () => {
      const waiting = await readDraft(courseId)
      if (waiting.length === 0) {
        return say(
          "Le brouillon est vide : rien à poser. Dépose d'abord tes passages avec note_brouillon."
        )
      }

      const result = await postDraft(courseId)
      const notes: string[] = []
      if (result.rejected.length > 0) {
        notes.push(
          `Ces passages n'ont pas pu être posés et restent au brouillon :\n${result.rejected.join('\n')}`
        )
      }

      if (result.posted > 0) {
        notes.unshift(
          `${result.posted} passage${result.posted > 1 ? 's' : ''} ancré${result.posted > 1 ? 's' : ''} et inséré${result.posted > 1 ? 's' : ''} dans les notes, à sa place dans l'ordre du cours.`
        )
        return say(notes.join('\n\n'))
      }

      // Rien n'est parti : le brouillon est intact et se reposera plus tard.
      // On le dit, sinon le modele reecrirait ce qu'il vient d'ecrire.
      notes.unshift(
        result.outcome
          ? describeProposalStatus(result.outcome)
          : "Rien n'a pu être posé."
      )
      notes.push('Le brouillon est conservé : ne le réécris pas.')
      return say(notes.join('\n\n'))
    }
  )
  const noteRemplacer = sdk.tool(
    'note_remplacer',
    "Propose de remplacer un passage precis des notes du cours ouvert — pour reformuler ou corriger sans toucher au reste. Pour retoucher un tableau, un schema ou un encadre, prefere note_objets puis note_objet_modifier, qui les visent par numero. L'utilisateur voit un apercu et decide ; l'appel attend sa decision.",
    {
      cible: z
        .string()
        .describe(
          "Le passage a remplacer, recopie exactement depuis note_lire, Markdown compris. Il doit apparaitre une seule fois dans la note : elargis-le s'il est ambigu."
        ),
      remplacement: z
        .string()
        .describe(
          "Le nouveau texte, en Markdown. Conserve telles quelles les balises <mark> et <span> presentes dans le passage d'origine : ce sont les surlignages et couleurs de l'utilisateur."
        )
    },
    async ({ cible, remplacement }) => {
      if (!cible.trim()) return say('Cible vide : indique le passage à remplacer.')

      const { markdown } = await currentNoteMarkdown(courseId)
      const found = locate(viewOf(markdown), cible, 'cible')
      if (typeof found === 'string') return say(found)

      // Une cible qui enjambe une ligne d'ancre l'emporte avec elle : le
      // remplacement la retrouve devant le bloc qui la portait, au caractere
      // pres. Sans ancre dans la cible, le texte du modele passe tel quel.
      const carriesAnchor = new RegExp(ANCHOR_LINES.source, 'm').test(found.span.text)
      const body = carriesAnchor
        ? assembleAnchored(reattachAnchors(found.span.text, stripAnchorLines(remplacement)))
        : remplacement

      const status = await proposeNoteChange({
        courseId,
        kind: 'remplacer',
        content: `${found.prefix}${body}`,
        target: found.target,
        trier: true
      })
      return say(describeProposalStatus(status))
    }
  )

  const noteReecrire = sdk.tool(
    'note_reecrire',
    "Propose une nouvelle version complete de la note du cours ouvert. Reserve au cas ou l'utilisateur a explicitement demande une refonte d'ensemble — « mets au propre mes notes ». Pour tout le reste, note_brouillon ou note_remplacer. L'utilisateur voit un apercu et decide ; l'appel attend sa decision.",
    {
      contenu: z
        .string()
        .describe(
          'La note entiere, reecrite en Markdown. Tout ce qui n\'y figure pas sera perdu : repars toujours du contenu rendu par note_lire.'
        )
    },
    async ({ contenu }) => {
      if (!contenu.trim()) {
        return say('Contenu vide : une réécriture ne peut pas effacer la note.')
      }

      // La note au moment de la proposition. Si elle change avant que
      // l'utilisateur accepte, la proposition est caduque : appliquer une
      // reecriture calculee sur un texte perime ecraserait sa frappe.
      const { markdown: base } = await currentNoteMarkdown(courseId)

      // Le modele n'a lu que la vue et n'ecrit pas d'ancre. Chaque bloc
      // conserve — retouche, deplace, fondu, coupe — retrouve ici l'ancre
      // qu'il avait, au caractere pres ; les blocs nouveaux s'ancrent comme
      // une insertion, d'abord parmi les endroits consultes dans ce tour.
      const blocks = reattachAnchors(base, stripAnchorLines(contenu))
      if (blocks.some((entry) => !entry.matched && anchorable(entry.block))) {
        // Les blocs retrouves gardent leur ancre et bornent les nouveaux : un
        // paragraphe ajoute entre deux blocs de la p. 54 et de la p. 60 se
        // cherche entre ces deux pages.
        const slots = slotsOf(blocks.map((entry) => entry.block)).map((slot, index) =>
          blocks[index].matched ? { ...slot, fixed: blocks[index].anchor } : slot
        )
        const anchors = await resolveAnchorSequence(
          courseId,
          slots,
          unitKeysForAnchors(courseId, [...turn.cited])
        )
        blocks.forEach((entry, index) => {
          if (!entry.matched) entry.anchor = anchors[index] ?? null
        })
      }

      const content = assembleAnchored(blocks)
      if (!content.trim()) {
        return say('Contenu vide : une réécriture ne peut pas effacer la note.')
      }

      const status = await proposeNoteChange({
        courseId,
        kind: 'reecrire',
        content,
        base,
        trier: true
      })
      return say(describeProposalStatus(status))
    }
  )

  const noteTrier = sdk.tool(
    'note_trier',
    "Range les blocs de la note du cours ouvert dans l'ordre du cours — par page, puis par passage dans la page — sans rien reecrire. A utiliser quand l'utilisateur demande de trier, ranger ou remettre ses notes dans l'ordre. Chaque ajout, remplacement ou reecriture range deja la note : cet outil sert quand il le demande pour lui-meme. L'utilisateur voit un apercu et decide ; l'appel attend sa decision.",
    {},
    async () => {
      const { markdown } = await currentNoteMarkdown(courseId)
      if (!markdown.trim()) return say('La note est vide : rien à ranger.')

      const status = await proposeNoteChange({
        courseId,
        kind: 'reecrire',
        content: markdown,
        base: markdown,
        trier: true
      })
      return say(describeProposalStatus(status))
    }
  )

  // -------------------------------------------------------------------------
  // Les objets deja poses dans la note
  // -------------------------------------------------------------------------

  const noteObjets = sdk.tool(
    'note_objets',
    "Liste les tableaux, schemas et encadres presents dans les notes du cours ouvert, avec leur numero. A appeler avant de modifier ou de supprimer l'un d'eux : c'est ce numero que prennent note_objet_modifier et note_objet_supprimer.",
    {},
    async () => {
      const { markdown } = await currentNoteMarkdown(courseId)
      const objects = listNoteObjects(markdown)

      if (objects.length === 0) {
        return say(
          "Cette note ne contient ni tableau, ni schéma, ni encadré. Pour en créer un, écris-le en Markdown avec note_brouillon."
        )
      }

      return say(
        `${objects.length} objet(s) dans la note :\n\n` +
          objects.map((object) => `${object.index}. ${object.summary}`).join('\n')
      )
    },
    READ_ONLY
  )

  /** L'objet vise, ou la raison de ne pas pouvoir le viser. */
  async function findObject(
    numero: number
  ): Promise<{ markdown: string; object: NoteObject } | string> {
    const { markdown } = await currentNoteMarkdown(courseId)
    const objects = listNoteObjects(markdown)

    const object = objects.find((entry) => entry.index === numero)
    if (!object) {
      return objects.length === 0
        ? "Cette note ne contient aucun objet à modifier."
        : `Il n'y a pas d'objet numéro ${numero}. La note en compte ${objects.length} :\n\n` +
            objects.map((entry) => `${entry.index}. ${entry.summary}`).join('\n')
    }

    return { markdown, object }
  }

  /** Repose l'habillage d'un tableau sur son texte, marqueur compris. */
  function dressTable(raw: string, design?: TableDesign, accent?: TableAccent): string {
    const lines = raw.split('\n')
    const first = TABLE_MARKER.exec(bareLine(lines[0]))
    const body = first ? lines.slice(1).join('\n') : raw

    const current = first ? parseTableMarkerSafe(first[1]) : null
    const marker = tableMarker(
      design ?? current?.design ?? 'sobre',
      accent ?? current?.accent ?? 'laiton'
    )

    return `${marker}${body}`
  }

  const noteObjetModifier = sdk.tool(
    'note_objet_modifier',
    "Propose de modifier un objet des notes designe par son numero (voir note_objets). Le parametre depend de l'objet : « design » et « accent » pour un tableau, « couleur » pour un encadre, « syntaxe » pour un schema — et « contenu » remplace n'importe quel objet en entier quand un reglage ne suffit pas. Evite de recopier tout l'objet pour n'en changer qu'un reglage. L'utilisateur voit un apercu et decide.",
    {
      numero: z.number().int().min(1).describe('Le numero rendu par note_objets.'),
      design: z
        .enum(TABLE_DESIGNS.map((entry) => entry.id) as [string, ...string[]])
        .optional()
        .describe(
          'Tableau uniquement. ' +
            TABLE_DESIGNS.map((entry) => `« ${entry.id} » = ${entry.hint}`).join(' ; ')
        ),
      accent: z
        .enum(TABLE_ACCENTS as unknown as [string, ...string[]])
        .optional()
        .describe(
          "Tableau uniquement. La couleur de l'en-tete, prise aux cinq codes semantiques : « laiton » est neutre, « definition » pour un tableau de definitions, « formule » pour des chiffres, et ainsi de suite."
        ),
      couleur: z
        .enum(COLOUR_IDS)
        .optional()
        .describe('Encadre uniquement : la nouvelle couleur, donc le nouveau sens.'),
      syntaxe: z
        .string()
        .optional()
        .describe(
          'Schema uniquement : la nouvelle syntaxe Mermaid, sans les triples accents graves. Elle est verifiee avant tout affichage.'
        ),
      contenu: z
        .string()
        .optional()
        .describe(
          "Le Markdown complet du nouvel objet, quand il change trop pour un simple reglage. Remplace tout l'objet."
        )
    },
    async ({ numero, design, accent, couleur, syntaxe, contenu }) => {
      const found = await findObject(numero)
      if (typeof found === 'string') return say(found)

      const { markdown, object } = found
      let replacement: string | null = null

      if (contenu?.trim()) {
        replacement = contenu.trim()
      } else if (object.kind === 'tableau' && (design || accent)) {
        replacement = dressTable(object.raw, design as TableDesign, accent as TableAccent)
      } else if (object.kind === 'schema' && syntaxe?.trim()) {
        replacement = `\`\`\`mermaid\n${syntaxe.trim()}\n\`\`\``
      } else if (object.kind === 'encadre' && couleur) {
        replacement = object.raw.replace(/\[![a-zA-Z-]+\]/, `[!${couleur}]`)
      }

      if (replacement === null) {
        return say(
          `L'objet ${numero} est un ${object.kind} : ${
            object.kind === 'tableau'
              ? '« design » et/ou « accent »'
              : object.kind === 'schema'
                ? '« syntaxe »'
                : '« couleur »'
          } ou « contenu » sont les paramètres qui s'y appliquent.`
        )
      }

      const aim = uniqueTarget(markdown, object)
      if (!aim) {
        return say(
          "Cet objet apparaît plusieurs fois à l'identique dans la note : impossible de le viser sans ambiguïté. Passe par note_remplacer avec un passage plus large."
        )
      }

      const status = await proposeNoteChange({
        courseId,
        kind: 'remplacer',
        content: `${aim.prefix}${replacement}`,
        target: aim.target
      })
      return say(describeProposalStatus(status))
    }
  )

  const noteObjetSupprimer = sdk.tool(
    'note_objet_supprimer',
    "Propose de retirer des notes un objet designe par son numero (voir note_objets) : un tableau, un schema ou un encadre, avec tout ce qu'il contient. L'utilisateur voit ce qui disparaitrait et decide.",
    {
      numero: z.number().int().min(1).describe('Le numero rendu par note_objets.')
    },
    async ({ numero }) => {
      const found = await findObject(numero)
      if (typeof found === 'string') return say(found)

      const { markdown, object } = found
      const aim = uniqueTarget(markdown, object)
      if (!aim) {
        return say(
          "Cet objet apparaît plusieurs fois à l'identique dans la note : impossible de le viser sans ambiguïté. Passe par note_remplacer avec un passage plus large."
        )
      }

      const status = await proposeNoteChange({
        courseId,
        kind: 'remplacer',
        content: aim.prefix.trim(),
        target: aim.target
      })
      return say(describeProposalStatus(status))
    }
  )

  // -------------------------------------------------------------------------
  // Interroger l'utilisateur
  // -------------------------------------------------------------------------

  const quiz = sdk.tool(
    'quiz',
    "Fait passer un questionnaire a l'utilisateur : les questions s'affichent dans le fil comme une carte a remplir, cases a cocher pour un QCM, champ de saisie pour une question ouverte. Il repond a tout, envoie, et l'outil te rend sa copie — tu corriges alors dans la foulee, question par question. C'est le SEUL moyen d'interroger l'utilisateur : ne redige jamais un quiz en texte dans ta reponse, il n'aurait rien pour y repondre. Annonce la carte d'une ligne avant de l'appeler, puis laisse-la parler ; ne devoile ni les reponses ni les indices tant qu'il n'a pas envoye.",
    {
      titre: z
        .string()
        .optional()
        .describe(
          "Ce sur quoi porte le quiz, en trois ou quatre mots — « Structure de capital », « Methodes de valorisation ». Affiche en tete de la carte."
        ),
      questions: z
        .array(
          z.object({
            type: z
              .enum(['qcm', 'libre'])
              .describe(
                "« qcm » quand des distracteurs plausibles existent — c'est ce qui teste la discrimination ; « libre » quand la reponse se redige, se calcule ou s'explique."
              ),
            question: z
              .string()
              .min(1)
              .describe("L'enonce, autonome et sans ambiguite. Formules en $…$."),
            options: z
              .array(z.string().min(1))
              .optional()
              .describe(
                "QCM uniquement : de 2 a 6 options, dans un ordre qui ne trahit pas la bonne reponse. Les distracteurs sont des erreurs que l'on fait vraiment, jamais des remplissages absurdes."
              ),
            multiple: z
              .boolean()
              .optional()
              .describe(
                "QCM uniquement : vrai si plusieurs options sont justes. L'enonce doit alors le dire. Faux par defaut."
              )
          })
        )
        .min(1)
        .max(12)
        .describe('Les questions, dans l\'ordre ou elles seront posees — 12 au plus.')
    },
    async ({ titre, questions }) => {
      // Un QCM sans options ne se coche pas : on renvoie la faute au modele
      // avant que la carte n'atteigne l'ecran, pour qu'il la corrige lui-meme.
      const faulty = questions.findIndex(
        (entry) => entry.type === 'qcm' && (entry.options?.length ?? 0) < 2
      )
      if (faulty !== -1) {
        return say(
          `La question ${faulty + 1} est un QCM mais n'a pas au moins deux options. Ajoute-les et rappelle l'outil — l'utilisateur n'a rien vu.`
        )
      }

      const posees: QuizQuestion[] = questions.map((entry, index) => ({
        n: index + 1,
        type: entry.type,
        question: entry.question.trim(),
        options: entry.type === 'qcm' ? (entry.options ?? []).map((option) => option.trim()) : [],
        multiple: entry.type === 'qcm' && entry.multiple === true
      }))

      const outcome = await askQuiz({ courseId, titre: titre?.trim() || undefined, questions: posees })

      if (outcome.status === 'not-open') {
        return say("Aucune fenêtre n'était ouverte pour afficher le quiz.")
      }
      if (outcome.status === 'cancelled') {
        return say("Le quiz a été retiré : le tour a été interrompu.")
      }
      if (outcome.status !== 'answered' || !outcome.answers?.length) {
        return say(
          "L'utilisateur a passé le quiz sans y répondre. N'insiste pas : enchaîne sur autre chose."
        )
      }

      return say(
        `Voici sa copie. ${QUIZ_CORRECTION_BRIEF}\n\n${formatQuizCopy(posees, outcome.answers)}`
      )
    }
  )

  const cartesCreer = sdk.tool(
    'cartes_creer',
    "Cree des flashcards de revision pour le cours ouvert, quand l'utilisateur le demande. Chaque carte : un recto (une vraie question, autonome, comprehensible sans le cours sous les yeux — jamais « que dit ce passage ? »), un verso (reponse complete mais compacte, au vocabulaire exact du support, formules en $…$), et si possible sa reference. Les cartes rejoignent le set du cours dans la section Flashcards et entrent dans la repetition espacee, dues immediatement. Attention aux doublons : les surlignages jaunes, verts et bleus engendrent deja des cartes automatiquement — consulte mes_surlignages pour eviter de recreer ce qui est deja surligne dans ces couleurs.",
    {
      cartes: z
        .array(
          z.object({
            recto: z.string().min(1).describe('La question, en Markdown. Formules en $…$.'),
            verso: z.string().min(1).describe('La reponse, en Markdown.'),
            type: z
              .enum(['definition', 'retenir', 'formule'])
              .optional()
              .describe(
                "Nature de la carte, affichee en revision par sa pastille de couleur : definition (verte), retenir — point important (jaune, par defaut), formule / chiffre (bleue)."
              ),
            page: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe('Page du passage source, pour un document pagine.'),
            section: z
              .string()
              .optional()
              .describe('Titre de la section source, pour un document sans pages.')
          })
        )
        .min(1)
        .max(20)
        .describe('Les cartes a creer — une entree par carte, 20 au plus par appel.')
    },
    async ({ cartes }) => {
      const { added, total } = await appendManualCards(
        courseId,
        cartes.map((carte) => ({
          recto: carte.recto.trim(),
          verso: carte.verso.trim(),
          colour: carte.type ?? 'retenir',
          page: carte.page ?? null,
          heading: carte.section?.trim() || null
        }))
      )
      return say(
        `${added} carte${added > 1 ? 's' : ''} créée${added > 1 ? 's' : ''} — le set du cours en compte ${total}. Elles apparaissent dans la section Flashcards, dues immédiatement.`
      )
    }
  )

  return sdk.createSdkMcpServer({
    name: 'cours',
    version: '1.0.0',
    instructions:
      "Ces outils donnent acces au cours actuellement ouvert a l'ecran et aux notes que l'utilisateur prend dessus. Ils ne voient que ce document ; pour les autres cours, utilise Grep et Read dans le dossier de travail.",
    tools: [
      rechercher,
      lire,
      mesSurlignages,
      quiz,
      cartesCreer,
      noteLire,
      noteBrouillon,
      notePoser,
      noteRemplacer,
      noteReecrire,
      noteTrier,
      noteObjets,
      noteObjetModifier,
      noteObjetSupprimer
    ],

    // Sans ceci, le moteur met ces outils de cote et l'assistant doit d'abord
    // les chercher : un aller-retour de plus avant chaque reponse, alors que
    // « rechercher » sert a chaque question.
    alwaysLoad: true
  })
}

/**
 * Serveur reduit a la seule consultation — pour le tuteur de flashcards, qui
 * lit le support du cours mais ne touche ni aux notes ni aux cartes.
 */
export function courseConsultTools(sdk: AgentSdk, courseId: string) {
  return sdk.createSdkMcpServer({
    name: 'cours',
    version: '1.0.0',
    instructions:
      "Ces outils donnent acces au support du cours dont vient la flashcard : « rechercher » localise les passages, « lire » ouvre une page ou une section.",
    tools: [buildRechercher(sdk, courseId), buildLire(sdk, courseId)],
    alwaysLoad: true
  })
}

/**
 * Les definitions brutes des deux outils de consultation — pour la route
 * Gemini de la generation de flashcards, qui les sert par un vrai serveur MCP
 * (gemini/mcp.ts) plutot que par le moteur Claude. Memes constructions, memes
 * handlers : la route change, jamais l'outil.
 */
export function consultToolDefinitions(sdk: AgentSdk, courseId: string) {
  return [buildRechercher(sdk, courseId), buildLire(sdk, courseId)]
}

/** Noms qualifies des seuls outils de consultation, pour le tuteur. */
export const CONSULT_TOOL_NAMES = ['mcp__cours__rechercher', 'mcp__cours__lire'] as const

/** Noms qualifies, tels que le moteur les expose. */
export const COURSE_TOOL_NAMES = [
  'mcp__cours__rechercher',
  'mcp__cours__lire',
  'mcp__cours__mes_surlignages',
  'mcp__cours__cartes_creer',
  'mcp__cours__note_lire',
  'mcp__cours__note_brouillon',
  'mcp__cours__note_poser',
  'mcp__cours__note_remplacer',
  'mcp__cours__note_reecrire',
  'mcp__cours__note_objets',
  'mcp__cours__note_objet_modifier',
  'mcp__cours__note_objet_supprimer'
] as const
