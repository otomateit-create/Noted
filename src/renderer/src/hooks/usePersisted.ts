import { useCallback, useState } from 'react'

/**
 * Un choix qui survit au redemarrage. Le reglage est un confort d'usage, pas une
 * donnee de travail : il vit dans le navigateur, pas dans le vault.
 */
export function usePersisted(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => window.localStorage.getItem(key) ?? fallback)

  const update = useCallback(
    (next: string) => {
      setValue(next)
      if (next) window.localStorage.setItem(key, next)
      else window.localStorage.removeItem(key)
    },
    [key]
  )

  return [value, update]
}
