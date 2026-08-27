/**
 * Le contexte du cours ouvert, ajoute sous le prompt de l'assistant.
 *
 * Le prompt lui-meme n'est plus ici : il vit dans le vault, en clair, sous
 * Prompts/assistant.md — voir prompts/store.ts. Ce fichier ne porte plus que
 * ce que l'application calcule et ajoute d'elle-meme, que personne ne regle.
 *
 * Le contenu du cours n'y figure pas. L'assistant le consulte par ses outils,
 * passage par passage ; ce qu'on lui donne ici, c'est de quoi savoir quoi
 * chercher : le sujet, la matiere et le plan du document.
 */

import path from 'node:path'
import type { Course, PromptAnnexe } from '../../shared/types'
import { composePrompt } from '../prompts/store'
import type { IndexedCourse } from '../rag/store'
import { vaultPaths } from '../vault'

/**
 * Le prefixe qui part au modele : le fichier Prompts/assistant.md du vault,
 * ses reperes remplis. Relu a chaque tour — un prompt modifie, ici ou dans
 * Obsidian, prend effet au message suivant sans redemarrage.
 */
export async function assistantPrefix(): Promise<string> {
  return composePrompt('assistant')
}

/**
 * Ce que l'application ajoute sous le prompt, montre a l'ecran Parametres.
 *
 * Le bloc n'est pas decrit, il est produit : `courseContext` est appelee sur
 * un cours d'exemple, exactement comme elle l'est sur le cours ouvert. Une
 * description a la main mentirait des la premiere evolution du contexte.
 */
export function assistantAnnexes(): PromptAnnexe[] {
  return [
    {
      titre: 'Ajoute sous le prompt, recalculé à chaque message',
      texte: courseContext(
        {
          id: 'Private Equity/cours-lbo.pdf',
          title: 'cours lbo',
          subject: 'Private Equity',
          path: path.join(vaultPaths().courses, 'Private Equity/cours-lbo.pdf')
        },
        {
          index: { size: 214 },
          outline: [
            '- p. 1 — Introduction : pourquoi le LBO',
            '- p. 8 — La structure de dette',
            '- p. 23 — Le modèle de sortie'
          ],
          anchor: 'page',
          pageCount: 48,
          looksScanned: false
        },
        true
      )
    }
  ]
}

/** Au-dela, le plan cesse d'etre un repere et redevient un pave a lire. */
const OUTLINE_LIMIT = 120

/**
 * Partie propre au cours ouvert. Ce bloc repart a chaque message : tout ce qui
 * y bouge d'un tour a l'autre invalide le cache du prompt et de l'historique
 * entier. Il ne porte donc que des donnees stables. Ni les surlignages ni le
 * contenu de la memoire n'y figurent — l'assistant va les chercher avec
 * « mes_surlignages » et « se_souvenir », dont le prompt statique porte deja
 * le mode d'emploi.
 */
export function courseContext(
  course: Pick<Course, 'id' | 'title' | 'subject' | 'path'>,
  indexed: CourseExtent | null,
  hasMemory: boolean
): string {
  const sections: string[] = []

  // Le chemin complet, et non l'identifiant : c'est ce que « Read » attend
  // pour montrer une page telle qu'imprimee.
  sections.push(`## Cours ouvert

- Titre : ${course.title}
- Matière : ${course.subject}
- Fichier : ${course.path}
- ${indexed ? describeExtent(indexed) : 'Indexation en cours'}
- Mémoire : ${hasMemory ? 'des entrées existent à portée de ce cours' : 'encore vide'}

L'utilisateur travaille en ce moment sur cette matière. Les autres matières de
son espace de travail ne te concernent pas, sauf s'il te demande explicitement
d'aller y voir.`)

  if (indexed?.looksScanned) {
    sections.push(`## Attention

L'extraction de ce document a rendu très peu de texte : il s'agit probablement
d'un PDF scanné ou d'un support fait d'images. Tes recherches ne trouveront
donc presque rien, et ce n'est pas la faute de ta requête. Dis-le à
l'utilisateur plutôt que d'inventer le contenu manquant — et regarde les pages
avec « Read » (voir « Voir une page ») : c'est alors la seule façon de lire ce
document.`)
  }

  if (indexed && indexed.outline.length > 0) {
    const outline = indexed.outline.slice(0, OUTLINE_LIMIT)
    const truncated =
      indexed.outline.length > outline.length
        ? `\n… (${indexed.outline.length - outline.length} entrées supplémentaires)`
        : ''

    sections.push(`## Plan du document

Voici de quoi savoir où chercher. Ce plan n'est pas le contenu : pour le
contenu, utilise tes outils.

${outline.join('\n')}${truncated}`)
  }

  return sections.join('\n\n')
}

/**
 * Ce que ce module lit d'un cours indexe, et rien de plus. Le type est reduit
 * a ces champs pour que l'exemple de l'ecran Parametres se construise avec un
 * objet litteral, sans fabriquer un faux index complet ni forcer un cast.
 */
type CourseExtent = Pick<IndexedCourse, 'outline' | 'anchor' | 'pageCount' | 'looksScanned'> & {
  index: { size: number }
}

/** Ce qu'on annonce de l'etendue du document. */
function describeExtent(indexed: CourseExtent): string {
  const passages = `${indexed.index.size} passages indexés`
  return indexed.anchor === 'page'
    ? `Pages : ${indexed.pageCount} — ${passages}`
    : `Document sans pagination — ${passages}`
}
