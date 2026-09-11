/**
 * Du texte qui s'ecrit au texte qui se dit.
 *
 * Deux operations, toutes deux pures :
 *
 * - le decoupage en phrases d'un texte qui arrive par bouffees, pour que la
 *   voix parte des la premiere phrase complete sans attendre la fin de la
 *   reponse — chaque phrase garde ses bornes dans le texte brut, pour savoir
 *   ensuite ou l'utilisateur en etait quand il a coupe ;
 * - la mise au propre pour la voix : ce qui reste de mise en forme, de
 *   formules ou de references quand le modele, malgre la consigne du style
 *   parle, en a laisse. Un filet de securite : rien ici ne doit s'entendre.
 */

/** Une phrase prete a etre dite, et d'ou elle vient dans le texte brut. */
export interface Phrase {
  /** Ce qui sera prononce. */
  texte: string
  /** Position de la phrase dans le texte brut recu du modele. */
  debut: number
  fin: number
}

/** Un « point » qui ne termine pas une phrase : abreviation, initiale, numero. */
const ABREVIATIONS = /(?:\b(?:p|pp|ex|cf|etc|vs|env|chap|fig|n|no|art|al|min|max|M|Mme|Mlle|Dr|St|Ste|éd|vol|tel|approx)|\b[A-Z])\.$/u

/** Au-dela, une phrase sans ponctuation est coupee a une virgule pour que la voix parte. */
const PHRASE_LONGUE = 260
/** En deca, un « morceau » est trop court pour valoir une phrase : il attend la suivante. */
const PHRASE_COURTE = 3

/**
 * Coupe un flux de texte en phrases, au fil de l'eau. On lui donne les deltas
 * tels qu'ils arrivent ; il rend les phrases devenues completes, et garde le
 * reste pour la suite. `vider` rend ce qui reste quand le texte est fini.
 */
export class Decoupeur {
  private brut = ''
  /** Debut, dans le texte brut, de ce qui n'a pas encore ete rendu. */
  private curseur = 0

  pousser(delta: string): Phrase[] {
    this.brut += delta
    const phrases: Phrase[] = []
    for (;;) {
      const phrase = this.suivante()
      if (!phrase) break
      phrases.push(phrase)
    }
    return phrases
  }

  /** Ce qui reste, phrase ou non — le texte est termine. */
  vider(): Phrase | null {
    const texte = this.brut.slice(this.curseur)
    if (!texte.trim()) return null
    const phrase = { texte, debut: this.curseur, fin: this.brut.length }
    this.curseur = this.brut.length
    return phrase
  }

  /** Le texte brut recu jusqu'ici. */
  get texte(): string {
    return this.brut
  }

