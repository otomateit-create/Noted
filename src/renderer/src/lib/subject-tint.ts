/**
 * La couleur d'une matiere.
 *
 * Une matiere n'est qu'un dossier sous Cours/ : rien n'y stocke de couleur, et
 * en demander une a chaque creation ajouterait une question la ou l'utilisateur
 * ne veut donner qu'un nom. La teinte est donc derivee du nom lui-meme — meme
 * nom, meme couleur, a tous les lancements, sans un octet ecrit nulle part.
 *
 * Le prix a payer est que renommer une matiere la fait changer de couleur.
 * C'est le bon compromis : renommer est rare, et l'inverse — un fichier de
 * couleurs a tenir a jour a chaque renommage, deplacement ou suppression —
 * couterait plus cher que le confort qu'il achete.
 */

export interface SubjectTint {
  /** Depart du degrade, cote clair. */
  from: string
  /** Arrivee du degrade, cote soutenu. */
  to: string
}

/**
 * Huit teintes, chacune un degrade de deux tons de la meme famille. Elles
 * couvrent le cercle chromatique pour que deux matieres voisines dans la
 * grille ne se ressemblent pas, et restent assez sourdes pour qu'un ecran
 * de quatre cartes ne vire pas au bariolage.
 */
const TINTS: readonly SubjectTint[] = [
  { from: '#ffb27a', to: '#e05f4e' }, // ambre → corail
  { from: '#7ec2f0', to: '#3a63cc' }, // ciel → bleu
  { from: '#7fd9b0', to: '#0e8f77' }, // menthe → sapin
  { from: '#9fb0e6', to: '#4b57a3' }, // pervenche → indigo
  { from: '#f0a8c0', to: '#b05080' }, // rose → prune
  { from: '#b8d97a', to: '#4f8a3a' }, // tilleul → foret
  { from: '#f5c99a', to: '#c26a3a' }, // peche → rouille
  { from: '#b3a6dd', to: '#6e619f' } // lavande → violet
] as const

export function subjectTint(name: string): SubjectTint {
  // Un melange positionnel plutot qu'une somme de caracteres : « IA » et « AI »
  // doivent tomber sur deux teintes differentes. Le modulo tient le nombre
  // sous la limite des entiers exacts, quelle que soit la longueur du nom.
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 1000003
  }

  return TINTS[hash % TINTS.length]
}
