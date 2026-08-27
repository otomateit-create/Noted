import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUp, Bot, X } from 'lucide-react'
import { marked } from 'marked'
import type { ChatMessage, ChatStreamEvent } from '@shared/types'
import type { ReviewQueueItem } from '@shared/flashcards'
import { protectMath, restoreMath } from '../lib/math'
import '../styles/flashcards.css'

/**
 * Le tuteur d'une carte : un panneau de chat qui s'ouvre a droite de la carte
 * en revision. A l'ouverture, il demande de lui-meme l'explication — la
 * methode est dans le prompt cote main — puis l'utilisateur enchaine ses
 * questions. La question de verification arrive dans un bloc `verif` que le
 * panneau transforme en petit questionnaire.
 */

interface FlashcardsTutorProps {
  item: ReviewQueueItem
  onClose: () => void
}

/** Un message du fil, avec le premier — la demande automatique — masque. */
type TutorMessage = ChatMessage & { hidden?: boolean }

/** La question de verification, telle que le bloc `verif` la decrit. */
interface TutorQuiz {
  type: 'qcm' | 'libre'
  question: string
  options: string[]
  multiple: boolean
}

const VERIF_BLOCK = /```verif\s*([\s\S]*?)```/

/**
 * Separe l'explication de sa question de verification. Un bloc encore ouvert
 * pendant l'ecriture est masque (pas de code brut qui clignote) ; un bloc
 * illisible reste affiche tel quel plutot que de disparaitre.
 */
function splitVerif(text: string, streaming: boolean): { body: string; quiz: TutorQuiz | null } {
  const match = text.match(VERIF_BLOCK)
  if (!match) {
    if (streaming) {
      const opening = text.indexOf('```verif')
      if (opening !== -1) return { body: text.slice(0, opening), quiz: null }
    }
    return { body: text, quiz: null }
  }

  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>
    const question = typeof raw.question === 'string' ? raw.question.trim() : ''
    const options = Array.isArray(raw.options)
      ? raw.options.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      : []

    if (question && (raw.type === 'libre' || (raw.type === 'qcm' && options.length >= 2))) {
      return {
        body: text.replace(VERIF_BLOCK, '').trim(),
        quiz: {
          type: raw.type as 'qcm' | 'libre',
          question,
          options,
          multiple: raw.multiple === true
        }
      }
    }
  } catch {
    // JSON fautif : le bloc reste visible en code, rien n'est perdu.
  }
  return { body: text, quiz: null }
}

/** La recette du chat de l'assistant : Markdown puis formules KaTeX. */
function renderTutorHtml(markdown: string): string {
  if (!markdown) return ''
  const { text, formulas } = protectMath(markdown)
  const html = marked.parse(text, { async: false, gfm: true })
  if (typeof html !== 'string') return ''
  return restoreMath(html, formulas)
}

export default function FlashcardsTutor({
  item,
  onClose
}: FlashcardsTutorProps): React.JSX.Element {
  const [messages, setMessages] = useState<TutorMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  /** Reponse donnee a chaque question de verification, par message. */
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const scrollRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    const unsubscribe = window.noted.flashcards.onTutorStream((event: ChatStreamEvent) => {
      setMessages((previous) => {
        const index = previous.findIndex((message) => message.id === event.messageId)
        if (index === -1) return previous

        const next = [...previous]
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
            break
          case 'tool-result':
            message.toolCalls = message.toolCalls?.map((call) =>
              call.id === event.toolId ? { ...call, result: event.result, running: false } : call
            )
            break
          case 'tokens':
            message.tokens = event.tokens
            break
          case 'done':
            message.streaming = false
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
        return next
      })

      if (event.kind === 'done' || event.kind === 'error') setBusy(false)
    })

    return unsubscribe
  }, [])

  const sendTurn = useCallback(
    (prompt: string, hidden = false) => {
      const trimmed = prompt.trim()
      if (!trimmed) return

      const userMessage: TutorMessage = {
        id: `tu-${Date.now()}`,
        role: 'user',
        text: trimmed,
        hidden
      }
      const assistantMessage: TutorMessage = {
        id: `ta-${Date.now()}`,
        role: 'assistant',
        text: '',
        streaming: true
      }

      setMessages((previous) => [...previous, userMessage, assistantMessage])
      setBusy(true)

      window.noted.flashcards
        .tutorSend({
          messageId: assistantMessage.id,
          prompt: trimmed,
          card: { setId: item.courseId, recto: item.card.recto, verso: item.card.verso }
        })
        .catch((cause) => {
          const detail = cause instanceof Error ? cause.message : 'Envoi impossible.'
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantMessage.id
                ? { ...message, streaming: false, error: detail }
                : message
            )
          )
          setBusy(false)
        })
    },
    [item]
  )

  // A l'ouverture : conversation neuve, puis la demande d'explication part
  // toute seule — c'est le clic sur le robot qui l'a formulee.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void window.noted.flashcards
      .tutorReset()
      .catch(() => undefined)
      .then(() => sendTurn('Explique-moi comment retenir cette carte.', true))
    return () => {
      void window.noted.flashcards.tutorStop().catch(() => undefined)
    }
  }, [sendTurn])

  // Suivre la reponse pendant qu'elle s'ecrit, sauf si on est remonte relire.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const fromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    if (fromBottom < 160) element.scrollTop = element.scrollHeight
  })

  const submitDraft = useCallback(() => {
    if (busy || !draft.trim()) return
    sendTurn(draft)
    setDraft('')
  }, [busy, draft, sendTurn])

  const answerQuiz = useCallback(
    (messageId: string, text: string) => {
      setAnswers((previous) => ({ ...previous, [messageId]: text }))
      sendTurn(text)
    },
    [sendTurn]
  )

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id
    }
    return null
  }, [messages])

  return (
    <motion.aside
      className="fc-tutor"
      initial={{ opacity: 0, x: 28 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 28 }}
      transition={{ duration: 0.26, ease: [0.22, 0.61, 0.36, 1] }}
      aria-label="Tuteur de la carte"
    >
      <header className="fc-tutor-head">
        <span className="fc-tutor-badge" aria-hidden="true">
          <Bot />
        </span>
        <span className="fc-tutor-title">Tuteur</span>
        <button className="fc-tutor-close" onClick={onClose} aria-label="Fermer le tuteur">
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="fc-tutor-scroll" ref={scrollRef}>
        {messages
          .filter((message) => !message.hidden)
          .map((message) =>
            message.role === 'user' ? (
              <div key={message.id} className="fc-tutor-user">
                {message.text}
              </div>
            ) : (
              <TutorAnswer
                key={message.id}
                message={message}
                answered={answers[message.id]}
                interactive={message.id === lastAssistantId && !busy}
                onAnswer={(text) => answerQuiz(message.id, text)}
              />
            )
          )}
      </div>

      <div className="fc-tutor-input">
        <textarea
          className="fc-tutor-field"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submitDraft()
            }
          }}
          placeholder="Une question sur cette carte ?"
          rows={1}
          spellCheck={false}
        />
        <button
          className="fc-tutor-send"
          onClick={submitDraft}
          disabled={busy || !draft.trim()}
          aria-label="Envoyer"
        >
          <ArrowUp aria-hidden="true" />
        </button>
      </div>
    </motion.aside>
  )
}

