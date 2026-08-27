import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { PhotoProposal } from '@shared/types'
import '../styles/library.css'

/**
 * L'ordre dans lequel des photos vont devenir un cours, avant de le lancer.
 *
 * Cet ecran existe pour une raison precise : l'ordre est devine, non donne. Il
 * suit les dates de prise de vue quand toutes les photos en portent une, et les
 * noms de fichiers sinon — un lot passe par AirDrop ou par un message perd
 * souvent ses dates, et une capture d'ecran n'en a jamais eu. Une page a
 * l'envers dans un cours de trente pages se corrige mal apres coup ; la voir
 * avant coute un regard.
 *
 * Rien n'a encore ete ecrit a ce stade : renoncer ne laisse aucune trace.
 *
 * Il vit dans son propre fichier parce qu'il a trois appelants : la
 * bibliotheque, la page d'une matiere et le glisser-deposer. Les trois
 * importent, donc les trois peuvent tomber sur des images — et il n'y a qu'une
 * facon correcte de les presenter.
 */
export default function PhotoOrder({
  proposal,
  onCancel,
  onConfirm
}: {
  proposal: PhotoProposal
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Le clavier doit arriver quelque part : sans champ de recherche a l'ecran,
  // c'est le bouton qui valide qui prend le foyer, et echap continue de rendre.
  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  return (
    <>
      <div className="library-search library-search--proposal">
        <div className="library-proposal-head">
          <span className="library-proposal-title">{proposal.title}</span>
          <span className="library-proposal-meta">
            {proposal.photos.length} images dans {proposal.subject}
            {' · '}
            {proposal.byDate
              ? 'ordre des prises de vue'
              : 'ordre des noms de fichiers — une image au moins ne porte pas de date'}
          </span>
        </div>
        <kbd className="library-escape">esc</kbd>
      </div>

      <ol className="library-results library-proposal-list">
        {proposal.photos.map((photo, index) => (
          <li key={photo.path} className="library-proposal-item">
            <span className="library-proposal-rank">{index + 1}</span>
            <span className="library-proposal-name">{photo.name}</span>
          </li>
        ))}
      </ol>

      <footer className="library-footer library-footer--proposal">
        <span className="library-footer-label">
          Les images seront archivées dans Originaux, puis lues une à une.
        </span>
        <div className="library-import">
          <button className="library-import-button" onClick={onCancel}>
            Annuler
          </button>
          <button
            ref={confirmRef}
            className="library-import-button library-import-button--new"
            onClick={onConfirm}
          >
            Créer le cours
          </button>
        </div>
      </footer>
    </>
  )
}

/**
 * Le meme ecran, mais pose par-dessus la page.
 *
 * Dans la bibliotheque la proposition remplace le contenu du panneau — elle est
 * deja dans une fenetre. Ailleurs, il faut la fenetre : c'est tout ce que cette
 * enveloppe ajoute, avec l'echappement et le clic a cote qui referment, comme
 * partout ailleurs dans l'application.
 *
 * Par un portail, et pas seulement par principe : ses appelants sont la page
 * d'une matiere, qui defile, et la zone de depot. Un voile en `position: fixed`
 * pose dans un conteneur qui porte un filtre ou une transformation se recale
 * sur lui au lieu de la fenetre, et se retrouve rogne. Attache au corps du
 * document, il ne depend plus de l'endroit d'ou il a ete appele.
 */
export function PhotoOrderDialog({
  proposal,
  onCancel,
  onConfirm
}: {
  proposal: PhotoProposal
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return createPortal(
    <div className="library-backdrop" onPointerDown={onCancel}>
      <div
        className="library"
        role="dialog"
        aria-label="Ordre des images avant lecture"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      >
        <PhotoOrder proposal={proposal} onCancel={onCancel} onConfirm={onConfirm} />
      </div>
    </div>,
    document.body
  )
}
