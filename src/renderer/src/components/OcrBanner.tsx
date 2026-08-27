/**
 * Le bandeau d'un cours lu par OCR.
 *
 * Il vit deux moments distincts, et c'est ce qui explique sa forme.
 *
 * **Pendant la lecture** : le document d'origine est affiche, on le parcourt
 * normalement, et l'onglet « Texte lu » tourne en annoncant la page ou l'on en
 * est. Rien n'attend : c'est tout l'interet.
 *
 * **Une fois lue** : les deux onglets se valent, et l'asymetrie change de
 * nature. « Texte lu » devient le cours — on y surligne, on y ancre, l'IA le
 * cite. « Original » ne sert plus qu'a verifier un schema ou un chiffre ; on n'y
 * ecrit pas, et c'est ce qui garantit qu'il n'existe jamais qu'un seul jeu
 * d'ancres.
 */

export type OcrView = 'ocr' | 'original'

interface OcrBannerProps {
  view: OcrView
  onChange: (view: OcrView) => void
  /** Nom du document d'origine, affiche en clair. */
  original: string
  /** Renseigne tant que les pages sont en cours de lecture. */
  progress?: { done: number; total: number } | null
  /**
   * Renseigne quand la lecture attend un accord, parce qu'elle detruirait des
   * surlignages faits sur l'original.
   */
  asking?: { count: number; accept: () => void; decline: () => void } | null
}

export default function OcrBanner({
  view,
  onChange,
  original,
  progress,
  asking
}: OcrBannerProps): React.JSX.Element {
  const reading = Boolean(progress)

  // La question occupe la meme barre que les onglets, et pour cause : il n'y a
  // pas encore de texte lu, donc pas encore d'onglets a proposer. Le document
  // reste lisible derriere, et ne rien repondre le laisse tel quel.
  if (asking) {
    return (
      <div className="ocr-banner ocr-banner--asking">
        <span className="ocr-note">
          {asking.count === 1
            ? 'Ce cours porte un surlignage posé sur l’original.'
            : `Ce cours porte ${asking.count} surlignages posés sur l’original.`}{' '}
          Le lire par images remplace le cours par sa version en texte, et ce
          qui est surligné n’y sera pas replacé.
        </span>
        <div className="ocr-choices">
          <button className="ocr-choice" onClick={asking.decline}>
            Laisser tel quel
          </button>
          <button className="ocr-choice ocr-choice--go" onClick={asking.accept}>
            Lire quand même
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ocr-banner">
      <div className="ocr-tabs" role="tablist" aria-label="Version du document">
        <button
          role="tab"
          aria-selected={view === 'ocr'}
          className="ocr-tab"
          data-active={view === 'ocr'}
          // Pendant la lecture, il n'y a encore rien a montrer sous cet onglet :
          // le proposer donnerait un panneau vide.
          disabled={reading}
          onClick={() => onChange('ocr')}
          title={reading ? 'Lecture des pages en cours' : undefined}
        >
          {reading && <span className="ocr-spinner" aria-hidden="true" />}
          Texte lu
        </button>
        <button
          role="tab"
          aria-selected={view === 'original'}
          className="ocr-tab"
          data-active={view === 'original'}
          onClick={() => onChange('original')}
        >
          Original
        </button>
      </div>

      <span className="ocr-note">
        {reading
          ? `Lecture des images — page ${progress?.done ?? 0} sur ${progress?.total ?? 0}`
          : view === 'ocr'
            ? 'Reconstitué par lecture d’images — surlignable et cité par l’assistant'
            : `${original} — consultation seule`}
      </span>
    </div>
  )
}
