/**
 * Ce que l'application joint au tour utilisateur, apres ses mots.
 *
 * Au premier message d'une conversation, un rappel de ce que la memoire sait
 * deja de l'utilisateur ; tous les huit echanges, la methode par laquelle il
 * relit la conversation et en tire ce qui est durable — le texte du vault,
 * Prompts/memoire.md, dans son enveloppe. Rien de tout cela ne va dans le
 * prompt systeme : il y
 * resterait en cache et vieillirait, alors que le tour utilisateur repart a
 * chaque message. Rien n'est non plus laisse a la discretion du modele : c'est
 * l'application qui choisit les entrees, par trois chemins qui ne se
 * recouvrent pas — le profil (toujours), la reprise du cours (les dernieres
 * entrees), et la pertinence (les entrees proches de la demande, par le sens
 * et par les mots).
 *
 * Module pur : lire la memoire et chercher dedans reste l'affaire de
 * memory/rag.ts ; ici on choisit, on borne et on ecrit.
 */

import type { MemoryEntry, PromptAnnexe } from '../../shared/types'

/** Une entree proche de la demande, avec ce qui la recommande. */
export interface RecallCandidate {
  entry: MemoryEntry
  /** Un mot de la demande figure dans l'entree. */
  lexical: boolean
  /** Proximite de sens avec la demande ; null sans vecteurs. */
  similarity: number | null
}

/** Les trois sources du rappel, deja restreintes a la portee du cours. */
export interface RecallSources {
  /** Les entrees globales : le profil de l'utilisateur. */
  profile: MemoryEntry[]
  /** Les entrees du cours ouvert, dans l'ordre des fichiers. */
  latest: MemoryEntry[]
  /** Les entrees proches de la demande, les mieux classees d'abord. */
  relevant: RecallCandidate[]
}

/**
 * En dessous, la proximite de sens ne dit plus rien. Calibre sur une memoire
 * simulee de trente entrees avec le vrai moteur (etape 35f) : les entrees
 * attendues sortent entre 0,63 et 0,72, le bruit entre 0,40 et 0,58 — un
 * « salut » plafonne a 0,43. Une entree sous le plancher n'est retenue que si
 * un mot de la demande y figure.
 */
export const SIMILARITY_FLOOR = 0.6

/** Taille du bloc en caracteres — de l'ordre de six cents tokens. */
export const RECALL_BUDGET = 2400
/** Un corps plus long est un document, pas un fait : on le coupe. */
const BODY_LIMIT = 280
const PROFILE_LIMIT = 6
const LATEST_LIMIT = 2
const RELEVANT_LIMIT = 5

const OPENING = `<memoire-rappelee>
Rappel de l'application, pas de l'utilisateur : ce que ta mémoire contient déjà à son sujet. Sers-t'en sans le recopier ni le commenter ; « se_souvenir » en donne le reste, « memoire_corriger » prend l'identifiant.`
const CLOSING = '</memoire-rappelee>'

/** La plus recente d'abord ; a date egale, la derniere ecrite dans le fichier. */
export function latestFirst(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].reverse().sort((a, b) => b.date.localeCompare(a.date))
}

/** Une entree sur une ligne : de quoi la reconnaitre, la citer, la corriger. */
function line(entry: MemoryEntry): string {
  // Un corps qui commence par une puce de liste la perd : la ligne en est deja une.
  const body = entry.body.replace(/\s+/g, ' ').trim().replace(/^[-*•]\s+/, '')
  const cut = body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1).trimEnd()}…` : body
  return `- [${entry.id}] ${entry.title} (${entry.date})${cut ? ` : ${cut}` : ''}`
}

/**
 * Le bloc a joindre au premier message, ou null s'il n'y a rien a rappeler.
 * Les sections viennent dans l'ordre de leur surete — le profil ne depend de
 * rien, la reprise du cours de rien non plus, la pertinence d'une recherche —
 * et le budget se remplit dans cet ordre : ce qui saute en premier est ce
 * qu'on est le moins sur de devoir dire.
 */
export function recallBlock(sources: RecallSources): string | null {
  const sections: { title: string; entries: MemoryEntry[] }[] = [
    { title: 'Profil', entries: latestFirst(sources.profile).slice(0, PROFILE_LIMIT) },
    { title: 'Ce cours, en dernier', entries: latestFirst(sources.latest).slice(0, LATEST_LIMIT) },
    {
      title: 'En rapport avec la demande',
      entries: sources.relevant
        .filter(
          (candidate) =>
            candidate.lexical ||
            (candidate.similarity !== null && candidate.similarity >= SIMILARITY_FLOOR)
        )
        .slice(0, RELEVANT_LIMIT)
        .map((candidate) => candidate.entry)
    }
  ]

  const seen = new Set<string>()
  const parts: string[] = []
  let size = OPENING.length + CLOSING.length

  for (const section of sections) {
    const lines: string[] = []
    for (const entry of section.entries) {
      if (seen.has(entry.id)) continue
      const rendered = line(entry)
      if (size + rendered.length > RECALL_BUDGET) break
      seen.add(entry.id)
      lines.push(rendered)
      size += rendered.length + 1
    }
    if (lines.length > 0) parts.push(`${section.title} :\n${lines.join('\n')}`)
  }

  if (parts.length === 0) return null
  return `${OPENING}\n\n${parts.join('\n\n')}\n${CLOSING}`
}

/** Tous les huit echanges, l'invitation a noter ce qui est durable. */
export const NUDGE_EVERY = 8

/** Vrai quand le message de ce rang doit porter la methode de memoire. */
export function isNudgeTurn(turns: number): boolean {
  return turns >= NUDGE_EVERY && turns % NUDGE_EVERY === 0
}

/**
 * L'enveloppe du rappel : ce que l'application dit autour de la methode.
 *
 * La methode elle-meme — comment relire les huit echanges et y reconnaitre ce
 * qui est durable — n'est pas ici : elle vit dans le vault, sous
 * Prompts/memoire.md, et se regle a l'ecran Parametres. Elle est passee en
 * argument plutot que lue, pour que ce module reste pur.
 */
export function nudgeBlock(turns: number, skill: string): string {
  return `<rappel-application>
Cette conversation compte ${turns} échanges. L'application te demande de tenir ta mémoire à jour. Ce qui suit ne vient pas de l'utilisateur et n'appelle aucune réponse : réponds-lui d'abord, puis fais ce travail en silence.

${skill.trim()}
</rappel-application>`
}

/**
 * Ce que l'application ecrit autour de la methode, montre a l'ecran Parametres.
 * Produit par la fonction qui l'ecrit, sur un corps d'exemple : une description
 * a la main se desynchroniserait de l'enveloppe reelle.
 */
export function memoireAnnexes(): PromptAnnexe[] {
  return [
    {
      titre: `Ajouté autour du texte, tous les ${NUDGE_EVERY} échanges`,
      texte: nudgeBlock(NUDGE_EVERY, '[le texte ci-dessus]')
    }
  ]
}

/** Les blocs de l'application, tels qu'ils apparaissent dans un tour stocke. */
const APP_BLOCKS = /\s*<(memoire-rappelee|rappel-application)>[\s\S]*?<\/\1>/g

/** Les mots de l'utilisateur seuls, sans ce que l'application y a joint. */
export function userText(content: string): string {
  return content.replace(APP_BLOCKS, '').trim()
}
