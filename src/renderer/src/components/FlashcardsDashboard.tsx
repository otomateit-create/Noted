import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { ChevronRight, Flame } from 'lucide-react'
import type { FlashcardsOverview, FlashcardsStats, SetSummary } from '@shared/flashcards'
import { detectSubjectTheme } from '../lib/subject-theme'
import { subjectTint } from '../lib/subject-tint'
import { countLabel, dueDayLabel } from './FlashcardsReview'
import '../styles/hub.css'
import '../styles/flashcards.css'

/**
 * Le tableau de bord des flashcards : la courbe d'activite des 30 derniers
 * jours, la carte sombre de l'acquisition (la memoire long terme), la serie
 * de jours, puis quatre tuiles chiffrees avec leur tendance — et la liste des
 * matieres, qui reste la navigation.
 */

interface FlashcardsDashboardProps {
  overview: FlashcardsOverview
  onOpenSubject: (name: string) => void
}

const cascade: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } }
}

const block: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 0.61, 0.36, 1] } }
}

export default function FlashcardsDashboard({
  overview,
  onOpenSubject
}: FlashcardsDashboardProps): React.JSX.Element {
  const reduce = useReducedMotion()
  const activity = generationLine(overview)
  const hasSets = overview.subjects.length > 0

  return (
    <div className="hub-page">
      <motion.div
        className="hub-page-inner"
        variants={cascade}
        initial={reduce ? false : 'hidden'}
        animate="visible"
      >
        <motion.h1 className="hub-page-title" variants={block}>
          Flashcards
        </motion.h1>

        {activity && (
          <motion.p className="fc-genline" variants={block} role="status">
            <span className="fc-genline-dot" aria-hidden="true" />
            {activity}
          </motion.p>
        )}

        {hasSets ? (
          <>
            <motion.div className="fcd-grid" variants={block}>
              <ActivityCard stats={overview.stats} />
              <div className="fcd-side">
                <GoalCard stats={overview.stats} />
                <StreakCard stats={overview.stats} />
              </div>
            </motion.div>

            <KpiRow stats={overview.stats} />

            <motion.section className="hub-group" variants={block}>
              <h2 className="fc-heading">Matières</h2>
              <div className="fc-subjects">
                {overview.subjects.map(({ subject, general, sets }) => (
                  <SubjectCard
                    key={subject}
                    name={subject}
                    general={general}
                    sets={sets}
                    onOpen={() => onOpenSubject(subject)}
                  />
                ))}
              </div>
            </motion.section>
          </>
        ) : (
          <motion.div className="fc-empty" variants={block}>
            <p className="fc-empty-title">Aucune carte pour l'instant</p>
            <p className="fc-empty-text">
              Surligne tes cours : chaque passage jaune, vert ou bleu devient une carte,
              fabriquée toute seule en tâche de fond.
            </p>
            <div className="fc-empty-swatches">
              <span className="fc-swatch">
                <span className="fc-swatch-dot" style={{ background: 'var(--hl-retenir)' }} />
                À retenir
              </span>
              <span className="fc-swatch">
                <span className="fc-swatch-dot" style={{ background: 'var(--hl-definition)' }} />
                Définition
              </span>
              <span className="fc-swatch">
                <span className="fc-swatch-dot" style={{ background: 'var(--hl-formule)' }} />
                Formule / chiffre
              </span>
            </div>
          </motion.div>
        )}
      </motion.div>
    </div>
  )
}

