/**
 * Second decoupage du meme cours, en passages de quelques phrases.
 *
 * Le decoupage large de `chunk.ts` repond a « de quoi parle cet endroit du
 * cours » : mille quatre cents caracteres, un paragraphe entier ou deux, de
 * quoi tenir tout seul dans une reponse. Celui-ci repond a une autre question
 * — « quelle phrase, exactement, ce bloc de note commente-t-il » — et c'est
 * pour cela qu'on ne se contente pas du premier.
 *
 * Un vecteur est une moyenne : plus le passage est long, plus il tire vers le
 * theme general et moins il distingue une phrase de sa voisine. Un bloc de note
 * fait une ligne ou deux ; le confronter a mille quatre cents caracteres
 * revient a demander lequel de deux paragraphes parle « le plus » du meme
 * sujet, et la reponse est a peu pres oui pour les deux. Ce qu'on veut poser au
 * bout, en revanche, est un surlignage de trois lignes : la comparaison doit se
 * faire a la taille du resultat attendu, pas a celle de la recherche.
 *
 * Tout le reste — l'ancre citee, le contexte `title:`, le sommaire ecarte, les
 * phrases recollees d'une page a l'autre — est repris tel quel de `chunk.ts`.
 * Les deux decoupages decrivent le meme document ; s'ils cessaient d'etre
 * d'accord sur ses frontieres, un passage fin renverrait a un endroit que le
 * decoupage large, et donc le lecteur, ne connait pas.
 */

import { CONTEXT, readable } from '../../shared/passage'
import type { ExtractedCourse } from '../../shared/types'
import { contextLine, hardSplit, pagesText, splitByHeading } from './chunk'

export interface FineChunk {
  /** Identifiant stable dans le cours : « p12#3 » (page) ou « s7#2 » (section). */
  id: string
  /** L'unite du document d'ou vient ce passage : « page:12 » ou « section:7 ». */
  unitKey: string
  /** Ce qui se cite : « p. 12 » ou « 2. Les covenants ». Meme forme que Chunk.anchor. */
  anchor: string
  /** Numero de page, pour les documents pagines uniquement. Null sinon. */
  page: number | null
  /** Ordinal du titre qui ouvre la section, 0 pour le preambule. Null pour un document pagine. */
  sectionIndex: number | null
  /** Titre de la section d'ou vient le passage, si le document en a un. */
  heading: string | null
  /**
   * Le texte du passage, tel qu'il s'affiche a l'ecran : passe par `readable()`
   * et, pour un cours a titres, debarrasse de son balisage. C'est ce qui permet
   * de le retrouver dans le document affiche, donc d'y encadrer la phrase.
   */
  text: string
  /** Voisinage immediat dans le texte source, CONTEXT (=40) caracteres, readable(). */
  before: string
  /** Idem, apres. */
  after: string
  /** Meme role que Chunk.context : l'emplacement `title:` d'EmbeddingGemma. */
  context: string
}

/**
 * Nombre de phrases par passage.
 *
 * Une seule phrase serait la granularite ideale sur le papier, et la pire en
 * pratique : « C'est la difference essentielle. » ne dit rien hors de ce qui la
 * precede, et son vecteur ne ressemble a rien. Quatre suffisent a porter une
 * idee complete, et absorbent au passage les fausses coupes du segmenteur —
 * « M. Dupont » lui fait deux phrases, ce qui ne se voit plus une fois groupe.
 */
const SENTENCES = 4

/**
 * Plafond d'une phrase, en caracteres.
 *
 * `Intl.Segmenter` ne coupe que sur une ponctuation suivie d'une majuscule. Un
 * tableau aplati, une enumeration, une page de titres sans points : rien de
 * tout cela n'en contient, et le segmenteur rend alors la page entiere comme
 * une seule « phrase ». Quatre de ces phrases-la feraient un passage de
 * plusieurs milliers de caracteres, c'est-a-dire exactement ce que ce
 * decoupage existe pour eviter.
 */
const MAX_SIZE_FINE = 700

/**
 * En deca de quoi un passage ne designe plus rien.
 *
 * Le numero imprime en pied de page se retrouve seul dans son groupe des que le
 * compte de phrases tombe juste : trois mille passages d'un vault en comptaient
 * quatre-vingt-six reduits a « 41 ». Ce n'est pas du contenu, c'est un reste de
 * mise en page, et cela couterait un vecteur pour un candidat sur lequel aucune
 * note ne peut sensement s'ancrer — d'autant qu'ici le meilleur score gagne
 * toujours, sans seuil pour l'ecarter au moment du choix.
 *
 * Douze caracteres : en dessous, un passage n'a plus de quoi se distinguer de
 * n'importe quel autre bout du cours, et le retrouver dans le document
 * releverait du hasard autant que de la recherche.
 */
const MIN_SIZE_FINE = 12

