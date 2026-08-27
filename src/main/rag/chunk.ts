/**
 * Decoupage d'un cours en passages interrogeables.
 *
 * Un passage doit etre assez grand pour se suffire a lui-meme — une definition
 * coupee en deux ne sert a rien — et assez petit pour qu'en remonter une dizaine
 * reste bien plus economique que d'envoyer le cours entier.
 *
 * Chaque passage porte son ancre : le numero de page pour un PDF, le titre de
 * section pour un Word ou un Markdown. C'est cette ancre que l'IA cite, et
 * c'est elle qui permet de revenir au bon endroit du document.
 */

import type { ExtractedCourse } from '../../shared/types'

/** Taille visee d'un passage, en caracteres. */
const TARGET_SIZE = 1400

/**
 * Taille au-dela de laquelle un passage sort du regime ou le modele a ete
 * evalue.
 *
 * Le rapport technique d'EmbeddingGemma annonce une fenetre de 2048 tokens,
 * mais precise que la qualite est mesuree a 512 tokens — au-dela, seule une
 * tache synthetique de reperage a ete testee. Le tokeniseur du modele, applique
 * aux cours de ce vault, rend 3,68 caracteres par token (3,45 a 3,50 sur le
 * francais, 4,39 sur l'anglais) ; le prefixe de tache en consomme 9. Il reste
 * donc environ 1850 caracteres de passage utile.
 *
 * C'est un plafond, pas une cible : un paragraphe entier qui deborde legerement
 * de la taille visee vaut mieux qu'un paragraphe coupe en deux.
 */
const MAX_SIZE = 1850

/**
 * Reprise entre deux passages consecutifs.
 *
 * Elle ne sert plus que la ou l'on coupe sans frontiere : un paragraphe unique
 * qui depasse a lui seul le plafond. Partout ailleurs, la coupe tombe sur une
 * fin de paragraphe, et il n'y a plus de phrase a cheval a rattraper.
 */
const OVERLAP = 200

export interface Chunk {
  /** Identifiant stable dans le cours. */
  id: string
  /** Ce que l'IA cite : « p. 12 » ou « 2. Les covenants ». */
  anchor: string
  /** Numero de page, pour les documents pagines uniquement. */
  page: number | null
  /** Titre de la section d'ou vient le passage, si le document en a. */
  heading: string | null
  text: string
  /**
   * D'ou vient ce passage : matiere, cours, section, page.
   *
   * Ce n'est pas du texte a lire, et cela ne rejoint jamais `text` : mesure sur
   * les cours de ce vault, un fil d'Ariane recopie en tete de chaque passage
   * degrade la recherche au lieu de l'aider. Presque identique partout, il tire
   * tous les vecteurs vers un meme centre — la moyenne des tokens fait le
   * reste. Il part en revanche dans l'emplacement `title:` qu'EmbeddingGemma
   * attend, ou le modele a appris a le traiter comme une etiquette et non comme
   * du propos.
   */
  context: string
}

export interface CourseIndexSource {
  chunks: Chunk[]
  /** Plan du document, place dans le prompt pour guider les recherches. */
  outline: string[]
}

/** Longueur maximale d'une entree du plan. */
const OUTLINE_MAX = 90

export function chunkCourse(extracted: ExtractedCourse): CourseIndexSource {
  return extracted.anchor === 'page' ? chunkPages(extracted) : chunkSections(extracted)
}

// ---------------------------------------------------------------------------
// Documents pagines
// ---------------------------------------------------------------------------

