/**
 * La feuille de cartes : le standard d'ecriture des flashcards ajoutees a la
 * main, et son analyseur.
 *
 * Le format, fige avec Raphael :
 *
 *   Q: la question, en Markdown, sur une ou plusieurs lignes
 *   R: la reponse, idem
 *   ---
 *   Q: la carte suivante…
 *
 * « Q: » et « R: » en debut de ligne, « --- » seul sur sa ligne entre deux
 * cartes. L'analyseur est tolerant : casse indifferente, espace avant les
 * deux-points a la francaise, « === » accepte comme separateur, et un « Q: »
 * qui suit une reponse ouvre une carte meme sans separateur. Ce qui n'est pas
 * compris n'est jamais perdu en silence : chaque carte ecartee et chaque
 * ligne orpheline ressortent dans `problems`.
 *
 * Le module ne depend de rien : le renderer s'en sert pour le compteur en
 * direct de la feuille de collage, et il se verifie seul.
 */

export interface SheetCard {
  recto: string
  verso: string
}

export interface SheetResult {
  cards: SheetCard[]
  /** Ce qui n'a pas ete compris, en clair, affiche sous la feuille. */
  problems: string[]
}

const QUESTION = /^\s*q\s*:\s?(.*)$/i
const ANSWER = /^\s*r\s*:\s?(.*)$/i
const SEPARATOR = /^\s*[-=]{3,}\s*$/

/** Les premiers mots d'une question, pour designer une carte dans un probleme. */
function excerpt(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim()
  return flat.length > 44 ? `${flat.slice(0, 44)}…` : flat
}

export function parseSheet(text: string): SheetResult {
  const cards: SheetCard[] = []
  const problems: string[] = []

  let recto: string[] | null = null
  let verso: string[] | null = null
  let ordinal = 0
  let strays = 0

  // Clot la carte en cours : complete, elle rejoint la liste ; bancale, elle
  // devient un probleme lisible et rien d'autre.
  const close = (): void => {
    if (recto === null) return
    const question = recto.join('\n').trim()
    const answer = (verso ?? []).join('\n').trim()

    if (!question) {
      problems.push(`Carte ${ordinal} : question vide — ignorée.`)
    } else if (verso === null) {
      problems.push(`Carte ${ordinal} (« ${excerpt(question)} ») : pas de « R: » — ignorée.`)
    } else if (!answer) {
      problems.push(`Carte ${ordinal} (« ${excerpt(question)} ») : réponse vide — ignorée.`)
    } else {
      cards.push({ recto: question, verso: answer })
    }
    recto = null
    verso = null
  }

  // Les caracteres invisibles que laisse la copie d'une formule rendue :
  // espaces de largeur nulle (U+200B..D, U+FEFF), operateurs invisibles
  // (U+2061..64). Rien a en garder, et ils faussent l'affichage.
  const cleaned = text.replace(/[\u200B\u200C\u200D\uFEFF\u2061-\u2064]/g, '')

  for (const line of cleaned.replace(/\r\n?/g, '\n').split('\n')) {
    const question = line.match(QUESTION)
    if (question) {
      close()
      ordinal += 1
      recto = [question[1]]
      continue
    }

    if (SEPARATOR.test(line)) {
      close()
      continue
    }

    // « R: » n'ouvre la reponse que dans une carte qui l'attend ; partout
    // ailleurs, la ligne est du contenu ordinaire.
    if (recto !== null && verso === null) {
      const answer = line.match(ANSWER)
      if (answer) {
        verso = [answer[1]]
        continue
      }
    }

    if (verso !== null) verso.push(line)
    else if (recto !== null) recto.push(line)
    else if (line.trim() !== '') strays += 1
  }
  close()

  // Des symboles de l'alphabet mathematique (𝑅, 𝑊, 𝐴…) trahissent une
  // formule rendue par un chat puis copiee : la source LaTeX est perdue et la
  // carte afficherait des glyphes empiles. On previent, sans rien bloquer.
  if (/[\u{1D400}-\u{1D7FF}]/u.test(cleaned)) {
    problems.push(
      "Des formules déjà rendues semblent collées (symboles 𝑅𝑊𝐴…) — redemande la source LaTeX brute à l'IA, livrée dans un bloc de code."
    )
  }

  if (strays > 0) {
    problems.push(
      strays === 1
        ? '1 ligne hors carte, ignorée — chaque carte commence par « Q: ».'
        : `${strays} lignes hors carte, ignorées — chaque carte commence par « Q: ».`
    )
  }

  return { cards, problems }
}
