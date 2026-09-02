/**
 * Ou l'on en etait.
 *
 * Reprendre un support de quarante-huit pages a la page 1 chaque matin oblige a
 * refaire tout le chemin a la molette. Ce qui est retenu ici n'est pas une
 * donnee de travail — cela ne regarde ni Obsidian ni la sauvegarde du vault —
 * mais un confort de reprise : cela vit donc dans le navigateur, a cote du
 * choix du modele, et non dans un fichier du vault.
 */

const SPOT_PREFIX = 'noted.lecture.'

export interface ReadingSpot {
  /**
   * L'endroit ou l'on s'est arrete : le rang du bloc que la ligne de lecture
   * traversait, et la fraction parcourue de ce bloc.
   *
   * Un rang et une fraction, jamais des pixels : le defilement d'un document
   * depend de la largeur du panneau et du grossissement, qui changent d'une
   * session a l'autre — repris tel quel, il retombe ailleurs, et sur un
   * document dont les images arrivent apres coup il retombe au debut. Le
   * troisieme paragraphe, lui, reste le troisieme paragraphe.
   *
   * Les blocs sont ceux que le panneau donne a la ligne de lecture : une page
   * pour un PDF, un paragraphe ou un titre pour les autres formats. Un PDF
   * revient donc a la bonne hauteur dans la bonne page, et non en tete de page.
   */
  block?: { index: number; offset: number }
  /**
   * Grossissement du document, 1 valant la largeur du panneau. Retenu par
   * cours et non une fois pour toutes : un support de diapositives se lit de
   * loin, un contrat en corps 8 demande qu'on s'en approche.
   */
  zoom?: number
  /**
   * L'onglet choisi sur un cours reconstitue par lecture d'images. « Texte lu »
   * au premier abord ; basculer sur l'original pour verifier un schema ne doit
   * pas etre a refaire a chaque ouverture.
   */
  view?: 'ocr' | 'original'
}

function spotKey(courseId: string): string {
  return `${SPOT_PREFIX}${courseId}`
}

export function readingSpot(courseId: string): ReadingSpot | null {
  const raw = window.localStorage.getItem(spotKey(courseId))
  if (!raw) return null

  try {
    return JSON.parse(raw) as ReadingSpot
  } catch {
    return null
  }
}

/**
 * Retient ce qui a change, sans effacer le reste : la page et le grossissement
 * sont ecrits par deux mecaniques differentes, et la derniere ne doit pas
 * emporter ce que la premiere venait de noter.
 */
export function rememberSpot(courseId: string, spot: ReadingSpot): void {
  const merged = { ...readingSpot(courseId), ...spot }
  window.localStorage.setItem(spotKey(courseId), JSON.stringify(merged))
}

/** Efface la position d'un cours supprime, pour ne pas laisser d'orphelin. */
export function forgetReading(courseId: string): void {
  window.localStorage.removeItem(spotKey(courseId))
}

/** Suit un cours renomme ou deplace : son identifiant change, pas sa lecture. */
export function renameReading(previousId: string, nextId: string): void {
  const spot = readingSpot(previousId)
  window.localStorage.removeItem(spotKey(previousId))
  if (spot) rememberSpot(nextId, spot)
}
