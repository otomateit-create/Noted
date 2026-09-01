/**
 * Ce qu'on fait des regions detectees, avant d'aller lire quoi que ce soit.
 *
 * Tout ici est de la geometrie et des regles : aucun modele n'intervient, rien
 * n'est aleatoire, et le fichier se relit en entier. C'est deliberé — c'est la
 * partie de la chaine ou une erreur est silencieuse. Une region avalee par une
 * autre, et un tableau disparait du cours sans que personne ne s'en apercoive.
 *
 * Trois decisions y sont prises, dans cet ordre :
 *
 *   1. **le menage** — le detecteur rend parfois un bloc de texte *et* les
 *      lignes qui le composent ; on garde le bloc ;
 *   2. **l'ordre de lecture** — de haut en bas, mais par bandes, pour qu'une
 *      diapositive en deux colonnes ne se lise pas en zigzag ;
 *   3. **le budget** — combien de pixels chaque region a le droit de couter.
 */

import { OCR_PAGE_PIXEL_BUDGET, fitToOcrBudget } from '../../shared/types'
import type { PageLayout, Region } from './layout'

/**
 * Ce qu'on va faire d'une region. C'est cette valeur, et non la classe rendue
 * par le detecteur, qui choisit la tache envoyee au modele.
 */
export type JobKind = 'title' | 'text' | 'table' | 'formula' | 'figure'

export interface Job {
  kind: JobKind
  left: number
  top: number
  width: number
  height: number
  /** Cote de l'image envoyee au modele, apres application du budget. */
  scaledWidth: number
  scaledHeight: number
}

/**
 * De la classe du detecteur a la tache.
 *
 * Les legendes et les notes de bas de tableau rejoignent le texte : elles se
 * lisent comme du texte, et les distinguer n'apporterait rien au cours.
 * `abandon` — en-tetes, pieds de page, numeros de page, notes marginales — n'a
 * pas de tache du tout : ces lignes sont ecartees, et c'est un gain. Elles
 * polluaient le cours et l'index sans jamais rien apprendre.
 */
function jobKind(label: string): JobKind | null {
  switch (label) {
    case 'abandon':
      return null
    case 'title':
      return 'title'
    case 'table':
      return 'table'
    case 'isolate_formula':
      return 'formula'
    case 'figure':
      return 'figure'
    default:
      // `plain text`, `figure_caption`, `table_caption`, `table_footnote`, et
      // toute classe qu'une reexportation du modele ajouterait.
      return 'text'
  }
}

/**
 * Qui l'emporte quand deux regions se recouvrent.
 *
 * Un tableau reconnu comme tel vaut mieux qu'un bloc de texte qui le contient :
 * la tache dediee rendra une structure la ou l'autre rendrait des lignes
 * aplaties. C'est tout ce que ce classement exprime.
 */
const RANK: Record<JobKind, number> = { table: 3, formula: 3, figure: 2, title: 1, text: 0 }

const area = (box: Region): number => box.width * box.height

/** Part de `inner` qui tombe dans `outer`, entre 0 et 1. */
function overlap(inner: Region, outer: Region): number {
  const left = Math.max(inner.left, outer.left)
  const top = Math.max(inner.top, outer.top)
  const right = Math.min(inner.left + inner.width, outer.left + outer.width)
  const bottom = Math.min(inner.top + inner.height, outer.top + outer.height)

  if (right <= left || bottom <= top) return 0
  const inside = (right - left) * (bottom - top)
  return area(inner) > 0 ? inside / area(inner) : 0
}

/** Part de `region` couverte par une region plus specialisee. */
const CONTAINED = 0.7

/**
 * Fait le menage dans ce que le detecteur a rendu.
 *
 * Deux cas, observes sur de vraies captures :
 *
 *   - **le bloc et ses lignes.** Une page rendait un bloc de 830 × 252 et, a
 *     l'interieur, quatre lignes de 26 pixels de haut. Lire les cinq
 *     donnerait le meme texte cinq fois. On garde le plus grand — c'est aussi
 *     celui qui laisse au modele le plus de contexte ;
 *   - **le tableau pris dans un bloc de texte.** La, garder le plus grand
 *     serait exactement la faute a ne pas commettre : c'est la region
 *     specialisee qui compte, et le bloc qui l'enveloppe est ecarte.
 */
export function tidy(regions: Region[]): { region: Region; kind: JobKind }[] {
  const kept = regions
    .map((region) => ({ region, kind: jobKind(region.label) }))
    .filter((entry): entry is { region: Region; kind: JobKind } => entry.kind !== null)

  return kept.filter(({ region, kind }, index) =>
    kept.every((other, otherIndex) => {
      if (otherIndex === index) return true

      const inside = overlap(region, other.region)
      if (inside < CONTAINED) return true

      // Contenue dans une region plus specialisee : elle disparait, la tache
      // dediee rendra ce qu'elle porte.
      if (RANK[other.kind] > RANK[kind]) return false

      // Meme importance : le plus grand garde la main. L'egalite stricte est
      // tranchee par le rang dans la liste, sans quoi deux boites identiques
      // s'elimineraient l'une l'autre et leur contenu serait perdu.
      if (RANK[other.kind] === RANK[kind]) {
        if (area(other.region) > area(region)) return false
        if (area(other.region) === area(region)) return otherIndex > index
      }

      return true
    })
  )
}

