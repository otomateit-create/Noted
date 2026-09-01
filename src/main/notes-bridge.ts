/**
 * Pont entre les outils de l'assistant et la note affichee a l'ecran.
 *
 * La note vit dans l'editeur du renderer, pas sur le disque : ce qui vient
 * d'etre tape n'est ecrit qu'apres un delai d'inactivite. Les outils du main
 * doivent donc faire l'aller-retour — demander le markdown courant, et
 * soumettre chaque proposition d'ecriture a l'utilisateur, qui l'applique ou
 * la refuse depuis son panneau de notes.
 *
 * Un appel d'outil reste en attente pendant que l'apercu est a l'ecran :
 * c'est voulu. Le modele ne recoit la main que lorsque l'utilisateur a
 * tranche, et sait donc si sa proposition a ete appliquee.
 */

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { CHANNELS } from '../shared/channels'
import type {
  NoteDraft,
  NoteDraftEnd,
  NoteProposal,
  NoteProposalOutcome,
  NoteProposalStatus
} from '../shared/types'

let getWindow: () => BrowserWindow | null = () => null

interface LiveWaiter {
  resolve: (markdown: string | null) => void
  timer: NodeJS.Timeout
}

interface ProposalWaiter {
  courseId: string
  resolve: (outcome: NoteProposalOutcome) => void
  timer: NodeJS.Timeout
}

const liveWaiters = new Map<string, LiveWaiter>()
const proposalWaiters = new Map<string, ProposalWaiter>()

/** Le renderer peut mettre un rendu a repondre ; au-dela, la note n'est pas ouverte. */
const LIVE_TIMEOUT = 1_500

/**
 * Au-dela, la proposition est reputee ignoree et le tour reprend. Sans cette
 * borne, un apercu oublie bloquerait la conversation pour toujours.
 */
const PROPOSAL_TIMEOUT = 10 * 60_000

const STATUSES: NoteProposalStatus[] = ['applied', 'refused', 'stale', 'not-open', 'invalid']

function window(): BrowserWindow | null {
  const candidate = getWindow()
  return candidate && !candidate.isDestroyed() ? candidate : null
}

/** Enregistre les canaux de reponse. A appeler une fois, avec les autres IPC. */
export function bindNotesBridge(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter

  ipcMain.on(CHANNELS.notesLiveReply, (_event, requestId: unknown, markdown: unknown) => {
    if (typeof requestId !== 'string') return
    const waiter = liveWaiters.get(requestId)
    if (!waiter) return

    liveWaiters.delete(requestId)
    clearTimeout(waiter.timer)
    waiter.resolve(typeof markdown === 'string' ? markdown : null)
  })

  ipcMain.on(
    CHANNELS.notesProposalReply,
    (_event, proposalId: unknown, status: unknown, detail: unknown) => {
      if (typeof proposalId !== 'string') return
      settleProposal(
        proposalId,
        STATUSES.includes(status as NoteProposalStatus)
          ? (status as NoteProposalStatus)
          : 'refused',
        typeof detail === 'string' ? detail : undefined
      )
    }
  )
}

/**
 * Le markdown de la note telle qu'elle est a l'ecran, ou null si le panneau
 * des notes n'affiche pas ce cours — l'appelant se rabat alors sur le disque.
 */
export function readLiveNote(courseId: string): Promise<string | null> {
  const target = window()
  if (!target) return Promise.resolve(null)

  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      liveWaiters.delete(requestId)
      resolve(null)
    }, LIVE_TIMEOUT)

    liveWaiters.set(requestId, { resolve, timer })
    target.webContents.send(CHANNELS.notesLiveRequest, { requestId, courseId })
  })
}

/**
 * Soumet une proposition d'ecriture a l'utilisateur et attend sa decision.
 * La promesse ne rejette jamais : toute issue est un statut.
 *
 * Elle commence par s'assurer qu'il y a quelqu'un au bout du fil. L'apercu
 * part en `send` : s'il n'atteint aucun ecouteur — l'espace de travail quitte
 * pour le tableau de bord, un autre cours charge — personne ne repondra, et
 * l'appel d'outil resterait dix minutes en suspens, l'assistant « pense » a
 * l'ecran et la note jamais ecrite. La lecture de la note vivante tranche en
 * 1,5 s au pire, et sur exactement la meme condition que celle qui decide le
 * panneau a repondre : nulle, c'est qu'il n'y a personne pour recevoir.
 */
export async function proposeNoteChange(
  proposal: Omit<NoteProposal, 'id'>
): Promise<NoteProposalOutcome> {
  if ((await readLiveNote(proposal.courseId)) === null) return { status: 'not-open' }

  const target = window()
  if (!target) return { status: 'not-open' }

  const id = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // L'apercu est reste sans reponse : on le retire de l'ecran nous-memes,
      // sans quoi il proposerait d'appliquer une modification que le modele
      // croit deja refusee.
      window()?.webContents.send(CHANNELS.notesProposalCancel, id)
      settleProposal(id, 'refused')
    }, PROPOSAL_TIMEOUT)

    proposalWaiters.set(id, { courseId: proposal.courseId, resolve, timer })
    target.webContents.send(CHANNELS.notesProposal, { ...proposal, id })
  })
}

/**
 * Retire les propositions en attente d'un cours — tour interrompu, cours
 * renomme ou supprime. L'apercu disparait de l'ecran, et la promesse est
 * resolue pour ne pas fuir, meme si plus personne n'en lit le resultat.
 */
export function cancelProposals(courseId: string): void {
  for (const [id, waiter] of proposalWaiters) {
    if (waiter.courseId !== courseId) continue
    window()?.webContents.send(CHANNELS.notesProposalCancel, id)
    settleProposal(id, 'refused')
  }
}

/**
 * Le texte d'une ecriture de notes, pendant qu'il se compose. Rien n'est
 * attendu en retour : le panneau montre, la proposition reelle suivra par
 * `proposeNoteChange`, et c'est elle qui se decide.
 */
export function showNoteDraft(draft: NoteDraft): void {
  window()?.webContents.send(CHANNELS.notesDraft, draft)
}

/** Retire un brouillon — ou tous ceux du cours quand `id` est null. */
export function endNoteDrafts(courseId: string, id: string | null): void {
  const end: NoteDraftEnd = { courseId, id }
  window()?.webContents.send(CHANNELS.notesDraftEnd, end)
}

function settleProposal(
  proposalId: string,
  status: NoteProposalStatus,
  detail?: string
): void {
  const waiter = proposalWaiters.get(proposalId)
  if (!waiter) return

  proposalWaiters.delete(proposalId)
  clearTimeout(waiter.timer)
  waiter.resolve({ status, detail })
}
