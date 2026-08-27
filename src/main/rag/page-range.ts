/**
 * Ce que l'assistant ecrit pour designer une ou plusieurs pages.
 *
 * « 12 », « p. 12 », « 50-55 », « pp. 50–55 », « 50 à 55 » : une reference
 * s'ecrit comme on la lit. Une plage rend plusieurs pages d'un seul appel, la
 * ou il en fallait un par page — six allers-retours pour lire un chapitre.
 *
 * Pur : ni cours ni index ici, seulement la lecture d'une chaine. C'est ce qui
 * permet de la prouver a part.
 */

/**
 * Au-dela, on reverse un chapitre entier d'un coup, et une lecture cesse
 * d'etre une lecture pour redevenir le cours dans le prompt.
 */
export const MAX_PAGES_PER_READ = 10

export interface PageSpan {
  from: number
  to: number
}

const RANGE = /^\s*(?:pp?\.?\s*|pages?\s*)?(\d+)\s*(?:[-–—]|à|a|to|,)\s*(?:pp?\.?\s*)?(\d+)\s*$/iu
const SINGLE = /^\s*(?:pp?\.?\s*|pages?\s*)?(\d+)\s*$/iu

/**
 * La ou les pages designees, dans l'ordre, ou null si rien ne se lit.
 *
 * Une plage inversee (« 55-50 ») est remise a l'endroit : l'intention est
 * claire. Le repli sur les seuls chiffres garde ce que l'ancien code acceptait
 * (« page numero 12 ») ; c'est a l'appelant de verifier que le numero existe.
 */
export function parsePageReference(reference: string): PageSpan | null {
  const range = RANGE.exec(reference)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    if (a > 0 && b > 0) return { from: Math.min(a, b), to: Math.max(a, b) }
  }

  const single = SINGLE.exec(reference)
  if (single) {
    const page = Number(single[1])
    return page > 0 ? { from: page, to: page } : null
  }

  const digits = Number(reference.replace(/[^\d]/g, ''))
  return Number.isFinite(digits) && digits > 0 ? { from: digits, to: digits } : null
}
