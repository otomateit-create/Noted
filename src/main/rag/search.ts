/**
 * Index de recherche d'un cours.
 *
 * Le classement suit BM25, la reference des moteurs plein texte : un mot compte
 * d'autant plus qu'il est rare dans le cours, et un passage court qui contient
 * le mot passe devant un passage long qui le contient autant de fois.
 *
 * Tout est en memoire et en JavaScript pur. Un cours represente quelques
 * centaines de passages, pas des millions : une base de donnees native
 * apporterait ici surtout une dependance a recompiler a chaque version
 * d'Electron.
 */

import type { Chunk } from './chunk'

/** Ponderations usuelles de BM25. */
const K1 = 1.2
const B = 0.75

/**
 * Mots trop frequents pour discriminer quoi que ce soit. Sans cette liste, une
 * question comme « quelle est la difference entre… » ferait remonter les
 * passages les plus longs plutot que les plus pertinents.
 */
const STOPWORDS = new Set([
  'a', 'ai', 'ainsi', 'alors', 'au', 'aucun', 'aussi', 'autre', 'aux', 'avec', 'avoir',
  'bien', 'car', 'ce', 'cela', 'ces', 'cet', 'cette', 'chaque', 'comme', 'comment',
  'dans', 'de', 'des', 'donc', 'donne', 'du', 'elle', 'elles', 'en', 'entre', 'est',
  'et', 'etait', 'etre', 'eux', 'faire', 'fait', 'il', 'ils', 'je', 'la', 'le', 'les',
  'leur', 'lui', 'ma', 'mais', 'me', 'meme', 'mes', 'moi', 'mon', 'ne', 'ni', 'non',
  'nos', 'notre', 'nous', 'on', 'ou', 'par', 'pas', 'peut', 'plus', 'pour', 'pourquoi',
  'quand', 'que', 'quel', 'quelle', 'quelles', 'quels', 'qui', 'quoi', 'sa', 'sans',
  'se', 'ses', 'si', 'son', 'sont', 'sur', 'ta', 'te', 'tes', 'toi', 'ton', 'tous',
  'tout', 'toute', 'toutes', 'tu', 'un', 'une', 'vos', 'votre', 'vous', 'y',
  'and', 'are', 'for', 'from', 'have', 'is', 'it', 'its', 'of', 'that', 'the', 'this',
  'to', 'was', 'were', 'with'
])

/** Signes diacritiques laisses par la decomposition NFD. */
const DIACRITICS = /\p{Mn}/gu

/** Sans accents ni majuscules : « échéancier » et « echeancier » se rejoignent. */
function fold(text: string): string {
  return text.normalize('NFD').replace(DIACRITICS, '').toLowerCase()
}

/**
 * Met un mot deja replie sous sa forme d'indexation, au singulier. Les cours
 * melangent « covenant » et « covenants » ; sans cela, chercher l'un ne trouve
 * pas l'autre.
 */
function singularise(word: string): string {
  // On ne retire le pluriel que la ou c'est sur : « flux » et « cas » ne
  // doivent pas devenir « flu » et « ca ».
  if (word.length >= 5 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    return word.slice(0, -1)
  }
  return word
}

export function tokenise(text: string): string[] {
  const tokens: string[] = []

  for (const word of fold(text).split(/[^a-z0-9]+/)) {
    if (word.length < 2) continue
    if (STOPWORDS.has(word)) continue
    tokens.push(singularise(word))
  }
  return tokens
}

