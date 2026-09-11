import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatEffort, VoixEtat, VoixParole } from '@shared/types'
import { usePersisted } from './usePersisted'

/** Le modele et le niveau de reflexion de la barre de chat, repris tels quels. */
export interface VoiceChoice {
  model?: string
  effort?: ChatEffort
}

/**
 * Le mode voix, vu du panneau : ouvert ou non, ou en est la session, quelle
 * phrase la voix lit. Tout le reste — micro, transcription, coupure, tours —
 * vit dans le main ; ici on ouvre, on ferme, et on ecoute ce qu'il raconte.
 */
export function useVoice(courseId: string | null, choice: VoiceChoice) {
  const [active, setActive] = useState(false)
  const [opening, setOpening] = useState(false)
  const [etat, setEtat] = useState<VoixEtat>({ phase: 'ferme' })
  const [parole, setParole] = useState<VoixParole | null>(null)
  const [voix, setVoix] = usePersisted('noted.voix.voix', '')
  const [vitesseBrute, setVitesseBrute] = usePersisted('noted.voix.vitesse', '1')
  const vitesse = Number(vitesseBrute) || 1

  // Le choix de la barre au moment d'entrer, sans rouvrir la session quand il
  // change ensuite : le modele d'une session ouverte ne bouge plus.
  const choiceRef = useRef(choice)
  choiceRef.current = choice

  useEffect(() => {
    const unsubscribe = window.noted.voix.onEtat((next) => {
      setEtat(next)
      // Fermee par le main — un message ecrit, un cours supprime, une panne :
      // le panneau reprend sa barre de saisie.
      if (next.phase === 'ferme') {
        setActive(false)
        setOpening(false)
        setParole(null)
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => window.noted.voix.onParole(setParole), [])

  const enter = useCallback(async () => {
    if (!courseId || opening || active) return
    setOpening(true)
    setEtat({ phase: 'ouverture' })
    try {
      const result = await window.noted.voix.entrer({
        courseId,
        model: choiceRef.current.model,
        effort: choiceRef.current.effort,
        reglages: { voix: voix || undefined, vitesse }
      })
      if (result.ok) setActive(true)
      else setEtat({ phase: 'ferme', erreur: result.raison })
    } catch (cause) {
      setEtat({
        phase: 'ferme',
        erreur: cause instanceof Error ? cause.message : 'Ouverture du mode voix impossible.'
      })
    } finally {
      setOpening(false)
    }
  }, [courseId, opening, active, voix, vitesse])

  const leave = useCallback(() => {
    setActive(false)
    setOpening(false)
    setParole(null)
    void window.noted.voix.sortir()
  }, [])

  // Changer de cours, ou quitter le panneau, ferme le mode : la session
  // vocale est celle d'un cours.
  useEffect(
    () => () => {
      void window.noted.voix.sortir()
    },
    [courseId]
  )

  const chooseVoice = useCallback(
    (id: string) => {
      setVoix(id)
      void window.noted.voix.choisirVoix(id)
    },
    [setVoix]
  )

  const setRate = useCallback(
    (value: number) => {
      setVitesseBrute(String(value))
      void window.noted.voix.vitesse(value)
    },
    [setVitesseBrute]
  )

  return { active, opening, etat, parole, voix, vitesse, enter, leave, chooseVoice, setRate }
}
