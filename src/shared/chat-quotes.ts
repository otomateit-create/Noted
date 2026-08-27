/**
 * Repondre a des passages precis — d'une reponse de l'assistant, ou des notes.
 *
 * Ce qui part au modele est un bloc de citation Markdown numerote, suivi de la
 * question :
 *
 *     > [1 · mes notes, p. 12] le levier financier
 *     > [2] le multiple d'entree
 *
 *     Developpe les deux.
 *
 * La forme est celle qu'on ecrirait a la main pour citer quelqu'un : le modele
 * la comprend sans qu'on ait a la lui expliquer, et un transcript relu a l'oeil
 * nu reste lisible.
 *
 * La provenance vit dans le crochet, jamais dans le texte cite. C'est ce qui
 * permet aux deux origines de partager une seule numerotation — mentionner un
 * passage de ses notes et repondre a une phrase de l'assistant dans le meme
 * message — et ce qui rend la relecture sure : le contenu du crochet est ecrit
 * par l'application, pas par qui que ce soit d'autre, alors qu'un passage cite
 * peut commencer par n'importe quoi.
 *
 * Le meme fichier ecrit et relit ce bloc : l'ecriture se fait cote interface au
 * moment de l'envoi, la relecture cote main process quand on rouvre une
 * conversation passee — le fil affiche alors les memes pastilles qu'a l'envoi
 * plutot que deux lignes de « > [1] » restees en texte brut.
 */

import type { ChatQuote } from './types'

/**
 * Une ligne du bloc : « > [1] le passage cite », ou « > [1 · mes notes, p. 12]
 * le passage cite » quand il vient d'ailleurs que du fil.
 *
 * Le libelle de provenance ne peut pas contenir de crochet fermant : c'est ce
 * qui garantit que la fin du marqueur est trouvee sans ambiguite, quel que soit
 * le texte cite ensuite.
 */
const QUOTE_LINE = /^> \[(\d+)(?: · ([^\]]+))?\] (.+)$/

/** Le message tel qu'il part au modele : le bloc de citations, puis la question. */
export function formatQuotedPrompt(quotes: ChatQuote[], question: string): string {
  if (quotes.length === 0) return question
  const block = quotes
    .map((quote) => `> [${quote.n}${quote.source ? ` · ${quote.source}` : ''}] ${quote.text}`)
    .join('\n')
  return `${block}\n\n${question}`
}

/**
 * L'operation inverse, sur un tour relu depuis le disque.
 *
 * Le bloc doit ouvrir le message et etre numerote 1, 2, 3 sans trou : c'est ce
 * que cette application ecrit, et un message qui cite autrement — quelqu'un qui
 * colle un extrait de code contenant « > [2] » — ressort intact plutot que
 * decoupe de travers.
 */
export function splitQuotedPrompt(prompt: string): { quotes: ChatQuote[]; question: string } {
  const lines = prompt.split('\n')
  const quotes: ChatQuote[] = []

  let index = 0
  for (; index < lines.length; index++) {
    const match = QUOTE_LINE.exec(lines[index])
    if (!match || Number(match[1]) !== quotes.length + 1) break
    quotes.push({ n: quotes.length + 1, text: match[3], source: match[2] })
  }

  if (quotes.length === 0) return { quotes: [], question: prompt }

  // La ligne vide qui separe le bloc de la question ne fait pas partie d'elle.
  while (index < lines.length && !lines[index].trim()) index++
  return { quotes, question: lines.slice(index).join('\n') }
}
