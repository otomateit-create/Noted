/**
 * Recherche dans le document ouvert.
 *
 * Deux documents, deux facons de chercher. Un PDF est peint dans un canvas :
 * il n'y a pas de texte a surligner a l'ecran, seulement le texte extrait a
 * l'ouverture — on rend donc une liste d'occurrences, chacune avec sa page. Un
 * Word ou un Markdown, lui, est du vrai HTML dans la page : on peut y poser un
 * surlignage sur l'occurrence elle-meme.
 */

/**
 * Depliage des accents, un caractere pour un caractere. Le tableau importe
 * autant que le resultat : « resume » doit trouver « resume », mais surtout
 * chaque position du texte deplie doit correspondre exactement a la meme
 * position du texte d'origine. Sans cela, le surlignage se poserait a cote.
 *
 * C'est pourquoi on n'utilise pas `normalize('NFD')`, qui separe la lettre de
 * son accent et allonge donc la chaine.
 */
const ACCENTS = 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸ'
const PLAIN = 'aaaaaaceeeeiiiinooooouuuuyyAAAAAACEEEEIIIINOOOOOUUUUYY'

/** Table construite une fois : chercher dans la chaine coutait cinquante-quatre
 *  comparaisons par caractere du document. */
const FOLDED = new Map<string, string>(
  Array.from(ACCENTS, (accent, index) => [accent, PLAIN[index]])
)

/** Met un texte a plat pour la comparaison, sans jamais changer sa longueur. */
export function fold(text: string): string {
  let folded = ''

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const plain = FOLDED.get(character)

    if (plain !== undefined) {
      folded += plain
      continue
    }

    // Une poignee de caracteres exotiques s'allongent en minuscule ; on les
    // laisse tels quels plutot que de decaler tout ce qui suit.
    const lower = character.toLowerCase()
    folded += lower.length === 1 ? lower : character
  }

  return folded
}

/** Positions de toutes les occurrences, sans jamais se recouvrir. */
function positions(haystack: string, needle: string): number[] {
  const found: number[] = []
  let from = 0

  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return found
    found.push(at)
    from = at + needle.length
  }
}

/** Ce qu'on montre autour d'une occurrence, de chaque cote. */
const CONTEXT = 42

export interface FindHit {
  /** Page du PDF. Vaut null pour un document sans pagination. */
  page: number | null
  /** Titre de section le plus proche, pour un document sans pagination. */
  heading: string | null
  /** Extrait coupe en trois, pour pouvoir souligner le milieu. */
  before: string
  match: string
  after: string
  /** Etendue dans le DOM. Absente pour un PDF, qui n'a pas de texte a l'ecran. */
  range?: Range
}

