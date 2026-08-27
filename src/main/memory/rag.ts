/**
 * L'index de recherche de la memoire : un seul index pour tous les fichiers,
 * chaque entree portant son niveau — on ne choisit jamais quels fichiers
 * interroger, on cherche une fois et on filtre.
 *
 * Meme mecanique que pour les cours — BM25 et vecteurs fusionnes par rangs,
 * meme modele deja telecharge — mais un decoupage different : le passage,
 * c'est l'entree. Pas de redecoupage du fichier a l'ecriture : ajouter une
 * onzieme entree ne vectorise que la onzieme, corriger une entree ne
 * revectorise qu'elle, en oublier une ne fait que retirer son vecteur. Le
 * cache sur disque est donc tenu par identifiant d'entree et empreinte de son
 * texte, la ou celui des cours l'est par empreinte du document entier.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Course, MemoryEntry } from '../../shared/types'
import type { RecallCandidate, RecallSources } from '../claude/recall'
import type { Chunk } from '../rag/chunk'
import { EMBEDDING_MODEL, embed } from '../rag/embedder'
import { CourseIndex } from '../rag/search'
import { vaultPaths } from '../vault'
import { listAllEntries, memoryFileForCourse } from './entries'

interface MemoryIndex {
  entries: MemoryEntry[]
  byId: Map<string, MemoryEntry>
  index: CourseIndex
  /** Resolue quand les vecteurs sont attaches — ou qu'ils ne le seront pas. */
  ready: Promise<void>
}

let current: MemoryIndex | null = null
let dirty = true
let building: Promise<MemoryIndex> | null = null

/** A appeler apres toute mutation des fichiers de memoire. */
export function invalidateMemoryIndex(): void {
  dirty = true
}

/**
 * L'index courant, reconstruit s'il est perime. La partie lexicale est prete
 * au retour ; les vecteurs s'attachent en arriere-plan, comme pour un cours —
 * la recherche fonctionne sans eux, en moins fin.
 */
async function memoryIndex(): Promise<MemoryIndex> {
  while (dirty || !current) {
    if (!building) {
      dirty = false
      building = build().finally(() => {
        building = null
      })
    }
    current = await building
  }
  return current
}

/**
 * L'etiquette qui part dans l'emplacement `title:` du modele, comme le fil
 * d'Ariane d'un passage de cours : d'ou vient cette entree, sans polluer son
 * texte.
 */
function contextOf(entry: MemoryEntry): string {
  if (entry.level === 'global') return 'Memoire globale'
  if (entry.level === 'matiere') return `Memoire › ${entry.subject}`

  const course = path.posix
    .basename(entry.file)
    .replace(/\.md$/, '')
    .replace(/[-_]+/g, ' ')
  return `Memoire › ${entry.subject} › ${course}`
}

function toChunk(entry: MemoryEntry): Chunk {
  return {
    id: entry.id,
    anchor: entry.title,
    page: null,
    heading: entry.title,
    // Le titre porte souvent les mots-cles ; il fait partie du texte cherche.
    text: entry.body ? `${entry.title}\n\n${entry.body}` : entry.title,
    context: contextOf(entry)
  }
}

async function build(): Promise<MemoryIndex> {
  const entries = await listAllEntries()
  const chunks = entries.map(toChunk)

  const built: MemoryIndex = {
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    index: new CourseIndex(chunks),
    ready: Promise.resolve()
  }

  // Personne n'est oblige d'attendre cette promesse : la recherche lexicale
  // est deja prete, et les vecteurs s'attacheront quand le calcul — presque
  // toujours une seule entree — aura abouti. Le rappel du premier message,
  // lui, lui accorde un court delai.
  built.ready = vectorise(built, chunks).catch(() => undefined)

  return built
}

// ---------------------------------------------------------------------------
// Vecteurs : un par entree, caches par identifiant et empreinte
// ---------------------------------------------------------------------------

/** A incrementer si la disposition des fichiers change. */
const FORMAT = 1

interface MemoryManifest {
  format: number
  modele: string
  dimensions: number
  /** Une ligne par vecteur du .vec, dans le meme ordre. */
  entrees: Array<{ id: string; empreinte: string }>
}

function cacheBase(): string {
  return path.join(vaultPaths().internal, 'vecteurs', 'memoire')
}