/** Une phrase achevee. Ce qui n'en est pas une continue a la page suivante. */
const FINISHED = /[.!?:;»"')\]]\s*$/

/**
 * Le texte utile de chaque page, prepare une fois pour toutes.
 *
 * Une page est l'unite naturelle d'un PDF : c'est ce que l'utilisateur voit, et
 * ce vers quoi une citation le renvoie. Elle reste donc l'ancre — mais elle
 * n'est plus un mur. Une phrase qui court d'une page a l'autre y est recollee,
 * et le passage qui la contient est cite a la page ou il commence.
 *
 * Cette preparation est a part parce qu'elle sert deux decoupages : le large,
 * juste en dessous, et le fin de `chunk-fine.ts`. Les refaire chacun de son
 * cote finirait par les faire diverger — et deux passages qui ne parlent plus
 * de la meme page sont deux passages qui ne se recoupent plus.
 */
export function pagesText(
  extracted: ExtractedCourse
): { page: number; section: string | null; paragraphs: string[] }[] {
  // Le sommaire n'est pas du contenu : ses lignes sont des renvois, et leurs
  // titres empiles remontent a toutes les questions sans repondre a aucune.
  const pages = extracted.pages
    .filter((page) => !page.toc)
    .map((page) => ({
      page: page.page,
      section: page.section ?? null,
      paragraphs: page.text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
    }))

  // Recollage des phrases a cheval. Le paragraphe qui reprend en haut de la
  // page suivante rejoint celui qu'il termine, et non l'inverse : c'est la ou
  // la phrase commence que le lecteur doit etre renvoye.
  for (let index = 0; index < pages.length - 1; index += 1) {
    const current = pages[index]
    const next = pages[index + 1]

    const tail = current.paragraphs[current.paragraphs.length - 1]
    const head = next.paragraphs[0]
    if (!tail || !head) continue

    // Une section qui change est une vraie rupture, quoi que dise la
    // ponctuation : la page suivante parle d'autre chose.
    if (current.section && next.section && current.section !== next.section) continue
    if (next.page !== current.page + 1) continue

    // Une phrase inachevee d'un cote, une reprise en minuscule de l'autre : les
    // deux conditions, car un titre non ponctue suivi d'un paragraphe ordinaire
    // remplirait la premiere a lui seul.
    if (FINISHED.test(tail)) continue
    if (!/^[\p{Ll}(«"']/u.test(head)) continue

    current.paragraphs[current.paragraphs.length - 1] = `${tail} ${head}`
    next.paragraphs.shift()
  }

  return pages
}

/**
 * Une page reste l'unite citee : les paragraphes s'y regroupent, mais un
 * passage ne traverse jamais sa frontiere — l'ancre doit designer un endroit
 * que le lecteur retrouve a l'oeil.
 */
function chunkPages(extracted: ExtractedCourse): CourseIndexSource {
  const chunks: Chunk[] = []

  for (const page of pagesText(extracted)) {
    const text = page.paragraphs.join('\n\n').trim()
    if (!text) continue

    const anchor = `p. ${page.page}`
    const context = contextLine(extracted.courseId, page.section, anchor)

    split(text).forEach((part, index) => {
      chunks.push({
        id: `p${page.page}#${index}`,
        anchor,
        page: page.page,
        heading: page.section,
        text: part,
        context
      })
    })
  }

  return { chunks, outline: pageOutline(extracted) }
}

/**
 * D'ou vient ce passage : la matiere, le cours, la section, la page.
 *
 * C'est la version gratuite de l'enrichissement contextuel — pas une phrase
 * ecrite par un modele, juste ce que le document sait deja de lui-meme, et
 * qu'on jetait.
 */
export function contextLine(courseId: string, section: string | null, anchor: string): string {
  const parts = courseId.split('/')
  const subject = parts.length > 1 ? parts[0] : null
  const title = (parts[parts.length - 1] ?? courseId)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()

  return [subject, title, section, anchor].filter(Boolean).join(' › ')
}

/**
 * Le plan du document, une entree par section et non par page.
 *
 * Les en-tetes courants se repetent sur toute leur section : les lister page
 * par page donnerait quarante lignes pour douze sections, et le plan cesserait
 * d'etre un plan.
 */
function pageOutline(extracted: ExtractedCourse): string[] {
  const outline: string[] = []
  let previous: string | null = null

  for (const page of extracted.pages) {
    if (page.toc) continue
    const section = page.section ?? null
    if (!section || section === previous) continue

    outline.push(`p. ${page.page} — ${truncate(section, OUTLINE_MAX)}`)
    previous = section
  }

  if (outline.length > 0) return outline

  // Aucun en-tete courant : le document n'a pas de sections reperables. La
  // premiere ligne de chaque page reprend son ancien role — moins juste, mais
  // un plan approximatif guide mieux les recherches que pas de plan du tout.
  return extracted.pages
    .filter((page) => !page.toc && page.text.trim())
    .map((page) => {
      const first = page.text.split('\n')[0]?.trim()
      return first ? `p. ${page.page} — ${truncate(first, OUTLINE_MAX)}` : ''
    })
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Documents structures par titres
// ---------------------------------------------------------------------------

interface Section {
  /** Titre de la section elle-meme. */
  heading: string | null
  /** Chemin complet des titres, du plus general au plus precis. */
  path: string[]
  level: number
  lines: string[]
}

/**
 * Un Word ou un Markdown n'a pas de pages, mais il a des titres — et un titre
 * delimite bien mieux une idee qu'une coupe tous les mille caracteres.
 */
function chunkSections(extracted: ExtractedCourse): CourseIndexSource {
  const sections = splitByHeading(extracted.markdown)
  const chunks: Chunk[] = []
  const outline: string[] = []

  for (const section of sections) {
    const text = section.lines.join('\n').trim()
    if (!text) continue

    // L'ancre porte le chemin entier, pas seulement le titre le plus proche :
    // un cours contient dix sections « Description », et « Description » tout
    // court ne renverrait l'utilisateur nulle part.
    const anchor = section.path.length > 0 ? section.path.join(' › ') : 'Introduction'
    if (section.heading) {
      // L'indentation du plan reproduit la hierarchie des titres.
      outline.push(`${'  '.repeat(Math.max(0, section.level - 1))}${truncate(section.heading, OUTLINE_MAX)}`)
    }

    // Meme contexte que pour un PDF, tire cette fois de titres explicites : un
    // Word ou un Markdown n'a pas a les deviner.
    const context = contextLine(extracted.courseId, null, anchor)

    split(text).forEach((part, index) => {
      chunks.push({
        id: `${slug(anchor)}#${index}`,
        anchor,
        page: null,
        heading: section.heading,
        text: part,
        context
      })
    })
  }

  return { chunks, outline }
}

export function splitByHeading(markdown: string): Section[] {
  const sections: Section[] = []
  // Titre courant a chaque niveau, pour reconstituer le chemin.
  const stack: string[] = []
  let current: Section = { heading: null, path: [], level: 0, lines: [] }

  for (const line of markdown.split('\n')) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) {
      if (current.lines.length > 0 || current.heading) sections.push(current)

      const level = match[1].length
      const title = match[2].trim()

      // On oublie les niveaux plus profonds que celui-ci : ils appartenaient au
      // chapitre precedent.
      stack.length = level - 1
      stack[level - 1] = title

      current = {
        heading: title,
        // Un document peut sauter un niveau ; les trous sont ecartes.
        path: stack.slice(0, level).filter(Boolean),
        level,
        lines: [title]
      }
      // Le titre fait partie du texte du passage : c'est souvent lui qui porte
      // les mots-cles de la question.
      continue
    }
    current.lines.push(line)
  }
  sections.push(current)

  return sections
}

// ---------------------------------------------------------------------------
// Decoupe d'un bloc trop long
// ---------------------------------------------------------------------------

/**
 * Regroupe des paragraphes en passages.
 *
 * On empile tant que la taille visee le permet, et on ferme sur une fin de
 * paragraphe — jamais au compteur de caracteres. C'est tout le benefice d'une
 * extraction qui rend enfin les frontieres de paragraphe : un passage commence
 * et finit ou l'auteur a commence et fini.
 */
function split(text: string): string[] {
  // Un document sans ligne vide n'a pas de frontiere de paragraphe a offrir —
  // un Word converti, par exemple. La fin de ligne est alors la meilleure
  // frontiere disponible, et vaut toujours mieux qu'un compteur.
  const separator = /\n{2,}/.test(text) ? /\n{2,}/ : /\n/

  const paragraphs = text
    .split(separator)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  const parts: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.trim()) parts.push(current.trim())
    current = ''
  }

  for (const paragraph of paragraphs) {
    // Un paragraphe qui depasse a lui seul le plafond n'a pas de frontiere ou
    // se poser : c'est le seul cas ou l'on coupe dans le texte, au plus pres
    // d'une fin de phrase, avec une reprise pour ne rien perdre a la jointure.
    if (paragraph.length > MAX_SIZE) {
      flush()
      parts.push(...hardSplit(paragraph))
      continue
    }

    if (!current) {
      current = paragraph
      continue
    }

    const joined = `${current}\n\n${paragraph}`
    if (joined.length <= TARGET_SIZE) {
      current = joined
      continue
    }

    // Entre la taille visee et le plafond : on accepte le debordement plutot
    // que d'ouvrir un passage pour un paragraphe seul, qui serait orphelin de
    // ce qui l'amene.
    if (joined.length <= MAX_SIZE && current.length < TARGET_SIZE * 0.5) {
      current = joined
      flush()
      continue
    }

    flush()
    current = paragraph
  }

  flush()
  return parts
}

/** Fin de phrase : point, deux-points, point d'interrogation, suivis d'un blanc. */
const SENTENCE_END = /[.!?:;][ »"')\]]*\s/g

/**
 * Coupe un paragraphe demesure au plus pres d'une fin de phrase.
 *
 * Le plafond et la reprise sont des arguments parce que le decoupage fin se
 * sert du meme repli avec un plafond bien plus bas : une « phrase » qu'`Intl
 * .Segmenter` n'a pas su terminer — un tableau, une enumeration sortie d'un
 * OCR — doit ceder au meme endroit, sur une ponctuation, et non a un compteur.
 * Les valeurs par defaut sont celles du decoupage large : son appel n'a pas
 * bouge d'un caractere.
 */
export function hardSplit(paragraph: string, maxSize = MAX_SIZE, overlap = OVERLAP): string[] {
  const parts: string[] = []
  let rest = paragraph

  while (rest.length > maxSize) {
    const window = rest.slice(0, maxSize)

    // La derniere fin de phrase de la fenetre, si elle n'est pas trop tot :
    // couper au tout debut ne ferait que reporter le probleme.
    let cut = -1
    SENTENCE_END.lastIndex = 0
    for (let match = SENTENCE_END.exec(window); match; match = SENTENCE_END.exec(window)) {
      cut = match.index + match[0].length
    }

    const end = cut > maxSize * 0.5 ? cut : maxSize
    parts.push(rest.slice(0, end).trim())
    rest = rest.slice(Math.max(0, end - overlap)).trimStart()
  }

  if (rest.trim()) parts.push(rest.trim())
  return parts
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}
