/**
 * Les marqueurs de figure : les numeroter a l'arrivee, les enrichir a la sortie.
 *
 * La conversion laisse « [figure] » — ou « [figure : legende] » — a la place de
 * chaque image, dans le meme ordre que la liste `media`. Ce contrat suffisait
 * tant qu'un seul passage remplacait tous les marqueurs d'un coup : un compteur
 * partait de zero, avancait d'un marqueur a l'autre, et la n-ieme image trouvait
 * sa place.
 *
 * Il ne suffit plus. Les descriptions n'arrivent qu'apres la vectorisation, et
 * elles ne se posent plus sur le texte entier mais sur ce que « lire » rend :
 * une page, une plage de pages, une section — un morceau dont on ignore combien
 * de figures le precedent. Le rang doit donc etre inscrit dans le marqueur
 * lui-meme, une fois pour toutes, a la reception du texte : « [figure 7] » se
 * suffit a lui-meme ou qu'il apparaisse ensuite.
 */

import type { ExtractedCourse } from '../../shared/types'

/** Ce qu'une image dit, et ou la regarder. */
export interface FigureDescription {
  description: string
  /**
   * Le PNG reduit, en chemin absolu.
   *
   * Relatif au vault d'abord — c'est le repertoire de travail de l'assistant —,
   * mais « Read » exige un chemin absolu, et l'assistant en fabriquait un
   * mauvais : il rabattait « .noted/figures/… » sur le dossier du cours ouvert,
   * echouait, et se rattrapait par un Glob. Deux appels perdus a chaque figure
   * regardee, pour economiser trente caracteres.
   */
  image: string
}

/**
 * Un marqueur de figure, numerote ou non. La legende, quand il y en a une, est
 * capturee pour etre reconduite telle quelle : elle vient du document, et le
 * texte de remplacement d'une image en dit souvent plus que sa description.
 */
const FIGURE = /\[figure(?:\s+\d+)?(?:\s*:([^\]]*))?\]/gi

/**
 * Un marqueur deja numerote, et lui seul.
 *
 * `withDescriptions` s'en sert plutot que de `FIGURE` : les cours HTML portent
 * des « [figure : titre] » qui ne designent aucune image sur le disque — leurs
 * graphiques sont deja rendus en texte — et rien ne doit venir s'y substituer.
 */
const NUMBERED = /\[figure\s+(\d+)(?:\s*:([^\]]*))?\]/gi

function legendOf(captured: string | undefined): string {
  return captured?.trim() ?? ''
}

function marker(rank: number, legend: string): string {
  return legend ? `[figure ${rank} : ${legend}]` : `[figure ${rank}]`
}

/**
 * Inscrit son rang dans chaque marqueur de figure.
 *
 * Pure et idempotente : le rang est la position du marqueur dans le document,
 * jamais un compteur qui s'incremente d'un appel a l'autre. Passer deux fois le
 * meme texte rend deux fois le meme texte — ce qui n'est pas theorique, la
 * deuxieme ouverture d'un cours relit son extraction en cache, deja numerotee,
 * et la renvoie ici telle quelle.
 *
 * Le compteur repart a un pour le Markdown complet, qui reprend les memes
 * figures dans le meme ordre que les pages.
 */
export function numberFigures(extracted: ExtractedCourse): ExtractedCourse {
  if (!extracted.media || extracted.media.length === 0) return extracted

  let rank = 0
  const substitute = (_match: string, legend: string | undefined): string =>
    marker((rank += 1), legendOf(legend))

  const pages = extracted.pages.map((page) => ({
    ...page,
    text: page.text.replace(FIGURE, substitute)
  }))

  rank = 0
  const markdown = extracted.markdown.replace(FIGURE, substitute)

  return { ...extracted, pages, markdown }
}

/**
 * Remplace les marqueurs par ce que les images disent.
 *
 * A la volee, sur le texte que « lire » s'apprete a rendre, et nulle part
 * ailleurs : les descriptions n'entrent ni dans les passages ni dans les
 * vecteurs. Ce sont des phrases ecrites par un modele, pas du contenu de cours —
 * les faire concourir avec le cours dans la recherche reviendrait a laisser une
 * paraphrase evincer le texte qu'elle paraphrase.
 *
 * Un rang sans description reste nu : l'image est decorative, illisible, ou sa
 * description n'est pas encore revenue.
 */
export function withDescriptions(
  text: string,
  figures: ReadonlyMap<number, FigureDescription>
): string {
  if (figures.size === 0) return text

  return text.replace(NUMBERED, (match, rank: string, legend: string | undefined) => {
    const figure = figures.get(Number(rank))
    if (!figure) return match

    // Un point, et non un tiret cadratin : ce texte est ce que l'assistant a sous
    // les yeux, et c'est de la qu'il recopie sa ponctuation.
    const said = legendOf(legend)
      ? `${legendOf(legend)}. ${figure.description}`
      : figure.description

    return `[figure ${rank} : ${said} Pour la voir en détail : Read « ${figure.image} »]`
  })
}
