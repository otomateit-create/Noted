/**
 * Les fichiers de la memoire : lecture, ecriture, entree par entree.
 *
 * Trois niveaux, dans une arborescence qui reprend celle de Cours/ et Notes/ :
 *
 *     Memoire/global.md                    ce qui vaut partout
 *     Memoire/Corporate Finance.md         ce qui vaut pour la matiere
 *     Memoire/Corporate Finance/cours.md   ce qui vaut pour ce cours
 *
 * Plusieurs fichiers plutot qu'un seul, parce qu'une ecriture ne doit toucher
 * qu'un petit fichier, qu'un cours supprime doit emporter sa memoire, et qu'un
 * fichier unique de quinze mille lignes serait ingerable a la main.
 *
 * Une entree est un fait court : un marqueur invisible qui porte l'identifiant
 * et la date, un titre en `##`, quelques lignes, et — quand elle en a — une
 * derniere ligne de liens vers d'autres entrees. Le tout reste du Markdown
 * ordinaire, lisible et editable dans Obsidian — seule la ligne de marqueur
 * doit rester au-dessus de son entree.
 *
 * La ligne de liens est tenue a part du corps : les outils d'ecriture ne la
 * voient jamais, ce qui garantit qu'ajouter un lien ne change pas le texte
 * vectorise, donc ne revectorise rien.
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { MAX_LINKS, linkTarget, normaliseTarget } from '../../shared/memory-links'
import type { MemoryEntry, MemoryLevel } from '../../shared/types'
import { exists, vaultPaths } from '../vault'

/** Ou ecrire : le niveau, et de quoi trouver le fichier. */
export type MemoryTarget =
  | { level: 'global' }
  | { level: 'matiere'; subject: string }
  | { level: 'cours'; courseId: string }

/**
 * La ligne qui ouvre une entree. Invisible dans Obsidian, elle porte ce que la
 * note n'a pas a montrer : l'identifiant stable et la date d'ecriture.
 */
const MARKER = /^<!--\s*entree:([a-z0-9-]+)\s+(\d{4}-\d{2}-\d{2})\s*-->\s*$/

/** La derniere ligne d'une entree quand elle porte des liens. */
const LINK_LINE = /^Voir\s*:\s*(.*)$/
const WIKILINK = /\[\[([^\]]+)\]\]/g

/** Le fichier de memoire d'un cours : meme arborescence, extension .md. */
export function memoryFileForCourse(courseId: string): string {
  return `${courseId.replace(/\.[^./]+$/, '')}.md`
}

function memoryFileFor(target: MemoryTarget): string {
  switch (target.level) {
    case 'global':
      return 'global.md'
    case 'matiere':
      return `${target.subject}.md`
    case 'cours':
      return memoryFileForCourse(target.courseId)
  }
}

/**
 * Chemin absolu d'un fichier de memoire, en refusant tout ce qui sortirait de
 * Memoire/. Les noms viennent de l'utilisateur — matiere, nom de cours — et un
 * « ../ » ne doit pas pouvoir faire ecrire ailleurs.
 */
function absolute(relative: string): string {
  const root = vaultPaths().memory
  const resolved = path.resolve(root, relative)
  const rel = path.relative(root, resolved)

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Fichier de mémoire hors du vault : ${relative}`)
  }
  return resolved
}

/** Niveau et matiere d'un fichier, lus dans sa place sous Memoire/. */
function placeOf(relative: string): { level: MemoryLevel; subject: string | null } {
  const parts = relative.split('/')
  if (parts.length === 1) {
    return parts[0] === 'global.md'
      ? { level: 'global', subject: null }
      : { level: 'matiere', subject: parts[0].replace(/\.md$/, '') }
  }
  return { level: 'cours', subject: parts[0] }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function newId(): string {
  return `m-${randomBytes(4).toString('hex')}`
}

// ---------------------------------------------------------------------------
// Lecture et ecriture d'un fichier
// ---------------------------------------------------------------------------

interface ParsedEntry {
  id: string
  date: string
  title: string
  body: string
  /** Cibles `fichier#titre`, telles qu'ecrites sur la ligne « Voir : ». */
  links: string[]
}

