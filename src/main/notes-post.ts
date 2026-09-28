/**
 * La pose : de ce que l'assistant a ecrit a ce qui entre dans la note.
 *
 * Trois gestes, dans cet ordre, et l'ordre est le sujet.
 *
 * 1. Chaque passage devient un emplacement d'ancrage borne par la source que
 *    l'assistant a declaree. Le vecteur ne choisit plus la page — il ne
 *    choisit que la phrase, a l'interieur de cette page-la.
 * 2. Les passages d'une ecriture s'ancrent d'un seul appel : l'ordre de leurs
 *    ancres est monotone. D'une ecriture a l'autre, c'est la source declaree
 *    qui tient chaque passage a sa place — elle borne l'ancre, et le tri range.
 * 3. Le tout part en une seule ecriture, rangee dans l'ordre du cours.
 *
 * Ce module est appele de trois endroits, et c'est pourquoi il n'habite ni
 * `claude/tools.ts` ni `notes-bridge.ts` : par l'outil `note_brouillon`, qui
 * pose chaque ecriture aussitot — la note se remplit partie par partie, sous
 * les yeux de l'utilisateur —, et, pour ce qui n'a pas pu l'etre (panneau des
 * notes ferme, note qui changeait sous la frappe), par l'outil `note_poser` et
 * par la fin de tour de `claude/session.ts`. Ce qui attend au brouillon ne doit
 * pas dependre de ce que le modele a pense a faire en dernier.
 */

import { proposeNoteChange } from './notes-bridge'
import { clearDraft, readDraft } from './notes-draft'
import type { DraftPassage } from './notes-draft'
import { assembleAnchored, plainNote, splitBlocks } from './notes-view'
import { declaredScope, resolveAnchorSequence } from './rag/auto-anchor'
import type { AnchorSlot } from './rag/auto-anchor'
import type { NoteAnchor, NoteProposalOutcome } from '../shared/types'

/** Ce qu'une pose a donne, pour le dire a l'assistant. */
export interface PostedDraft {
  /** Le nombre de passages verses dans la note. Zero quand rien n'a ete pose. */
  posted: number
  /** L'issue de l'ecriture, absente quand il n'y avait rien a poser. */
  outcome?: NoteProposalOutcome
  /** Les sources refusees par l'index, une phrase chacune. */
  rejected: string[]
}

/**
 * Un passage du brouillon, pret pour l'ancrage.
 *
 * Un passage est un *groupe*, pas un bloc : le texte entier est compare au
 * cours d'un seul tenant, et l'ancre trouvee vaut pour tout ce qu'il contient.
 * C'est exactement ce que l'assistant a voulu en le composant ainsi, et c'est
 * ce qui retire de l'application les deux heuristiques qui le devinaient
 * autrefois — le titre qui empruntait le texte du bloc suivant, le tableau qui
 * relevait du bloc precedent. Un groupement declare n'a pas besoin d'etre
 * devine.
 */
function slotOf(courseId: string, passage: DraftPassage): AnchorSlot | string {
  const scope = declaredScope(courseId, passage.source)
  if (typeof scope === 'string') return scope

  return {
    text: plainNote(passage.contenu),
    // Les pages citees dans la prose ne servent plus a rien ici : la source
    // declaree dit l'endroit, et elle le dit mieux. On garde le champ vide
    // plutot que de laisser un « voir aussi p. 200 » au fil d'une phrase
    // deplacer l'ancre de tout un passage.
    cited: [],
    scope: scope.unitKeys,
    place: scope.place
  }
}

/**
 * Le Markdown d'un passage ancre : un marqueur devant le groupe, puis son
 * texte tel qu'il a ete ecrit.
 *
 * On redecoupe en blocs pour passer par `assembleAnchored`, qui connait seul
 * la regle du marqueur — un marqueur au changement d'ancre, et jamais devant
 * un bloc incapable de le porter. Tous les blocs du groupe recoivent la meme
 * ancre : un seul marqueur est donc ecrit, en tete, et le reste du groupe en
 * releve.
 */
function renderPassage(contenu: string, anchor: NoteAnchor | null): string {
  return assembleAnchored(splitBlocks(contenu).map((block) => ({ block, anchor })))
}

/**
 * Ancre des passages et les verse dans la note, sans passer par le brouillon :
 * c'est l'ecriture de `note_brouillon`, a chaque appel. A l'appelant de garder
 * au brouillon ce qui n'a pas pu etre pose.
 */
export async function postPassages(
  courseId: string,
  passages: DraftPassage[]
): Promise<PostedDraft> {
  if (passages.length === 0) return { posted: 0, rejected: [] }

  const slots: AnchorSlot[] = []
  const kept: DraftPassage[] = []
  const rejected: string[] = []

  passages.forEach((passage, index) => {
    const slot = slotOf(courseId, passage)
    if (typeof slot === 'string') {
      rejected.push(`Passage ${index + 1} (« ${passage.source} ») : ${slot}`)
      return
    }
    slots.push(slot)
    kept.push(passage)
  })

  if (kept.length === 0) return { posted: 0, rejected }

  // `consultedUnitKeys` reste vide : chaque emplacement porte deja sa portee,
  // et le filtre d'attention du tour n'a plus rien a departager. Le passer
  // quand meme ne changerait rien — `circles` court-circuite des qu'une portee
  // est declaree — mais le passer suggererait qu'il compte encore.
  const anchors = await resolveAnchorSequence(courseId, slots, [])

  const content = kept
    .map((passage, index) => renderPassage(passage.contenu, anchors[index] ?? null))
    .join('\n\n')

  const outcome = await proposeNoteChange({
    courseId,
    kind: 'inserer',
    content,
    position: 'fin',
    // L'ajout part en fin de note et c'est le tri qui le repartit : chaque
    // passage rejoint les notes qui parlent du meme endroit du cours, au lieu
    // de s'empiler derriere ce qui parle de la p. 107.
    trier: true,
    // Sans apercu : le texte s'est ecrit sous les yeux de l'utilisateur, dans
    // la carte « L'assistant ecrit… », et une carte de confirmation ne lui
    // apprendrait rien qu'il n'ait vu.
    direct: true
  })

  return { posted: outcome.status === 'applied' ? kept.length : 0, outcome, rejected }
}

/**
 * Ancre le brouillon d'un cours et le verse dans la note, puis le vide.
 *
 * Le brouillon n'est efface que sur une ecriture reellement appliquee. Refus,
 * note absente de l'ecran, texte perime : le fichier reste ou il est, et le
 * travail du tour se recupere — a la main dans `Brouillons/`, ou par une
 * nouvelle pose au tour suivant.
 */
export async function postDraft(courseId: string): Promise<PostedDraft> {
  const result = await postPassages(courseId, await readDraft(courseId))
  if (result.outcome?.status === 'applied') await clearDraft(courseId)
  return result
}
