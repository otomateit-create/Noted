import { useCallback, useEffect, useState } from 'react'
import type { Subject } from '@shared/types'
import { readableError } from '../lib/errors'
import '../styles/drop.css'

interface DropZoneProps {
  subjects: Subject[]
  /** Cours importes, dans l'ordre. Le premier sera ouvert. */
  onImported: (courseIds: string[]) => void
}

/**
 * Import par glisser-deposer.
 *
 * Le fichier ne va pas dans une matiere devinee : les matieres apparaissent
 * pendant que le fichier survole la fenetre, et c'est celle sur laquelle on
 * lache qui le recoit. Un fichier lache a cote n'est pas importe — un cours
 * range dans la mauvaise matiere se paie ensuite en recherche.
 */
export default function DropZone({ subjects, onImported }: DropZoneProps): React.JSX.Element | null {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Matiere actuellement survolee. On doit savoir ou l'on lache avant de lacher. */
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    /**
     * Un compteur, et non un booleen : `dragenter` se declenche a nouveau a
     * chaque element survole a l'interieur de la fenetre, et le `dragleave` du
     * precedent arrive apres. Sans ce comptage, la surimpression clignoterait a
     * chaque passage d'un panneau a l'autre.
     */
    let depth = 0

    const carriesFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      depth += 1
      setDragging(true)
    }

    const onDragOver = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      // Sans ce refus du comportement par defaut, Electron quitterait
      // l'application pour afficher le fichier lache a sa place.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }

    const onDrop = (event: DragEvent): void => {
      event.preventDefault()
      depth = 0
      setDragging(false)
      setHovered(null)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)

    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const dropInto = useCallback(
    async (subject: string, files: FileList | null): Promise<void> => {
      // La surimpression se referme ici et non dans l'ecouteur de la fenetre :
      // la cible arrete la propagation de l'evenement pour etre seule a traiter
      // le depot, si bien que l'ecouteur global ne le voit jamais passer.
      setDragging(false)

      const paths = Array.from(files ?? []).map((file) => window.noted.pathForFile(file))
      if (paths.length === 0) return

      setBusy(subject)
      setError(null)
      try {
        const { imported } = await window.noted.vault.importPaths(paths, subject)
        if (imported.length === 0) {
          setError('Aucun de ces fichiers n’est un cours (PDF, Word, PowerPoint, Markdown, HTML).')
          return
        }
        onImported(imported)
      } catch (cause) {
        setError(readableError(cause, "L'import a échoué."))
      } finally {
        setBusy(null)
      }
    },
    [onImported]
  )

  // Le message d'erreur survit a la fin du survol : il n'y aurait aucun moyen
  // de le lire s'il disparaissait avec la surimpression.
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 5000)
    return () => clearTimeout(timer)
  }, [error])

  if (!dragging && !error) return null

  return (
    <div className="drop" data-quiet={!dragging}>
      {dragging && (
        <div className="drop-panel">
          <p className="drop-title">Déposer dans quelle matière ?</p>

          {subjects.length === 0 ? (
            <p className="drop-hint">Crée d'abord une matière depuis la bibliothèque (⌘K).</p>
          ) : (
            <div className="drop-targets">
              {subjects.map((subject) => (
                <div
                  key={subject.name}
                  className="drop-target"
                  data-over={hovered === subject.name}
                  data-busy={busy === subject.name}
                  onDragEnter={() => setHovered(subject.name)}
                  onDragOver={(event) => {
                    // Sans ce refus, la cible n'accepte pas le lacher.
                    event.preventDefault()
                    event.stopPropagation()
                    setHovered(subject.name)
                  }}
                  onDragLeave={() => setHovered((name) => (name === subject.name ? null : name))}
                  onDrop={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setHovered(null)
                    void dropInto(subject.name, event.dataTransfer.files)
                  }}
                >
                  <span className="drop-target-name">{subject.name}</span>
                  <span className="drop-target-count">
                    {subject.courses.length === 1
                      ? '1 cours'
                      : `${subject.courses.length} cours`}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="drop-hint">
            PDF, Word, PowerPoint, Markdown, HTML. Lâche à côté pour annuler.
          </p>
        </div>
      )}

      {error && <div className="drop-error">{error}</div>}
    </div>
  )
}
