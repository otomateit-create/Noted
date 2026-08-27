/**
 * La copie d'un quiz, mise en texte.
 *
 * Le meme rendu sert deux fois. Cote main, c'est ce que l'outil `quiz` rend au
 * modele quand la carte est envoyee. Cote interface, c'est ce qui part comme
 * message ordinaire lorsque le tour qui attendait la copie s'est termine sans
 * elle — un plantage, un depassement, une interruption : la carte reste alors
 * a l'ecran mais plus personne n'ecoute a l'autre bout, et les reponses
 * seraient perdues sans ce repli.
 *
 * Chaque question est rappelee avec ses options : le modele corrige sans avoir
 * a se souvenir de l'ordre dans lequel il les a posees, et le transcript relu
 * a l'oeil nu se comprend seul.
 */

import type { QuizAnswer, QuizQuestion } from './types'

/** La lettre d'une option, comme la carte l'affiche. */
function letter(index: number): string {
  return String.fromCharCode(65 + index)
}

/** Ce qui a ete repondu a une question, en clair. */
function given(question: QuizQuestion, answer: QuizAnswer | undefined): string {
  if (question.type === 'qcm') {
    const picked = (answer?.choisis ?? [])
      .filter((index) => index >= 0 && index < question.options.length)
      .map((index) => `${letter(index)} — ${question.options[index]}`)
    return picked.length > 0 ? picked.join(' ; ') : 'sans réponse'
  }
  return answer?.texte?.trim() || 'sans réponse'
}

/**
 * La copie entiere : enonces, options rappelees, reponses donnees.
 *
 * `label` porte la voix. L'outil rend la copie au modele et parle donc de
 * l'utilisateur a la troisieme personne ; le repli, lui, s'affiche dans la
 * bulle de l'utilisateur, ou « sa reponse » sonnerait faux.
 */
export function formatQuizCopy(
  questions: QuizQuestion[],
  answers: QuizAnswer[],
  label = 'Sa réponse'
): string {
  return questions
    .map((question) => {
      const options =
        question.type === 'qcm'
          ? `\n   Options : ${question.options
              .map((option, index) => `${letter(index)} — ${option}`)
              .join(' | ')}`
          : ''
      const answer = answers.find((entry) => entry.n === question.n)
      return `${question.n}. ${question.question}${options}\n   ${label} : ${given(question, answer)}`
    })
    .join('\n\n')
}

/** Ce qui accompagne la copie, des deux cotes du pont. */
export const QUIZ_CORRECTION_BRIEF =
  "Corrige-la maintenant, question par question : dis pour chacune si c'est juste, et quand c'est faux repars du raisonnement qui a manqué plutôt que d'asséner la bonne réponse."