interface ParsedFile {
  /** Frontmatter et titre du fichier, tout ce qui precede la premiere entree. */
  preamble: string
  entries: ParsedEntry[]
}

function parseMemoryFile(content: string): ParsedFile {
  const preambleLines: string[] = []
  const entries: ParsedEntry[] = []
  let current: { id: string; date: string; lines: string[] } | null = null

  for (const line of content.split('\n')) {
    const match = MARKER.exec(line)
    if (match) {
      if (current) entries.push(finishEntry(current))
      current = { id: match[1], date: match[2], lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else preambleLines.push(line)
  }
  if (current) entries.push(finishEntry(current))

  return { preamble: preambleLines.join('\n').trimEnd(), entries }
}

function finishEntry(raw: { id: string; date: string; lines: string[] }): ParsedEntry {
  let title = ''
  const body: string[] = []

  for (const line of raw.lines) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (!title && heading) {
      title = heading[1].trim()
      continue
    }
    body.push(line)
  }

  const links = takeLinkLine(body)

  // Une entree remaniee a la main peut avoir perdu son titre : la premiere
  // ligne pleine en tient lieu, plutot que de perdre l'entree.
  if (!title) {
    const first = body.findIndex((line) => line.trim())
    if (first !== -1) title = body.splice(first, 1)[0].trim()
  }

  return {
    id: raw.id,
    date: raw.date,
    title: title || 'Sans titre',
    body: body.join('\n').trim(),
    links
  }
}

/**
 * Retire du corps sa derniere ligne si c'est celle des liens, et rend les
 * cibles qu'elle portait. Le corps rendu aux outils — et vectorise — n'en
 * garde donc aucune trace.
 */
function takeLinkLine(body: string[]): string[] {
  for (let index = body.length - 1; index >= 0; index--) {
    if (!body[index].trim()) continue

    const match = LINK_LINE.exec(body[index].trim())
    if (!match) return []

    const links = [...match[1].matchAll(WIKILINK)]
      .map((hit) => hit[1].trim())
      .filter(Boolean)
      .slice(0, MAX_LINKS)

    // « Voir : le chapitre 3 » est une phrase, pas une ligne de liens : sans
    // wikilink, la ligne reste dans le corps plutot que de disparaitre.
    if (links.length === 0) return []

    body.splice(index, 1)
    return links
  }
  return []
}

function renderEntry(entry: ParsedEntry): string {
  const links = entry.links.length
    ? `Voir : ${entry.links.map((target) => `[[${target}]]`).join(' · ')}`
    : ''

  return [`<!-- entree:${entry.id} ${entry.date} -->\n## ${entry.title}`, entry.body.trim(), links]
    .filter(Boolean)
    .join('\n\n')
}

function renderFile(preamble: string, entries: ParsedEntry[]): string {
  const blocks = entries.map(renderEntry)
  return `${[preamble.trimEnd(), ...blocks].filter(Boolean).join('\n\n')}\n`
}

/** En-tete d'un fichier neuf : le frontmatter, un titre, rien de plus. */
function newPreamble(target: MemoryTarget): string {
  const label =
    target.level === 'global'
      ? 'Mémoire globale'
      : target.level === 'matiere'
        ? `Mémoire — ${target.subject}`
        : `Mémoire — ${path.posix
            .basename(target.courseId)
            .replace(/\.[^./]+$/, '')
            .replace(/[-_]+/g, ' ')}`

  return `---\ntype: memoire\nniveau: ${target.level}\n---\n\n# ${label}`
}

/**
 * L'ecriture passe par un fichier temporaire puis un rename atomique, comme les
 * notes : une fermeture en pleine ecriture ne peut pas laisser une memoire
 * tronquee.
 */
async function writeMemoryFile(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const temporary = `${abs}.tmp`
  await fs.writeFile(temporary, content, 'utf8')
  await fs.rename(temporary, abs)
}

// ---------------------------------------------------------------------------
// Les entrees, tous fichiers confondus
// ---------------------------------------------------------------------------

/**
 * Les mutations se suivent une par une. Deux conversations peuvent ecrire en
 * meme temps dans le meme fichier — global.md, typiquement — et deux
 * lectures-reecritures entrelacees se mangeraient l'une l'autre.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialised<T>(task: () => Promise<T>): Promise<T> {
  const turn = queue.then(task)
  queue = turn.catch(() => undefined)
  return turn
}

/** Les fichiers de memoire presents, chemins relatifs sous Memoire/. */
async function listMemoryFiles(): Promise<string[]> {
  const root = vaultPaths().memory
  try {
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true })
    return entries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.')
      )
      .map((entry) =>
        path
          .relative(root, path.join(entry.parentPath ?? root, entry.name))
          .split(path.sep)
          .join('/')
      )
      .sort((a, b) => a.localeCompare(b, 'fr'))
  } catch {
    // Memoire/ a pu partir a la corbeille depuis le Finder : aucune memoire
    // n'est une reponse juste, pas une erreur.
    return []
  }
}