/**
 * Le segmenteur est construit une fois : l'assembler coute une resolution de
 * locale ICU, et un cours en demande des milliers.
 */
const SEGMENTER = new Intl.Segmenter('fr', { granularity: 'sentence' })

/** Un morceau du texte source, garde par ses positions et non par sa copie. */
interface Span {
  start: number
  end: number
}

export function chunkCourseFine(extracted: ExtractedCourse): FineChunk[] {
  return extracted.anchor === 'page' ? chunkPagesFine(extracted) : chunkSectionsFine(extracted)
}

function chunkPagesFine(extracted: ExtractedCourse): FineChunk[] {
  const chunks: FineChunk[] = []

  for (const page of pagesText(extracted)) {
    const source = page.paragraphs.join('\n\n').trim()
    if (!source) continue

    const anchor = `p. ${page.page}`
    const context = contextLine(extracted.courseId, page.section, anchor)

    passages(source).forEach((span, index) => {
      chunks.push({
        id: `p${page.page}#${index}`,
        unitKey: `page:${page.page}`,
        anchor,
        page: page.page,
        sectionIndex: null,
        heading: page.section,
        ...around(source, span),
        context
      })
    })
  }

  return chunks
}

/**
 * Le texte d'une section tel qu'il s'affiche a l'ecran.
 *
 * Un cours pagine est indexe depuis le texte que l'extraction rend, et c'est
 * exactement celui que la couche de texte de la page affiche : les deux cotes
 * disent la meme chose, mot pour mot. Un cours a titres, lui, est indexe depuis
 * sa source Markdown — celle du fichier pour un Markdown, celle que la
 * conversion produit pour un Word — mais il est *affiche* en HTML rendu. Les
 * deux etoiles d'un gras, la puce d'une liste, la barre d'un tableau, le
 * chevron d'une citation n'arrivent jamais jusqu'a l'ecran.
 *
 * Or l'ancre d'une note ne garde pas une position mais le texte du passage, et
 * `locateAnnotation` le retrouve en le cherchant, tel quel, dans le document
 * affiche. Un passage garde avec son balisage n'y est donc jamais retrouve : le
 * point de la marge ramenait bien a la bonne section, sans jamais encadrer la
 * phrase — l'encadre ne se voyait que sur les PDF. Mesure sur les cours
 * Markdown du vault : un passage sur huit se retrouvait, contre neuf sur dix
 * une fois le balisage retire.
 *
 * Le nettoyage a lieu ici, avant le decoupage, et non a la relecture : les
 * phrases se comptent alors sur la prose seule, le voisinage se prend dans du
 * texte propre, et le passage cite dans la marge se lit comme le cours. Le
 * vecteur y gagne au passage, pour la raison que `plainNote` expose de l'autre
 * cote — une moyenne sur les tokens que le balisage tire vers un centre qui
 * n'est celui d'aucun paragraphe.
 *
 * Le decoupage large, lui, n'est pas touche : ce qu'il rend part chez
 * l'assistant, a qui la structure sert.
 */
function displayed(lines: string[], titled: boolean): string {
  return lines
    .map((line, index) =>
      // La premiere ligne d'une section titree *est* son titre, dont
      // `splitByHeading` a deja retire les dieses. Un « 1. » ou un « - » en
      // tete d'un titre lui appartient et s'affiche : y appliquer les marques
      // de bloc effacerait le numero que le lecteur a sous les yeux.
      index === 0 && titled ? withoutInlineMarks(line) : withoutInlineMarks(withoutBlockMarks(line))
    )
    .join('\n')
    .trim()
}

/** Ce que le navigateur dessine en tete de ligne au lieu de l'ecrire. */
function withoutBlockMarks(line: string): string {
  return (
    line
      // La ligne qui fait d'un tableau un tableau : de la ponctuation pure,
      // rendue par une bordure.
      .replace(/^ {0,3}\|?(?:\s*:?-{3,}:?\s*\|)+.*$/, ' ')
      // Les clotures d'un bloc de code : le contenu reste, les accents non.
      .replace(/^ {0,3}(?:```|~~~).*$/, ' ')
      // Les chevrons d'abord, car ils precedent tout le reste, et un titre ou
      // une puce peut vivre dans une citation.
      .replace(/^[ \t]*(?:>[ \t]?)+/, ' ')
      // Titre, puce, numero de liste : un retrait, une pastille, un compteur —
      // jamais du texte. Le filet horizontal, lui, se passe de regle : ses
      // tirets sont deja ignores de part et d'autre de la comparaison.
      .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+[.)])[ \t]+/, ' ')
  )
}

/**
 * Ce qui habille un mot sans rien ajouter a l'ecran.
 *
 * Deux signes de balisage restent, et c'est voulu. Le dollar, parce qu'un cours
 * de finance en est plein — « une operation a $1 milliard » s'affiche avec son
 * dollar, et une vraie formule est de toute facon composee par KaTeX, donc
 * introuvable quoi qu'on fasse. Le tiret bas, parce qu'un nom de variable en
 * porte plus souvent qu'un mot en italique n'en est encadre.
 */
function withoutInlineMarks(text: string): string {
  return (
    text
      // Un lien ne montre que son libelle ; son adresse n'est nulle part.
      .replace(/\[([^\]]*)\]\([^()\s]*(?:[ \t]+"[^"]*")?\)/g, '$1')
      // Emphase, code en ligne, barres d'un tableau.
      .replace(/[*`|]/g, ' ')
  )
}

