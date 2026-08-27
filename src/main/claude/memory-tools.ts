/**
 * Les outils par lesquels l'assistant lit et ecrit sa memoire.
 *
 * La memoire n'est plus versee dans le prompt : l'assistant la retrouve par
 * recherche, comme le cours — « se_souvenir » remplace l'injection du fichier
 * entier. L'ecriture passe par des outils dedies, jamais par Write ou Edit :
 * c'est ce qui garantit le format des entrees, la trace a l'ecran et
 * l'annulation. Pas de confirmation prealable — le garde-fou est la trace,
 * visible sous la reponse et annulable d'un clic.
 *
 * Les entrees se repondent : « memoire_lier » relie deux faits, et c'est encore
 * l'outil qui ecrit la syntaxe du lien. Le partage des roles est le meme
 * partout — la similarite met sous les yeux, l'assistant tranche, le code
 * ecrit : apres chaque ecriture, le resultat de l'outil montre les entrees
 * proches, a fusionner ou a relier selon ce que la conversation dit.
 */

import { z } from 'zod'
import { MAX_LINKS, incomingEntries, outgoingEntries } from '../../shared/memory-links'
import type { Course, MemoryEntry, MemoryLevel } from '../../shared/types'
import { correctMemory, forgetMemory, linkMemory, noteMemory } from '../memory/bridge'
import { allMemoryEntries, searchMemory } from '../memory/rag'

type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk')

/** Nombre d'entrees remontees par defaut. */
const DEFAULT_RESULTS = 6
const MAX_RESULTS = 20

/**
 * Une entree est un fait court. Au-dela, c'est un document — et un document a
 * sa place dans les notes, pas dans la memoire.
 */
const MAX_BODY = 1200
const MAX_TITLE = 90

const LEVELS = ['global', 'matiere', 'cours'] as const

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
}

