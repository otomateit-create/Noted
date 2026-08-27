/**
 * Pont entre l'outil « quiz » de l'assistant et la carte affichee dans le fil.
 *
 * Meme mecanique que les propositions d'ecriture (voir notes-bridge) : le main
 * envoie le questionnaire au renderer et garde la promesse ouverte. L'appel
 * d'outil reste donc en attente tant que l'utilisateur n'a pas envoye ses
 * reponses — le modele ne reprend la main qu'avec la copie remplie, et corrige
 * dans le meme tour, sans qu'un message de plus soit necessaire.
 *
 * A la difference d'une proposition d'ecriture, l'attente n'est bornee par
 * aucun minuteur. Une proposition se decide en un coup d'oeil ; un quiz de
 * neuf questions se compose, se rature et se relit — un plafond de onze
 * minutes coupait le fil au milieu d'une reflexion, et l'envoi ne faisait
 * alors plus rien (constate le 25 aout 2026 sur deux quiz de neuf questions).
 * Trois sorties suffisent, toutes a portee de clic : « Passer » sur la carte,
 * « Arreter » dans la barre de saisie, ou le message suivant — qui interrompt
 * le tour precedent, donc annule le quiz reste ouvert.
 */

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { CHANNELS } from '../shared/channels'
import type { QuizAnswer, QuizForm, QuizOutcome } from '../shared/types'

let getWindow: () => BrowserWindow | null = () => null

interface QuizWaiter {
  courseId: string
  resolve: (outcome: QuizOutcome) => void
}

const waiters = new Map<string, QuizWaiter>()

function window(): BrowserWindow | null {
  const candidate = getWindow()
  return candidate && !candidate.isDestroyed() ? candidate : null
}

/** Ne garde d'une reponse recue que ce qui a la forme attendue. */
function cleanAnswers(raw: unknown): QuizAnswer[] {
  if (!Array.isArray(raw)) return []

  const answers: QuizAnswer[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.n !== 'number') continue

    const chosen = Array.isArray(record.choisis)
      ? record.choisis.filter((value): value is number => Number.isInteger(value))
      : undefined
    const text = typeof record.texte === 'string' ? record.texte : undefined

    answers.push({ n: record.n, choisis: chosen, texte: text })
  }
  return answers
}

/** Enregistre le canal de reponse. A appeler une fois, avec les autres IPC. */
export function bindQuizBridge(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  ipcMain.on(CHANNELS.quizReply, (_event, quizId: unknown, outcome: unknown) => {
    if (typeof quizId !== 'string') return

    const payload = (outcome ?? {}) as Record<string, unknown>
    const status = payload.status === 'answered' ? 'answered' : 'skipped'
    settle(quizId, {
      status,
      answers: status === 'answered' ? cleanAnswers(payload.answers) : undefined
    })
  })
}

/**
 * Soumet un questionnaire a l'utilisateur et attend sa copie. La promesse ne
 * rejette jamais : toute issue est un statut.
 */
export function askQuiz(form: Omit<QuizForm, 'id'>): Promise<QuizOutcome> {
  const target = window()
  if (!target) return Promise.resolve({ status: 'not-open' })

  const id = randomUUID()
  return new Promise((resolve) => {
    waiters.set(id, { courseId: form.courseId, resolve })
    target.webContents.send(CHANNELS.quizAsk, { ...form, id })
  })
}

/**
 * Retire les quiz en attente d'un cours — tour interrompu, cours ferme. La
 * carte disparait de l'ecran et la promesse est resolue pour ne pas fuir.
 */
export function cancelQuizzes(courseId: string): void {
  for (const [id, waiter] of waiters) {
    if (waiter.courseId !== courseId) continue
    window()?.webContents.send(CHANNELS.quizCancel, id)
    settle(id, { status: 'cancelled' })
  }
}

function settle(quizId: string, outcome: QuizOutcome): void {
  const waiter = waiters.get(quizId)
  if (!waiter) return

  waiters.delete(quizId)
  waiter.resolve(outcome)
}