/** Forme comparable d'un titre : replie, sans ponctuation, espaces resserres. */
function foldHeading(text: string): string {
  return fold(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Document {
  chunk: Chunk
  /** Nombre d'occurrences de chaque terme. */
  frequencies: Map<string, number>
  length: number
  /** Vecteur de sens du passage, si le modele a pu le calculer. */
  vector?: number[]
}

export interface SearchHit {
  chunk: Chunk
  score: number
}

/**
 * Constante de la fusion par rangs reciproques. Elle amortit l'ecart entre les
 * premieres places : un passage classe premier d'un cote et dixieme de l'autre
 * reste devant un passage moyen partout.
 */
const RRF_K = 60

function cosine(a: number[], b: number[]): number {
  let total = 0
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i]
  return total
}

export class CourseIndex {
  private readonly documents: Document[] = []
  /** Nombre de passages contenant chaque terme. */
  private readonly documentFrequency = new Map<string, number>()
  private averageLength = 0
  private vectorised = false

  constructor(chunks: Chunk[]) {
    for (const chunk of chunks) {
      const tokens = tokenise(chunk.text)
      const frequencies = new Map<string, number>()

      for (const token of tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
      }
      for (const token of frequencies.keys()) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
      }

      this.documents.push({ chunk, frequencies, length: tokens.length })
    }

    const total = this.documents.reduce((sum, document) => sum + document.length, 0)
    this.averageLength = this.documents.length > 0 ? total / this.documents.length : 0
  }

  get size(): number {
    return this.documents.length
  }

  /** Attache les vecteurs de sens, dans l'ordre des passages. */
  setVectors(vectors: number[][]): void {
    if (vectors.length !== this.documents.length) return
    this.documents.forEach((document, index) => {
      document.vector = vectors[index]
    })
    this.vectorised = true
  }

  get hasVectors(): boolean {
    return this.vectorised
  }

  /** Classement lexical : les mots exacts, ponderes par leur rarete. */
  private lexical(query: string): SearchHit[] {
    const terms = [...new Set(tokenise(query))]
    if (terms.length === 0) return []

    const count = this.documents.length
    const hits: SearchHit[] = []

    for (const document of this.documents) {
      let score = 0

      for (const term of terms) {
        const frequency = document.frequencies.get(term)
        if (!frequency) continue

        const containing = this.documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (count - containing + 0.5) / (containing + 0.5))
        const norm = 1 - B + (B * document.length) / (this.averageLength || 1)

        score += idf * ((frequency * (K1 + 1)) / (frequency + K1 * norm))
      }

      if (score > 0) hits.push({ chunk: document.chunk, score })
    }

    return hits.sort((a, b) => b.score - a.score)
  }

  /** Classement par le sens : proximite des vecteurs. */
  private semantic(queryVector: number[]): SearchHit[] {
    const hits: SearchHit[] = []

    for (const document of this.documents) {
      if (!document.vector) continue
      hits.push({ chunk: document.chunk, score: cosine(queryVector, document.vector) })
    }

    return hits.sort((a, b) => b.score - a.score)
  }

  /**
   * La proximite de sens de chaque passage a un vecteur, par identifiant. Pour
   * qui doit juger d'un seuil et non d'un rang : la fusion ci-dessous classe
   * tout, meme ce qui ne ressemble a rien.
   */
  similarities(queryVector: number[]): Map<string, number> {
    const result = new Map<string, number>()
    for (const document of this.documents) {
      if (document.vector) result.set(document.chunk.id, cosine(queryVector, document.vector))
    }
    return result
  }

  /**
   * Recherche hybride.
   *
   * Les deux classements repondent a des questions differentes : le lexical
   * retrouve « IFRS 18 » ou « match_type » au caractere pres, le semantique
   * comprend « pourquoi la dette rend l'operation risquee » sans qu'aucun de
   * ces mots figure dans le passage. Aucun des deux ne sait faire le travail de
   * l'autre.
   *
   * On les fusionne sur les rangs plutot que sur les scores : un score BM25 et
   * un cosinus ne vivent pas sur la meme echelle, et vouloir les normaliser
   * revient a inventer une equivalence arbitraire.
   */
  search(query: string, limit: number, queryVector?: number[] | null): SearchHit[] {
    if (this.documents.length === 0) return []

    const lexical = this.lexical(query)
    if (!queryVector || !this.vectorised) return lexical.slice(0, limit)

    const fused = new Map<string, { chunk: Chunk; score: number }>()

    const contribute = (hits: SearchHit[]): void => {
      hits.forEach((hit, rank) => {
        const entry = fused.get(hit.chunk.id) ?? { chunk: hit.chunk, score: 0 }
        entry.score += 1 / (RRF_K + rank + 1)
        fused.set(hit.chunk.id, entry)
      })
    }

    contribute(lexical)
    contribute(this.semantic(queryVector))

    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** Tous les passages du cours, dans l'ordre du document. */
  all(): Chunk[] {
    return this.documents.map((document) => document.chunk)
  }

  /** Tous les passages d'une page, dans l'ordre. */
  page(page: number): Chunk[] {
    return this.documents
      .filter((document) => document.chunk.page === page)
      .map((document) => document.chunk)
  }

  /**
   * Tous les passages d'une section.
   *
   * La comparaison porte sur le chemin complet autant que sur le titre seul,
   * ce qui donne deux gestes utiles avec un seul outil : demander « 1. MATCH »
   * remonte tout le chapitre, demander « Les 3 modes de match_type » remonte la
   * seule sous-section. Elle reste souple sur la casse, les accents et la
   * ponctuation — l'assistant recopie un titre tel qu'il l'a lu.
   */
  section(title: string): Chunk[] {
    const needle = foldHeading(title)
    if (!needle) return []

    const matches = this.documents.filter((document) => {
      const { anchor, heading } = document.chunk
      const path = foldHeading(anchor)

      if (path === needle || path.includes(needle)) return true
      if (!heading) return false

      const leaf = foldHeading(heading)
      return leaf === needle || needle.includes(leaf)
    })

    return matches.map((document) => document.chunk)
  }
}
