/**
 * Index fin d'un cours, en memoire.
 *
 * Il ne repond qu'a une seule question : de quel passage de quelques phrases ce
 * texte-ci est-il le plus proche. Pas de BM25, pas de fusion de rangs, pas de
 * seuil — et c'est une difference de fond avec `CourseIndex`, pas une version
 * simplifiee de celui-ci.
 *
 * `CourseIndex` sert une question posee a l'assistant : elle emploie les mots de
 * celui qui la pose, rarement ceux du cours, et le lexical y rattrape ce que le
 * sens manque — un numero de norme, un nom de variable. Ici, le texte compare
 * est une note que le lecteur vient d'ecrire en regardant sa page : elle
 * reformule ce qu'il lit, dans le vocabulaire qu'il vient d'en tirer. Le
 * classement lexical n'y apporterait qu'un second rang a departager, et un
 * arbitrage de plus a regler entre deux echelles incomparables.
 *
 * Le meilleur score gagne toujours, meme mauvais. C'est une decision produit :
 * une note posee sur le mauvais paragraphe se voit et se corrige d'un geste,
 * une note qui refuse de s'ancrer ne laisse rien a corriger.
 */

import type { FineChunk } from './chunk-fine'

/**
 * Proximite de deux vecteurs.
 *
 * Un produit scalaire nu, sans division par les normes — exactement ce que fait
 * `CourseIndex.semantic`, et pour la meme raison : le worker vectorise avec
 * `normalize: true`, donc tout ce qui sort du modele est deja de norme 1, et le
 * cosinus se reduit au produit scalaire. Diviser par 1 quelques milliers de
 * fois par ancrage n'achete rien.
 *
 * Le jour ou cette option disparaitrait du worker, les deux endroits seraient a
 * corriger ensemble : le classement deviendrait faux ici comme la-bas, et sans
 * rien casser de visible.
 */
function cosine(a: number[], b: number[]): number {
  let total = 0
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i]
  return total
}

export class FineIndex {
  private readonly chunks: FineChunk[]

  /**
   * Les vecteurs, dans l'ordre des passages, ou null tant qu'ils manquent.
   *
   * Un tableau parallele plutot qu'un champ pose sur chaque passage : c'est
   * exactement ce que rend le cache, et c'est exactement ce qu'on lui rend a
   * l'ecriture. Un aller-retour par passage n'ajouterait qu'une occasion de
   * decaler les deux ordres l'un par rapport a l'autre.
   */
  private vectors: number[][] | null = null

  constructor(chunks: FineChunk[]) {
    this.chunks = chunks
  }

  get size(): number {
    return this.chunks.length
  }

  /**
   * Les passages, dans l'ordre du document.
   *
   * `best` repond a la question pour laquelle cet index existe, mais le chemin
   * de l'assistant en pose une seconde : traduire les ancres lisibles qu'il
   * vient de citer — « p. 12 », « 2. Les covenants » — en unites de document,
   * la seule forme que `best` sache filtrer. Nulle part ailleurs les deux
   * formes ne cohabitent sur un meme objet : un passage du decoupage large
   * porte bien son ancre, jamais l'ordinal de sa section, et le recompter
   * depuis des resultats de recherche pris aux quatre coins du document n'a
   * simplement pas de sens.
   *
   * Rendu tel quel et non recopie : la liste ne bouge plus une fois l'index
   * construit, et en dupliquer quelques milliers d'entrees a chaque ancrage
   * paierait cher une ecriture que le type interdit deja.
   */
  get passages(): readonly FineChunk[] {
    return this.chunks
  }

  /**
   * Attache les vecteurs, dans l'ordre des passages.
   *
   * Un tableau de la mauvaise longueur est ignore en silence, comme dans
   * `CourseIndex` : un vecteur decale d'un cran ancrerait chaque note au
   * passage voisin du bon — plus nuisible que pas d'ancrage du tout, et
   * invisible a la relecture puisque le resultat reste plausible.
   */
  setVectors(vectors: number[][]): void {
    if (vectors.length !== this.chunks.length) return
    this.vectors = vectors
  }

  get hasVectors(): boolean {
    return this.vectors !== null
  }

  /**
   * Le passage le plus proche du vecteur donne.
   *
   * `unitKeys` dit d'ou la note peut raisonnablement venir : les pages
   * actuellement visibles a l'ecran, ou celles que l'assistant vient de citer.
   * C'est un filtre d'attention, jamais une condition — s'il ne retient aucun
   * passage (fenetre pas encore mesuree, tour d'IA sans la moindre citation,
   * cours dont les unites ne portent pas ces noms), on balaie l'index entier
   * plutot que de rendre les mains vides.
   *
   * Ce repli n'est pas un seuil deguise : il ne juge la qualite de rien, il
   * garantit seulement qu'il y a toujours quelque chose a comparer. Rendre null
   * la ou le filtre s'est trompe reviendrait a faire dependre l'ancrage d'une
   * plomberie que le lecteur ne voit pas et ne peut pas corriger.
   */
  best(queryVector: number[], unitKeys?: string[]): FineChunk | null {
    return (this.topK(queryVector, 1, unitKeys)[0] ?? this.topK(queryVector, 1)[0])?.chunk ?? null
  }

  /**
   * Les `k` passages les plus proches, du meilleur au moins bon, avec leur
   * score.
   *
   * A la difference de `best`, le filtre est ici une condition : avec des
   * `unitKeys` qui ne retiennent rien, la liste est vide, et c'est a
   * l'appelant de decider ou chercher ensuite. C'est ce qui permet a
   * l'ancrage d'une suite de blocs d'essayer plusieurs cercles — les pages
   * que le bloc cite, puis l'intervalle entre ses voisins, puis les pages
   * consultees, puis tout — dans un ordre qu'il est seul a connaitre.
   *
   * Plusieurs candidats et non un seul parce que le meilleur cosinus n'est pas
   * toujours le bon endroit : un manuel repete sa structure d'un chapitre a
   * l'autre, et deux passages paralleles a soixante pages d'ecart se valent
   * presque au vecteur. Le second de la liste, s'il respecte l'ordre du
   * document, vaut souvent mieux que le premier qui le rompt.
   */
  topK(
    queryVector: number[],
    k: number,
    unitKeys?: string[]
  ): { chunk: FineChunk; score: number }[] {
    const vectors = this.vectors
    if (!vectors || this.chunks.length === 0 || k <= 0) return []

    const wanted = unitKeys && unitKeys.length > 0 ? new Set(unitKeys) : null
    const kept: { chunk: FineChunk; score: number }[] = []

    for (let index = 0; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index]
      if (wanted && !wanted.has(chunk.unitKey)) continue

      const score = cosine(queryVector, vectors[index])
      if (kept.length === k && score <= kept[k - 1].score) continue

      let at = kept.length
      while (at > 0 && kept[at - 1].score < score) at -= 1
      kept.splice(at, 0, { chunk, score })
      if (kept.length > k) kept.pop()
    }

    return kept
  }
}
