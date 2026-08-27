/**
 * Le regime A : les captures d'ecran d'un document par ailleurs lisible.
 *
 * L'utilisateur ne voit rien. Aucun fichier de cours n'est cree ni modifie, le
 * document reste affiche tel quel, et l'image reste une image. La seule
 * difference est que le tableau de comparables colle en capture cesse d'etre un
 * trou : l'assistant le lit, la recherche le trouve.
 *
 * **Le moment compte autant que le resultat.** Cette lecture s'intercale entre
 * l'extraction du texte et le decoupage en passages. Placee apres, le texte
 * d'une capture n'aurait ni ancre ni vecteur — il serait arrive trop tard pour
 * entrer dans un passage, et donc trop tard pour etre trouve ou cite. C'est
 * pourquoi l'index d'un document illustre attend cette lecture, quand
 * l'affichage, lui, n'attend rien.
 */

import type { ExtractedCourse, FigureReading } from '../../shared/types'
import { mediaPath, readMedia } from '../media'
import { cachedRead, keepRead } from './cache'
import { readPage } from './page'
import { imageFingerprint, ocrInstalled } from './model'
import { toPng } from './photos'

/**
 * Le marqueur laisse par la conversion a la place d'une image : « [figure] », ou
 * « [figure : texte de remplacement] » quand le document en portait un.
 */
const FIGURE = /\[figure(?:\s*:[^\]]*)?\]/g

/**
 * Taille en deca de laquelle une image ne porte pas de texte utile.
 *
 * Un separateur, une puce, un logo d'ecole en pied de page : ces images-la sont
 * decoratives, et les donner a lire couterait vingt secondes chacune pour rendre
 * une ligne vide ou, pire, une invention. Quinze kilo-octets laissent passer
 * toute vraie capture d'ecran — la plus modeste des captures de tableau en fait
 * plusieurs centaines.
 */
export const DECORATIVE_BYTES = 15_000

/**
 * Remplace les marqueurs de figure par ce que les images disent reellement.
 *
 * Rend le texte inchange des que quelque chose manque — modele absent, image
 * introuvable, lecture infructueuse. C'est la regle de toute cette etape : sans
 * moteur, tout continue exactement comme avant.
 */
export async function readFigures(extracted: ExtractedCourse): Promise<ExtractedCourse> {
  const names = extracted.media ?? []
  if (names.length === 0) return extracted
  if (!(await ocrInstalled())) return extracted

  // Rien n'est lu deux fois dans un meme document : la meme capture repetee en
  // en-tete de chaque section ne coute qu'une lecture.
  const readings = new Map<string, string | null>()

  for (const name of names) {
    if (readings.has(name)) continue
    readings.set(name, await readOne(name))
  }

  // Si aucune image n'a rien donne, le document repart tel quel plutot que de
  // traverser une reecriture qui ne changerait rien.
  if (![...readings.values()].some(Boolean)) return extracted

  /*
   * Ce que chaque image a dit, avant meme de le verser dans le texte.
   *
   * La liste se construit ici et non dans le remplacement, parce qu'elle ne
   * depend de rien d'autre que des lectures : `names` donne le rang de chaque
   * image dans le document, `readings` ce qu'elle dit, et les images muettes
   * ne comptent pas puisque leur marqueur reste en place. La calculer dans le
   * remplacement obligerait a se garder de la compter deux fois — il a lieu
   * une fois pour les pages, une fois pour le Markdown.
   */
  const figures: FigureReading[] = names
    .map((name, at) => ({ at, text: readings.get(name) ?? '' }))
    .filter((figure) => figure.text !== '')

  let index = 0
  const substitute = (marker: string): string => {
    const name = names[index++]
    const text = name ? readings.get(name) : null
    if (!text) return marker

    // Le texte prend la place du marqueur, sans annonce ni guillemets : pour
    // l'index comme pour l'assistant, ce doit etre du contenu du cours a
    // l'endroit ou il se trouve, et non une citation d'image.
    return text
  }

  const pages = extracted.pages.map((page) => ({
    ...page,
    text: page.text.replace(FIGURE, substitute)
  }))

  // Le compteur repart pour le Markdown complet, qui reprend les memes figures
  // dans le meme ordre.
  index = 0
  const markdown = extracted.markdown.replace(FIGURE, substitute)

  return { ...extracted, pages, markdown, figures }
}

/** Lit une image, en passant par le cache. Rend null si rien n'en sort. */
async function readOne(name: string): Promise<string | null> {
  const bytes = await readMedia(name)
  if (!bytes) return null

  // Les images decoratives sont ecartees avant toute depense : la taille du
  // fichier suffit a les reconnaitre, et elle ne coute rien a consulter.
  if (bytes.length < DECORATIVE_BYTES) return null

  const file = mediaPath(name)
  if (!file) return null

  // **La reduction n'est pas une optimisation, c'est une condition.** Les
  // captures d'ecran d'un cours font couramment 2500 pixels de large ; au-dela
  // de 1280 sur le cote le plus long, l'encodeur visuel demande au processeur
  // graphique plus de memoire que les huit gigaoctets unifies n'en laissent, et
  // le moteur meurt sans rien rendre. Constate ici : sur vingt et une captures
  // envoyees telles quelles, une seule reponse en dix minutes, et vide.
  const reduced = await toPng(file)
  if (!reduced) return null

  // L'empreinte porte sur l'image reellement lue, et non sur l'originale : deux
  // captures differentes qui se reduisent au meme resultat partagent alors leur
  // lecture, et changer un jour de plafond invalide proprement le cache.
  const fingerprint = imageFingerprint(reduced)

  const known = await cachedRead(fingerprint)
  if (known) return known.markdown || null

  // Sans `keepFigures` : cette image est deja affichee a sa place dans le
  // document, et la redonner dans le texte la ferait apparaitre deux fois.
  // Seul son contenu lisible nous interesse ici — un tableau colle en capture
  // devient enfin un tableau.
  const read = await readPage(reduced, { keepFigures: false })

  // `null` : le moteur n'a pas pu travailler. On ne garde rien — l'image sera
  // relue un jour ou il ira mieux. Et on le dit : une image qui ne se lit
  // jamais coute vingt secondes a chaque ouverture du cours, sans qu'aucun
  // compteur ne monte a l'ecran, et c'est ici le seul endroit ou cela se voit.
  if (!read) {
    console.warn(`[ocr] figure ${name} non lue, elle sera reprise a la prochaine ouverture`)
    return null
  }

  // Une lecture vide est un resultat : elle se garde, sans quoi les images sans
  // texte seraient relues a chaque ouverture du cours.
  await keepRead(fingerprint, read)
  return read.markdown || null
}
