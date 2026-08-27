/**
 * Le catalogue des prompts : ce que l'ecran Parametres affiche.
 *
 * Il vit a part du magasin (`store.ts`) parce qu'il connait les agents, alors
 * que le magasin ne connait que des identifiants et du texte. Sans cette
 * separation, les agents importeraient un module qui les importe : chacun lit
 * son fichier par le magasin, seul le catalogue les rassemble.
 *
 * Chaque entree porte le texte du fichier — celui qui tourne —, le texte livre
 * avec l'application pour pouvoir y revenir, et l'annexe : ce que
 * l'application ajoute d'elle-meme sous le prompt et qu'aucune modification ne
 * remplace. Le dire evite la mauvaise surprise de croire qu'on a supprime le
 * plan du cours en effacant la ligne qui en parlait.
 */

import type { PromptAnnexe, PromptId, PromptSetting } from '../../shared/types'
import { assistantAnnexes } from '../claude/prompt'
import { memoireAnnexes } from '../claude/recall'
import { tutorAnnexes } from '../claude/tutor'
import { generationAnnexes } from '../flashcards/generation'
import { promptPath, PROMPT_IDS, readPrompt, shippedPrompt, writePrompt } from './store'

interface Descriptor {
  label: string
  description: string
  /**
   * Les blocs ajoutes autour du prompt. Une fonction, et non un texte : ils
   * sont produits par le code qui les ajoute, sur un exemple, pour qu'ils ne
   * puissent pas se desynchroniser de la realite.
   */
  annexes: () => PromptAnnexe[]
}

const CATALOG: Record<PromptId, Descriptor> = {
  assistant: {
    label: "L'assistant IA",
    description:
      "Le panneau de droite dans l'espace de travail. Il répond sur le cours ouvert, cite ses pages, écrit dans les notes et tient sa mémoire.",
    annexes: assistantAnnexes
  },
  tuteur: {
    label: 'Le tuteur de flashcards',
    description:
      'Ouvert depuis une carte en révision, quand tu bloques. Il explique la logique de la notion et pose une question de vérification.',
    annexes: tutorAnnexes
  },
  generateur: {
    label: 'Le fabricant de flashcards',
    description:
      'En tâche de fond, sans rien afficher : il transforme tes surlignages jaunes, verts et bleus en cartes de révision.',
    annexes: generationAnnexes
  },
  memoire: {
    label: 'La tenue de la mémoire',
    description:
      "Tous les huit échanges, joint à ton message : la méthode que l'assistant suit pour relire la conversation et en tirer ce qui mérite d'être retenu sur toi. Ce n'est pas un agent de plus — c'est ce qu'on demande à l'assistant à ce moment-là.",
    annexes: memoireAnnexes
  }
}

/** Les prompts, tels que les fichiers du vault les portent. */
export async function listPromptSettings(): Promise<PromptSetting[]> {
  const settings: PromptSetting[] = []

  for (const id of PROMPT_IDS) {
    const descriptor = CATALOG[id]
    const defaut = shippedPrompt(id)
    const texte = await readPrompt(id)

    settings.push({
      id,
      label: descriptor.label,
      description: descriptor.description,
      defaut,
      chemin: promptPath(id),
      texte,
      // Compare au texte livre plutot qu'a un drapeau : le fichier peut avoir
      // ete modifie dans Obsidian, sans que l'application l'ait jamais su.
      personnalise: texte !== defaut,
      annexes: descriptor.annexes()
    })
  }

  return settings
}

/**
 * Ecrit un prompt et rend la liste a jour. `null` remet le texte livre avec
 * l'application — le fichier existe toujours, c'est son contenu qui revient.
 */
export async function setPromptSetting(
  id: PromptId,
  texte: string | null
): Promise<PromptSetting[]> {
  await writePrompt(id, texte ?? shippedPrompt(id))
  return listPromptSettings()
}

/** Vrai si l'identifiant vient bien du catalogue — le renderer est valide. */
export function isPromptId(value: unknown): value is PromptId {
  return typeof value === 'string' && (PROMPT_IDS as readonly string[]).includes(value)
}
