import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExtractedPage } from '@shared/types'
import { clearHits, paintHits, searchHtml, searchPages, type FindHit } from '../lib/find'

interface DocumentFinderProps {
  /** Texte extrait, pour un PDF. Null tant que la lecture n'est pas finie. */
  pages: ExtractedPage[] | null
  /** Element du document affiche en HTML, pour un Word ou un Markdown. */
  htmlRoot: HTMLElement | null
  /** Conteneur defilant du panneau, ou l'on fait descendre l'occurrence. */
  body: HTMLElement | null
  /** Amene le document sur une page precise, avec le halo d'arrivee. */
  onGoToPage: (page: number) => void
  onClose: () => void
}

/** Au-dela, la liste ne sert plus a choisir : elle sert a defiler. */
const MAX_RESULTS = 200

/**
 * Recherche dans le cours ouvert, ouverte par ⌘F.
 *
 * Elle repond a la question qu'on se pose vingt fois par seance — « ou est-ce
 * qu'il parle de ca ? » — sans passer par l'assistant, qui coute quelques
 * secondes et quelques tokens pour un mot qu'on cherche des yeux.
 */
export default function DocumentFinder({
  pages,
  htmlRoot,
  body,
  onGoToPage,
  onClose
}: DocumentFinderProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  /**
   * La requete sur laquelle on cherche vraiment, un souffle apres la frappe.
   *
   * Chercher demande de parcourir tout le document ; le faire a chaque touche
   * de « amortissement » revient a le parcourir douze fois pour n'afficher que
   * le douzieme resultat. Le champ, lui, reste immediat.
   */
  const [settled, setSettled] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), 120)
    return () => clearTimeout(timer)
  }, [query])

  const hits = useMemo(() => {
    const needle = settled.trim()
    if (needle.length < 2) return []

    // Deux caracteres au minimum : en dessous, tout document repond des
    // milliers de fois et la liste ne veut plus rien dire.
    const found = htmlRoot ? searchHtml(htmlRoot, needle) : pages ? searchPages(pages, needle) : []
    return found.slice(0, MAX_RESULTS)
  }, [settled, pages, htmlRoot])

  useEffect(() => {
    setCurrent(0)
  }, [settled])

  // Le surlignage ne vaut que pour les documents HTML : un PDF est peint dans
  // un canvas, il n'y a pas de texte a l'ecran sur lequel se poser.
  useEffect(() => {
    paintHits(hits, current)
  }, [hits, current])

  useEffect(() => clearHits, [])

  // Amene l'occurrence courante sous les yeux, dans le document et dans la liste.
  useEffect(() => {
    const hit = hits[current]
    if (!hit) return

    if (hit.range && body) {
      const rect = hit.range.getBoundingClientRect()
      const frame = body.getBoundingClientRect()
      // Au tiers superieur plutot qu'en haut : on lit une phrase avec ce qui la
      // precede, pas collee au bord.
      body.scrollTop += rect.top - frame.top - body.clientHeight / 3
    } else if (hit.page !== null) {
      onGoToPage(hit.page)
    }

    listRef.current
      ?.querySelector<HTMLElement>(`[data-index='${current}']`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [hits, current, body, onGoToPage])

  const step = (delta: number): void => {
    if (hits.length === 0) return
    setCurrent((index) => (index + delta + hits.length) % hits.length)
  }

  // Les seules touches que la recherche traite elle-meme. Tout arreter, comme
  // on le faisait, rendait ⌘S, ⌘J, ⌘K et ⌘/ muets tant qu'on cherchait — alors
  // que le menu les annonce. On ne retient donc que celles-ci.
  const A_NOUS = ['Escape', 'Enter', 'ArrowDown', 'ArrowUp']

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!A_NOUS.includes(event.key)) return

    // La palette ⌘K et les raccourcis de l'application ecoutent aussi ces
    // touches : sans cela, Echap fermerait autre chose que la recherche.
    event.stopPropagation()

    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(1)
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(-1)
    }
  }

  const searchable = Boolean(htmlRoot) || Boolean(pages)

  return (
    <div className="finder" onKeyDown={onKeyDown}>
      <div className="finder-bar">
        <span className="finder-glyph" aria-hidden="true">
          ⌕
        </span>
        <input
          ref={inputRef}
          className="finder-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchable ? 'Chercher dans le cours…' : 'Lecture du cours en cours…'}
          aria-label="Chercher dans le cours"
          disabled={!searchable}
        />

        {/* Le compte suit la requete effectivement cherchee, sinon il
            annoncerait « Aucun resultat » pendant les cent millisecondes ou la
            recherche n'a pas encore eu lieu. */}
        <span className="finder-count">
          {settled.trim().length < 2
            ? ''
            : hits.length === 0
              ? 'Aucun résultat'
              : `${current + 1} / ${hits.length}${hits.length === MAX_RESULTS ? '+' : ''}`}
        </span>

        <button
          className="icon-button"
          onClick={() => step(-1)}
          disabled={hits.length === 0}
          title="Occurrence précédente (⇧⏎)"
        >
          ‹
        </button>
        <button
          className="icon-button"
          onClick={() => step(1)}
          disabled={hits.length === 0}
          title="Occurrence suivante (⏎)"
        >
          ›
        </button>
        <button className="icon-button" onClick={onClose} title="Fermer la recherche (échap)">
          ✕
        </button>
      </div>

      {hits.length > 0 && (
        <div className="finder-results" ref={listRef}>
          {hits.map((hit, index) => (
            <button
              key={index}
              data-index={index}
              className="finder-result"
              data-current={index === current}
              onClick={() => setCurrent(index)}
            >
              <span className="finder-result-anchor">{anchorOf(hit)}</span>
              <span className="finder-result-text">
                {hit.before}
                <mark className="finder-result-mark">{hit.match}</mark>
                {hit.after}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Ou se trouve l'occurrence : une page pour un PDF, un titre sinon. */
function anchorOf(hit: FindHit): string {
  if (hit.page !== null) return `p. ${hit.page}`
  return hit.heading ?? '—'
}
