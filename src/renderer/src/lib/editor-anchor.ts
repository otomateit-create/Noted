/**
 * L'ancre portee par un bloc de note.
 *
 * Elle appartient au bloc et non a une ligne : inserer trois paragraphes plus
 * haut ne decale aucun lien, et deplacer, dupliquer ou supprimer un bloc
 * emporte son ancre avec lui. C'est aussi ce qui la fait entrer dans
 * l'historique d'annulation — ⌘Z sur la frappe qui a cree un bloc defait
 * l'ancre du meme geste, sans qu'on ait a s'en occuper.
 *
 * Un bloc sans ancre n'est pas un bloc sans lien : c'est un bloc qui releve du
 * dernier ancre au-dessus de lui. On n'ecrit donc une ancre qu'au changement,
 * ce qui laisse la marge lisible et le fichier propre.
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { sameAnchor, type NoteAnchor } from '@shared/types'

/**
 * Les blocs qui portent une ancre. On s'en tient a ce qu'on ecrit en prenant
 * des notes ; un tableau, un encadre ou un schema porte deja son propre
 * marqueur au-dessus de lui et releve du bloc qui le precede.
 */
/**
 * Les blocs qui peuvent porter une ancre et une identite.
 *
 * Exportee parce que l'absence d'identite ne veut dire « ecrit un autre jour »
 * que pour ces types-la. Un tableau ou une image n'en recoivent jamais : lire
 * leur silence comme une frontiere couperait un groupe en deux sans raison.
 */
export const ANCHORED = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock'
]

export interface AnchorOptions {
  /** L'ancre a poser en ce moment, ou null quand aucun cours n'est ouvert. */
  current: () => NoteAnchor | null
  /**
   * Faux pendant qu'on charge une note ou qu'on applique une proposition de
   * l'assistant : ce n'est pas de la frappe, il n'y a rien a ancrer. Les blocs
   * ecrits par l'assistant heritent ainsi de leur voisin, comme convenu.
   */
  enabled: () => boolean
}

/** Ce dont releve un bloc : sa propre ancre, ou la derniere posee au-dessus. */
/**
 * L'ancre dont ce bloc releve : la sienne, ou a defaut la derniere posee
 * au-dessus de lui.
 *
 * Exportee parce que `ancrerBloc` s'en sert pour choisir la protection qu'il
 * depose, et que celui qui la deplace ensuite doit chercher exactement la meme
 * valeur. Recalculer chacun de son cote laissait les deux diverger des que la
 * tete heritait au lieu de porter son ancre — la protection restait alors
 * collee au milieu du groupe.
 */
export function effectiveAnchor(doc: ProseMirrorNode, index: number): NoteAnchor | null {
  let found: NoteAnchor | null = null

  doc.forEach((node, _offset, at) => {
    if (at > index) return
    const anchor = node.attrs.ancre as NoteAnchor | null
    if (anchor) found = anchor
  })

  return found
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ancre: {
      /** Pose (ou retire, avec null) l'ancre du bloc de premier niveau a cette position. */
      ancrerBloc: (pos: number, anchor: NoteAnchor | null) => ReturnType
    }
  }
}

