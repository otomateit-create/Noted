/**
 * Poursuivre la lecture d'un cours reconstitue incomplet.
 *
 * Un cours converti alors que des pages resistaient — moteur tombe en cours de
 * route, page qui ne se dessinait pas — porte la liste de ses manques dans son
 * en-tete. L'original, lui, est aux archives. Ce geste le rouvre, ne dessine
 * que les pages manquantes, et les insere a leur place dans le Markdown : les
 * pages deja lues ne sont jamais relues.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OcrCourse } from '../lib/ocr-document'
import { loadDocument } from '../lib/pdf'
import { pageToPng } from './useOcrConversion'

export interface ResumeState {
  running: boolean
  /** Pages tentees, et pages a tenter. */
  done: number
  total: number
  /** Ce qui a empeche la reprise, en clair. Null tant que rien n'a echoue. */
  error: string | null
}

const IDLE: ResumeState = { running: false, done: 0, total: 0, error: null }

export function useOcrResume(
  courseId: string | null,
  course: OcrCourse | null
): ResumeState & { start: () => void } {
  const [state, setState] = useState<ResumeState>(IDLE)

  // L'etat ne doit plus bouger apres le demontage — la lecture, elle, va au
  // bout : chaque page lue entre au cache, et le fichier est complete par le
  // processus principal, que le panneau soit encore la pour le voir ou non.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Un changement de cours remet le compteur a zero. */
  useEffect(() => {
    setState(IDLE)
  }, [courseId])

  const start = useCallback(() => {
    const missing = course?.document.missing ?? []
    if (!courseId || !course || missing.length === 0 || state.running) return

    const put = (next: ResumeState): void => {
      if (mounted.current) setState(next)
    }

    void (async () => {
      put({ running: true, done: 0, total: missing.length, error: null })

      try {
        const model = await window.noted.ocr.modelStatus()
        if (model.phase !== 'pret') {
          put({ ...IDLE, error: 'Le moteur de lecture n’est pas installe.' })
          return
        }

        const bytes = await window.noted.ocr.readOriginal(course.document.original)
        const handle = await loadDocument(bytes)

        try {
          const pages: { page: number; markdown: string }[] = []

          for (const [index, number] of missing.entries()) {
            const png = await pageToPng(handle.document, number)
            if (png) {
              const read = await window.noted.ocr.readImage(png)
              // Une lecture vide est un resultat : la page sort des manquantes
              // sans rien inserer. Null, lui, reste un manque.
              if (read) pages.push({ page: number, markdown: read.markdown })
            }
            put({ running: true, done: index + 1, total: missing.length, error: null })
          }

          if (pages.length === 0) {
            put({ ...IDLE, error: 'Aucune de ces pages n’a pu etre lue cette fois-ci.' })
            return
          }

          await window.noted.ocr.patch(courseId, pages)
          // Le fichier vient de changer : le panneau rechargera le cours de
          // lui-meme, et l'en-tete relu dira ce qui manque encore.
          put(IDLE)
        } finally {
          void handle.close()
        }
      } catch (cause) {
        put({ ...IDLE, error: cause instanceof Error ? cause.message : String(cause) })
      }
    })()
  }, [courseId, course, state.running])

  return { ...state, start }
}
