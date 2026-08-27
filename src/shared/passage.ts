/**
 * La forme commune d'un passage cite, des deux cotes de l'application.
 *
 * Un passage n'est jamais garde comme une position — ni un decalage d'octets,
 * qu'un PDF n'a pas, ni un chemin dans le DOM, qui change des qu'un
 * convertisseur evolue. Il est garde comme son texte exact, plus le voisinage
 * immediat qui distingue la bonne occurrence des autres, et on le retrouve en
 * refaisant une recherche.
 *
 * Deux endroits en fabriquent : le surlignage, dans la fenetre, qui part d'une
 * selection de l'utilisateur ; le decoupage des cours, dans le processus
 * principal, qui part du texte extrait. Ce que l'un enregistre, l'autre doit
 * pouvoir le retrouver — donc les deux doivent mesurer et normaliser de la
 * meme facon, faute de quoi la comparaison echoue sur un espace.
 *
 * D'ou ce fichier, compile par les deux configurations : ni DOM ni Node, du
 * JavaScript pur, pour que cette regle n'existe qu'une seule fois.
 */

/**
 * Voisinage garde de chaque cote. Assez pour lever l'ambiguite entre deux
 * occurrences d'une meme phrase, assez court pour ne pas gonfler le fichier
 * ni casser au premier caractere qui bouge.
 */
export const CONTEXT = 40

/** Remet un texte sur une ligne, pour qu'il se lise et se cite. */
export function readable(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