function toMemoryEntry(relative: string, parsed: ParsedEntry): MemoryEntry {
  const place = placeOf(relative)
  return { ...parsed, level: place.level, subject: place.subject, file: relative }
}

/** Toutes les entrees, dans l'ordre des fichiers puis du fichier. */
export async function listAllEntries(): Promise<MemoryEntry[]> {
  await migrateLegacyGlobal()

  const all: MemoryEntry[] = []
  for (const relative of await listMemoryFiles()) {
    let content: string
    try {
      content = await fs.readFile(absolute(relative), 'utf8')
    } catch {
      continue
    }
    for (const entry of parseMemoryFile(content).entries) {
      all.push(toMemoryEntry(relative, entry))
    }
  }
  return all
}

/**
 * Ajoute une entree, en creant le fichier si c'est la premiere. `keep` rejoue
 * une entree existante — c'est le chemin de l'annulation d'un oubli, qui doit
 * restaurer l'identifiant et la date d'origine.
 */
export function addEntry(
  target: MemoryTarget,
  title: string,
  body: string,
  keep?: { id: string; date: string; links?: string[] }
): Promise<MemoryEntry> {
  return serialised(async () => {
    const relative = memoryFileFor(target)
    const abs = absolute(relative)

    let parsed: ParsedFile
    try {
      parsed = parseMemoryFile(await fs.readFile(abs, 'utf8'))
    } catch {
      parsed = { preamble: newPreamble(target), entries: [] }
    }

    const entry: ParsedEntry = {
      id: keep?.id ?? newId(),
      date: keep?.date ?? today(),
      title: title.trim(),
      body: body.trim(),
      links: keep?.links ?? []
    }

    parsed.entries.push(entry)
    await writeMemoryFile(abs, renderFile(parsed.preamble, parsed.entries))
    return toMemoryEntry(relative, entry)
  })
}

/** L'entree qui porte cet identifiant, ou null. Parcourt tous les fichiers. */
async function locate(
  entryId: string
): Promise<{ relative: string; abs: string; parsed: ParsedFile; index: number } | null> {
  for (const relative of await listMemoryFiles()) {
    const abs = absolute(relative)
    let content: string
    try {
      content = await fs.readFile(abs, 'utf8')
    } catch {
      continue
    }
    const parsed = parseMemoryFile(content)
    const index = parsed.entries.findIndex((entry) => entry.id === entryId)
    if (index !== -1) return { relative, abs, parsed, index }
  }
  return null
}

/**
 * Corrige une entree designee par son identifiant. La date passe a aujourd'hui
 * — sauf si `date` est fournie, ce qui sert a l'annulation d'une correction,
 * qui doit rendre l'entree exactement telle qu'elle etait.
 */