/** Une reponse du tuteur : etapes discretes, texte rendu, questionnaire. */
function TutorAnswer({
  message,
  answered,
  interactive,
  onAnswer
}: {
  message: TutorMessage
  answered: string | undefined
  interactive: boolean
  onAnswer: (text: string) => void
}): React.JSX.Element {
  const { body, quiz } = useMemo(
    () => splitVerif(message.text, Boolean(message.streaming)),
    [message.text, message.streaming]
  )
  const html = useMemo(() => renderTutorHtml(body), [body])

  return (
    <div className="fc-tutor-answer">
      {message.toolCalls?.map((call) => (
        <div key={call.id} className="fc-tutor-step" data-running={call.running || undefined}>
          <span className="fc-tutor-step-dot" aria-hidden="true" />
          {call.summary}
        </div>
      ))}

      {html && (
        <div className="fc-markdown fc-tutor-text" dangerouslySetInnerHTML={{ __html: html }} />
      )}

      {message.streaming && !message.text && (
        <div className="fc-tutor-wait" role="status">
          Réflexion…
        </div>
      )}

      {quiz && !message.streaming && (
        <QuizWidget
          quiz={quiz}
          answered={answered}
          disabled={!interactive || answered !== undefined}
          onSubmit={onAnswer}
        />
      )}

      {message.error && <div className="fc-tutor-error">{message.error}</div>}
    </div>
  )
}

/**
 * La question de verification, presentee comme un petit questionnaire : la
 * question en haut, la zone de reponse en bas — cases pour un QCM, champ
 * libre sinon. La reponse part dans le fil, ou le tuteur corrige.
 */
function QuizWidget({
  quiz,
  answered,
  disabled,
  onSubmit
}: {
  quiz: TutorQuiz
  answered: string | undefined
  disabled: boolean
  onSubmit: (text: string) => void
}): React.JSX.Element {
  const [chosen, setChosen] = useState<number[]>([])
  const [free, setFree] = useState('')

  const toggle = (index: number): void => {
    if (disabled) return
    setChosen((previous) =>
      quiz.multiple
        ? previous.includes(index)
          ? previous.filter((entry) => entry !== index)
          : [...previous, index]
        : [index]
    )
  }

  const letter = (index: number): string => String.fromCharCode(65 + index)

  const submit = (): void => {
    if (disabled) return
    if (quiz.type === 'qcm') {
      if (chosen.length === 0) return
      const picked = [...chosen].sort((a, b) => a - b)
      onSubmit(
        `Ma réponse : ${picked.map((index) => `${letter(index)} — ${quiz.options[index]}`).join(' ; ')}`
      )
    } else {
      if (!free.trim()) return
      onSubmit(free.trim())
    }
  }

  return (
    <div className="fc-quiz" data-answered={answered !== undefined || undefined}>
      <p className="fc-quiz-label">Pour vérifier</p>
      <p className="fc-quiz-question">{quiz.question}</p>

      {quiz.type === 'qcm' ? (
        <div className="fc-quiz-options" role="group" aria-label="Réponses possibles">
          {quiz.options.map((option, index) => (
            <button
              key={index}
              className="fc-quiz-option"
              data-chosen={chosen.includes(index) || undefined}
              disabled={disabled}
              onClick={() => toggle(index)}
            >
              <span className="fc-quiz-letter">{letter(index)}</span>
              <span className="fc-quiz-option-text">{option}</span>
            </button>
          ))}
        </div>
      ) : answered === undefined ? (
        <textarea
          className="fc-quiz-free"
          value={free}
          onChange={(event) => setFree(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="Ta réponse…"
          rows={2}
          disabled={disabled}
          spellCheck={false}
        />
      ) : null}

      {answered === undefined ? (
        <button
          className="fc-primary fc-quiz-submit"
          disabled={disabled || (quiz.type === 'qcm' ? chosen.length === 0 : !free.trim())}
          onClick={submit}
        >
          Envoyer
        </button>
      ) : (
        <p className="fc-quiz-answered">{answered}</p>
      )}
    </div>
  )
}
