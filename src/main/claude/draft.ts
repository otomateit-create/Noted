/**
 * Le texte d'une ecriture de notes pendant qu'elle se compose.
 *
 * Le modele ecrit les parametres d'un outil comme il ecrit une reponse : par
 * morceaux, sous la forme d'un JSON qui n'est complet qu'a la fin. Une
 * reecriture de note de dix mille caracteres met ainsi une bonne demi-minute a
 * arriver, pendant laquelle l'utilisateur ne voyait rien. Ce module lit dans
 * ce JSON encore ouvert la valeur du champ qui porte le texte, pour que la
 * carte d'apercu puisse le montrer au fur et a mesure.
 *
 * Rien ici ne pretend valider quoi que ce soit : la proposition reelle, elle,
 * passe par l'outil et ses verifications. On decode seulement ce qui est
 * deja lisible, et on s'arrete a la premiere chose qui ne l'est pas encore —
 * une sequence d'echappement coupee au milieu, par exemple.
 */

import type { NoteProposal } from '../../shared/types'

/**
 * Les outils dont on montre l'ecriture, et le champ qui porte le texte chez
 * chacun. Les objets (tableau, schema) ne sont pas de la partie : leur
 * syntaxe est courte, et un schema a moitie ecrit ne se dessine pas.
 */
const DRAFTED: Record<string, { kind: NoteProposal['kind']; key: string }> = {
  // Le brouillon depose plusieurs passages en un appel : la cle revient une
  // fois par passage, et `draftText` les recolle dans l'ordre d'ecriture.
  mcp__cours__note_brouillon: { kind: 'inserer', key: 'contenu' },
  mcp__cours__note_remplacer: { kind: 'remplacer', key: 'remplacement' },
  mcp__cours__note_reecrire: { kind: 'reecrire', key: 'contenu' }
}

/** Ce que l'appel d'outil va proposer, ou null s'il n'y a rien a montrer. */
export function draftedTool(name: string): { kind: NoteProposal['kind']; key: string } | null {
  return DRAFTED[name] ?? null
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t'
}

/**
 * Les valeurs du champ `key` dans un JSON peut-etre incomplet, decodees aussi
 * loin qu'elles se lisent et recollees. Vide tant que le champ n'a pas
 * commence.
 *
 * Toutes les occurrences et non la premiere, parce que le brouillon depose un
 * tableau de passages : la cle y revient une fois par passage, et n'en montrer
 * qu'une donnerait a voir le premier paragraphe d'une note qui en compte dix,
 * puis plus rien pendant que le reste s'ecrit. Sur les outils a valeur unique,
 * la boucle trouve une seule valeur et se comporte comme avant.
 */
export function draftText(partialJson: string, key: string): string {
  const parts: string[] = []
  const pattern = new RegExp(`"${key}"\\s*:\\s*"`, 'g')

  let opening = pattern.exec(partialJson)
  while (opening) {
    const value = readString(partialJson, opening.index + opening[0].length)
    parts.push(value.text)
    // La recherche reprend apres la valeur lue, jamais dedans : un texte de
    // note qui contiendrait lui-meme `"contenu":"` ouvrirait sinon un passage
    // fantome au milieu du precedent. C'est bien le decalage *brut* qu'on
    // reprend, celui que `readString` a atteint : la longueur du texte decode
    // serait plus courte des qu'une echappement s'y trouve — un saut de ligne
    // occupe deux caracteres dans le JSON et un seul apres lecture —, et la
    // recherche repartirait au milieu de la valeur qu'elle vient de lire.
    pattern.lastIndex = value.end
    opening = pattern.exec(partialJson)
  }

  return parts.join('\n\n')
}

/**
 * Une chaine JSON lue a partir de `from`, aussi loin qu'elle se decode : le
 * texte obtenu, et l'endroit du JSON brut ou la lecture s'est arretee.
 */
function readString(partialJson: string, from: number): { text: string; end: number } {
  let out = ''
  let at = from

  while (at < partialJson.length) {
    const char = partialJson[at]

    if (char === '"') break

    if (char !== '\\') {
      out += char
      at += 1
      continue
    }

    // Une sequence d'echappement. Coupee en plein milieu, elle sera complete
    // au prochain morceau : on s'arrete la pour cette fois.
    const code = partialJson[at + 1]
    if (code === undefined) break

    if (code === 'u') {
      const hex = partialJson.slice(at + 2, at + 6)
      if (hex.length < 4) break
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        // Pas un echappement valide : on le recopie tel quel plutot que de
        // perdre le fil, le vrai JSON sera de toute facon relu par l'outil.
        out += '\\u'
        at += 2
        continue
      }
      out += String.fromCharCode(parseInt(hex, 16))
      at += 6
      continue
    }

    out += SIMPLE_ESCAPES[code] ?? code
    at += 2
  }

  return { text: out, end: at }
}
