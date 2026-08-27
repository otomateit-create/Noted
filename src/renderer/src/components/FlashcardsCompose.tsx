import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { Check, ChevronLeft, Copy } from 'lucide-react'
import { GENERAL_SET_TITLE, generalSetId } from '@shared/flashcards'
import { parseSheet } from '@shared/cardSheet'
import { countLabel, renderCardHtml } from './FlashcardsReview'
import '../styles/flashcards.css'

/**
 * La feuille de collage : creer des cartes a la main, dix d'un coup, en
 * collant un texte au standard Q:/R:. Le guide en tete se copie tel quel dans
 * un chat d'IA ; sous la feuille, le compteur et l'apercu montrent ce que le
 * texte donnera — rien ne part sans avoir ete vu.
 */

interface FlashcardsComposeProps {
  subject: string
  onBack: () => void
  onDone: () => void
}

/** Le guide affiche, et copie tel quel : une consigne prete pour une IA. */
const GUIDE = `Rédige des flashcards au format suivant, et livre TOUT dans un seul bloc de code brut (\`\`\`) — je copierai la source telle quelle, jamais un rendu :

Q: la question — autonome, précise, compréhensible sans le cours sous les yeux
R: la réponse — complète mais compacte
---
Q: la question suivante
R: sa réponse

Règles :
- « Q: » et « R: » en début de ligne ; « --- » seul sur sa ligne sépare deux cartes.
- Plusieurs lignes possibles ; chaque retour à la ligne est conservé à l'affichage.
- Markdown de type GitHub : **gras**, listes, tableaux « | … | ».
- Formules en LaTeX source, compatible KaTeX : $…$ en ligne, $$…$$ seule et centrée.
  Exemple : $$WACC = \\frac{E}{V}\\,k_E + \\frac{D}{V}\\,k_D\\,(1 - T)$$
- Aucun texte en dehors des cartes.`

const PLACEHOLDER = `Q: Qu'est-ce que le TRI ?
R: Le taux d'actualisation qui annule la VAN des flux du projet.
---
Q: …
R: …`

const cascade: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } }
}

const block: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 0.61, 0.36, 1] } }
}

export default function FlashcardsCompose({
  subject,
  onBack,
  onDone
}: FlashcardsComposeProps): React.JSX.Element {
  const reduce = useReducedMotion()

  // La destination : le set general de la matiere, ou le set d'un de ses
  // cours — tous ses cours, meme ceux qui n'ont pas encore de cartes.
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([
    { id: generalSetId(subject), label: GENERAL_SET_TITLE }
  ])
  const [setId, setSetId] = useState(generalSetId(subject))
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    window.noted.vault
      .listSubjects()
      .then((subjects) => {
        if (!alive) return
        const courses = subjects.find((entry) => entry.name === subject)?.courses ?? []
        setTargets([
          { id: generalSetId(subject), label: GENERAL_SET_TITLE },
          ...courses.map((course) => ({ id: course.id, label: course.title }))
        ])
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [subject])

  const parsed = useMemo(() => parseSheet(text), [text])
  const count = parsed.cards.length
  const targetLabel = targets.find((target) => target.id === setId)?.label ?? ''

  const copyGuide = useCallback(() => {
    navigator.clipboard
      .writeText(GUIDE)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => undefined)
  }, [])

  const submit = useCallback(() => {
    if (busy || parsed.cards.length === 0) return
    setBusy(true)
    setError(null)
    window.noted.flashcards
      .import(setId, parsed.cards)
      .then(() => onDone())
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : 'Création impossible.')
        setBusy(false)
      })
  }, [busy, parsed, setId, onDone])

  return (
    <div className="hub-page">
      <motion.div
        className="hub-page-inner"
        variants={cascade}
        initial={reduce ? false : 'hidden'}
        animate="visible"
      >
        <motion.button className="fc-back" variants={block} onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
          {subject}
        </motion.button>

        <motion.header className="fc-compose-head" variants={block}>
          <div className="fc-subhead-id">
            <h1 className="fc-subhead-title">Ajouter des cartes</h1>
            <p className="fc-subhead-meta">
              Colle un texte au format ci-dessous — chaque carte entre dans la répétition
              espacée, due dès maintenant.
            </p>
          </div>
          <label className="fc-target">
            <span className="fc-target-label">Destination</span>
            <select
              className="fc-target-select"
              value={setId}
              onChange={(event) => setSetId(event.target.value)}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </select>
          </label>
        </motion.header>

        <motion.section className="fc-guide" variants={block}>
          <div className="fc-guide-head">
            <h2 className="fc-heading">Le format</h2>
            <button className="fc-secondary fc-guide-copy" onClick={copyGuide}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? 'Copié' : 'Copier pour une IA'}
            </button>
          </div>
          <pre className="fc-guide-pre">{GUIDE}</pre>
        </motion.section>

        <motion.section className="fc-sheet-wrap" variants={block}>
          <textarea
            className="fc-sheet"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.metaKey && event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            autoFocus
          />
          <div className="fc-detect" role="status">
            <span className={count > 0 ? 'fc-detect-count' : 'fc-detect-count fc-detect-count--zero'}>
              {countLabel(count, 'carte détectée', 'cartes détectées')}
            </span>
            {count > 0 && targetLabel && (
              <span className="fc-detect-target">vers « {targetLabel} »</span>
            )}
          </div>
          {parsed.problems.length > 0 && (
            <ul className="fc-problems">
              {parsed.problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          )}
        </motion.section>

        {count > 0 && (
          <motion.section className="fc-preview-wrap" variants={block}>
            <h2 className="fc-heading">Aperçu</h2>
            <div className="fc-preview">
              {parsed.cards.map((card, index) => (
                <article className="fc-preview-card" key={index}>
                  <div
                    className="fc-markdown fc-preview-q"
                    dangerouslySetInnerHTML={{ __html: renderCardHtml(card.recto) }}
                  />
                  <div className="fc-preview-rule" aria-hidden="true" />
                  <div
                    className="fc-markdown"
                    dangerouslySetInnerHTML={{ __html: renderCardHtml(card.verso) }}
                  />
                </article>
              ))}
            </div>
          </motion.section>
        )}

        <motion.div className="fc-compose-actions" variants={block}>
          <button className="fc-primary" disabled={busy || count === 0} onClick={submit}>
            {busy
              ? 'Création…'
              : count > 0
                ? `Créer ${countLabel(count, 'carte', 'cartes')}`
                : 'Créer les cartes'}
          </button>
          <button className="fc-secondary" onClick={onBack}>
            Annuler
          </button>
          {error ? (
            <span className="fc-compose-error">{error}</span>
          ) : (
            <span className="fc-compose-hint">
              <kbd className="fc-kbd">⌘⏎</kbd> pour créer
            </span>
          )}
        </motion.div>
      </motion.div>
    </div>
  )
}
