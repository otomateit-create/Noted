/**
 * Les prompts des agents : un fichier Markdown par agent, dans le vault.
 *
 *     ~/Documents/Noted/Prompts/assistant.md
 *     ~/Documents/Noted/Prompts/tuteur.md
 *     ~/Documents/Noted/Prompts/generateur.md
 *     ~/Documents/Noted/Prompts/memoire.md
 *     ~/Documents/Noted/Prompts/descripteur.md
 *     ~/Documents/Noted/Prompts/voix.md
 *
 * Les deux derniers ne sont pas des prompts systeme. memoire.md est la methode
 * que l'assistant relit tous les huit echanges, quand l'application lui
 * demande de tenir sa memoire ; voix.md est le style parle, joint a chaque
 * message dicte en mode voix. Ils vivent ici parce qu'ils se reglent comme les
 * autres, et qu'un texte qui dit quoi retenir d'une conversation, ou comment
 * parler plutot qu'ecrire, se retouche plus souvent qu'un fichier de code.
 *
 * Ces fichiers sont la seule source de verite. Il n'y a pas de defaut du code
 * qui s'appliquerait par-dessous : ce qui est ecrit la est ce qui part au
 * modele, et rien d'autre. Les textes livres avec l'application (`graines/`)
 * ne servent qu'a ecrire ces fichiers la premiere fois, et a les remettre en
 * etat quand on clique « Restaurer ».
 *
 * Ils se lisent et se modifient de trois facons, toutes equivalentes : l'ecran
 * Parametres, Obsidian, n'importe quel editeur de texte. D'ou l'absence de
 * cache — le fichier est relu a chaque appel, quelques kilo-octets une fois
 * par message. Un cache ferait mentir la modification faite hors de
 * l'application.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import assistantGraine from './graines/assistant.md?raw'
import descripteurGraine from './graines/descripteur.md?raw'
import generateurGraine from './graines/generateur.md?raw'
import memoireGraine from './graines/memoire.md?raw'
import tuteurGraine from './graines/tuteur.md?raw'
import voixGraine from './graines/voix.md?raw'
import {
  DEFAULT_TABLE_ACCENT,
  DEFAULT_TABLE_DESIGN,
  HIGHLIGHT_COLORS,
  TABLE_ACCENTS,
  TABLE_DESIGNS
} from '../../shared/types'
import type { PromptId } from '../../shared/types'
import { vaultPaths } from '../vault'

export const PROMPT_IDS: readonly PromptId[] = [
  'assistant',
  'tuteur',
  'generateur',
  'memoire',
  'descripteur',
  'voix'
]

/** Les textes livres avec l'application, inlines a la construction. */
const GRAINES: Record<PromptId, string> = {
  assistant: assistantGraine,
  tuteur: tuteurGraine,
  generateur: generateurGraine,
  memoire: memoireGraine,
  descripteur: descripteurGraine,
  voix: voixGraine
}

/** Le fichier d'un agent dans le vault. */
export function promptPath(id: PromptId): string {
  return path.join(vaultPaths().prompts, `${id}.md`)
}

/** Le texte livre avec l'application — ce que « Restaurer » remet. */
export function shippedPrompt(id: PromptId): string {
  return GRAINES[id]
}

// ---------------------------------------------------------------------------
// Les reperes remplis a l'envoi
// ---------------------------------------------------------------------------

/**
 * La legende des surlignages, prise a la table partagee plutot que recopiee
 * dans le prompt. Recopiee, elle se perimerait en silence le jour ou une
 * couleur change de sens.
 */
function colourConventions(): string {
  return HIGHLIGHT_COLORS.map(
    (colour) => `- ${colour.label} (${colour.id}) : ${colour.meaning}`
  ).join('\n')
}

/**
 * Les habillages de tableau, meme raison : recopies, le prompt continuerait
 * d'annoncer un nom que la validation refuse.
 */
function tableConventions(): string {
  // Les libelles de la table sont ecrits pour un menu : ils commencent par une
  // majuscule, qui detonne au milieu d'une phrase.
  const designs = TABLE_DESIGNS.map((design) => {
    const defaut = design.id === DEFAULT_TABLE_DESIGN ? ' (par defaut)' : ''
    const hint = design.hint.charAt(0).toLowerCase() + design.hint.slice(1)
    return `- \`${design.id}\`${defaut} : ${hint}`
  }).join('\n')

  const accents = TABLE_ACCENTS.map(
    (accent) => `\`${accent}\`${accent === DEFAULT_TABLE_ACCENT ? ' (neutre, par defaut)' : ''}`
  ).join(', ')

  return `Designs :

${designs}

Et un accent qui teinte l'en-tete, pris aux codes couleur ci-dessus : ${accents}.`
}

/** Les reperes du prompt, remplaces par ce qu'ils designent. */
function fillMarkers(text: string): string {
  return text
    .replaceAll('{{couleurs}}', colourConventions())
    .replaceAll('{{tableaux}}', tableConventions())
}

// ---------------------------------------------------------------------------
// Lire, ecrire
// ---------------------------------------------------------------------------

/**
 * Le fichier d'un agent, tel qu'il est ecrit — reperes compris. C'est ce que
 * l'ecran Parametres montre et ce qu'Obsidian ouvre.
 *
 * Un fichier absent ou vide est reecrit depuis la graine plutot que signale :
 * un agent sans prompt ne peut pas travailler, et le premier lancement passe
 * par ce chemin comme les autres.
 */
export async function readPrompt(id: PromptId): Promise<string> {
  const file = promptPath(id)

  try {
    const raw = await fs.readFile(file, 'utf8')
    if (raw.trim()) return raw
  } catch {
    // Premier lancement, ou fichier efface depuis le Finder.
  }

  await writePrompt(id, GRAINES[id])
  return GRAINES[id]
}

/** Le prompt tel qu'il part au modele : le fichier, ses reperes remplis. */
export async function composePrompt(id: PromptId): Promise<string> {
  return fillMarkers(await readPrompt(id))
}

/** Ecrit le fichier d'un agent. Un texte vide le rend a sa graine. */
export async function writePrompt(id: PromptId, texte: string): Promise<void> {
  const contenu = texte.trim() ? texte : GRAINES[id]

  await fs.mkdir(vaultPaths().prompts, { recursive: true })
  await fs.writeFile(promptPath(id), contenu, 'utf8')
}

/**
 * Ecrit les fichiers manquants. Appele au demarrage : le dossier
 * Prompts/ doit exister dans le vault avant qu'on aille l'y chercher, sans
 * quoi il n'apparaitrait qu'apres le premier message envoye.
 */
export async function seedPrompts(): Promise<void> {
  for (const id of PROMPT_IDS) await readPrompt(id)
}