/** Ce que la ligne d'activite raconte — null quand rien ne tourne. */
function generationLine(overview: FlashcardsOverview): string | null {
  const parts: string[] = []
  if (overview.generating) parts.push('Génération de cartes en cours')
  if (overview.pending > 0) {
    parts.push(`${countLabel(overview.pending, 'cours', 'cours')} en attente de cartes`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

// ---------------------------------------------------------------------------
// La grande carte : la courbe des revisions par jour
// ---------------------------------------------------------------------------

/** La geometrie du trace — figee, le SVG s'etire a la largeur de la carte. */
const CHART_W = 600
const CHART_H = 200
const PAD_TOP = 34
const PAD_BOTTOM = 8
const PAD_X = 5

/**
 * Une courbe lisse par Catmull-Rom converti en Bezier. Les points de controle
 * sont bornes verticalement : un pic voisin d'un jour vide ne doit pas faire
 * plonger le trace sous la ligne de base.
 */
function smoothPath(points: [number, number][]): string {
  const clampY = (y: number): number =>
    Math.min(CHART_H - PAD_BOTTOM, Math.max(PAD_TOP - 16, y))
  let d = `M ${points[0][0]},${points[0][1]}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6)
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6)
    d += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`
  }
  return d
}

function ActivityCard({ stats }: { stats: FlashcardsStats }): React.JSX.Element {
  const values = stats.activity
  const total = values.reduce((sum, value) => sum + value, 0)
  const today = values[values.length - 1] ?? 0

  // La tendance : ces 30 jours contre les 30 d'avant. Muette sans passe.
  const delta =
    stats.activityBefore > 0
      ? Math.round(((total - stats.activityBefore) / stats.activityBefore) * 100)
      : null

  const max = Math.max(...values, 1)
  const points: [number, number][] = values.map((value, i) => [
    PAD_X + (i / (values.length - 1)) * (CHART_W - 2 * PAD_X),
    PAD_TOP + (1 - value / max) * (CHART_H - PAD_TOP - PAD_BOTTOM)
  ])
  const line = smoothPath(points)
  const area = `${line} L ${points[points.length - 1][0]},${CHART_H} L ${points[0][0]},${CHART_H} Z`
  const [lastX, lastY] = points[points.length - 1]

  // Cinq reperes de date sous la courbe, du plus ancien a aujourd'hui.
  const now = new Date()
  const ticks = [0, 1, 2, 3, 4].map((i) => {
    const back = 29 - Math.round((29 * i) / 4)
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    return back === 0
      ? "aujourd'hui"
      : day.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
  })

  return (
    <section className="fcd-chart" aria-label="Révisions par jour">
      <div className="fcd-chart-head">
        <div>
          <h2 className="fcd-chart-title">Révisions</h2>
          <p className="fcd-caps">30 derniers jours</p>
        </div>
        <div className="fcd-chart-figure">
          <div className="fcd-chart-value-row">
            <span className="fcd-chart-value">{total}</span>
            {delta !== null && (
              <span className={delta >= 0 ? 'fcd-badge fcd-badge--up' : 'fcd-badge fcd-badge--down'}>
                {delta >= 0 ? `+${delta} %` : `${delta} %`}
              </span>
            )}
          </div>
          <span className="fcd-chart-sub">
            {total === 0 ? 'aucune réponse sur la période' : 'réponses au total'}
          </span>
        </div>
      </div>

      <svg
        className="fcd-plot"
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        role="img"
        aria-label={`${total} révisions sur 30 jours, dont ${today} aujourd'hui`}
      >
        <defs>
          <linearGradient id="fcd-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--brass)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--brass)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#fcd-area)" />
        <path d={line} fill="none" stroke="var(--brass)" strokeWidth="2" strokeLinecap="round" />
        <circle cx={lastX} cy={lastY} r="3.5" fill="var(--brass)" />
        <circle cx={lastX} cy={lastY} r="7" fill="var(--brass)" opacity="0.18" />
        {today > 0 && (
          <g transform={`translate(${lastX - 14}, ${Math.max(6, lastY - 30)})`}>
            <rect
              x={-16}
              y={0}
              width={32 + String(today).length * 4}
              height={19}
              rx={6}
              fill="var(--brass)"
            />
            <text
              x={String(today).length * 2}
              y={13.5}
              textAnchor="middle"
              fontSize="11"
              fontWeight="600"
              fill="var(--on-brass)"
            >
              {today}
            </text>
          </g>
        )}
      </svg>

      <div className="fcd-ticks" aria-hidden="true">
        {ticks.map((tick, i) => (
          <span key={i}>{tick}</span>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// La colonne de droite : l'objectif de fond, puis la serie
// ---------------------------------------------------------------------------

function GoalCard({ stats }: { stats: FlashcardsStats }): React.JSX.Element {
  const share = stats.total > 0 ? stats.acquired / stats.total : 0
  const percent = Math.round(share * 100)

  return (
    <section className="fcd-goal" aria-label="Acquisition">
      <p className="fcd-caps fcd-caps--dark">Objectif de fond</p>
      <h2 className="fcd-goal-title">Acquisition</h2>
      <div className="fcd-goal-row">
        <span className="fcd-goal-value">{percent} %</span>
        <span className="fcd-goal-detail">
          {stats.acquired} / {stats.total} cartes
        </span>
      </div>
      <div className="fcd-goal-bar" role="presentation">
        <div className="fcd-goal-fill" style={{ width: `${Math.max(percent, 1)}%` }} />
      </div>
    </section>
  )
}

function StreakCard({ stats }: { stats: FlashcardsStats }): React.JSX.Element {
  return (
    <section className="fcd-streak" aria-label="Série de révision">
      <div className="fcd-streak-head">
        <span className="fcd-streak-icon" aria-hidden="true">
          <Flame />
        </span>
        <h2 className="fcd-streak-title">Série</h2>
      </div>
      <p className="fcd-streak-text">
        {stats.streak === 0 ? (
          <>Aucune série en cours — une seule carte révisée suffit à en lancer une.</>
        ) : stats.reviewedToday > 0 ? (
          <>
            <strong>{countLabel(stats.streak, 'jour', 'jours')}</strong> d'affilée avec au
            moins une révision, aujourd'hui compris.
          </>
        ) : (
          <>
            <strong>{countLabel(stats.streak, 'jour', 'jours')}</strong> d'affilée — révise
            aujourd'hui pour prolonger la série.
          </>
        )}
      </p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Les quatre tuiles chiffrees
// ---------------------------------------------------------------------------

type Tone = 'up' | 'down' | 'flat'

function KpiRow({ stats }: { stats: FlashcardsStats }): React.JSX.Element {
  // A revoir : le complement quand tout est fait, la part de nouvelles sinon.
  const dueBadge: { text: string; tone: Tone } | null =
    stats.dueNow === 0
      ? stats.nextDue
        ? { text: `revient ${dueDayLabel(stats.nextDue)}`, tone: 'flat' }
        : { text: 'à jour', tone: 'up' }
      : stats.fresh > 0
        ? { text: `dont ${stats.fresh} nouvelles`, tone: 'flat' }
        : null

  const createdBadge: { text: string; tone: Tone } | null =
    stats.createdThisWeek > 0
      ? { text: `+${stats.createdThisWeek} cette semaine`, tone: 'up' }
      : null

  // La reussite : cette semaine contre la precedente, en points.
  let rateBadge: { text: string; tone: Tone } | null = null
  if (stats.successRate !== null && stats.successRateBefore !== null) {
    const points = Math.round((stats.successRate - stats.successRateBefore) * 100)
    rateBadge =
      points === 0
        ? { text: 'stable', tone: 'flat' }
        : points > 0
          ? { text: `+${points} pts`, tone: 'up' }
          : { text: `${points} pts`, tone: 'down' }
  }

  const weekAverage = Math.round(stats.activity.slice(-7).reduce((sum, v) => sum + v, 0) / 7)
  const todayBadge: { text: string; tone: Tone } | null =
    weekAverage > 0 ? { text: `moy. ${weekAverage} / j`, tone: 'flat' } : null

  return (
    <motion.div className="fcd-kpis" variants={block} aria-label="Statistiques">
      <Kpi label="À revoir maintenant" value={String(stats.dueNow)} badge={dueBadge} />
      <Kpi label="Cartes" value={String(stats.total)} badge={createdBadge} />
      <Kpi
        label="Réussite 7 j"
        value={stats.successRate === null ? '—' : `${Math.round(stats.successRate * 100)} %`}
        badge={rateBadge}
      />
      <Kpi label="Revues aujourd'hui" value={String(stats.reviewedToday)} badge={todayBadge} />
    </motion.div>
  )
}

function Kpi({
  label,
  value,
  badge
}: {
  label: string
  value: string
  badge: { text: string; tone: Tone } | null
}): React.JSX.Element {
  return (
    <div className="fcd-kpi">
      <span className="fcd-caps">{label}</span>
      <span className="fcd-kpi-row">
        <span className="fcd-kpi-value">{value}</span>
        {badge && <span className={`fcd-badge fcd-badge--${badge.tone}`}>{badge.text}</span>}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Une matiere du tableau de bord
// ---------------------------------------------------------------------------

function SubjectCard({
  name,
  general,
  sets,
  onOpen
}: {
  name: string
  general: SetSummary | null
  sets: SetSummary[]
  onOpen: () => void
}): React.JSX.Element {
  const theme = detectSubjectTheme(name)
  const tint = subjectTint(name)
  const all = general ? [general, ...sets] : sets
  const cards = all.reduce((sum, set) => sum + set.total, 0)
  const due = all.reduce((sum, set) => sum + set.due, 0)

  return (
    <motion.button
      className="fc-subject"
      variants={block}
      style={{ '--tint-from': tint.from, '--tint-to': tint.to } as React.CSSProperties}
      onClick={onOpen}
    >
      <span className="fc-orb" aria-hidden="true">
        {theme.icon}
      </span>
      <span className="fc-subject-body">
        <span className="fc-subject-name">{name}</span>
        <span className="fc-subject-meta">
          {sets.length > 0
            ? `${countLabel(sets.length, 'cours', 'cours')} · ${countLabel(cards, 'carte', 'cartes')}`
            : countLabel(cards, 'carte', 'cartes')}
        </span>
      </span>
      {due > 0 ? (
        <span className="fc-pill">{due} à revoir</span>
      ) : (
        <span className="fc-calm">à jour</span>
      )}
      <ChevronRight className="fc-chevron" aria-hidden="true" />
    </motion.button>
  )
}
