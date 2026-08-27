/**
 * Les gestes de l'assistant sur sa memoire, et leur trace a l'ecran.
 *
 * L'ecriture est automatique — une memoire ne se remplit que si la remplir ne
 * coute rien. Le garde-fou n'est pas la confirmation prealable, c'est la
 * visibilite : chaque geste envoie sa trace au renderer, qui l'affiche sous la
 * reponse dans le style des appels d'outils, et chaque trace porte de quoi
 * annuler le geste apres coup.
 *
 * Le journal des annulations vit en memoire : une trace ne survit pas au
 * redemarrage, mais l'entree, elle, reste visible dans l'ecran Memoire et dans
 * les fichiers — l'annulation tardive passe par la.
 */

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { CHANNELS } from '../../shared/channels'
import type { Course, MemoryEntry, MemoryLevel, MemoryTrace } from '../../shared/types'
import { targetOf } from '../../shared/memory-links'
import {
  addEntry,
  changeEntryLink,
  listAllEntries,
  removeEntry,
  restoreEntry,
  setEntryLinks,
  updateEntry
} from './entries'
import type { MemoryTarget } from './entries'
import { invalidateMemoryIndex } from './rag'

let getWindow: () => BrowserWindow | null = () => null

/** A appeler une fois, avec les autres IPC. */
export function bindMemoryBridge(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
}

interface Undoable {
  trace: MemoryTrace
  undo: () => Promise<void>
}

const journal = new Map<string, Undoable>()

/** Au-dela, les plus anciennes annulations s'oublient. */
const JOURNAL_LIMIT = 100

function announce(trace: MemoryTrace): void {
  const window = getWindow()
  if (window && !window.isDestroyed()) {
    window.webContents.send(CHANNELS.memoireTrace, trace)
  }
}

function record(trace: MemoryTrace, undo: () => Promise<void>): void {
  journal.set(trace.id, { trace, undo })
  for (const key of journal.keys()) {
    if (journal.size <= JOURNAL_LIMIT) break
    journal.delete(key)
  }
  announce(trace)
}

function targetFor(course: Course, level: MemoryLevel): MemoryTarget {
  switch (level) {
    case 'global':
      return { level: 'global' }
    case 'matiere':
      return { level: 'matiere', subject: course.subject }
    case 'cours':
      return { level: 'cours', courseId: course.id }
  }
}

/** Ecrit une entree neuve. La trace permet de la retirer d'un clic. */
export async function noteMemory(
  course: Course,
  level: MemoryLevel,
  title: string,
  body: string
): Promise<MemoryEntry> {
  const entry = await addEntry(targetFor(course, level), title, body)
  invalidateMemoryIndex()

  record(
    {
      id: randomUUID(),
      courseId: course.id,
      action: 'noter',
      entryId: entry.id,
      level: entry.level,
      title: entry.title,
      body: entry.body,
      cancellable: true
    },
    async () => {
      await removeEntry(entry.id)
    }
  )
  return entry
}

/** Corrige une entree. L'annulation restaure titre, corps et date d'avant. */
export async function correctMemory(
  course: Course,
  entryId: string,
  patch: { title?: string; body?: string }
): Promise<MemoryEntry | null> {
  const change = await updateEntry(entryId, patch)
  if (!change) return null
  invalidateMemoryIndex()

  const { before, after } = change
  record(
    {
      id: randomUUID(),
      courseId: course.id,
      action: 'corriger',
      entryId: after.id,
      level: after.level,
      title: after.title,
      body: after.body,
      cancellable: true
    },
    async () => {
      await updateEntry(entryId, { title: before.title, body: before.body, date: before.date })
    }
  )
  return after
}

/**
 * Supprime une entree devenue fausse, et avec elle les liens qui la visaient.
 * L'annulation la rejoue telle quelle, ces liens compris.
 */
export async function forgetMemory(
  course: Course,
  entryId: string
): Promise<MemoryEntry | null> {
  const removed = await removeEntry(entryId)
  if (!removed) return null
  invalidateMemoryIndex()

  const entry = removed.entry
  record(
    {
      id: randomUUID(),
      courseId: course.id,
      action: 'oublier',
      entryId: entry.id,
      level: entry.level,
      title: entry.title,
      body: entry.body,
      cancellable: true
    },
    async () => {
      await restoreEntry(removed)
    }
  )
  return entry
}

/** Ce que la liaison a donne, dit dans la langue de l'assistant. */
export type LinkResult =
  | { ok: true; entry: MemoryEntry; target: MemoryEntry; removed: boolean }
  | { ok: false; reason: string }

/**
 * Relie deux entrees, ou defait le lien. L'assistant designe les deux entrees
 * par leur identifiant ; c'est ici que la cible `[[fichier#titre]]` se compose,
 * pour qu'aucune syntaxe ne depende de ce qu'il aura ecrit.
 */
export async function linkMemory(
  course: Course,
  sourceId: string,
  targetId: string,
  remove: boolean
): Promise<LinkResult> {
  if (sourceId === targetId) {
    return { ok: false, reason: 'Une entrée ne se relie pas à elle-même.' }
  }

  const entries = await listAllEntries()
  const source = entries.find((entry) => entry.id === sourceId)
  const target = entries.find((entry) => entry.id === targetId)

  if (!source) return { ok: false, reason: `Aucune entrée ne porte l'identifiant « ${sourceId} ».` }
  if (!target) return { ok: false, reason: `Aucune entrée ne porte l'identifiant « ${targetId} ».` }

  const change = await changeEntryLink(sourceId, targetOf(target), remove)
  if (!change.ok) {
    return { ok: false, reason: LINK_REFUSALS[change.reason] }
  }
  invalidateMemoryIndex()

  const previous = change.previous
  record(
    {
      id: randomUUID(),
      courseId: course.id,
      action: 'lier',
      entryId: source.id,
      level: source.level,
      title: source.title,
      body: remove
        ? `Lien retiré vers « ${target.title} » [${target.id}].`
        : `Reliée à « ${target.title} » [${target.id}].`,
      cancellable: true
    },
    async () => {
      await setEntryLinks(sourceId, previous)
    }
  )

  return { ok: true, entry: change.entry, target, removed: remove }
}

/** Pourquoi une liaison n'a pas eu lieu, en clair pour l'assistant. */
const LINK_REFUSALS: Record<'introuvable' | 'plafond' | 'deja' | 'absent', string> = {
  introuvable: "L'entrée source a disparu entre-temps.",
  plafond:
    "Cette entrée porte déjà cinq liens, le maximum. Retire-en un avec « retirer: true » si celui-ci compte davantage, ou laisse-la ainsi — au-delà, l'entrée n'est plus un fait mais un carrefour.",
  deja: 'Ces deux entrées sont déjà reliées.',
  absent: 'Cette entrée ne portait pas ce lien.'
}

/**
 * Annule un geste depuis sa trace. Rend la trace mise a jour pour que
 * l'interface l'affiche barree, ou null si elle n'est plus annulable.
 */
export async function cancelMemoryTrace(traceId: string): Promise<MemoryTrace | null> {
  const known = journal.get(traceId)
  if (!known) return null

  // Retiree avant d'agir : deux clics rapides ne doivent pas annuler deux fois.
  journal.delete(traceId)
  await known.undo()
  invalidateMemoryIndex()

  return { ...known.trace, cancellable: false, cancelled: true }
}
