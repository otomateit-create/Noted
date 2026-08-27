import { useCallback, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { marked } from 'marked'
import type { QuizAnswer, QuizForm, QuizQuestion } from '@shared/types'
import { protectMath, restoreMath } from '../lib/math'

/**
 * Le questionnaire que l'assistant fait passer, pose dans le fil comme une
 * feuille blanche sur le papier creme du chat.
 *
 * On remplit tout, puis on envoie une fois : le tour de conversation est en
 * attente pendant ce temps — c'est l'outil `quiz` cote main qui tient la
 * promesse ouverte —, et la copie lui revient d'un bloc, corrigee dans la
 * foulee. Une fois envoyee, la carte se verrouille et garde les reponses a
 * l'ecran : la correction se lit en regard de ce qu'on avait coche.
 */

interface QuizCardProps {
  quiz: QuizForm
  /** Les reponses deja envoyees. Absent tant que la carte attend. */
  answers: QuizAnswer[] | undefined
  /**
   * Le tour qui attendait cette copie s'est termine sans elle : plus personne
   * n'ecoute a l'autre bout. La carte reste remplissable — l'envoi part alors
   * comme message ordinaire plutot que comme resultat d'outil.
   */
  orphaned: boolean
  onSubmit: (answers: QuizAnswer[]) => void
  onSkip: () => void
}

/** L'enonce d'une question : Markdown en ligne, formules comprises. */
function renderStem(markdown: string): string {
  const { text, formulas } = protectMath(markdown)
  const html = marked.parseInline(text, { async: false })
  return typeof html === 'string' ? restoreMath(html, formulas) : ''
}

const letter = (index: number): string => String.fromCharCode(65 + index)

/**
 * Le champ d'une question ouverte grandit avec ce qu'on y ecrit. Une reponse
 * de six lignes tapee dans une fenetre de deux se relit a l'aveugle : on ne
 * voit plus le debut de ce qu'on vient de dire au moment de le conclure.
 */
function fit(field: HTMLTextAreaElement | null): void {
  if (!field) return
  field.style.height = 'auto'
  field.style.height = `${field.scrollHeight}px`
}

export default function QuizCard({
  quiz,
  answers,
  orphaned,
  onSubmit,
  onSkip
}: QuizCardProps): React.JSX.Element {
  /** Les cases cochees, par numero de question. */
  const [chosen, setChosen] = useState<Record<number, number[]>>({})
  /** Le texte saisi, par numero de question. */
  const [written, setWritten] = useState<Record<number, string>>({})

  const locked = answers !== undefined

  const toggle = useCallback(
    (question: QuizQuestion, index: number) => {
      setChosen((previous) => {
        const current = previous[question.n] ?? []
        const next = question.multiple
          ? current.includes(index)
            ? current.filter((entry) => entry !== index)
            : [...current, index].sort((a, b) => a - b)
          : [index]
        return { ...previous, [question.n]: next }
      })
    },
    []
  )

  /** Ce qui a ete repondu, dans la forme que l'outil attend. */
  const filled = useMemo(
    () =>
      quiz.questions.map((question) =>
        question.type === 'qcm'
          ? { n: question.n, choisis: chosen[question.n] ?? [] }
          : { n: question.n, texte: (written[question.n] ?? '').trim() }
      ),
    [quiz.questions, chosen, written]
  )

  const done = filled.filter((answer) =>
    answer.choisis ? answer.choisis.length > 0 : Boolean(answer.texte)
  ).length

  /** Ce qu'on lit dans la carte : la saisie en cours, ou la copie rendue. */
  const shown = answers ?? filled

  return (
    <motion.section
      className="quiz-card"
      data-locked={locked || undefined}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 0.61, 0.36, 1] }}
      aria-label={quiz.titre ? `Quiz — ${quiz.titre}` : 'Quiz'}
    >
      <header className="quiz-head">
        <div className="quiz-head-text">
          <p className="quiz-kicker">Quiz</p>
          {quiz.titre && <h3 className="quiz-title">{quiz.titre}</h3>}
        </div>
        <span className="quiz-count">
          {locked ? 'Copie envoyée' : `${done} / ${quiz.questions.length}`}
        </span>
      </header>

      {/* La jauge de remplissage : d'un coup d'oeil, ce qui reste a faire. */}
      {!locked && (
        <div className="quiz-gauge" aria-hidden="true">
          <span style={{ width: `${(done / quiz.questions.length) * 100}%` }} />
        </div>
      )}

      <ol className="quiz-questions">
        {quiz.questions.map((question) => {
          const answer = shown.find((entry) => entry.n === question.n)
          const picked = answer?.choisis ?? []

          return (
            <li className="quiz-question" key={question.n}>
              <div className="quiz-stem">
                <span className="quiz-n" aria-hidden="true">
                  {question.n}
                </span>
                <p
                  className="quiz-stem-text"
                  dangerouslySetInnerHTML={{ __html: renderStem(question.question) }}
                />
              </div>

              {question.multiple && !locked && (
                <p className="quiz-hint">Plusieurs réponses possibles</p>
              )}

              {question.type === 'qcm' ? (
                <div className="quiz-options" role="group">
                  {question.options.map((option, index) => (
                    <button
                      type="button"
                      key={index}
                      className="quiz-option"
                      data-chosen={picked.includes(index) || undefined}
                      disabled={locked}
                      onClick={() => toggle(question, index)}
                    >
                      <span className="quiz-letter">{letter(index)}</span>
                      <span
                        className="quiz-option-text"
                        dangerouslySetInnerHTML={{ __html: renderStem(option) }}
                      />
                    </button>
                  ))}
                </div>
              ) : locked ? (
                <p className="quiz-written">{answer?.texte || 'Sans réponse'}</p>
              ) : (
                <textarea
                  className="quiz-field"
                  ref={fit}
                  value={written[question.n] ?? ''}
                  onChange={(event) => {
                    fit(event.target)
                    setWritten((previous) => ({ ...previous, [question.n]: event.target.value }))
                  }}
                  placeholder="Ta réponse…"
                  rows={2}
                  spellCheck={false}
                />
              )}
            </li>
          )
        })}
      </ol>

      {!locked && (
        <footer className="quiz-foot">
          <button
            type="button"
            className="quiz-send"
            disabled={done === 0}
            onClick={() => onSubmit(filled)}
            title={
              done < quiz.questions.length
                ? 'Envoyer maintenant — les questions laissées vides seront comptées sans réponse'
                : 'Envoyer ma copie'
            }
          >
            Envoyer ma copie
          </button>
          <button type="button" className="quiz-skip" onClick={onSkip}>
            Passer
          </button>
        </footer>
      )}

      {/* Le tour a fini sans la copie. On le dit plutot que de laisser un
          bouton qui ne fait rien — c'etait tout le probleme. */}
      {!locked && orphaned && (
        <p className="quiz-orphan" role="status">
          Ce tour s'est terminé sans recevoir ta copie. L'envoi la postera comme message —
          rien n'est perdu.
        </p>
      )}
    </motion.section>
  )
}
