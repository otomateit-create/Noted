import type { VoixEtat, VoixParole, VoixPhase } from '@shared/types'
import Picker from './Picker'
import '../styles/voice.css'

/** Les vitesses proposees : de « je prends des notes » a « je connais deja ». */
const RATES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5]

function formatRate(value: number): string {
  return value.toFixed(value === Math.round(value) ? 0 : 2).replace(/0$/, '').replace('.', ',')
}

function statusLine(phase: VoixPhase, etat: VoixEtat): string {
  switch (phase) {
    case 'ouverture':
      return 'Ouverture du micro et de la voix…'
    case 'repos':
      return 'Je t’écoute. Parle quand tu veux.'
    case 'ecoute':
      return 'Je t’écoute…'
    case 'reflexion':
      return etat.detail ?? 'Il réfléchit…'
    case 'parole':
      return 'Il parle. Parle pour le couper.'
    default:
      return etat.erreur ?? 'Mode voix fermé.'
  }
}

function languageLabel(langue: string): string {
  if (langue === 'fr-FR') return 'France'
  if (langue === 'fr-CA') return 'Canada'
  return langue
}

function qualityLabel(qualite: number): string {
  if (qualite >= 3) return 'Premium'
  if (qualite === 2) return 'Améliorée'
  return 'Compacte'
}

/**
 * La console vocale : a la place de la barre de saisie, le temps du mode voix.
 * Le fil reste au-dessus, inchange — c'est la meme conversation.
 *
 * Elle dit trois choses, et rien de plus : ou il en est (l'orbe et sa ligne),
 * ce qu'il a compris de la question (la transcription, pendant qu'on parle),
 * et ce qu'il est en train de dire (la phrase lue, ses mots qui s'allument).
 */
export default function VoiceConsole({
  etat,
  parole,
  opening,
  voix,
  vitesse,
  onVoice,
  onRate,
  onLeave
}: {
  etat: VoixEtat
  parole: VoixParole | null
  opening: boolean
  voix: string
  vitesse: number
  onVoice: (id: string) => void
  onRate: (value: number) => void
  onLeave: () => void
}): React.JSX.Element {
  const phase: VoixPhase = opening ? 'ouverture' : etat.phase
  const voices = etat.voix ?? []
  const chosen = etat.voixChoisie || voix
  const chosenName = voices.find((entry) => entry.id === chosen)?.nom ?? 'Voix'

  return (
    <div className="voice" data-phase={phase}>
      <div className="voice-field">
        <div className="voice-orb" aria-hidden="true">
          <span className="voice-orb-bar" />
          <span className="voice-orb-bar" />
          <span className="voice-orb-bar" />
        </div>

        <div className="voice-text" aria-live="polite">
          <p className="voice-status">{statusLine(phase, etat)}</p>

          {phase === 'ecoute' && etat.transcription && (
            <p className="voice-transcript">{etat.transcription}</p>
          )}

          {phase === 'parole' && parole?.phrase && (
            <p className="voice-sentence">
              <span className="voice-said">{parole.phrase.slice(0, parole.jusqua)}</span>
              {parole.phrase.slice(parole.jusqua)}
            </p>
          )}

          {etat.erreur && phase !== 'ferme' && <p className="voice-error">{etat.erreur}</p>}
        </div>
      </div>

      <div className="voice-actions">
        <div className="composer-settings">
          <Picker
            label={chosenName}
            title="Voix de lecture"
            disabled={voices.length === 0}
            options={voices.map((entry) => ({
              value: entry.id,
              label: `${entry.nom} · ${languageLabel(entry.langue)}`,
              description: qualityLabel(entry.qualite)
            }))}
            selected={chosen}
            onSelect={onVoice}
          />

          <Picker
            label={`${formatRate(vitesse)}×`}
            title="Vitesse de lecture"
            options={RATES.map((rate) => ({
              value: String(rate),
              label: `${formatRate(rate)}×`,
              description:
                rate === 1 ? 'La vitesse normale de la voix.' : rate < 1 ? 'Plus lent.' : 'Plus rapide.'
            }))}
            selected={String(vitesse)}
            onSelect={(value) => onRate(Number(value))}
          />
        </div>

        <button
          type="button"
          className="icon-button"
          onClick={onLeave}
          title="Le micro se ferme ; la conversation continue au clavier, avec tout ce qui vient d'être dit"
        >
          Revenir à l'écrit
        </button>
      </div>
    </div>
  )
}
