import { useCallback, useEffect, useState } from 'react'
import { incomingEntries, outgoingEntries } from '@shared/memory-links'
import type { MemoryEntry } from '@shared/types'
import '../styles/hub.css'

/**
 * L'ecran de consultation de la memoire : ce que l'IA a retenu, niveau par
 * niveau, avec la suppression d'une entree et les liens qu'elle porte dans les
 * deux sens. Volontairement minimal — l'edition fine se fait dans Obsidian, les
 * fichiers sont du Markdown ordinaire sous Memoire/.
 */
interface MemoryPageProps {
  /**
   * Les entrees depliees vivent hors de chaque ligne : suivre un lien, c'est
   * ouvrir une autre ligne que celle sur laquelle on a clique. Et hors de la
   * page : on les retrouve depliees en revenant d'une autre section.
   */
  open: ReadonlySet<string>
  onOpen: (update: (previous: ReadonlySet<string>) => ReadonlySet<string>) => void
}

export default function MemoryPage({ open, onOpen: setOpen }: MemoryPageProps): React.JSX.Element {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null)

  const refresh = useCallback(() => {
    window.noted.memoire
      .list()
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [])

  useEffect(refresh, [refresh])

  const toggle = useCallback((entryId: string) => {
    setOpen((previous) => {
      const next = new Set(previous)
      if (!next.delete(entryId)) next.add(entryId)
      return next
    })
  }, [])

  /** Suivre un lien : l'entree visee s'ouvre, et l'ecran va la chercher. */
  const reveal = useCallback((entryId: string) => {
    setOpen((previous) => new Set(previous).add(entryId))
    window.requestAnimationFrame(() => {
      document.getElementById(`memoire-${entryId}`)?.scrollIntoView({ block: 'center' })
    })
  }, [])

  const forget = useCallback(
    async (entry: MemoryEntry) => {
      if (!window.confirm(`Supprimer « ${entry.title} » de la mémoire ?`)) return
      await window.noted.memoire.forget(entry.id)
      refresh()
    },
    [refresh]
  )

  if (entries === null) {
    return <div className="hub-page" />
  }

  const globals = entries.filter((entry) => entry.level === 'global')

  // Les entrees de matiere et de cours, groupees par matiere — l'ordre est
  // celui des fichiers, deja trie.
  const subjects = new Map<string, MemoryEntry[]>()
  for (const entry of entries) {
    if (entry.level === 'global' || !entry.subject) continue
    const list = subjects.get(entry.subject) ?? []
    list.push(entry)
    subjects.set(entry.subject, list)
  }

  const group = (name: string, list: MemoryEntry[]): React.JSX.Element => (
    <MemoryGroup
      key={name}
      name={name}
      entries={list}
      all={entries}
      open={open}
      onToggle={toggle}
      onReveal={reveal}
      onForget={forget}
    />
  )

  return (
    <div className="hub-page">
      <div className="hub-page-inner">
        <h1 className="hub-page-title">Mémoire</h1>
        <p className="hub-page-lede">
          Ce que l'assistant retient de toi, d'une session à l'autre. Il écrit ici de lui-même —
          chaque écriture laisse une trace annulable sous sa réponse — et retrouve ces entrées par
          recherche. Les fichiers vivent dans Memoire/, éditables dans Obsidian.
        </p>

        {entries.length === 0 ? (
          <div className="hub-empty">
            Rien encore. La mémoire se remplit au fil des conversations : difficultés qui
            reviennent, progression, échéances, préférences.
          </div>
        ) : (
          <>
            {group('Global', globals)}
            {[...subjects.entries()].map(([subject, list]) => group(subject, list))}
          </>
        )}
      </div>
    </div>
  )
}

interface RowHandlers {
  all: MemoryEntry[]
  open: ReadonlySet<string>
  onToggle: (entryId: string) => void
  onReveal: (entryId: string) => void
  onForget: (entry: MemoryEntry) => void
}

function MemoryGroup({
  name,
  entries,
  ...handlers
}: { name: string; entries: MemoryEntry[] } & RowHandlers): React.JSX.Element | null {
  if (entries.length === 0) return null

  return (
    <section className="hub-group">
      <h2 className="hub-group-name">{name}</h2>
      <ul className="hub-rows">
        {entries.map((entry) => (
          <MemoryRow key={entry.id} entry={entry} {...handlers} />
        ))}
      </ul>
    </section>
  )
}

/** D'ou vient l'entree, quand le groupe ne suffit pas : le cours concerne. */
function courseLabel(entry: MemoryEntry): string | null {
  if (entry.level !== 'cours') return null
  const base = entry.file.split('/').pop() ?? entry.file
  return base.replace(/\.md$/, '').replace(/[-_]+/g, ' ')
}

function MemoryRow({
  entry,
  all,
  open,
  onToggle,
  onReveal,
  onForget
}: { entry: MemoryEntry } & RowHandlers): React.JSX.Element {
  const course = courseLabel(entry)
  const expanded = open.has(entry.id)

  return (
    <li id={`memoire-${entry.id}`}>
      <button
        className="hub-row memory-row"
        onClick={() => onToggle(entry.id)}
        aria-expanded={expanded}
      >
        <span className="hub-row-title">{entry.title}</span>
        {course && <span className="hub-row-meta">{course}</span>}
        <span className="hub-row-meta">{entry.date}</span>
      </button>

      {expanded && (
        <div className="memory-detail">
          {entry.body ? (
            <pre className="memory-detail-body">{entry.body}</pre>
          ) : (
            <p className="memory-detail-empty">Cette entrée n'a pas de corps.</p>
          )}

          <MemoryLinks label="Liée à" targets={outgoingEntries(entry, all)} onReveal={onReveal} />
          <MemoryLinks
            label="Référencée par"
            targets={incomingEntries(entry, all)}
            onReveal={onReveal}
          />

          <div className="memory-detail-actions">
            <span className="memory-detail-id">{entry.id}</span>
            <button className="memory-forget" onClick={() => onForget(entry)}>
              Supprimer
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/**
 * Les liens d'une entree, dans un sens. Un clic deplie l'entree visee, qui est
 * forcement sur la page — l'ecran les liste toutes.
 */
function MemoryLinks({
  label,
  targets,
  onReveal
}: {
  label: string
  targets: MemoryEntry[]
  onReveal: (entryId: string) => void
}): React.JSX.Element | null {
  if (targets.length === 0) return null

  return (
    <div className="memory-links">
      <span className="memory-links-label">{label}</span>
      {targets.map((target) => (
        <button key={target.id} className="memory-link" onClick={() => onReveal(target.id)}>
          {target.title}
        </button>
      ))}
    </div>
  )
}
