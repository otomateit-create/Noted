import { useCallback, useRef, useState } from 'react'

interface SplitterProps {
  /** Recoit le deplacement horizontal en pixels depuis le dernier evenement. */
  onResize: (delta: number) => void
  label: string
}

/**
 * Separateur redimensionnable entre deux panneaux.
 *
 * La capture du pointeur garantit que le glissement continue meme si le
 * curseur passe au-dessus du PDF ou de l'editeur, qui avalent autrement les
 * evenements de souris.
 *
 * Trois gardes valent d'etre expliquees, parce qu'elles corrigent un defaut
 * observe a l'usage : les panneaux se redimensionnaient tout seuls au simple
 * passage de la souris. Un trackpad regle en « toucher pour cliquer » envoie un
 * appui des qu'on effleure, et un maintien juste apres ouvre un glissement que
 * plus rien ne referme — le pointeur reste capture, et chaque mouvement
 * continue de deplacer le separateur.
 *
 *   1. On ne demarre que sur le bouton principal.
 *   2. A chaque deplacement on verifie qu'un bouton est bel et bien enfonce ;
 *      sinon le relachement s'est perdu, et on referme le glissement.
 *   3. On ecoute les abandons que le systeme peut envoyer (`pointercancel`,
 *      perte de capture), que l'ancien code ignorait completement.
 *
 * L'etat de glissement vit dans un ref et non dans un etat React : un etat
 * n'est relu qu'au rendu suivant, et le premier deplacement arrivait avant lui.
 * L'etat React ne sert plus qu'a colorer le filet.
 */
export default function Splitter({ onResize, label }: SplitterProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const active = useRef(false)
  const lastX = useRef(0)

  const stop = useCallback((element: HTMLDivElement, pointerId: number) => {
    if (!active.current) return
    active.current = false
    setDragging(false)
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
  }, [])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    // Sans cela, l'appui peut aussi demarrer une selection de texte, qui se
    // superpose au glissement et le rend saccade.
    event.preventDefault()

    event.currentTarget.setPointerCapture(event.pointerId)
    lastX.current = event.clientX
    active.current = true
    setDragging(true)
  }, [])

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!active.current) return

      if (event.buttons === 0) {
        stop(event.currentTarget, event.pointerId)
        return
      }

      const delta = event.clientX - lastX.current
      lastX.current = event.clientX
      if (delta !== 0) onResize(delta)
    },
    [onResize, stop]
  )

  const handlePointerEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      stop(event.currentTarget, event.pointerId)
    },
    [stop]
  )

  // Au clavier, les fleches deplacent le separateur par pas de 24 pixels.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onResize(-24)
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        onResize(24)
      }
    },
    [onResize]
  )

  return (
    <div
      className="splitter"
      data-dragging={dragging}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
      onKeyDown={handleKeyDown}
    />
  )
}