export const AnchorAttribute = Extension.create<AnchorOptions>({
  name: 'ancre',

  addOptions() {
    return {
      current: () => null,
      enabled: () => false
    }
  },

  addGlobalAttributes() {
    return [
      {
        types: ANCHORED,
        attributes: {
          ancre: {
            default: null,
            /**
             * Sans cela, couper un bloc en deux recopie ses attributs dans le
             * nouveau : chaque paragraphe naissait porteur de l'ancre du
             * precedent, la marge se remplissait du meme repere, et l'ancre ne
             * changeait plus jamais de page. Une ancre se pose, elle ne se
             * duplique pas.
             */
            keepOnSplit: false,
            parseHTML: (element: HTMLElement): NoteAnchor | null => {
              const raw = element.getAttribute('data-ancre')
              if (!raw) return null
              try {
                return JSON.parse(raw) as NoteAnchor
              } catch {
                return null
              }
            },
            renderHTML: (attributes: { ancre?: NoteAnchor | null }) => {
              if (!attributes.ancre) return {}
              return { 'data-ancre': JSON.stringify(attributes.ancre) }
            }
          },

          /**
           * L'identite du bloc, independante de sa place dans le document.
           *
           * L'ancrage automatique vectorise le texte d'un bloc *apres coup*,
           * une fois la frappe retombee, et l'aller-retour dure. Pendant ce
           * temps, rien n'empeche d'ecrire trois lignes plus haut : toutes les
           * positions ProseMirror ont alors glisse, et la position d'ou l'on
           * etait parti ne designe plus le bloc qu'on cherchait — au mieux un
           * voisin, au pire le milieu d'un autre paragraphe. On poserait donc
           * l'ancre trouvee sur le mauvais bloc, silencieusement.
           *
           * Un identifiant, lui, ne bouge pas avec le texte : on le retrouve en
           * parcourant le document au retour, ou l'on constate qu'il a disparu
           * — le bloc a ete efface entre-temps — et il n'y a rien a poser.
           */
          blocId: {
            default: null,
            /**
             * Meme raison que pour l'ancre, et plus imperieuse encore : couper
             * un bloc en deux recopierait l'identifiant dans le nouveau, et
             * deux blocs portant la meme identite ne sont plus distinguables du
             * tout — le premier trouve gagnerait, au hasard de l'ordre du
             * document.
             */
            keepOnSplit: false,
            parseHTML: (element: HTMLElement): string | null => element.getAttribute('data-bloc-id'),
            renderHTML: (attributes: { blocId?: string | null }) => {
              if (!attributes.blocId) return {}
              return { 'data-bloc-id': attributes.blocId }
            }
          }
        }
      }
    ]
  },

  addCommands() {
    return {
      ancrerBloc:
        (pos, anchor) =>
        ({ tr, state, dispatch }) => {
          const resolved = state.doc.resolve(Math.min(Math.max(pos, 0), state.doc.content.size))
          if (resolved.depth === 0) return false

          const at = resolved.before(1)
          const node = state.doc.nodeAt(at)
          if (!node || !ANCHORED.includes(node.type.name)) return false

          if (dispatch) {
            tr.setNodeAttribute(at, 'ancre', anchor)

            /*
             * L'ancre neuve ne doit pas s'emparer de ce qui suit.
             *
             * Un bloc sans ancre releve du dernier ancre au-dessus de lui :
             * ancrer un bloc au milieu d'une note reattribuait donc, d'un seul
             * geste, toutes les notes ecrites en dessous — sur autre chose, et
             * parfois un autre jour. Le trait de la session naissait long de
             * tout ce qui restait a lire, alors qu'on n'avait pas encore tape un
             * caractere. On fixe donc au bloc suivant l'ancre dont il relevait
             * deja : elle etait implicite, elle devient ecrite, et rien ne
             * change de sens.
             */
            if (anchor) {
              const index = state.doc.resolve(at).index(0)
              const inherited = effectiveAnchor(state.doc, index)
              const nextAt = at + node.nodeSize
              const next = nextAt < state.doc.content.size ? state.doc.nodeAt(nextAt) : null

              if (
                next &&
                ANCHORED.includes(next.type.name) &&
                !next.attrs.ancre &&
                inherited &&
                !sameAnchor(inherited, anchor)
              ) {
                tr.setNodeAttribute(nextAt, 'ancre', inherited)
              }
            }
          }

          return true
        }
    }
  },

  addProseMirrorPlugins() {
    const options = this.options

    return [
      new Plugin({
        key: new PluginKey('ancre-auto'),

        /**
         * Deux regles, sur le seul bloc ou est le curseur.
         *
         * Deux choses s'y decident, et il ne faut pas les confondre.
         *
         * *Qui est ce bloc* : tout bloc neuf recoit une identite, sans
         * condition. Elle ne dit rien de son contenu ni de ce qu'il regarde ;
         * elle sert a le retrouver plus tard, quand les positions auront
         * bouge.
         *
         * *De quoi il parle* : l'ancre, elle, ne se pose qu'au changement. Un
         * bloc sans ancre releve du dernier ancre au-dessus de lui, et une
         * ancre qui repete ce dont on relevait deja n'apprend rien a personne.
         *
         * Les deux se posent au meme instant — le premier caractere d'un bloc
         * neuf — mais pas aux memes conditions, et c'est ce qui permet a dix
         * paragraphes ecrits en face d'une meme page d'avoir chacun un nom
         * tout en n'ayant qu'une seule ancre entre eux.
         */
        appendTransaction: (transactions, oldState, newState) => {
          if (!transactions.some((transaction) => transaction.docChanged)) return null

          const here = newState.selection.$from
          if (here.depth === 0) return null

          const at = here.before(1)
          const node = newState.doc.nodeAt(at)
          if (!node || !ANCHORED.includes(node.type.name)) return null

          const index = newState.doc.resolve(at).index(0)
          const inherited = effectiveAnchor(newState.doc, index - 1)

          const own = node.attrs.ancre as NoteAnchor | null

          /*
           * Un bloc neuf : celui dont on vient d'ecrire le premier caractere,
           * reconnu a ce que le bloc ou etait le curseur *avant* ce changement
           * etait vide. Rouvrir la note un mois plus tard pour corriger une
           * faute ne remplit donc cette condition nulle part.
           *
           * Un bloc neuf n'enleve rien. Effacer une ligne vide d'un retour
           * arriere la fond dans le bloc du dessus : le curseur part bien d'un
           * bloc vide et arrive dans un bloc ecrit, mais ce bloc-la est ancien,
           * et on ne lui doit aucune ancre. Le nombre de blocs le dit.
           */
          const previous = oldState.selection.$from
          const neuf =
            options.enabled() &&
            previous.depth > 0 &&
            previous.node(1).textContent.trim() === '' &&
            node.textContent.trim() !== '' &&
            newState.doc.childCount >= oldState.doc.childCount

          const tr = newState.tr
          let ecrit = false

          /*
           * L'identite se pose sur tout bloc neuf, qu'il recoive une ancre ou
           * non — et c'est tout le point.
           *
           * Les deux etaient posees du meme geste, ce qui revenait a dire qu'un
           * bloc n'existe que s'il change de page. Tant qu'on ecrivait dix
           * paragraphes en face de la meme page, aucun n'avait de nom, et rien
           * ne pouvait plus leur etre pose au retour d'un calcul : on cherche un
           * bloc par son identite, jamais par sa position. Or l'identite d'un
           * bloc et ce dont il parle sont deux questions distinctes ; les avoir
           * liees faisait dependre la premiere d'un evenement — le changement de
           * page — qui ne la concerne pas.
           */
          if (neuf && typeof node.attrs.blocId !== 'string') {
            tr.setNodeAttribute(at, 'blocId', crypto.randomUUID())
            ecrit = true
          }

          if (neuf) {
            /*
             * Un bloc neuf prend la page qu'on lit, qu'il porte deja une ancre
             * ou non. Un bloc vide peut en porter une : celle qu'on lui a
             * laissee en effacant ce qu'on venait d'ecrire, ou la protection
             * deposee sur la ligne vide qui ferme un groupe. Elle dit d'ou on
             * venait, pas ce qu'on regarde maintenant — et c'est maintenant
             * qu'on ecrit. Ne poser l'ancre qu'en l'absence d'une autre
             * laissait la note retapee sur la page d'avant.
             */
            const anchor = options.current()
            const next = anchor && !sameAnchor(anchor, inherited) ? anchor : null

            if (!sameAnchor(own, next)) {
              tr.setNodeAttribute(at, 'ancre', next)
              ecrit = true

              // Meme protection que `ancrerBloc` : ce qui suit relevait de
              // l'ancre qu'on vient de remplacer, et doit continuer d'en
              // relever. On la lui fixe, elle etait implicite.
              const before = own ?? inherited
              const after = next ?? inherited
              const nextAt = at + node.nodeSize
              const following =
                nextAt < newState.doc.content.size ? newState.doc.nodeAt(nextAt) : null

              if (
                following &&
                ANCHORED.includes(following.type.name) &&
                !following.attrs.ancre &&
                before &&
                !sameAnchor(before, after)
              ) {
                tr.setNodeAttribute(nextAt, 'ancre', before)
              }
            }
          } else if (own && sameAnchor(own, inherited)) {
            // Une ancre qui repete ce dont le bloc relevait deja ne dit rien de
            // neuf. Elle vient surtout de ce que ProseMirror fait dans notre
            // dos : couper un bloc en deux recopie ses attributs dans le
            // nouveau, et `keepOnSplit` ne couvre pas toutes les facons de
            // couper. Une ancre marque un changement ; celle qui n'en marque
            // aucun encombre la marge.
            tr.setNodeAttribute(at, 'ancre', null)
            ecrit = true
          }

          return ecrit ? tr : null
        }
      })
    ]
  }
})
