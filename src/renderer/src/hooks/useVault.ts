import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClaudeStatus, Course, Subject } from '@shared/types'

/**
 * Etat du vault : les matieres, le cours ouvert, et la disponibilite de Claude.
 * Un seul endroit interroge le main process, les composants consomment.
 */
export function useVault() {
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [courseId, setCourseId] = useState<string | null>(null)
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const next = await window.noted.vault.listSubjects()
    setSubjects(next)
    return next
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const [nextSubjects, nextStatus] = await Promise.all([
        window.noted.vault.listSubjects(),
        window.noted.claude.status()
      ])
      if (cancelled) return

      setSubjects(nextSubjects)
      setStatus(nextStatus)
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Le vault est un dossier ordinaire : on y depose un PDF depuis le Finder, on
   * y jette une matiere a la corbeille. Le main process surveille Cours/ et
   * previent ; il ne reste qu'a relire. C'est ici que l'abonnement vit, parce
   * que c'est ici que tout l'ecran puise sa liste de matieres — tableau de
   * bord, page de matiere et bibliotheque suivent du meme coup.
   */
  useEffect(() => window.noted.vault.onChanged(() => void refresh().catch(() => {})), [refresh])

  const courses = useMemo(
    () => subjects.flatMap((subject) => subject.courses),
    [subjects]
  )

  const course = useMemo<Course | null>(
    () => courses.find((item) => item.id === courseId) ?? null,
    [courses, courseId]
  )

  return { subjects, courses, course, courseId, setCourseId, status, loading, refresh }
}