export function updateEntry(
  entryId: string,
  patch: { title?: string; body?: string; date?: string }
): Promise<{ before: MemoryEntry; after: MemoryEntry } | null> {
  return serialised(async () => {
    const found = await locate(entryId)
    if (!found) return null

    const previous = found.parsed.entries[found.index]
    const next: ParsedEntry = {
      id: previous.id,
      date: patch.date ?? today(),
      title: (patch.title ?? previous.title).trim(),
      body: (patch.body ?? previous.body).trim(),
      links: previous.links
    }

    found.parsed.entries[found.index] = next
    await writeMemoryFile(found.abs, renderFile(found.parsed.preamble, found.parsed.entries))

    // Un titre qui change deplace la cible de tous les liens qui la visaient :
    // c'est le code qui les suit, jamais l'assistant. L'annulation repasse par
    // ici avec l'ancien titre, et les remet donc en place d'elle-meme.
    if (next.title !== previous.title) {
      await retarget(
        linkTarget(found.relative, previous.title),
        linkTarget(found.relative, next.title)
      )
    }

    return {
      before: toMemoryEntry(found.relative, previous),
      after: toMemoryEntry(found.relative, next)
    }
  })
}

/** Une entree supprimee, et les liens que sa disparition a fait tomber. */
export interface RemovedEntry {
  entry: MemoryEntry
  /** Les entrees qui la designaient : identifiant de la source, cible ecrite. */
  detached: Array<{ id: string; target: string }>
}

/**
 * Supprime une entree, et avec elle les liens qui la visaient — un lien vers
 * rien n'apprend rien. Le fichier reste, meme vide de toute entree : son
 * en-tete dit ce qu'il est, et la prochaine ecriture le retrouvera.
 */
export function removeEntry(entryId: string): Promise<RemovedEntry | null> {
  return serialised(async () => {
    const found = await locate(entryId)
    if (!found) return null

    const [removed] = found.parsed.entries.splice(found.index, 1)
    await writeMemoryFile(found.abs, renderFile(found.parsed.preamble, found.parsed.entries))

    const gone = normaliseTarget(linkTarget(found.relative, removed.title))
    const detached = await rewriteAllLinks((target) =>
      normaliseTarget(target) === gone ? null : target
    )

    return { entry: toMemoryEntry(found.relative, removed), detached }
  })
}

/**
 * Rejoue une entree supprimee, la ou elle vivait — l'annulation d'un oubli.
 * Ses liens sortants reviennent avec elle, et les liens entrants tombes a sa
 * suppression sont recolles a leur source.
 */
export async function restoreEntry(removed: RemovedEntry): Promise<void> {
  const entry = removed.entry
  const target: MemoryTarget =
    entry.level === 'global'
      ? { level: 'global' }
      : entry.level === 'matiere'
        ? { level: 'matiere', subject: entry.subject ?? '' }
        : // Le fichier d'un cours se retrouve par son chemin : l'extension du
          // document n'importe pas, memoryFileForCourse ne fait que l'oter.
          { level: 'cours', courseId: entry.file.replace(/\.md$/, '.pdf') }

  await addEntry(target, entry.title, entry.body, {
    id: entry.id,
    date: entry.date,
    links: entry.links
  })

  for (const link of removed.detached) {
    await changeEntryLink(link.id, link.target, false)
  }
}

// ---------------------------------------------------------------------------
// Les liens entre entrees
// ---------------------------------------------------------------------------

/** Ce que la pose ou le retrait d'un lien a donne. */
export type LinkChange =
  | { ok: true; entry: MemoryEntry; previous: string[] }
  | { ok: false; reason: 'introuvable' | 'plafond' | 'deja' | 'absent' }

/**
 * Pose ou retire un lien sortant. C'est le seul chemin par lequel la syntaxe
 * `[[…]]` s'ecrit : l'assistant designe une entree, le code compose la cible.
 * La date ne bouge pas — lier n'est pas corriger.
 */