function say(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

/** Le niveau d'une entree, tel qu'on le lit dans un resultat. */
function levelLabel(entry: MemoryEntry): string {
  if (entry.level === 'global') return 'global'
  if (entry.level === 'matiere') return `matière ${entry.subject}`
  return `cours ${entry.file.replace(/\.md$/, '')}`
}

/** Une entree citee au fil du texte : de quoi la reconnaitre et la rappeler. */
function brief(entry: MemoryEntry): string {
  return `[${entry.id}] ${entry.title} (${levelLabel(entry)})`
}

/**
 * Une entree rendue avec ses deux sens de lien. Les sortants sont ce qu'elle
 * designe, les entrants ce qui la designe — ces derniers ne sont stockes nulle
 * part, ils se resolvent depuis l'ensemble des entrees.
 */
function renderEntry(entry: MemoryEntry, all: MemoryEntry[]): string {
  const lines = [
    `### [${entry.id}] ${entry.title} — ${levelLabel(entry)}, ${entry.date}`,
    '',
    entry.body || '(pas de corps)'
  ]

  const out = outgoingEntries(entry, all)
  const back = incomingEntries(entry, all)
  if (out.length > 0) lines.push('', `Liée à : ${out.map(brief).join(' · ')}`)
  if (back.length > 0) lines.push('', `Référencée par : ${back.map(brief).join(' · ')}`)

  return lines.join('\n')
}

function render(entries: MemoryEntry[], all: MemoryEntry[]): string {
  return entries.map((entry) => renderEntry(entry, all)).join('\n\n---\n\n')
}

/** Nombre d'entrees proches proposees apres une ecriture. */
const CANDIDATES = 3

/**
 * Ce que l'assistant lit juste apres avoir note : les entrees que la recherche
 * trouve les plus proches de celle qu'il vient d'ecrire. La similarite ne
 * decide de rien — elle met sous les yeux, au seul moment ou tout le contexte
 * de la conversation est encore la, ce qu'il faudrait peut-etre fusionner ou
 * relier.
 */
async function nearby(entry: MemoryEntry, course: Course): Promise<string> {
  const query = entry.body ? `${entry.title}\n\n${entry.body}` : entry.title

  let found: MemoryEntry[]
  try {
    found = await searchMemory(query, CANDIDATES + 1, {
      courseId: course.id,
      subject: course.subject,
      everywhere: true
    })
  } catch {
    // La recherche n'est qu'un service rendu : son echec ne doit pas faire
    // echouer une ecriture qui, elle, a abouti.
    return ''
  }

  const others = found.filter((other) => other.id !== entry.id).slice(0, CANDIDATES)
  if (others.length === 0) return ''

  return (
    `\n\nProches déjà en mémoire : ${others
      .map((other) => `${brief(other)}, ${other.date}`)
      .join(' · ')}.` +
    " Si l'une dit presque la même chose, fusionne : complète-la avec memoire_corriger, puis oublie" +
    ' le doublon. Si elle est distincte mais liée, relie-les avec memoire_lier. Sinon, ne fais rien.'
  )
}

export function memoryTools(sdk: AgentSdk, course: Course) {
  const seSouvenir = sdk.tool(
    'se_souvenir',
    "Cherche dans ta memoire persistante ce que tu sais deja de l'utilisateur : son profil, ses difficultes, sa progression, ses echeances. Par defaut, la recherche couvre le niveau global, la matiere ouverte et le cours ouvert ; « partout » l'etend aux autres matieres. A utiliser avant d'ecrire une entree, pour ne pas noter deux fois la meme chose, et des que l'historique personnel peut changer ta reponse : reprendre ou l'on s'etait arrete, revenir sur une difficulte connue, adapter ton niveau d'explication.",
    {
      requete: z
        .string()
        .optional()
        .describe(
          'Ce que tu cherches : « difficultes WACC », « echeances », « preferences d\'explication ».'
        ),
      id: z
        .string()
        .optional()
        .describe(
          "L'identifiant d'une entree precise, au lieu d'une recherche : c'est ainsi qu'on suit un lien (« m-1a2b3c4d »). L'entree est rendue avec ses liens."
        ),
      partout: z
        .boolean()
        .optional()
        .describe(
          "Vrai pour chercher aussi dans les memoires des autres matieres — uniquement quand l'utilisateur le demande ou que la question deborde clairement de la matiere ouverte."
        ),
      nombre: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS)
        .optional()
        .describe(`Nombre d'entrees a remonter. Par defaut ${DEFAULT_RESULTS}.`)
    },
    async ({ requete, id, partout, nombre }) => {
      const all = await allMemoryEntries()

      // Suivre un lien : l'entree est designee, il n'y a rien a chercher.
      if (id) {
        const wanted = all.find((entry) => entry.id === id)
        return wanted
          ? say(renderEntry(wanted, all))
          : say(`Aucune entrée ne porte l'identifiant « ${id} ». Cherche-la par « requete ».`)
      }

      if (!requete?.trim()) {
        return say('Donne « requete » — ce que tu cherches — ou « id » pour une entrée précise.')
      }

      const found = await searchMemory(requete, nombre ?? DEFAULT_RESULTS, {
        courseId: course.id,
        subject: course.subject,
        everywhere: partout ?? false
      })

      if (found.length === 0) {
        return say(
          `Rien dans ta mémoire pour « ${requete} »` +
            (partout ? '.' : ' dans la portée de ce cours — « partout: true » élargirait aux autres matières.') +
            " Si l'échange révèle quelque chose qui mérite d'être retenu, note-le avec memoire_noter."
        )
      }

      return say(`${found.length} entrée(s) :\n\n${render(found, all)}`)
    }
  )

  const noter = sdk.tool(
    'memoire_noter',
    "Retiens un fait durable sur l'utilisateur. Quatre choses le meritent : son profil et ses preferences d'apprentissage (niveau global) ; ses difficultes recurrentes — notions incomprises, erreurs qui reviennent, confusions entre concepts (matiere ou cours) ; sa progression — ce qui a ete travaille, ce qui est acquis, ou il s'est arrete (cours le plus souvent) ; les faits et echeances qu'il confie — « partiel le 12 mars », « le prof insiste sur X », « je vise un stage en M&A ». Cherche d'abord avec se_souvenir : si une entree proche existe, corrige-la au lieu d'en creer une deuxieme. L'utilisateur voit la trace sous ta reponse et peut annuler — pas besoin de demander la permission, ni d'annoncer que tu notes.",
    {
      niveau: z
        .enum(LEVELS)
        .describe(
          "« global » : vaut pour toutes les matieres (profil, preferences, objectifs). « matiere » : vaut pour la matiere ouverte. « cours » : ne vaut que pour ce cours (progression, difficulte locale)."
        ),
      titre: z
        .string()
        .describe('Titre court et precis, quelques mots — c\'est lui qu\'on lit dans les listes.'),
      contenu: z
        .string()
        .describe(
          'Le fait, en quelques lignes de Markdown. Court et factuel : ce qui aide les prochaines sessions, pas un resume de la conversation.'
        )
    },
    async ({ niveau, titre, contenu }) => {
      if (!titre.trim() || !contenu.trim()) {
        return say('Titre et contenu sont requis : rien n\'a été noté.')
      }
      if (titre.length > MAX_TITLE) {
        return say(
          `Ce titre fait ${titre.length} caractères ; ${MAX_TITLE} au plus. Raccourcis-le, le détail va dans le contenu.`
        )
      }
      if (contenu.length > MAX_BODY) {
        return say(
          `Ce contenu fait ${contenu.length} caractères ; ${MAX_BODY} au plus. Une entrée est un fait court — garde l'essentiel, le reste appartient aux notes du cours.`
        )
      }

      const entry = await noteMemory(course, niveau as MemoryLevel, titre, contenu)
      return say(
        `Retenu [${entry.id}] au niveau ${levelLabel(entry)}. L'utilisateur en voit la trace et peut l'annuler.` +
          (await nearby(entry, course))
      )
    }
  )

  const corriger = sdk.tool(
    'memoire_corriger',
    "Met a jour une entree de ta memoire designee par son identifiant — quand le fait a change, se precise, ou que tu allais noter un doublon. La date passe a aujourd'hui. L'utilisateur voit la trace et peut annuler.",
    {
      id: z.string().describe('L\'identifiant de l\'entree, tel que rendu par se_souvenir (« m-1a2b3c4d »).'),
      titre: z.string().optional().describe('Le nouveau titre, si tu le changes.'),
      contenu: z
        .string()
        .optional()
        .describe('Le nouveau contenu complet de l\'entree, si tu le changes.')
    },
    async ({ id, titre, contenu }) => {
      if (!titre?.trim() && !contenu?.trim()) {
        return say('Donne au moins un nouveau titre ou un nouveau contenu.')
      }
      if (contenu && contenu.length > MAX_BODY) {
        return say(`Ce contenu fait ${contenu.length} caractères ; ${MAX_BODY} au plus.`)
      }

      const updated = await correctMemory(course, id, {
        title: titre?.trim() || undefined,
        body: contenu?.trim() || undefined
      })
      if (!updated) {
        return say(
          `Aucune entrée ne porte l'identifiant « ${id} ». Retrouve la bonne entrée avec se_souvenir.`
        )
      }
      return say(`Entrée [${updated.id}] corrigée. L'utilisateur en voit la trace et peut l'annuler.`)
    }
  )

  const oublier = sdk.tool(
    'memoire_oublier',
    "Supprime une entree de ta memoire devenue fausse ou perimee — un point autrefois difficile desormais maitrise, une echeance passee. Une memoire qui ne peut pas oublier devient fausse a mesure que le niveau progresse. L'utilisateur voit la trace et peut annuler.",
    {
      id: z.string().describe('L\'identifiant de l\'entree, tel que rendu par se_souvenir.')
    },
    async ({ id }) => {
      const removed = await forgetMemory(course, id)
      if (!removed) {
        return say(
          `Aucune entrée ne porte l'identifiant « ${id} ». Retrouve la bonne entrée avec se_souvenir.`
        )
      }
      return say(`Entrée [${removed.id}] « ${removed.title} » oubliée. L'utilisateur en voit la trace et peut l'annuler.`)
    }
  )

  const lier = sdk.tool(
    'memoire_lier',
    `Relie deux entrees de ta memoire, designees par leurs identifiants. A utiliser quand un fait en eclaire un autre : une difficulte de cours qui illustre une confusion notee au niveau global, une notion qu'on retrouve dans deux matieres. Tu n'ecris jamais la syntaxe du lien toi-meme — tu donnes les deux identifiants, l'outil s'en charge. Le lien est range du cote de la source ; l'entree visee le verra comme un lien entrant. ${MAX_LINKS} liens sortants au plus par entree. Ne relie pas deux entrees qui disent la meme chose : celles-la se fusionnent (memoire_corriger, puis memoire_oublier).`,
    {
      id: z.string().describe("L'identifiant de l'entree qui portera le lien (la source)."),
      cible: z.string().describe("L'identifiant de l'entree visee."),
      retirer: z
        .boolean()
        .optional()
        .describe('Vrai pour defaire un lien existant au lieu d\'en poser un.')
    },
    async ({ id, cible, retirer }) => {
      const result = await linkMemory(course, id, cible, retirer ?? false)
      if (!result.ok) return say(result.reason)

      return say(
        result.removed
          ? `Lien retiré entre [${result.entry.id}] et ${brief(result.target)}.`
          : `[${result.entry.id}] « ${result.entry.title} » renvoie désormais à ${brief(result.target)}. L'utilisateur en voit la trace et peut l'annuler.`
      )
    }
  )

  return sdk.createSdkMcpServer({
    name: 'memoire',
    version: '1.0.0',
    instructions:
      "Ces outils donnent acces a ta memoire persistante sur l'utilisateur — lecture par recherche, ecriture tracee et annulable. Ils sont le seul moyen de l'ecrire : c'est ce qui garantit le format des entrees, la trace a l'ecran et l'annulation.",
    tools: [seSouvenir, noter, corriger, oublier, lier],

    // Meme raison que pour les outils du cours : sans ceci, l'assistant
    // devrait d'abord chercher ces outils avant de pouvoir s'en servir.
    alwaysLoad: true
  })
}

/** Noms qualifies, tels que le moteur les expose. */
export const MEMORY_TOOL_NAMES = [
  'mcp__memoire__se_souvenir',
  'mcp__memoire__memoire_noter',
  'mcp__memoire__memoire_corriger',
  'mcp__memoire__memoire_oublier',
  'mcp__memoire__memoire_lier'
] as const
