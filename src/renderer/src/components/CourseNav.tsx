import { useEffect, useRef, useState } from 'react'
import type { Course, Subject } from '@shared/types'
import '../styles/course-nav.css'

/**
 * Le logo du navigateur : un livre grand ouvert, vu de face, avec un eventail
 * de pages interieures en trait plus fin que les couvertures. Dessin maison
 * (variante « Face » retenue parmi six), dans le style lucide — viewBox 24,
 * trait 2, bouts ronds — pour s'accorder aux autres icones de la barre.
 */
function BookFace(): React.JSX.Element {
  return (
    <svg
      className="course-nav-logo"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 7c-1.9-1.7-4.4-2.5-8-2.5v13.6c3.6 0 6.1.8 8 2.5 1.9-1.7 4.4-2.5 8-2.5V4.5c-3.6 0-6.1.8-8 2.5Z" />
      <path d="M12 7v13.6" />
      <g strokeWidth="1.4">
        <path d="M7 8.6c1.5.2 2.8.7 3.8 1.4" />
        <path d="M7 11.6c1.5.2 2.8.7 3.8 1.4" />
        <path d="M17 8.6c-1.5.2-2.8.7-3.8 1.4" />
        <path d="M17 11.6c-1.5.2-2.8.7-3.8 1.4" />
      </g>
    </svg>
  )
}

interface CourseNavProps {
  /** Le cours actuellement ouvert — le bouton porte son titre. */
  course: Course
  subjects: Subject[]
  onOpenCourse: (id: string) => void
}

/**
 * Le navigateur de cours de la barre de titre : un petit logo de livres en
 * accordeon, suivi du titre du cours ouvert. Le clic deplie un panneau a deux
 * colonnes — les matieres a gauche, les cours de la matiere choisie a droite.
 *
 * Deux notions distinctes cohabitent : la matiere du cours *ouvert* (marquee
 * d'un point, elle ne bouge pas tant qu'on n'ouvre pas un autre cours) et la
 * matiere *depliee* (surlignee, elle change a chaque clic dans la colonne de
 * gauche). C'est ce qui permet d'aller voir les cours des autres matieres sans
 * perdre le repere de celle ou l'on se trouve.
 */
export default function CourseNav({
  course,
  subjects,
  onOpenCourse
}: CourseNavProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [deployed, setDeployed] = useState(course.subject)
  const rootRef = useRef<HTMLDivElement>(null)

  const toggle = (): void => {
    setOpen((was) => {
      // A chaque ouverture, le panneau repart de la matiere du cours affiche :
      // c'est la reponse a « ou suis-je ? » avant d'etre un outil d'exploration.
      if (!was) setDeployed(course.subject)
      return !was
    })
  }

  // Clic hors du panneau ou Echap : le panneau se referme, comme un menu.
  useEffect(() => {
    if (!open) return undefined

    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // La matiere depliee peut disparaitre pendant qu'on regarde (renommage,
  // suppression depuis le Finder) : on retombe sur celle du cours ouvert.
  const shown =
    subjects.find((subject) => subject.name === deployed) ??
    subjects.find((subject) => subject.name === course.subject)

  return (
    <div className="course-nav" ref={rootRef}>
      <button
        className="course-nav-button"
        data-open={open}
        onClick={toggle}
        title="Parcourir les matières et les cours"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <BookFace />
        <span className="course-nav-title">{course.title}</span>
      </button>

      {open && (
        <div className="course-nav-panel">
          <div className="course-nav-column course-nav-subjects">
            <div className="course-nav-eyebrow">Matières</div>
            {subjects.map((subject) => (
              <button
                key={subject.name}
                className="course-nav-item course-nav-subject"
                data-deployed={subject.name === shown?.name}
                data-current={subject.name === course.subject}
                onClick={() => setDeployed(subject.name)}
              >
                <span className="course-nav-item-label">{subject.name}</span>
                <span className="course-nav-count">{subject.courses.length}</span>
              </button>
            ))}
          </div>

          {/* La couture fuselee entre les deux blancs. */}
          <span className="course-nav-seam" aria-hidden="true" />

          <div className="course-nav-column course-nav-courses">
            <div className="course-nav-eyebrow">{shown?.name ?? 'Cours'}</div>
            {shown?.courses.map((item) => (
              <button
                key={item.id}
                className="course-nav-item course-nav-course"
                data-current={item.id === course.id}
                onClick={() => {
                  setOpen(false)
                  if (item.id !== course.id) onOpenCourse(item.id)
                }}
              >
                <span className="course-nav-item-label">{item.title}</span>
              </button>
            ))}
            {shown && shown.courses.length === 0 && (
              <div className="course-nav-empty">Aucun cours dans cette matière</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