export function changeEntryLink(
  sourceId: string,
  target: string,
  remove: boolean
): Promise<LinkChange> {
  return serialised(async () => {
    const found = await locate(sourceId)
    if (!found) return { ok: false, reason: 'introuvable' } as LinkChange

    const entry = found.parsed.entries[found.index]
    const previous = entry.links
    const already = previous.some((link) => normaliseTarget(link) === normaliseTarget(target))

    if (remove && !already) return { ok: false, reason: 'absent' } as LinkChange
    if (!remove && already) return { ok: false, reason: 'deja' } as LinkChange
    if (!remove && previous.length >= MAX_LINKS) {
      return { ok: false, reason: 'plafond' } as LinkChange
    }

    entry.links = remove
      ? previous.filter((link) => normaliseTarget(link) !== normaliseTarget(target))
      : [...previous, target]

    await writeMemoryFile(found.abs, renderFile(found.parsed.preamble, found.parsed.entries))
    return { ok: true, entry: toMemoryEntry(found.relative, entry), previous } as LinkChange
  })
}

/** Remet les liens d'une entree tels qu'ils etaient — l'annulation d'une liaison. */
export function setEntryLinks(entryId: string, links: string[]): Promise<void> {
  return serialised(async () => {
    const found = await locate(entryId)
    if (!found) return

    found.parsed.entries[found.index].links = links.slice(0, MAX_LINKS)
    await writeMemoryFile(found.abs, renderFile(found.parsed.preamble, found.parsed.entries))
  })
}

/**
 * Passe tous les liens de tous les fichiers au tamis de `map` : la nouvelle
 * cible, ou null pour retirer le lien. Rend les liens tombes, de quoi les
 * recoller si le geste s'annule.
 *
 * Interne et non serialise : les appelants tiennent deja le tour de file.
 */
async function rewriteAllLinks(
  map: (target: string) => string | null
): Promise<Array<{ id: string; target: string }>> {
  const dropped: Array<{ id: string; target: string }> = []

  for (const relative of await listMemoryFiles()) {
    const abs = absolute(relative)
    let content: string
    try {
      content = await fs.readFile(abs, 'utf8')
    } catch {
      continue
    }

    const parsed = parseMemoryFile(content)
    let touched = false

    for (const entry of parsed.entries) {
      if (entry.links.length === 0) continue

      const next: string[] = []
      for (const target of entry.links) {
        const mapped = map(target)
        if (mapped === null) {
          dropped.push({ id: entry.id, target })
          touched = true
          continue
        }
        if (mapped !== target) touched = true
        next.push(mapped)
      }
      entry.links = next
    }

    if (touched) await writeMemoryFile(abs, renderFile(parsed.preamble, parsed.entries))
  }

  return dropped
}

/** Fait pointer ailleurs tous les liens qui visaient cette cible. */
async function retarget(from: string, to: string): Promise<void> {
  const wanted = normaliseTarget(from)
  await rewriteAllLinks((target) => (normaliseTarget(target) === wanted ? to : target))
}

/**
 * Fait suivre aux liens un fichier qui change de nom ou de dossier. `from` et
 * `to` sont des chemins relatifs sous Memoire/ ; un dossier se reconnait a
 * l'absence d'extension, et emmene alors tous les fichiers qu'il contient.
 */
function rewriteMemoryLinkPaths(from: string, to: string): Promise<unknown> {
  const isFolder = !from.endsWith('.md')
  const before = normaliseTarget(from.replace(/\.md$/, ''))
  const after = to.replace(/\.md$/, '')

  return serialised(() =>
    rewriteAllLinks((target) => {
      const cut = target.indexOf('#')
      if (cut === -1) return target

      const file = target.slice(0, cut)
      const heading = target.slice(cut)

      if (normaliseTarget(file) === before) return `${after}${heading}`

      // Un dossier de matiere renomme emmene les cours qu'il contient : seul
      // son premier segment change, le reste du chemin est intact.
      const segments = file.split('/')
      if (isFolder && segments.length > 1 && normaliseTarget(segments[0]) === before) {
        return `${after}/${segments.slice(1).join('/')}${heading}`
      }
      return target
    })
  )
}

