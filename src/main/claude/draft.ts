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
  mcp__cours__note_inserer: { kind: 'inserer', key: 'contenu' },
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
 * La valeur du champ `key` dans un JSON peut-etre incomplet, decodee aussi
 * loin qu'elle se lit. Vide tant que le champ n'a pas commence.
 */
export function draftText(partialJson: string, key: string): string {
  const opening = new RegExp(`"${key}"\\s*:\\s*"`).exec(partialJson)
  if (!opening) return ''

  let out = ''
  let at = opening.index + opening[0].length

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

  return out
}
