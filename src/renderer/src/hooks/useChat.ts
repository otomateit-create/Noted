import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ChatHistoryEntry,
  ChatMessage,
  ChatQuote,
  ChatSendInput,
  ChatStreamEvent,
  MemoryTrace,
  QuizAnswer,
  QuizForm
} from '@shared/types'
import { formatQuotedPrompt } from '@shared/chat-quotes'

/**
 * L'outil qui pose un questionnaire. Sa ligne d'etape n'est pas affichee : la
 * carte elle-meme est la trace, et bien plus parlante.
 */
export const QUIZ_TOOL = 'mcp__cours__quiz'

/** Modele et niveau de reflexion choisis dans la barre de chat. */
type ChatChoice = Pick<ChatSendInput, 'model' | 'effort'>

/**
 * Conversation avec Claude, une par cours.
 *
 * Les fils sont conserves par cours : revenir sur un document retrouve
 * l'echange precedent, exactement comme la session cote main process.
 */
export function useChat(courseId: string | null) {
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({})
  const [busy, setBusy] = useState(false)
  const [compacting, setCompacting] = useState(false)

  /**
   * Cours deja repris automatiquement dans cette session de l'application —
   * pour ne demander la reprise qu'une fois par cours, meme si on y revient
   * plusieurs fois en naviguant.
   */
  const hydrated = useRef<Set<string>>(new Set())

  /**
   * A la premiere visite d'un cours dans cette session de l'app, reprend sa
   * derniere conversation si le CLI en a garde une — sinon le fil reste vide
   * comme avant. Une garde fonctionnelle (`previous[id] !== undefined`)
   * evite d'ecraser un « Nouvelle conversation » ou une reprise manuelle
   * declenches pendant que cet appel etait en vol.
   */
  useEffect(() => {
    if (!courseId || hydrated.current.has(courseId)) return
    hydrated.current.add(courseId)

    let cancelled = false
    void window.noted.claude
      .hydrate(courseId)
      .then((result) => {
        if (cancelled || !result) return
        setThreads((previous) => {
          if (previous[courseId] !== undefined) return previous
          return { ...previous, [courseId]: result.messages }
        })
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [courseId])

  /**
   * A quel cours appartient chaque reponse en cours.
   *
   * Une simple variable « cours en cours de reponse » ne suffit pas : si on
   * change de cours pendant que Claude repond, les fragments restants
   * atterriraient dans le mauvais fil. On rattache donc chaque reponse a son
   * cours par son identifiant de message.
   */
  const messageOwner = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    const unsubscribe = window.noted.claude.onStream((event: ChatStreamEvent) => {
      const target = messageOwner.current.get(event.messageId)
      if (!target) return

      setThreads((previous) => {
        const thread = previous[target] ?? []
        const index = thread.findIndex((message) => message.id === event.messageId)
        if (index === -1) return previous

        const next = [...thread]
        const message = { ...next[index] }

        switch (event.kind) {
          case 'text':
            message.text += event.delta
            break
          case 'thinking':
            message.thinking = (message.thinking ?? '') + event.delta
            break
          case 'tool':
            message.toolCalls = [...(message.toolCalls ?? []), event.call]
            // Ou en est le texte quand le quiz part : c'est la que la carte se
            // glissera, entre la phrase qui l'annonce et la correction a venir.
            if (event.call.name === QUIZ_TOOL) message.quizAt = message.text.length
            break
          case 'tool-result':
            message.toolCalls = message.toolCalls?.map((call) =>
              call.id === event.toolId
                ? { ...call, result: event.result, running: false }
                : call
            )
            break
          case 'tokens':
            message.tokens = event.tokens
            break
          case 'done':
            message.streaming = false
            // Un outil interrompu en cours de route ne doit pas rester
            // affiche comme s'il tournait encore.
            message.toolCalls = message.toolCalls?.map((call) =>
              call.running ? { ...call, running: false } : call
            )
            break
          case 'error':
            message.streaming = false
            message.error = event.message
            break
        }

        next[index] = message
        return { ...previous, [target]: next }
      })

      if (event.kind === 'done' || event.kind === 'error') {
        messageOwner.current.delete(event.messageId)
        setBusy(false)
      }
    })

    return unsubscribe
  }, [])

  // Les ecritures en memoire arrivent par leur propre canal : l'outil qui les
  // fait connait l'entree ecrite, pas l'identifiant du message. La trace se
  // rattache donc a la reponse en cours du cours concerne — ou a defaut a la
  // derniere reponse, pour une trace qui arriverait juste apres la fin du tour.
  useEffect(() => {
    const unsubscribe = window.noted.memoire.onTrace((trace: MemoryTrace) => {
      setThreads((previous) => {
        const thread = previous[trace.courseId]
        if (!thread || thread.length === 0) return previous

        let index = thread.findIndex((message) => message.streaming)
        if (index === -1) {
          for (let i = thread.length - 1; i >= 0; i -= 1) {
            if (thread[i].role === 'assistant') {
              index = i
              break
            }
          }
        }
        if (index === -1) return previous

        const next = [...thread]
        next[index] = {
          ...next[index],
          memoryTraces: [...(next[index].memoryTraces ?? []), trace]
        }
        return { ...previous, [trace.courseId]: next }
      })
    })

    return unsubscribe
  }, [])

  /**
   * Les questionnaires de l'assistant. Ils arrivent par leur propre canal —
   * l'outil ne connait que le cours, pas l'identifiant du message — et se
   * posent donc sur la reponse en cours de ce cours, comme les traces de
   * memoire. Le tour reste en attente tant que la carte n'a pas repondu.
   */
  useEffect(() => {
    const attach = (form: QuizForm): void => {
      setThreads((previous) => {
        const thread = previous[form.courseId]
        if (!thread || thread.length === 0) return previous

        let index = thread.findIndex((message) => message.streaming)
        if (index === -1) {
          for (let i = thread.length - 1; i >= 0; i -= 1) {
            if (thread[i].role === 'assistant') {
              index = i
              break
            }
          }
        }
        if (index === -1) return previous

        const next = [...thread]
        next[index] = { ...next[index], quiz: form, quizAnswers: undefined }
        return { ...previous, [form.courseId]: next }
      })
    }

    // Un quiz retire — tour interrompu, delai depasse — quitte le fil : la
    // carte proposerait d'envoyer a un tour qui n'ecoute plus.
    const detach = (quizId: string): void => {
      setThreads((previous) => {
        const next: Record<string, ChatMessage[]> = {}
        let touched = false
        for (const [id, thread] of Object.entries(previous)) {
          next[id] = thread.map((message) => {
            if (message.quiz?.id !== quizId || message.quizAnswers) return message
            touched = true
            const { quiz: _quiz, quizAt: _quizAt, ...rest } = message
            return rest
          })
        }
        return touched ? next : previous
      })
    }

    const unsubscribeAsk = window.noted.quiz.onAsk(attach)
    const unsubscribeCancel = window.noted.quiz.onCancel(detach)
    return () => {
      unsubscribeAsk()
      unsubscribeCancel()
    }
  }, [])

  /**
   * Rend la copie : les reponses partent au tour en attente, et restent
   * affichees sur la carte, desormais verrouillee.
   */
  const answerQuiz = useCallback((messageId: string, quizId: string, answers: QuizAnswer[]) => {
    window.noted.quiz.reply(quizId, { status: 'answered', answers })
    setThreads((previous) => {
      const next: Record<string, ChatMessage[]> = {}
      for (const [id, thread] of Object.entries(previous)) {
        next[id] = thread.map((message) =>
          message.id === messageId ? { ...message, quizAnswers: answers } : message
        )
      }
      return next
    })
  }, [])

  /** Passe le quiz : le tour reprend sans copie, et la carte quitte le fil. */
  const skipQuiz = useCallback((messageId: string, quizId: string) => {
    window.noted.quiz.reply(quizId, { status: 'skipped' })
    setThreads((previous) => {
      const next: Record<string, ChatMessage[]> = {}
      for (const [id, thread] of Object.entries(previous)) {
        next[id] = thread.map((message) => {
          if (message.id !== messageId) return message
          const { quiz: _quiz, quizAt: _quizAt, ...rest } = message
          return rest
        })
      }
      return next
    })
  }, [])

  /** Annule une ecriture en memoire depuis sa trace, et met la trace a jour. */
  const cancelTrace = useCallback(async (traceId: string) => {
    const updated = await window.noted.memoire.cancel(traceId)
    if (!updated) return

    setThreads((previous) => {
      const next: Record<string, ChatMessage[]> = {}
      for (const [courseId, thread] of Object.entries(previous)) {
        next[courseId] = thread.map((message) =>
          message.memoryTraces?.some((trace) => trace.id === traceId)
            ? {
                ...message,
                memoryTraces: message.memoryTraces.map((trace) =>
                  trace.id === traceId ? updated : trace
                )
              }
            : message
        )
      }
      return next
    })
  }, [])

  /**
   * Envoie une question, eventuellement en reponse a des passages precis de la
   * derniere reponse.
   *
   * La bulle garde les mots tapes d'un cote et les citations de l'autre — c'est
   * ce qui permet de les afficher en pastilles — tandis que le modele, lui,
   * recoit le tout en un seul texte : un bloc de citation Markdown numerote,
   * puis la question.
   */
  const send = useCallback(
    async (prompt: string, choice: ChatChoice = {}, quotes: ChatQuote[] = []) => {
      if (!courseId || !prompt.trim() || busy) return

      const userMessage: ChatMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        text: prompt.trim(),
        quotes: quotes.length > 0 ? quotes : undefined
      }
      const assistantMessage: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        text: '',
        streaming: true
      }

      setThreads((previous) => ({
        ...previous,
        [courseId]: [...(previous[courseId] ?? []), userMessage, assistantMessage]
      }))
      setBusy(true)
      messageOwner.current.set(assistantMessage.id, courseId)

      try {
        await window.noted.claude.send({
          courseId,
          messageId: assistantMessage.id,
          prompt: formatQuotedPrompt(quotes, userMessage.text),
          model: choice.model,
          effort: choice.effort
        })
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Envoi impossible.'
        setThreads((previous) => {
          const thread = previous[courseId] ?? []
          return {
            ...previous,
            [courseId]: thread.map((message) =>
              message.id === assistantMessage.id
                ? { ...message, streaming: false, error: detail }
                : message
            )
          }
        })
        messageOwner.current.delete(assistantMessage.id)
        setBusy(false)
      }
    },
    [courseId, busy]
  )

  const stop = useCallback(() => {
    if (!courseId) return
    void window.noted.claude.interrupt(courseId)
  }, [courseId])

  const clear = useCallback(() => {
    if (!courseId) return
    void window.noted.claude.reset(courseId)
    setThreads((previous) => ({ ...previous, [courseId]: [] }))
  }, [courseId])

  /** Les conversations passees de ce cours, pour le picker d'historique. */
  const history = useCallback((): Promise<ChatHistoryEntry[]> => {
    if (!courseId) return Promise.resolve([])
    return window.noted.claude.history(courseId)
  }, [courseId])

  /** Reprend une conversation choisie dans l'historique. */
  const openSession = useCallback(
    async (sessionId: string) => {
      if (!courseId) return
      // Marque comme deja repris : sans cela, l'effet d'auto-reprise ci-dessus
      // pourrait plus tard croire le fil jamais charge et le remplacer.
      hydrated.current.add(courseId)
      const messages = await window.noted.claude.openSession(courseId, sessionId)
      setThreads((previous) => ({ ...previous, [courseId]: messages }))
      setBusy(false)
    },
    [courseId]
  )

  /**
   * Compacte la conversation en cours : un repere « system » rejoint le fil,
   * succes ou echec, plutot qu'une paire question/reponse ordinaire.
   */
  const compact = useCallback(async () => {
    if (!courseId || busy || compacting) return
    setCompacting(true)
    try {
      const result = await window.noted.claude.compact(courseId)
      const marker: ChatMessage = result.ok
        ? { id: `c-${Date.now()}`, role: 'system', text: '', compactedTokens: result.droppedTokens }
        : { id: `c-${Date.now()}`, role: 'system', text: '', error: result.error }
      setThreads((previous) => ({
        ...previous,
        [courseId]: [...(previous[courseId] ?? []), marker]
      }))
    } finally {
      setCompacting(false)
    }
  }, [courseId, busy, compacting])

  return {
    messages: courseId ? (threads[courseId] ?? []) : [],
    busy,
    compacting,
    send,
    stop,
    clear,
    cancelTrace,
    answerQuiz,
    skipQuiz,
    history,
    openSession,
    compact
  }
}
