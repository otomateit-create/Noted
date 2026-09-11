import { useEffect, useRef, useState } from 'react'

export interface PickerOption {
  value: string
  label: string
  description: string
}

/**
 * Petit selecteur de la barre de chat. Il s'ouvre vers le haut : le composeur
 * est colle au bas du panneau, un menu vers le bas sortirait de la fenetre.
 */
export default function Picker({
  label,
  title,
  options,
  selected,
  onSelect,
  disabled
}: {
  label: string
  title: string
  options: PickerOption[]
  selected: string
  onSelect: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="composer-picker" ref={ref}>
      <button
        className="composer-chip"
        data-active={open}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        title={`${title} : ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="composer-chip-label">{label}</span>
        <span className="composer-chip-caret" aria-hidden="true">
          ⌃
        </span>
      </button>

      {open && (
        <div className="composer-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              className="composer-menu-item"
              role="option"
              aria-selected={option.value === selected}
              data-selected={option.value === selected}
              onClick={() => {
                onSelect(option.value)
                setOpen(false)
              }}
            >
              <span className="composer-menu-label">{option.label}</span>
              {option.description && (
                <span className="composer-menu-description">{option.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