  private suivante(): Phrase | null {
    // Les blancs de tete — le saut de ligne qui suivait la phrase precedente —
    // n'appartiennent a aucune phrase : on les passe, sinon un saut de
    // paragraphe en tete donnerait une phrase vide et un curseur immobile.
    const blancs = this.brut.slice(this.curseur).match(/^\s*/)?.[0].length ?? 0
    this.curseur += blancs
    const reste = this.brut.slice(this.curseur)
    if (!reste) return null

    // Une ligne vide ferme toujours ce qui precede : titre, element de
    // liste, paragraphe sans point final.
    const paragraphe = reste.search(/\n[ \t]*\n/)
    let fin = -1

    // La ponctuation finale, suivie d'un blanc : c'est le blanc qui dit que
    // la phrase est finie — « 3.5 » ou « p.12 » n'en ont pas.
    const ponctuation = /[.!?…]+["»)]?(?=\s)/g
    let candidat: RegExpExecArray | null
    while ((candidat = ponctuation.exec(reste))) {
      const position = candidat.index + candidat[0].length
      if (paragraphe !== -1 && candidat.index > paragraphe) break
      const avant = reste.slice(0, position)
      // Un point d'abreviation ou d'initiale ne finit rien.
      if (candidat[0] === '.' && ABREVIATIONS.test(avant.trimEnd())) continue
      // Un numero de liste (« 1. ») non plus.
      if (candidat[0] === '.' && /(?:^|\n)\s*\d+\.$/.test(avant)) continue
      fin = position
      break
    }

    if (fin === -1 && paragraphe !== -1) fin = paragraphe

    // Sans ponctuation en vue et deja longue : on coupe a la derniere virgule,
    // pour que la voix ne reste pas muette pendant qu'une phrase-fleuve s'ecrit.
    if (fin === -1 && reste.length > PHRASE_LONGUE) {
      const virgule = reste.slice(0, PHRASE_LONGUE).search(/[,;:][^,;:]*$/)
      if (virgule > PHRASE_LONGUE / 2) fin = virgule + 1
    }

    if (fin === -1) return null

    const texte = reste.slice(0, fin)
    // De la ponctuation seule, sans un mot : rien a dire, on passe.
    if (!/[\p{L}\p{N}]/u.test(texte)) {
      this.curseur += fin
      return this.suivante()
    }
    // Trop court pour etre une phrase (« 1. » ; « Oui. » passe) : on attend
    // la suite, qui s'y joindra.
    if (texte.trim().length <= PHRASE_COURTE && paragraphe === -1) return null

    const phrase = { texte, debut: this.curseur, fin: this.curseur + fin }
    this.curseur += fin
    return phrase
  }
}

// ---------------------------------------------------------------------------
// La mise au propre pour la voix
// ---------------------------------------------------------------------------

/** Les commandes LaTeX qu'une voix peut dire, quand une formule est passee. */
const LATEX: [RegExp, string][] = [
  [/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, ' $1 sur $2 '],
  [/\\sqrt\s*\{([^{}]*)\}/g, ' racine de $1 '],
  [/\\(?:times|cdot)\b/g, ' fois '],
  [/\\(?:le|leq)\b/g, ' inférieur ou égal à '],
  [/\\(?:ge|geq)\b/g, ' supérieur ou égal à '],
  [/\\neq\b/g, ' différent de '],
  [/\\approx\b/g, ' environ '],
  [/\\(?:sum|Sigma)\b/g, ' somme de '],
  [/\\(?:infty)\b/g, ' l’infini '],
  [/\\(?:ldots|dots|cdots)\b/g, ' et cetera '],
  [/\\%/g, ' pour cent'],
  [/\\(?:left|right|,|;|!|quad|qquad|displaystyle|text|mathrm|mathbf|operatorname)\b\s*/g, ' '],
  [/\^\s*\{?\s*2\s*\}?/g, ' au carré '],
  [/\^\s*\{?\s*3\s*\}?/g, ' au cube '],
  [/\^\s*\{([^{}]*)\}/g, ' puissance $1 '],
  [/\^\s*(\S)/g, ' puissance $1 '],
  [/_\s*\{([^{}]*)\}/g, ' indice $1 '],
  [/_\s*(\S)/g, ' indice $1 '],
  [/[{}]/g, ' '],
  [/\\([A-Za-z]+)/g, ' $1 '],
  [/\s*=\s*/g, ' égale '],
  [/\s*\+\s*/g, ' plus '],
  [/(?<=[\w)])\s*-\s*(?=[\w(])/g, ' moins '],
  [/\s*\*\s*/g, ' fois '],
  [/\s*\/\s*/g, ' sur ']
]

/** Une formule dite en toutes lettres, autant que faire se peut. */
function formule(source: string): string {
  let texte = source
  for (const [motif, remplacement] of LATEX) texte = texte.replace(motif, remplacement)
  return texte
}

/**
 * Ce qui part a la voix : plus de balisage, plus de symbole, des references de
 * pages en clair. L'ordre compte — les formules avant que « * » ne soit lu
 * comme du gras, les liens avant que les crochets ne disparaissent.
 */
export function pourLaVoix(source: string): string {
  let texte = source

  // Les formules d'abord : entre $$ et entre $.
  texte = texte.replace(/\$\$([\s\S]*?)\$\$/g, (_, corps: string) => ` ${formule(corps)} `)
  texte = texte.replace(/\$([^$\n]+?)\$/g, (_, corps: string) => ` ${formule(corps)} `)

  // Blocs de code : leur contenu tel quel, sans les barrieres.
  texte = texte.replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
  texte = texte.replace(/`([^`]*)`/g, '$1')

  // Balises HTML, commentaires d'ancre.
  texte = texte.replace(/<!--[\s\S]*?-->/g, ' ')
  texte = texte.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')

  // Liens et images : le texte, pas l'adresse.
  texte = texte.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  texte = texte.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // Titres, citations, listes, tableaux : la structure ne se dit pas.
  texte = texte.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  texte = texte.replace(/^[ \t]*>[ \t]?/gm, '')
  texte = texte.replace(/^[ \t]*[-*+•][ \t]+/gm, '')
  texte = texte.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
  texte = texte.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
  texte = texte.replace(/\|/g, ', ')

  // Gras, italique, surlignage, ajouts marques.
  texte = texte.replace(/\*\*([^*]+)\*\*/g, '$1')
  texte = texte.replace(/__([^_]+)__/g, '$1')
  texte = texte.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
  texte = texte.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1')
  texte = texte.replace(/==([^=]+)==(?:\{[a-z]+\})?/g, '$1')
  texte = texte.replace(/\+\+([^+]+)\+\+/g, '$1')

  // References de pages : « (p. 12) » se dit « page 12 », « p. 12-14 » « pages 12 à 14 ».
  texte = texte.replace(/\(?\bpp?\.\s*(\d+)\s*[-–]\s*(\d+)\)?/g, 'pages $1 à $2')
  texte = texte.replace(/\(?\bp\.\s*(\d+)\)?/g, 'page $1')

  // Symboles courants.
  texte = texte.replace(/(\d)\s*%/g, '$1 pour cent')
  texte = texte.replace(/(\d)\s*€/g, '$1 euros')
  texte = texte.replace(/€/g, ' euros ')
  texte = texte.replace(/(\d)\s*\$/g, '$1 dollars')
  texte = texte.replace(/×/g, ' fois ')
  texte = texte.replace(/≈/g, ' environ ')
  texte = texte.replace(/≥/g, ' supérieur ou égal à ')
  texte = texte.replace(/≤/g, ' inférieur ou égal à ')
  texte = texte.replace(/≠/g, ' différent de ')
  texte = texte.replace(/[→⇒]/g, ' donne ')
  texte = texte.replace(/[—–]/g, ', ')
  texte = texte.replace(/[«»"“”]/g, '')
  texte = texte.replace(/[#*_~^\\]/g, ' ')

  // Les blancs, une fois tout retire.
  return texte.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim()
}

/** Compte les mots d'une transcription — ce qui decide qu'on a bien entendu quelqu'un. */
export function compterMots(texte: string): number {
  const mots = texte.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)
  return mots ? mots.length : 0
}