/** L'empreinte d'une entree : ce qui part au modele, rien d'autre. */
function fingerprint(chunk: Chunk): string {
  return createHash('sha256')
    .update(`${EMBEDDING_MODEL} ${chunk.context} ${chunk.text}`)
    .digest('hex')
}

/** Relit le cache : identifiant -> empreinte et vecteur. Vide si rien ne va. */
async function loadCache(): Promise<Map<string, { empreinte: string; vector: number[] }>> {
  const known = new Map<string, { empreinte: string; vector: number[] }>()
  const base = cacheBase()

  try {
    const manifest = JSON.parse(await fs.readFile(`${base}.json`, 'utf8')) as MemoryManifest
    if (manifest.format !== FORMAT) return known
    if (manifest.modele !== EMBEDDING_MODEL) return known

    const raw = await fs.readFile(`${base}.vec`)
    if (raw.byteLength !== manifest.entrees.length * manifest.dimensions * 4) return known

    const floats = new Float32Array(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    )

    manifest.entrees.forEach((line, index) => {
      const start = index * manifest.dimensions
      known.set(line.id, {
        empreinte: line.empreinte,
        vector: Array.from(floats.subarray(start, start + manifest.dimensions))
      })
    })
  } catch {
    // Pas de cache, ou illisible : tout se recalcule, et la memoire est petite.
  }
  return known
}

async function saveCache(
  lines: Array<{ id: string; empreinte: string; vector: number[] }>
): Promise<void> {
  const dimensions = lines[0]?.vector.length ?? 0
  if (dimensions === 0) return

  const floats = new Float32Array(lines.length * dimensions)
  lines.forEach((line, index) => floats.set(line.vector, index * dimensions))

  const manifest: MemoryManifest = {
    format: FORMAT,
    modele: EMBEDDING_MODEL,
    dimensions,
    entrees: lines.map((line) => ({ id: line.id, empreinte: line.empreinte }))
  }

  const base = cacheBase()
  try {
    await fs.mkdir(path.dirname(base), { recursive: true })
    await fs.writeFile(`${base}.vec.tmp`, Buffer.from(floats.buffer))
    await fs.rename(`${base}.vec.tmp`, `${base}.vec`)
    await fs.writeFile(`${base}.json.tmp`, `${JSON.stringify(manifest, null, 2)}\n`)
    await fs.rename(`${base}.json.tmp`, `${base}.json`)
  } catch {
    // Disque plein, dossier en lecture seule : la recherche continue sans
    // cache, et les vecteurs se recalculeront a la prochaine ouverture.
  }
}

/**
 * Attache les vecteurs a l'index : ceux du cache pour les entrees inchangees,
 * un calcul pour les seules entrees nouvelles ou corrigees.
 */
async function vectorise(built: MemoryIndex, chunks: Chunk[]): Promise<void> {
  if (chunks.length === 0) return

  const cache = await loadCache()
  const wanted = chunks.map((chunk) => ({ chunk, empreinte: fingerprint(chunk) }))
  const missing = wanted.filter(
    ({ chunk, empreinte }) => cache.get(chunk.id)?.empreinte !== empreinte
  )

  if (missing.length > 0) {
    const { vectors } = await embed(
      missing.map(({ chunk }) => chunk.text),
      'document',
      missing.map(({ chunk }) => chunk.context)
    )
    // Moteur indisponible : la recherche reste lexicale, et le prochain index
    // retentera. Rien a ecrire — le cache existant reste valable.
    if (!vectors || vectors.length !== missing.length) return

    missing.forEach(({ chunk, empreinte }, index) => {
      cache.set(chunk.id, { empreinte, vector: vectors[index] })
    })
  }

  const lines = wanted.map(({ chunk, empreinte }) => ({
    id: chunk.id,
    empreinte,
    vector: cache.get(chunk.id)!.vector
  }))

  built.index.setVectors(lines.map((line) => line.vector))

  // Ecrit meme sans calcul neuf : c'est ainsi que les vecteurs des entrees
  // supprimees quittent le cache, qui ne garde que ce que l'index contient.
  if (missing.length > 0 || cache.size !== lines.length) {
    await saveCache(lines)
  }
}

// ---------------------------------------------------------------------------
// Recherche et portee
// ---------------------------------------------------------------------------

