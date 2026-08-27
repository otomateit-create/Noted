import { useEffect, useRef, useState } from 'react'
import { readableError } from '../lib/errors'

interface SubjectCreatorProps {
  /** Appele avec le nom retenu une fois le dossier cree. */
  onCreated: (name: string) => void | Promise<void>
  /** Classe du bouton d'ouverture, pour qu'il s'accorde a son voisinage. */
  triggerClassName: string
}

/**
 * Creation d'une matiere, saisie sur place.
 *
 * Electron desactive `window.prompt`, et une fenetre de dialogue serait de
 * toute facon disproportionnee pour saisir un mot. Le bouton se transforme en
 * champ de saisie : Entree valide, Echap annule.
 */
export default function SubjectCreator({
  onCreated,
  triggerClassName
}: SubjectCreatorProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const close = (): void => {
    setOpen(false)
    setName('')
    setError(null)
  }

  const submit = async (): Promise<void> => {
    try {
      const created = await window.noted.vault.createSubject(name)
      close()
      await onCreated(created)
    } catch (cause) {
      setError(readableError(cause, 'Impossible de créer cette matière.'))
    }
  }

  if (!open) {
    return (
      <button
        className={triggerClassName}
        onClick={() => setOpen(true)}
        title="Créer une matière"
      >
        + Nouvelle matière
      </button>
    )
  }

  return (
    <div className="subject-creator">
      <input
        ref={inputRef}
        className="subject-creator-input"
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          // La palette de cours ecoute aussi Entree et Echap : sans cela, Echap
          // fermerait toute la fenetre au lieu du seul champ.
          event.stopPropagation()
          if (event.key === 'Enter') void submit()
          if (event.key === 'Escape') close()
        }}
        onBlur={() => {
          if (!name.trim()) close()
        }}
        placeholder="Nom de la matière"
        aria-label="Nom de la nouvelle matière"
        aria-invalid={Boolean(error)}
      />
      {error && <span className="subject-creator-error">{error}</span>}
    </div>
  )
}
