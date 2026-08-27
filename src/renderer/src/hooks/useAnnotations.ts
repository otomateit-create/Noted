import { useCallback, useEffect, useRef, useState } from 'react'
import type { Annotation, HighlightColorId } from '@shared/types'
import type { Passage } from '../lib/annotate'

/**
 * Les surlignages du cours ouvert.
 *
 * La liste entiere est reecrite a chaque changement, comme la note : elle tient
 * dans quelques kilo-octets, et une API de modification fine ne servirait qu'a
 * compliquer les deux cotes du pont pour le meme resultat sur le disque.
 *
 * L'ecriture est differee d'un souffle : ecrire une note ancree caractere par
 * caractere reveillerait le disque a chaque touche, pour un fichier dont
 * personne n'a besoin avant la fin de la phrase.
 */
const SAVE_DELAY = 600

/** Ce dont un surlignage a besoin en plus de son passage. */
export interface NewAnnotation extends Passage {
  colour: HighlightColorId
  page: number | null
  heading: string | null
}

export interface AnnotationsApi {
  annotations: Annotation[]
  add: (input: NewAnnotation) => Annotation
  remove: (id: string) => void
  comment: (id: string, comment: string) => void
  recolour: (id: string, colour: HighlightColorId) => void
}

export function useAnnotations(courseId: string | null): AnnotationsApi {
  const [annotations, setAnnotations] = useState<Annotation[]>([])

  /**
   * Le cours dont la liste est reellement chargee. Sans lui, l'ecriture
   * differee d'un cours partirait dans le fichier du suivant : le minuteur
   * survit au changement de cours, l'identifiant en cours, lui, a deja change.
   */
  const loadedId = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<Annotation[] | null>(null)

  const flush = useCallback(() => {
    const target = loadedId.current
    const list = pending.current
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    pending.current = null
    if (!target || !list) return

    void window.noted.annotations.write(target, list).catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    flush()
    loadedId.current = null
    setAnnotations([])

    if (!courseId) return

    void window.noted.annotations
      .read(courseId)
      .then((list) => {
        if (cancelled) return
        loadedId.current = courseId
        setAnnotations(list)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [courseId, flush])

  // Un ⌘Q en pleine phrase ne doit pas perdre la note qu'on vient d'ecrire.
  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [flush])

  const commit = useCallback((next: Annotation[]) => {
    setAnnotations(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      const target = loadedId.current
      const list = pending.current
      pending.current = null
      if (target && list) void window.noted.annotations.write(target, list).catch(() => undefined)
    }, SAVE_DELAY)
  }, [])

  const add = useCallback(
    (input: NewAnnotation): Annotation => {
      const annotation: Annotation = {
        // La date suffit a distinguer deux surlignages : on ne peut pas en
        // poser deux dans la meme milliseconde a la souris.
        id: `h-${Date.now().toString(36)}`,
        colour: input.colour,
        page: input.page,
        heading: input.heading,
        text: input.text,
        before: input.before,
        after: input.after,
        comment: '',
        createdAt: new Date().toISOString()
      }

      commit([...annotations, annotation])
      return annotation
    },
    [annotations, commit]
  )

  const remove = useCallback(
    (id: string) => commit(annotations.filter((entry) => entry.id !== id)),
    [annotations, commit]
  )

  const comment = useCallback(
    (id: string, text: string) =>
      commit(annotations.map((entry) => (entry.id === id ? { ...entry, comment: text } : entry))),
    [annotations, commit]
  )

  const recolour = useCallback(
    (id: string, colour: HighlightColorId) =>
      commit(annotations.map((entry) => (entry.id === id ? { ...entry, colour } : entry))),
    [annotations, commit]
  )

  return { annotations, add, remove, comment, recolour }
}