export interface MemoryScope {
  courseId: string | null
  subject: string | null
  /** Vrai pour ouvrir la recherche aux autres matieres — demande explicite. */
  everywhere: boolean
}

function inScope(entry: MemoryEntry, scope: MemoryScope): boolean {
  if (scope.everywhere) return true
  if (entry.level === 'global') return true
  if (entry.level === 'matiere') return entry.subject === scope.subject
  return scope.courseId !== null && entry.file === memoryFileForCourse(scope.courseId)
}

/** Recherche hybride dans la memoire, filtree par la portee. */
export async function searchMemory(
  query: string,
  limit: number,
  scope: MemoryScope
): Promise<MemoryEntry[]> {
  const built = await memoryIndex()
  if (built.entries.length === 0) return []

  const { vectors } = await embed([query], 'query')

  // Le classement se fait sur tout, le filtre apres : limiter d'abord pourrait
  // evincer une entree a portee au profit d'une entree hors sujet mieux classee.
  const hits = built.index.search(query, built.entries.length, vectors?.[0] ?? null)

  return hits
    .map((hit) => built.byId.get(hit.chunk.id))
    .filter((entry): entry is MemoryEntry => Boolean(entry && inScope(entry, scope)))
    .slice(0, limit)
}

/** Delai accorde aux vecteurs de la memoire, puis au moteur, avant de chercher sans eux. */
const VECTORS_GRACE = 400
const ENGINE_GRACE = 1_500

function after(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms))
}

/**
 * Les sources du rappel joint au premier message d'une conversation : le
 * profil, les entrees du cours ouvert, et les entrees proches de la demande.
 *
 * La proximite de sens demande un vecteur de la demande, donc le moteur. Un
 * moteur deja chaud repond en quelques dizaines de millisecondes ; un moteur
 * a charger met des dizaines de secondes, et quelqu'un attend que son message
 * parte. On lui laisse donc une seconde et demie — le temps de finir de
 * charger s'il a ete lance quand la barre a pris le focus — et au-dela, les
 * mots suffisent : la demande part sans lui. Le calcul entame se termine en
 * arriere-plan et profite a la premiere recherche du modele.
 */
export async function recallSources(course: Course, query: string): Promise<RecallSources> {
  const built = await memoryIndex()
  const scope: MemoryScope = { courseId: course.id, subject: course.subject, everywhere: false }
  const courseFile = memoryFileForCourse(course.id)

  const profile = built.entries.filter((entry) => entry.level === 'global')
  const latest = built.entries.filter(
    (entry) => entry.level === 'cours' && entry.file === courseFile
  )

  let relevant: RecallCandidate[] = []
  if (built.entries.length > 0 && query.trim()) {
    await Promise.race([built.ready, after(VECTORS_GRACE)])
    const embedded = await Promise.race([embed([query], 'query'), after(ENGINE_GRACE)])
    const queryVector = embedded?.vectors?.[0] ?? null

    const lexical = new Set(
      built.index.search(query, built.entries.length, null).map((hit) => hit.chunk.id)
    )
    const similarities =
      queryVector && built.index.hasVectors ? built.index.similarities(queryVector) : null

    relevant = built.index
      .search(query, built.entries.length, queryVector)
      .map((hit) => built.byId.get(hit.chunk.id))
      .filter((entry): entry is MemoryEntry => Boolean(entry && inScope(entry, scope)))
      .map((entry) => ({
        entry,
        lexical: lexical.has(entry.id),
        similarity: similarities?.get(entry.id) ?? null
      }))
  }

  return { profile, latest, relevant }
}

/** Toutes les entrees, pour l'ecran de consultation. */
export async function allMemoryEntries(): Promise<MemoryEntry[]> {
  return (await memoryIndex()).entries
}

/**
 * Y a-t-il quoi que ce soit en memoire a portee de ce cours. Un booleen, pas
 * une carte : le prompt dit seulement s'il vaut la peine d'appeler
 * « se_souvenir », le contenu ne s'obtient que par cet outil. Lit les fichiers
 * sans construire l'index — cet appel est sur le chemin de chaque message.
 */
export async function hasMemoryInScope(course: Course): Promise<boolean> {
  const scope: MemoryScope = { courseId: course.id, subject: course.subject, everywhere: false }
  return (await listAllEntries()).some((entry) => inScope(entry, scope))
}