/**
 * Met les regions dans l'ordre ou on les lit.
 *
 * De haut en bas, mais par bandes : deux regions qui se chevauchent
 * verticalement de plus de moitie appartiennent a la meme bande, et se lisent
 * alors de gauche a droite. Sans cela, une diapositive en deux colonnes se
 * lirait en zigzag — une ligne a gauche, une ligne a droite — et le cours
 * serait illisible sans qu'aucune region n'ait pourtant ete mal lue.
 *
 * **On construit les bandes, on ne les devine pas dans un comparateur.** La
 * version precedente decidait au coup par coup — « meme bande ? alors gauche a
 * droite, sinon haut en bas » — et cette regle n'est pas un ordre : A avant B,
 * B avant C, et pourtant C avant A se construit sans peine sur une diapositive
 * a deux colonnes coiffee d'un bandeau. `Array.prototype.sort` ne promet alors
 * plus rien du tout, et la page ressortait dans un ordre que rien n'expliquait.
 *
 * Une bande est donc formee d'abord, autour de sa **premiere** region — et non
 * de son etendue accumulee, qui grandirait a chaque ajout jusqu'a avaler la
 * page. L'ordre qui en sort est total par construction : les bandes se suivent
 * dans l'ordre de leur premiere region, et chaque bande se lit de gauche a
 * droite.
 */
export function readingOrder(entries: { region: Region; kind: JobKind }[]): typeof entries {
  const byTop = [...entries].sort((a, b) => a.region.top - b.region.top || a.region.left - b.region.left)

  const bands: (typeof entries)[] = []

  for (const entry of byTop) {
    const band = bands[bands.length - 1]
    const first = band?.[0].region

    if (first && sameBand(first, entry.region)) band.push(entry)
    else bands.push([entry])
  }

  return bands.flatMap((band) => [...band].sort((a, b) => a.region.left - b.region.left))
}

/** Deux regions se chevauchent-elles verticalement de plus de la moitie ? */
function sameBand(first: Region, second: Region): boolean {
  const top = Math.max(first.top, second.top)
  const bottom = Math.min(first.top + first.height, second.top + second.height)
  const shared = Math.max(0, bottom - top)
  const shorter = Math.min(first.height, second.height)

  return shorter > 0 && shared / shorter > 0.5
}

/**
 * Marge ajoutee autour d'une region avant la decoupe.
 *
 * Les boites collent au contenu, parfois au pixel. Un tableau ampute de sa
 * derniere bordure, une lettre coupee en deux, et la lecture se degrade sans
 * raison visible. Six pixels ne coutent rien et evitent cela.
 */
const PADDING = 6

/** Une region trop petite ne porte rien qui vaille une lecture de vingt secondes. */
const MINIMUM = 24

/**
 * Etablit le plan de lecture d'une page : quoi lire, dans quel ordre, et a
 * quelle taille.
 *
 * Le budget se repartit en deux temps. Chaque region part de sa taille reelle,
 * ramenee au plafond d'une image seule — celui au-dela duquel l'encodeur visuel
 * epuise la memoire graphique. Si la somme depasse le budget de la page, tout
 * est reduit d'un meme facteur : les proportions entre regions sont conservees,
 * et le tableau reste le mieux servi de la page parce qu'il est le plus grand.
 */
export function planPage(layout: PageLayout): Job[] {
  const entries = readingOrder(tidy(layout.regions))

  const boxes = entries
    .map(({ region, kind }) => ({
      kind,
      left: Math.max(0, region.left - PADDING),
      top: Math.max(0, region.top - PADDING),
      width: Math.min(layout.width, region.left + region.width + PADDING) - Math.max(0, region.left - PADDING),
      height: Math.min(layout.height, region.top + region.height + PADDING) - Math.max(0, region.top - PADDING)
    }))
    .filter((box) => box.width >= MINIMUM && box.height >= MINIMUM)

  // Taille de depart : la taille reelle, sans jamais agrandir, et sous le
  // plafond d'une image seule.
  const wanted = boxes.map((box) => fitToOcrBudget(box.width, box.height))

  const total = wanted.reduce((sum, size) => sum + size.width * size.height, 0)
  const squeeze = total > OCR_PAGE_PIXEL_BUDGET ? Math.sqrt(OCR_PAGE_PIXEL_BUDGET / total) : 1

  return boxes.map((box, index) => {
    const size = wanted[index]
    const scaled = fitToOcrBudget(
      Math.max(MINIMUM, Math.round(size.width * squeeze)),
      Math.max(MINIMUM, Math.round(size.height * squeeze))
    )

    return { ...box, scaledWidth: scaled.width, scaledHeight: scaled.height }
  })
}
