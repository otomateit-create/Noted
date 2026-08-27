import { useEffect, useRef, useState } from 'react'

/**
 * Devoilement progressif du texte d'une reponse.
 *
 * Le modele n'envoie pas son texte a un rythme regulier : il arrive par
 * bouffees, parfois un paragraphe entier d'un coup. Affiche tel quel, cela
 * saccade. On garde donc le texte recu de cote et on le laisse apparaitre a
 * cadence constante, en rattrapant d'autant plus vite que le retard est grand —
 * la lecture reste fluide sans jamais decrocher de ce qui a ete recu.
 */

/** Temps vise pour resorber le retard accumule. */
const CATCH_UP_MS = 320

/**
 * Cadence de rafraichissement. A chaque pas, le Markdown est reanalyse et les
 * formules recomposees : monter a soixante images par seconde couterait le
 * double sans que l'oeil y gagne quoi que ce soit.
 */
const STEP_MS = 28

/**
 * Coupe une formule laissee a moitie ecrite. Sans cela, le `$` orphelin d'une
 * formule en cours de reception s'affiche en clair le temps d'un battement,
 * puis disparait — un clignotement d'autant plus visible que les cours en sont
 * pleins.
 */
function trimOpenMath(text: string): string {
  let count = 0
  let last = -1

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '$' && text[index - 1] !== '\\') {
      count += 1
      last = index
    }
  }

  return count % 2 === 0 ? text : text.slice(0, last)
}

export function useSmoothText(target: string, streaming: boolean): string {
  // Une reponse deja terminee s'affiche entiere : on ne rejoue pas sa frappe
  // a chaque fois que le panneau se remonte.
  const [revealed, setRevealed] = useState(() => (streaming ? 0 : target.length))
  const revealedRef = useRef(revealed)

  useEffect(() => {
    // Message remplace ou conversation effacee : le texte a rapetisse, il n'y
    // a rien a devoiler.
    if (target.length < revealedRef.current) {
      revealedRef.current = target.length
      setRevealed(target.length)
      return
    }

    if (revealedRef.current >= target.length) return

    let timer = 0
    let previous = performance.now()

    const step = (): void => {
      const now = performance.now()
      const elapsed = now - previous
      previous = now

      const total = target.length
      const current = revealedRef.current
      const backlog = total - current

      revealedRef.current = Math.min(
        total,
        current + Math.max(1, Math.ceil((backlog * elapsed) / CATCH_UP_MS))
      )
      setRevealed(revealedRef.current)

      if (revealedRef.current < total) {
        timer = window.setTimeout(step, STEP_MS)
      }
    }

    timer = window.setTimeout(step, STEP_MS)
    return () => window.clearTimeout(timer)
  }, [target])

  if (revealed >= target.length) return target
  return trimOpenMath(target.slice(0, revealed))
}