function chunkSectionsFine(extracted: ExtractedCourse): FineChunk[] {
  const chunks: FineChunk[] = []

  /**
   * L'ordinal se compte sur les titres rencontres, et surtout pas sur l'index
   * du tableau rendu par `splitByHeading` : ce tableau ne contient le preambule
   * que si le document en a un, si bien qu'un cours commencant par « # Titre »
   * et un cours commencant par une ligne vide numeroteraient la meme section
   * differemment. Le compte des titres, lui, donne le N-ieme `<h1>`-`<h6>` du
   * DOM — la seule chose que la fenetre sache montrer.
   */
  let sectionIndex = 0

  for (const section of splitByHeading(extracted.markdown)) {
    if (section.heading) sectionIndex += 1

    const source = displayed(section.lines, Boolean(section.heading))
    if (!source) continue

    // Meme ancre que le decoupage large : le chemin entier des titres, car un
    // cours contient dix sections « Description ».
    const anchor = section.path.length > 0 ? section.path.join(' › ') : 'Introduction'
    const context = contextLine(extracted.courseId, null, anchor)

    passages(source).forEach((span, index) => {
      chunks.push({
        id: `s${sectionIndex}#${index}`,
        unitKey: `section:${sectionIndex}`,
        anchor,
        page: null,
        sectionIndex,
        heading: section.heading,
        ...around(source, span),
        context
      })
    })
  }

  return chunks
}

/**
 * Les passages d'un texte : ses phrases, prises quatre par quatre.
 *
 * Sans recouvrement, contrairement au decoupage large. La reprise y servait a
 * ne pas perdre une phrase coupee en deux ; ici elle ferait tenir la meme
 * phrase dans deux passages voisins, qui se disputeraient le meme bloc de note
 * et se departageraient au hasard des arrondis.
 */
function passages(source: string): Span[] {
  const spans = sentences(source)
  const grouped: Span[] = []

  for (let index = 0; index < spans.length; index += SENTENCES) {
    const group = spans.slice(index, index + SENTENCES)
    const span = { start: group[0].start, end: group[group.length - 1].end }

    // Mesure sur le texte tel qu'il sera enregistre : la tranche brute d'un
    // numero de page seul compte ses blancs et passerait le seuil sans eux.
    if (readable(source.slice(span.start, span.end)).length < MIN_SIZE_FINE) continue

    grouped.push(span)
  }

  return grouped
}

/**
 * Les phrases d'un texte, reperees par leurs positions.
 *
 * On garde des positions et non des copies parce que le voisinage d'un passage
 * se prend dans le texte source : « avant » et « apres » n'ont de sens que la
 * ou le passage se trouvait, et une fois recopie il n'a plus de voisins.
 */
function sentences(source: string): Span[] {
  const spans: Span[] = []

  for (const { index, segment } of SEGMENTER.segment(source)) {
    // Le segmenteur rend les blancs qui suivent la ponctuation avec la phrase.
    // Ils appartiennent a la jointure, pas au passage.
    const start = index + segment.length - segment.trimStart().length
    const end = index + segment.trimEnd().length
    if (end <= start) continue

    const sentence = source.slice(start, end)
    if (sentence.length <= MAX_SIZE_FINE) {
      spans.push({ start, end })
      continue
    }

    // Une phrase demesuree cede au meme endroit que dans le decoupage large, au
    // plus pres d'une ponctuation. Ses morceaux sont des tranches de la phrase,
    // prises dans l'ordre : les retrouver au fil du texte redonne leurs
    // positions sans avoir a refaire le calcul de la coupe.
    let cursor = start
    for (const part of hardSplit(sentence, MAX_SIZE_FINE, 0)) {
      const at = source.indexOf(part, cursor)
      spans.push({ start: at, end: at + part.length })
      cursor = at + part.length
    }
  }

  return spans
}

/** Le passage et son voisinage immediat, tels qu'ils seront enregistres. */
function around(source: string, span: Span): { text: string; before: string; after: string } {
  return {
    text: readable(source.slice(span.start, span.end)),
    before: readable(source.slice(Math.max(0, span.start - CONTEXT), span.start)),
    after: readable(source.slice(span.end, span.end + CONTEXT))
  }
}