// ---------------------------------------------------------------------------
// Suivre les cours et les matieres
// ---------------------------------------------------------------------------

/** La memoire d'un cours suit son document renomme ou deplace. */
export async function moveCourseMemory(courseId: string, nextId: string): Promise<void> {
  const relative = memoryFileForCourse(courseId)
  const nextRelative = memoryFileForCourse(nextId)

  const from = absolute(relative)
  const to = absolute(nextRelative)
  try {
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(from, to)
  } catch {
    // Ce cours n'avait pas de memoire : rien a suivre.
  }

  // Les liens portent le chemin du fichier : ils le suivent, sinon ils
  // pointeraient vers l'ancien nom, c'est-a-dire vers rien.
  await rewriteMemoryLinkPaths(relative, nextRelative)
}

/** La memoire d'un cours supprime part a la corbeille avec lui. */
export async function deleteCourseMemory(courseId: string): Promise<void> {
  const abs = absolute(memoryFileForCourse(courseId))
  if (await exists(abs)) await shell.trashItem(abs)
}

/** Le fichier de matiere et son dossier de cours suivent le nouveau nom. */
export async function moveSubjectMemory(name: string, nextName: string): Promise<void> {
  for (const [from, to] of [
    [absolute(`${name}.md`), absolute(`${nextName}.md`)],
    [absolute(name), absolute(nextName)]
  ]) {
    try {
      await fs.rename(from, to)
    } catch {
      // Pas de memoire a ce niveau : rien a suivre.
    }
  }

  // Le fichier de la matiere, puis son dossier de cours : les liens suivent
  // les deux chemins.
  await rewriteMemoryLinkPaths(`${name}.md`, `${nextName}.md`)
  await rewriteMemoryLinkPaths(name, nextName)
}

/** La memoire d'une matiere supprimee part a la corbeille avec elle. */
export async function deleteSubjectMemory(name: string): Promise<void> {
  const file = absolute(`${name}.md`)
  if (await exists(file)) await shell.trashItem(file)

  const folder = absolute(name)
  if (await exists(folder)) await shell.trashItem(folder)
}

// ---------------------------------------------------------------------------
// Migration de l'ancien global.md
// ---------------------------------------------------------------------------

let migrated = false

/**
 * L'ancien global.md etait un document a sections, sans entrees. Chaque
 * section remplie devient une entree datee d'aujourd'hui ; les sections
 * restees a l'etat de gabarit — un corps vide ou en italique « _A completer._ »
 * — disparaissent. Ne touche a rien si le fichier porte deja des entrees.
 */
async function migrateLegacyGlobal(): Promise<void> {
  if (migrated) return
  migrated = true

  const abs = absolute('global.md')
  let content: string
  try {
    content = await fs.readFile(abs, 'utf8')
  } catch {
    return
  }
  if (/<!--\s*entree:/.test(content)) return

  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '')
  const entries: ParsedEntry[] = []

  // Les sections « ## Titre » et leur contenu, sans ce qui les precede — le
  // titre du fichier et son paragraphe d'explication, qui etaient du gabarit.
  const sections = body.split(/^##\s+/m).slice(1)
  for (const section of sections) {
    const lines = section.split('\n')
    const title = lines[0].trim()
    // Les gabarits « _A completer._ » sont des italiques, parfois sur
    // plusieurs lignes : c'est le bloc entier qui part, pas la seule ligne
    // qui l'ouvre.
    const text = lines
      .slice(1)
      .join('\n')
      .replace(/_[\s\S]*?_/g, '')
      .trim()

    if (title && text) {
      entries.push({ id: newId(), date: today(), title, body: text, links: [] })
    }
  }

  await writeMemoryFile(abs, renderFile(newPreamble({ level: 'global' }), entries))
}
