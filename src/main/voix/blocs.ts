/**
 * Ce que l'application joint a un message dicte, apres les mots de
 * l'utilisateur — sur le modele des blocs de memoire (claude/recall.ts).
 *
 * Deux blocs. Le premier, a chaque tour parle : la consigne de style, lue
 * dans le vault (Prompts/voix.md) et passee en argument pour que ce module
 * reste pur. Le second, quand l'utilisateur a coupe la parole a l'assistant :
 * ce qu'il a reellement entendu, et ou.
 *
 * Le second bloc est le coeur du mode voix. Le modele ecrit bien plus vite que
 * la voix ne parle : coupe apres vingt secondes, il a souvent redige la
 * reponse entiere, et le transcript la garde en entier. Sans ce bloc, il
 * croirait que tout a ete entendu, et repondrait « je viens de l'expliquer »
 * a une question sur un passage jamais prononce.
 */

import type { PromptAnnexe } from '../../shared/types'

/** Ce qu'il reste d'une coupure, a dire au modele au message suivant. */
export interface Coupure {
  /** Ce qui a ete prononce avant la coupure, mot pour mot. */
  entendu: string
  /** Le mot sur lequel la voix s'est tue, s'il y en a un. */
  motCoupe?: string
  /** Vrai quand la voix n'avait pas encore commence : rien n'a ete entendu. */
  avantParole: boolean
}

export function blocTourParle(style: string): string {
  return `<tour-parle>
Rappel de l'application, pas de l'utilisateur : ce message a été dicté à voix haute, et ta réponse sera lue par une voix de synthèse, phrase par phrase, à mesure que tu l'écris.

${style.trim()}
</tour-parle>`
}

export function blocCoupure(coupure: Coupure): string {
  if (coupure.avantParole) {
    return `<coupure>
Rappel de l'application, pas de l'utilisateur : il t'a coupé avant que la voix ait commencé à lire ta réponse précédente. Il n'en a rien entendu — ni les phrases que tu avais déjà écrites, ni tes recherches. Réponds à ce qu'il dit maintenant comme si cette réponse n'avait jamais été prononcée.
</coupure>`
  }

  const ou = coupure.motCoupe ? ` La voix s'est tue sur le mot « ${coupure.motCoupe} ».` : ''
  return `<coupure>
Rappel de l'application, pas de l'utilisateur : il t'a coupé la parole pendant que la voix lisait ta réponse précédente. Voici exactement ce qu'il en a entendu, et rien de plus :

« ${coupure.entendu} »
${ou}
Tout ce qui suit dans cette réponse a été rédigé mais jamais prononcé : il ne l'a pas entendu. Ne dis jamais que tu lui as déjà expliqué ce qui n'a pas été prononcé. Réponds à ce qu'il dit maintenant en partant de là, puis propose de reprendre là où tu en étais s'il le souhaite.
</coupure>`
}

/** Les enveloppes, montrees a l'ecran Parametres autour du texte du vault. */
export function voixAnnexes(): PromptAnnexe[] {
  return [
    {
      titre: 'Ajouté autour du texte, à chaque message dicté',
      texte: blocTourParle('[le texte ci-dessus]')
    },
    {
      titre: "Ajouté en plus, quand l'utilisateur a coupé la parole à l'assistant",
      texte: blocCoupure({
        entendu:
          "Le WACC, c'est le coût moyen pondéré du capital. Il pondère deux choses : le coût des fonds propres, et celui de la",
        motCoupe: 'la',
        avantParole: false
      })
    }
  ]
}