/** Decoupe l'extrait autour d'une occurrence, avec des points de suspension. */
function excerpt(text: string, at: number, length: number): Pick<FindHit, 'before' | 'match' | 'after'> {
  const start = Math.max(0, at - CONTEXT)
  const end = Math.min(text.length, at + length + CONTEXT)

  return {
    before: `${start > 0 ? '…' : ''}${text.slice(start, at).replace(/\s+/g, ' ')}`,
    match: text.slice(at, at + length),
    after: `${text.slice(at + length, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
  }
}

/**
 * Pages deja depliees, retenues par l'objet qui les porte.
 *
 * Le document ne change pas entre deux frappes, seule la requete change. Sans
 * cette memoire, chaque touche repliait les cinquante pages du cours. La table
 * est faible : les pages disparaissent avec le cours qu'on ferme.
 */
const foldedPages = new WeakMap<object, string>()

function foldedPage(page: { text: string }): string {
  const known = foldedPages.get(page)
  if (known !== undefined) return known

  const folded = fold(page.text)
  foldedPages.set(page, folded)
  return folded
}

/** Cherche dans le texte extrait d'un PDF, page par page. */
export function searchPages(
  pages: Array<{ page: number; text: string }>,
  query: string
): FindHit[] {
  const needle = fold(query.trim())
  if (!needle) return []

  const hits: FindHit[] = []

  for (const page of pages) {
    for (const at of positions(foldedPage(page), needle)) {
      hits.push({
        page: page.page,
        heading: null,
        ...excerpt(page.text, at, needle.length)
      })
    }
  }

  return hits
}

// ---------------------------------------------------------------------------
// Documents affiches en HTML : Word et Markdown
// ---------------------------------------------------------------------------

export interface TextPiece {
  node: Text
  /** Position du debut de ce noeud dans le texte concatene du document. */
  start: number
}

/**
 * Rassemble le texte visible du document et garde la trace de sa provenance.
 * C'est ce qui permet ensuite de retrouver, pour une position dans le texte,
 * le noeud exact et le decalage exact ou poser le surlignage.
 */
export function collect(root: HTMLElement): { text: string; pieces: TextPiece[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const pieces: TextPiece[] = []
  let text = ''

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const piece = node as Text
    if (!piece.data) continue

    pieces.push({ node: piece, start: text.length })
    text += piece.data
  }

  return { text, pieces }
}

/** Retrouve le noeud et le decalage correspondant a une position du texte. */
export function nodeAt(
  pieces: TextPiece[],
  position: number
): { node: Text; offset: number } | null {
  // Recherche dichotomique : un cours de trente pages fait plusieurs milliers
  // de noeuds, et cette fonction est appelee deux fois par occurrence.
  let low = 0
  let high = pieces.length - 1
  let found = -1

  while (low <= high) {
    const middle = (low + high) >> 1
    if (pieces[middle].start <= position) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (found < 0) return null
  const piece = pieces[found]
  return { node: piece.node, offset: position - piece.start }
}

/** Titre le plus proche au-dessus d'un noeud — l'equivalent du numero de page. */
export function headingAbove(node: Node, root: HTMLElement): string | null {
  let element = node.parentElement

  while (element && element !== root) {
    // Une occurrence trouvee dans un titre appartient a ce titre, et non au
    // precedent : sans ce controle, chercher un mot du titre « 2. Le cout moyen
    // pondere » le situerait dans la section 1.
    if (/^H[1-6]$/.test(element.tagName)) return element.textContent?.trim() ?? null

    for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) return sibling.textContent?.trim() ?? null
    }
    element = element.parentElement
  }

  return null
}

/**
 * Cherche dans un document affiche en HTML. Chaque occurrence rapporte son
 * etendue dans le DOM, prete a etre surlignee.
 */
export function searchHtml(root: HTMLElement, query: string): FindHit[] {
  const needle = fold(query.trim())
  if (!needle) return []

  const { text, pieces } = collect(root)
  const hits: FindHit[] = []

  for (const at of positions(fold(text), needle)) {
    const from = nodeAt(pieces, at)
    const to = nodeAt(pieces, at + needle.length - 1)
    if (!from || !to) continue

    const range = document.createRange()
    range.setStart(from.node, from.offset)
    // Le dernier caractere, plus un : une etendue s'arrete apres ce qu'elle
    // contient. Passer par le dernier caractere plutot que par la position
    // suivante evite de deborder sur le noeud d'apres.
    range.setEnd(to.node, to.offset + 1)

    hits.push({
      page: null,
      heading: headingAbove(from.node, root),
      ...excerpt(text, at, needle.length),
      range
    })
  }

  return hits
}

// ---------------------------------------------------------------------------
// Surlignage a l'ecran
// ---------------------------------------------------------------------------

const ALL = 'noted-find'
const CURRENT = 'noted-find-current'

/**
 * Peint les occurrences sans toucher au document.
 *
 * L'API de surlignage du navigateur travaille sur des etendues, pas sur des
 * balises : rien n'est insere dans le HTML. C'est ce qui compte ici, puisque ce
 * HTML est rendu par React — y glisser des balises reviendrait a lui retirer le
 * document sous les pieds au premier rendu suivant.
 */
export function paintHits(hits: FindHit[], current: number): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return

  const ranges = hits.map((hit) => hit.range).filter((range): range is Range => Boolean(range))
  if (ranges.length === 0) {
    clearHits()
    return
  }

  CSS.highlights.set(ALL, new Highlight(...ranges))

  const active = hits[current]?.range
  if (active) CSS.highlights.set(CURRENT, new Highlight(active))
  else CSS.highlights.delete(CURRENT)
}

export function clearHits(): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}
