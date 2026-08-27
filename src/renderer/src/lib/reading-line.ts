/**
 * La ligne de lecture — ou l'on decide quelle page on est en train de lire.
 *
 * La question n'a rien d'evident des que deux pages tiennent a l'ecran : la fin
 * de la page 3 en haut, le debut de la page 4 en bas. La regle precedente —
 * « la page dont plus de la moitie est visible » — repondait mal deux fois.
 * Dezoome, deux pages depassent la moitie en meme temps et c'est l'ordre
 * d'arrivee des evenements qui tranchait, autant dire le hasard. Zoome, une
 * page plus haute que deux fois le cadre n'atteint jamais la moitie et le
 * compteur restait bloque sur la derniere page reconnue.
 *
 * Une ligne horizontale fixe repond toujours, et toujours une seule fois : la
 * page courante est celle que la ligne traverse. La reponse est positionnelle,
 * donc reproductible — meme defilement, meme page — et monotone : descendre ne
 * fait franchir la ligne que dans un sens, rien ne peut osciller.
 *
 * Elle est posee au tiers superieur et non au milieu, la ou l'oeil se pose
 * quand on lit en prenant des notes. C'est aussi la hauteur ou le panneau
 * ramene deja un passage qu'on lui demande de rejoindre.
 */

/** Hauteur de la ligne dans le cadre, en fraction depuis le haut. */
const HEIGHT = 1 / 3

/**
 * Un endroit du document : le bloc que la ligne traverse, et ou elle le
 * traverse — une fraction de sa hauteur.
 *
 * La fraction est ce qui rend l'endroit retrouvable : elle ne depend d'aucune
 * taille d'affichage, la ou un nombre de pixels de defilement ne veut plus rien
 * dire des que la mise en page a change de taille.
 */
export interface ReadingAnchor {
  element: HTMLElement
  offset: number
}

/** Ordonnee de la ligne, en coordonnees de fenetre. */
export function readingLineY(body: HTMLElement): number {
  const box = body.getBoundingClientRect()
  return box.top + box.height * HEIGHT
}

/**
 * L'endroit que la ligne traverse, parmi les blocs qu'on lui donne.
 *
 * Les blocs sont ceux du document affiche : les emplacements de page pour un
 * PDF, les paragraphes et les titres pour un Word ou un Markdown. L'appelant
 * les choisit, parce que lui seul sait lequel des deux rendus est a l'ecran.
 *
 * On retient le dernier bloc commence au-dessus de la ligne, ce qui donne le
 * premier tant qu'on n'a rien fait defiler et le dernier quand on est au bout
 * du document.
 */
export function anchorAtLine(body: HTMLElement, blocks: HTMLElement[]): ReadingAnchor | null {
  const line = readingLineY(body)
  let found: ReadingAnchor | null = null

  for (const block of blocks) {
    const box = block.getBoundingClientRect()
    if (box.top > line) break
    // Un bloc de hauteur nulle — une ancre, un separateur — n'a pas de fraction
    // a offrir : viser son debut est la seule reponse qui ait un sens.
    found = { element: block, offset: box.height > 0 ? (line - box.top) / box.height : 0 }
  }

  return found
}

/**
 * Ramene un endroit du document sur la ligne de lecture.
 *
 * C'est l'operation inverse de la precedente, et le pendant exact de ce que
 * font deja les renvois et les citations : on mesure ou le bloc se trouve
 * maintenant, et on deplace le defilement de ce qu'il faut.
 */
export function scrollToAnchor(body: HTMLElement, anchor: ReadingAnchor): void {
  // Le document a pu etre refait entre-temps — un cours qu'on quitte, un Word
  // reconverti. Un bloc qui n'est plus dans la page n'a plus d'endroit.
  if (!body.contains(anchor.element)) return

  const box = anchor.element.getBoundingClientRect()
  body.scrollTop += box.top + anchor.offset * box.height - readingLineY(body)
}

/**
 * Le dernier titre passe au-dessus de la ligne — la section en cours de
 * lecture d'un Word ou d'un Markdown, qui n'ont pas de pages a compter.
 */
export function sectionAtLine(root: HTMLElement, body: HTMLElement): string | null {
  const line = readingLineY(body)
  let section: string | null = null

  for (const heading of Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))) {
    if (heading.getBoundingClientRect().top > line) break
    const text = heading.textContent?.trim()
    if (text) section = text
  }

  return section
}

/**
 * Les sections dont une partie tient dans le cadre — ce qu'on a sous les yeux,
 * et non ou l'on en est de sa lecture.
 *
 * sectionAtLine, juste au-dessus, repond a l'autre question et n'a qu'une seule
 * reponse : la ligne ne traverse qu'un endroit du document, et c'est celui-la
 * qu'on accroche a une note. Ici on veut l'inverse, tout ce qui est affiche, et
 * pour une raison differente : restreindre un champ de recherche. Une note
 * ecrite a cet instant commente forcement quelque chose de visible, alors on
 * cherche le passage qu'elle commente parmi ces sections-la et nulle part
 * ailleurs — le reste du cours n'apporterait que des faux voisins. Deux
 * questions, deux fonctions.
 *
 * Les ordinaux sont ceux de l'unite de document : le N-ieme titre du document
 * ouvre la section N, et 0 designe le preambule qui precede le tout premier
 * titre.
 */
export function visibleSectionIndices(root: HTMLElement, body: HTMLElement): number[] {
  const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
  // Un support ecrit d'un seul bloc n'a qu'une section, le preambule : quoi
  // qu'on regarde, c'est forcement elle.
  if (headings.length === 0) return [0]

  const frame = body.getBoundingClientRect()
  const content = root.getBoundingClientRect()
  /**
   * Les frontieres des sections, de haut en bas : le haut du contenu ouvre le
   * preambule, chaque titre ferme la section precedente et ouvre la sienne, le
   * bas du contenu ferme la derniere. La section d'ordinal n s'etend donc de
   * bounds[n] a bounds[n + 1], ce qui vaut aussi pour le preambule sans avoir
   * a le traiter a part. Les parcourir dans l'ordre suffit a rendre une liste
   * triee et sans doublon.
   */
  const bounds = [
    content.top,
    ...headings.map((heading) => heading.getBoundingClientRect().top),
    content.bottom
  ]

  const visible: number[] = []
  for (let ordinal = 0; ordinal + 1 < bounds.length; ordinal++) {
    if (bounds[ordinal] < frame.bottom && bounds[ordinal + 1] > frame.top) visible.push(ordinal)
  }

  return visible
}

/**
 * Ou l'on en est dans un document sans titre : la fraction du document deja
 * parcourue. Grossier, mais toujours disponible — et c'est la seule chose qui
 * reste a rattacher a une note sur un support ecrit d'un seul bloc.
 */
export function progressAtLine(body: HTMLElement): number {
  const travel = body.scrollHeight - body.clientHeight
  if (travel <= 0) return 0
  return Math.min(1, Math.max(0, body.scrollTop / travel))
}
