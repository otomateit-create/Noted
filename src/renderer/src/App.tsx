import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CourseMove, NoteAnchor } from '@shared/types'
import ChatPanel from './components/ChatPanel'
import type { ChatAsk, ChatMention } from './components/ChatPanel'
import CoursePanel from './components/CoursePanel'
import Dashboard from './components/Dashboard'
import DropZone from './components/DropZone'
import FlashcardsPage, { INITIAL_SCREEN } from './components/FlashcardsPage'
import type { Screen as FlashcardsScreen } from './components/FlashcardsPage'
import HubSidebar from './components/HubSidebar'
import type { HubView } from './components/HubSidebar'
import Library from './components/Library'
import MemoryPage from './components/MemoryPage'
import NotesPanel from './components/NotesPanel'
import type { NoteInsert, SaveState } from './components/NotesPanel'
import SettingsPage from './components/SettingsPage'
import Shortcuts from './components/Shortcuts'
import Splitter from './components/Splitter'
import SubjectPage from './components/SubjectPage'
import TitleBar from './components/TitleBar'
import { useVault } from './hooks/useVault'
import { dispositionRetenue, retenirDisposition, type Panneaux } from './lib/layout'
import { forgetReading, renameReading } from './lib/reading'
import './styles/app.css'

/** Bornes de redimensionnement : en deca, un panneau devient inutilisable. */
const COURSE_MIN = 320
const COURSE_MAX = 900
const CHAT_MIN = 300
const CHAT_MAX = 640

/**
 * Les notes n'ont pas de largeur a elles : elles prennent ce qui reste. Sans
 * plancher, ce reste pouvait tomber a deux pixels — le cours a 900, l'assistant
 * a 640, et la feuille sur laquelle on ecrit reduite a un trait. Le plancher
 * est celui d'une feuille encore utilisable, bandeau compris.
 */
const NOTES_MIN = 420

/** Un separateur fait un pixel de large (app.css). */
const SPLITTER = 1

type View = 'dashboard' | 'flashcards' | 'memoire' | 'reglages' | 'subject' | 'workspace'

/** Le panneau qu'on regarde seul, quand on veut se concentrer sur un seul. */
type Focus = 'course' | 'notes' | 'chat' | null

/**
 * Une page de l'historique de navigation — assez pour la reconstruire sans
 * rejouer le clic qui y a mene. `courseId` plutot que `course` : l'objet
 * peut changer de reference d'un rafraichissement a l'autre, l'identifiant
 * survit.
 */
interface NavLocation {
  view: View
  activeSubject: string | null
  courseId: string | null
}

const INITIAL_LOCATION: NavLocation = { view: 'dashboard', activeSubject: null, courseId: null }

/** Les vues qui composent la section Matieres : l'accueil, une matiere, un cours. */
const SUBJECTS_VIEWS: ReadonlySet<View> = new Set(['dashboard', 'subject', 'workspace'])

/** Le panneau que chaque chiffre agrandit. */
const FOCUS_KEYS: Record<string, Exclude<Focus, null>> = {
  '1': 'course',
  '2': 'notes',
  '3': 'chat'
}

export default function App(): React.JSX.Element {
  const { subjects, course, setCourseId, status, loading, refresh } = useVault()

  // On atterrit toujours sur le tableau de bord : reprendre le fil de la
  // veille est un choix qu'on fait en cliquant une carte, plus un automatisme
  // qui saute une etape.
  const [view, setView] = useState<View>('dashboard')
  const [activeSubject, setActiveSubject] = useState<string | null>(null)

  /**
   * L'historique de navigation, a la maniere d'un navigateur : une pile de
   * pages et l'index de celle qu'on regarde. Avancer au-dela du sommet coupe
   * le futur ; les fleches de la barre de titre remontent ou redescendent
   * la pile sans rien y ajouter.
   */
  const [nav, setNav] = useState<{ stack: NavLocation[]; index: number }>({
    stack: [INITIAL_LOCATION],
    index: 0
  })

  const pushLocation = useCallback((location: NavLocation) => {
    setNav((previous) => {
      const current = previous.stack[previous.index]
      if (
        current.view === location.view &&
        current.activeSubject === location.activeSubject &&
        current.courseId === location.courseId
      ) {
        return previous
      }
      const stack = [...previous.stack.slice(0, previous.index + 1), location]
      return { stack, index: stack.length - 1 }
    })
  }, [])

  /**
   * Les fleches de la barre de titre : reculer ou avancer dans l'historique
   * sans y ajouter de page, comme dans un navigateur. `courseId` est restaure
   * avec la vue — s'il a disparu depuis (cours supprime ou renomme), l'effet
   * de secours plus bas retombe deja sur le tableau de bord.
   */
  const goBack = useCallback(() => {
    if (nav.index === 0) return
    const target = nav.stack[nav.index - 1]
    setView(target.view)
    setActiveSubject(target.activeSubject)
    setCourseId(target.courseId)
    setNav((previous) => ({ ...previous, index: previous.index - 1 }))
  }, [nav, setCourseId])

  const goForward = useCallback(() => {
    if (nav.index >= nav.stack.length - 1) return
    const target = nav.stack[nav.index + 1]
    setView(target.view)
    setActiveSubject(target.activeSubject)
    setCourseId(target.courseId)
    setNav((previous) => ({ ...previous, index: previous.index + 1 }))
  }, [nav, setCourseId])

  const canGoBack = nav.index > 0
  const canGoForward = nav.index < nav.stack.length - 1

  /**
   * Chaque section retient la sous-page ou on l'a laissee, pour la retrouver
   * telle quelle en y revenant par la laterale. Pour Matieres, c'est la
   * derniere position (matiere ou cours ouvert) ; Flashcards et Memoire
   * portent leur ecran ici plutot que dans leur composant, qui se demonte
   * des qu'on change de section.
   */
  const lastSubjectsLocation = useRef<NavLocation>(INITIAL_LOCATION)
  useEffect(() => {
    if (!SUBJECTS_VIEWS.has(view)) return
    lastSubjectsLocation.current = { view, activeSubject, courseId: course?.id ?? null }
  }, [view, activeSubject, course])

  /** L'espace des trois panneaux : c'est sa largeur qui borne les separateurs. */
  const workspaceRef = useRef<HTMLDivElement>(null)

  const [flashcardsScreen, setFlashcardsScreen] = useState<FlashcardsScreen>(INITIAL_SCREEN)
  const [memoryOpen, setMemoryOpen] = useState<ReadonlySet<string>>(new Set())

  const activeSubjectData = useMemo(
    () => subjects.find((subject) => subject.name === activeSubject) ?? null,
    [subjects, activeSubject]
  )

  // Lue une seule fois : ensuite c'est l'etat de React qui fait foi.
  const [disposition] = useState(dispositionRetenue)
  const [courseWidth, setCourseWidth] = useState(disposition.courseWidth)
  const [chatWidth, setChatWidth] = useState(disposition.chatWidth)
  /**
   * Lesquelles des trois sections sont a l'ecran. Les trois boutons du bandeau
   * les allument et les eteignent ; il en reste toujours au moins une, sans quoi
   * l'espace de travail serait une page blanche sans rien pour en sortir.
   */
  const [panneaux, setPanneaux] = useState<Panneaux>(disposition.panneaux)
  const [partage, setPartage] = useState(disposition.partage)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  /**
   * Le mode concentration ne se retient pas d'un lancement a l'autre : c'est
   * un geste qu'on fait pour un moment de travail, pas un reglage. Retrouver
   * l'application avec deux panneaux disparus, sans savoir pourquoi, serait
   * une facon de se perdre.
   */
  const [focus, setFocus] = useState<Focus>(null)

  /** Reponses de l'assistant recopiees dans la note, et questions posees. */
  const [noteInsert, setNoteInsert] = useState<NoteInsert | null>(null)
  const [chatAsk, setChatAsk] = useState<ChatAsk | null>(null)
  /** Le passage des notes en route vers la barre de saisie de l'assistant. */
  const [chatMention, setChatMention] = useState<ChatMention | null>(null)
  /**
   * Le cadre de la feuille, tenu ici parce que les deux panneaux en ont besoin :
   * les notes le produisent, l'assistant y pose les pastilles des passages
   * mentionnes. En etat et non en ref — replier le panneau des notes le fait
   * disparaitre, et celui qui dessine dedans doit l'apprendre.
   */
  const [notesStage, setNotesStage] = useState<HTMLElement | null>(null)

  // --- Le lien vivant entre le cours et les notes ---------------------------
  //
  // `reading` dit ou l'on en est de la lecture : c'est l'ancre que porte ce
  // qu'on ecrit maintenant, capturee toute seule a la ligne de lecture.

  const [reading, setReading] = useState<NoteAnchor | null>(null)
  /**
   * Ce que le cours affiche au meme instant, en unites de document. Suit
   * exactement le chemin de `reading` — le panneau du cours le mesure, celui
   * des notes s'en sert — mais repond a l'autre question : non pas ou l'on en
   * est, mais tout ce qui est sous les yeux, pour que l'ancrage automatique
   * d'un bloc de note cherche son passage la et pas ailleurs.
   *
   * Pas de remise a zero au changement de cours, pour la meme raison que
   * `reading` n'en a pas : le panneau remplace la valeur des que le nouveau
   * document est mesure, et vider entre-temps ne ferait qu'ouvrir un trou.
   */
  const [visibleUnits, setVisibleUnits] = useState<string[]>([])
  /** Ce que chaque panneau demande a l'autre de rejoindre. */
  const [courseGoTo, setCourseGoTo] = useState<{
    anchor: NoteAnchor
    nonce: number
    /** La demande attend-elle qu'on montre l'endroit, ou seulement qu'on y aille ? */
    signal: boolean
  } | null>(null)
  const [notesFollow, setNotesFollow] = useState<{ anchor: NoteAnchor; nonce: number } | null>(null)

  /**
   * La synchronisation des deux defilements. Un reglage, pas un geste : il vaut
   * pour toute l'application et se retient d'un lancement a l'autre.
   */
  const [syncOn, setSyncOn] = useState(
    () => window.localStorage.getItem('noted.sync') !== '0'
  )
  const toggleSync = useCallback(() => {
    setSyncOn((current) => {
      window.localStorage.setItem('noted.sync', current ? '0' : '1')
      return !current
    })
  }, [])

  /** Le cours a defile : on note ou l'on en est, et les notes suivent. */
  const handleReading = useCallback(
    (next: NoteAnchor | null, fromUser: boolean) => {
      setReading(next)
      if (!next || !fromUser || !syncOn) return
      setNotesFollow((previous) => ({ anchor: next, nonce: (previous?.nonce ?? 0) + 1 }))
    },
    [syncOn]
  )

  /**
   * `signal` est le seul moyen de distinguer, dans ce canal partage, un clic
   * volontaire sur un repere d'ancrage — qui attend qu'on lui montre l'endroit —
   * d'un simple suivi de defilement, qui doit rester invisible.
   */
  const askCourse = useCallback((anchor: NoteAnchor, signal = false) => {
    setCourseGoTo((previous) => ({ anchor, nonce: (previous?.nonce ?? 0) + 1, signal }))
  }, [])

  /** Le defilement des notes entraine le cours, si la synchronisation joue. */
  const handleFollow = useCallback(
    (anchor: NoteAnchor) => {
      if (syncOn) askCourse(anchor)
    },
    [syncOn, askCourse]
  )

  /**
   * L'enregistrement se declenche dans le panneau des notes, qui seul detient
   * l'editeur ; la barre de titre ne fait que le demander et en afficher
   * l'issue. Ces deux etats sont le fil entre les deux.
   */
  const [saveRequest, setSaveRequest] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('idle')

  /**
   * Mode « Auto » : les ecritures de notes proposees par l'assistant
   * s'appliquent sans validation. Le bouton vit dans le panneau de
   * l'assistant, l'effet dans celui des notes : l'etat est donc ici. Retenu
   * d'un lancement a l'autre — c'est un reglage, pas un geste.
   */
  const [autoApply, setAutoApply] = useState(
    () => window.localStorage.getItem('noted.notes.auto') === '1'
  )
  const toggleAutoApply = useCallback(() => {
    setAutoApply((current) => {
      const next = !current
      window.localStorage.setItem('noted.notes.auto', next ? '1' : '0')
      return next
    })
  }, [])

  /**
   * Page vers laquelle sauter dans le document. Le compteur permet de
   * redemander la meme page deux fois de suite — cliquer deux fois « (p. 12) »
   * doit y ramener a chaque fois.
   */
  const [pageTarget, setPageTarget] = useState<{ page: number; nonce: number } | null>(null)

  const openPage = useCallback((page: number) => {
    setPageTarget((previous) => ({ page, nonce: (previous?.nonce ?? 0) + 1 }))
  }, [])

  /**
   * Allume ou eteint une section, depuis les trois boutons du bandeau.
   *
   * La derniere allumee ne s'eteint pas : un espace de travail vide n'aurait
   * plus rien a montrer, et le bouton pour en sortir serait le seul repere
   * restant. Le clic est alors sans effet — plutot qu'un bouton grise, qui
   * dirait « indisponible » la ou il s'agit d'une evidence.
   */
  const togglePanneau = useCallback((panel: keyof Panneaux) => {
    setPanneaux((current) => {
      if (current[panel] && Object.values(current).filter(Boolean).length === 1) return current
      return { ...current, [panel]: !current[panel] }
    })
  }, [])

  /**
   * Bascule le mode concentration, depuis l'etiquette d'un panneau.
   *
   * Agrandir une section eteinte l'allume : ⌘3 sur un assistant masque doit
   * l'ouvrir en grand, pas agrandir un panneau qui n'est pas la.
   */
  const toggleFocus = useCallback((panel: Exclude<Focus, null>) => {
    setPanneaux((current) => (current[panel] ? current : { ...current, [panel]: true }))
    setFocus((current) => (current === panel ? null : panel))
  }, [])

  /**
   * Le separateur entre le cours et l'assistant quand les notes sont masquees.
   * Il ne deplace pas une largeur mais une part, puisque les deux panneaux se
   * partagent alors l'ecran ; les bornes des deux sont traduites en parts.
   */
  const handlePartage = useCallback((delta: number) => {
    const total = workspaceRef.current?.clientWidth ?? 0
    if (!total) return
    setPartage((part) => {
      const plancher = COURSE_MIN / total
      const plafond = 1 - CHAT_MIN / total
      if (plancher >= plafond) return part
      return Math.min(Math.max(part + delta / total, plancher), plafond)
    })
  }, [])

  // Raccourcis globaux. ⌘S vit dans le panneau des notes, qui seul sait ce
  // qu'il y a a enregistrer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey) return

      if (event.key === 'k') {
        event.preventDefault()
        setLibraryOpen((open) => !open)
      }
      if (event.key === 'j') {
        event.preventDefault()
        togglePanneau('chat')
      }
      // ⌘F cherche toujours dans le cours, meme si le curseur est dans les
      // notes : celles-ci tiennent sous les yeux, le cours fait cinquante pages.
      if (event.key === 'f') {
        event.preventDefault()
        setFindOpen(true)
      }
      if (event.key === '/') {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
      }
      // ⌘[ / ⌘] : reculer ou avancer dans l'historique, comme Safari ou le Finder.
      if (event.key === '[') {
        event.preventDefault()
        goBack()
      }
      if (event.key === ']') {
        event.preventDefault()
        goForward()
      }

      const panel = FOCUS_KEYS[event.key]
      if (panel) {
        event.preventDefault()
        toggleFocus(panel)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goBack, goForward, toggleFocus, togglePanneau])

  // Ecriture immediate plutot que differee : le contenu tient en soixante
  // octets, et un ⌘Q juste apres avoir tire un separateur ne doit pas perdre
  // le geste qu'on vient de faire.
  useEffect(() => {
    retenirDisposition({ courseWidth, chatWidth, panneaux, partage })
  }, [courseWidth, chatWidth, panneaux, partage])

  /**
   * Ce qui resterait aux notes si le cours et l'assistant prenaient ces
   * largeurs-la. Tant que l'espace de travail n'est pas mesure, on ne bride
   * rien : une borne calculee sur une largeur nulle bloquerait tout.
   */
  const notesRoom = useCallback(
    (course: number, chat: number): number => {
      const total = workspaceRef.current?.clientWidth ?? 0
      if (!total) return Number.POSITIVE_INFINITY
      return (
        total -
        (panneaux.course ? course + SPLITTER : 0) -
        (panneaux.chat ? chat + SPLITTER : 0)
      )
    },
    [panneaux.course, panneaux.chat]
  )

  const handleCourseResize = useCallback(
    (delta: number) => {
      setCourseWidth((width) => {
        // On ne peut s'elargir que de ce que les notes acceptent de ceder.
        const cede = Math.max(0, notesRoom(width, chatWidth) - NOTES_MIN)
        const plafond = Math.min(COURSE_MAX, width + cede)
        return Math.min(plafond, Math.max(COURSE_MIN, width + delta))
      })
    },
    [chatWidth, notesRoom]
  )

  const handleChatResize = useCallback(
    (delta: number) => {
      // Le separateur du chat est a sa gauche : tirer vers la droite le retrecit.
      setChatWidth((width) => {
        const cede = Math.max(0, notesRoom(courseWidth, width) - NOTES_MIN)
        const plafond = Math.min(CHAT_MAX, width + cede)
        return Math.min(plafond, Math.max(CHAT_MIN, width - delta))
      })
    },
    [courseWidth, notesRoom]
  )

  /**
   * Retrecir la fenetre ne doit pas ecraser les notes non plus : le glissement
   * des separateurs n'est qu'une des deux facons de leur prendre leur place.
   * L'assistant cede en premier — on s'en passe d'un coup d'oeil, la ou le
   * cours est ce qu'on lit —, puis le cours. Si la fenetre est trop petite pour
   * les trois planchers, il n'y a plus rien a rendre : les bandeaux se
   * degarnissent alors d'eux-memes, chacun selon ses seuils.
   */
  useEffect(() => {
    const stage = workspaceRef.current
    if (!stage) return

    const rendre = (): void => {
      // Sans les notes a l'ecran, il n'y a personne a proteger : les panneaux
      // restants se partagent la largeur et suivent la fenetre d'eux-memes.
      if (!panneaux.notes) return

      const total = stage.clientWidth
      if (!total) return

      let manque =
        NOTES_MIN -
        (total -
          (panneaux.course ? courseWidth + SPLITTER : 0) -
          (panneaux.chat ? chatWidth + SPLITTER : 0))
      if (manque <= 0) return

      if (panneaux.chat) {
        const pris = Math.min(manque, chatWidth - CHAT_MIN)
        if (pris > 0) {
          setChatWidth(chatWidth - pris)
          manque -= pris
        }
      }
      if (manque > 0 && panneaux.course) {
        setCourseWidth((width) => Math.max(COURSE_MIN, width - manque))
      }
    }

    const observer = new ResizeObserver(rendre)
    observer.observe(stage)
    return () => observer.disconnect()
    // `view` en dependance : l'espace de travail n'existe pas sur le tableau de
    // bord, et sans lui l'effet s'arreterait sur une reference vide sans jamais
    // etre rejoue en arrivant sur un cours.
  }, [courseWidth, chatWidth, panneaux, view])

  const openCourse = useCallback(
    (id: string) => {
      setCourseId(id)
      setView('workspace')
      setLibraryOpen(false)
      // La cible de page et les occurrences trouvees appartenaient au document
      // precedent : elles ne veulent plus rien dire dans celui-ci.
      setPageTarget(null)
      setFindOpen(false)
      pushLocation({ view: 'workspace', activeSubject: null, courseId: id })
    },
    [setCourseId, pushLocation]
  )

  /** Un passage du cours part vers l'assistant, qui s'ouvre s'il etait replie. */
  const explainPassage = useCallback((text: string, reference: string) => {
    setPanneaux((current) => ({ ...current, chat: true }))
    setFocus(null)
    setChatAsk({
      prompt: `Explique-moi ce passage de mon cours (${reference}) :\n\n« ${text} »`
    })
  }, [])

  const clearAsk = useCallback(() => setChatAsk(null), [])

  /**
   * Un passage des notes rejoint la barre de saisie de l'assistant, qui s'ouvre
   * s'il etait replie. Rien ne part : la question s'ecrit ensuite, le passage
   * accroche dessous.
   */
  const mentionPassage = useCallback((mention: ChatMention) => {
    setPanneaux((current) => ({ ...current, chat: true }))
    setFocus(null)
    setChatMention(mention)
  }, [])

  const clearMention = useCallback(() => setChatMention(null), [])

  /** Une reponse de l'assistant recopiee dans la note, a sa place, sur clic explicite. */
  const insertResponse = useCallback((markdown: string) => {
    setNoteInsert((previous) => ({ text: markdown, nonce: (previous?.nonce ?? 0) + 1 }))
  }, [])

  /**
   * « Mets au propre mes notes » : la demande part a l'assistant, qui sait par
   * son prompt ce que le geste veut dire — lire la note, la restructurer sans
   * rien inventer, recouper avec le cours, et proposer le resultat en apercu.
   */
  const tidyNotes = useCallback(() => {
    setPanneaux((current) => ({ ...current, chat: true }))
    setFocus(null)
    setChatAsk({ prompt: 'Mets au propre mes notes de ce cours.' })
  }, [])

  /**
   * Une proposition de l'assistant vient d'arriver dans le panneau des notes :
   * s'il etait replie par le mode concentration, l'apercu resterait invisible
   * et la conversation attendrait dans le vide.
   */
  const revealNotes = useCallback(() => {
    setFocus((current) => (current === 'notes' ? current : null))
  }, [])

  /**
   * Qui absorbe la largeur restante.
   *
   * Tant que les notes sont la, ce sont elles : le cours et l'assistant gardent
   * la largeur qu'on leur a donnee, la feuille prend le reste — c'est la regle
   * depuis toujours, et elle ne bouge pas. Sans les notes, plus personne n'est
   * souple : les sections restantes se partagent l'ecran, par moitie tant qu'on
   * n'a pas tire le separateur, et une section seule le prend en entier.
   */
  const courseGrow = panneaux.notes ? undefined : panneaux.chat ? partage : 1
  const chatGrow = panneaux.notes ? undefined : panneaux.course ? 1 - partage : 1

  const openSubject = useCallback(
    (name: string) => {
      setActiveSubject(name)
      setView('subject')
      pushLocation({ view: 'subject', activeSubject: name, courseId: null })
    },
    [pushLocation]
  )

  const goHome = useCallback(() => {
    setView('dashboard')
    setActiveSubject(null)
    pushLocation({ view: 'dashboard', activeSubject: null, courseId: null })
  }, [pushLocation])

  /**
   * Navigation de la barre laterale. « Matieres » depuis une autre section
   * ramene la ou on en etait (le cours ouvert, la matiere) ; depuis la
   * section elle-meme, c'est un retour a l'accueil.
   */
  const openHubView = useCallback(
    (next: HubView) => {
      if (next === 'dashboard' && !SUBJECTS_VIEWS.has(view)) {
        const target = lastSubjectsLocation.current
        setView(target.view)
        setActiveSubject(target.activeSubject)
        setCourseId(target.courseId)
        pushLocation(target)
        return
      }
      setView(next)
      setActiveSubject(null)
      pushLocation({ view: next, activeSubject: null, courseId: null })
    },
    [view, pushLocation, setCourseId]
  )

  /**
   * Ce qu'on affiche vraiment. Le cours ouvert ou la matiere affichee peuvent
   * disparaitre pendant qu'on les regarde — supprimes depuis la bibliotheque
   * (⌘K), ou jetes a la corbeille depuis le Finder, ce que la veille sur le
   * dossier fait maintenant remonter en direct. On retombe alors sur le
   * tableau de bord, qui lui existe toujours.
   *
   * La vue effective est calculee plutot que corrigee par un effet : sans
   * cela, le temps d'un rendu, la barre de titre habillerait un ecran et le
   * corps de la fenetre en montrerait un autre.
   */
  const shownView: View =
    view === 'workspace' && !course
      ? 'dashboard'
      : view === 'subject' && !activeSubjectData
        ? 'dashboard'
        : view

  // L'etat suit l'affichage, mais sans precipitation : pendant un renommage,
  // le cours manque un instant le temps que la liste se remette a jour. Ce
  // delai laisse passer ces trous-la et ne conclut a une disparition que
  // lorsqu'elle dure.
  useEffect(() => {
    if (shownView === view) return undefined

    const timer = setTimeout(goHome, 400)
    return () => clearTimeout(timer)
  }, [shownView, view, goHome])

  // Sur la coque d'accueil, la barre de titre se detache du bord en pilule :
  // les feux macOS, places par le main, doivent suivre pour rester centres.
  // La liste est celle de la regle qui dessine la pilule (titlebar.css) et pas
  // une de plus : les reglages gardent une barre plaquee au bord, et leur
  // ajouter le decalage y poussait les feux 8px trop bas et trop a droite.
  const hubChrome =
    shownView === 'dashboard' ||
    shownView === 'flashcards' ||
    shownView === 'memoire' ||
    shownView === 'subject'
  useEffect(() => {
    window.noted.fenetre.feux(hubChrome)
  }, [hubChrome])

  /**
   * Des cours ont change d'identifiant. Tout ce qui les designe doit suivre du
   * meme geste : le cours affiche, et le signet de lecture qui porte leur nom.
   */
  const handleMoved = useCallback(
    (moves: CourseMove[]) => {
      for (const move of moves) renameReading(move.previousId, move.nextId)

      const followed = moves.find((move) => move.previousId === course?.id)
      if (followed) setCourseId(followed.nextId)

      void refresh()
    },
    [course, refresh, setCourseId]
  )

  /** Des cours ont disparu. Si c'est celui qu'on lisait, retour au tableau de bord. */
  const handleRemoved = useCallback(
    (removed: string[]) => {
      for (const id of removed) forgetReading(id)

      void refresh().then(() => {
        if (course && removed.includes(course.id)) goHome()
      })
    },
    [course, refresh, goHome]
  )

  /** Cours arrives par glisser-deposer : on ouvre le premier. */
  const handleDropped = useCallback(
    (imported: string[]) => {
      void refresh().then((next) => {
        const first = imported[0]
        if (first && next.some((subject) => subject.courses.some((c) => c.id === first))) {
          openCourse(first)
        }
      })
    },
    [refresh, openCourse]
  )

  if (loading) {
    return <div className="boot" />
  }

  return (
    // La vue est portee jusqu'au CSS : la barre de titre surmonte tantot la
    // feuille creme de l'espace de travail, tantot la coque claire de
    // l'accueil, et doit s'accorder a celle sur laquelle elle est posee.
    <div className="app" data-view={shownView}>
      <TitleBar
        course={shownView === 'workspace' ? course : null}
        subjectLabel={shownView === 'subject' ? activeSubject : null}
        subjects={subjects}
        status={status}
        panneaux={panneaux}
        saveState={saveState}
        onSave={() => setSaveRequest((tick) => tick + 1)}
        onTogglePanneau={togglePanneau}
        onOpenCourse={openCourse}
        onShortcuts={() => setShortcutsOpen((open) => !open)}
        onHome={goHome}
        onBack={goBack}
        onForward={goForward}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
      />

      {shownView === 'workspace' && course ? (
        // Le panneau agrandi est porte jusqu'au CSS : les deux autres se
        // replient par une regle de style, sans etre demontes — un editeur
        // qu'on demonte perd son curseur et son historique d'annulation.
        <div className="workspace" data-focus={focus ?? undefined} ref={workspaceRef}>
          {/* La laterale n'a pas sa place ici en permanence — le cours et les
              notes ont droit a tout l'ecran — mais reste a un survol du bord
              gauche, pour changer de matiere sans perdre sa lecture. */}
          <div className="workspace-edge-reveal">
            <div className="workspace-edge-sidebar">
              <HubSidebar current={null} onNavigate={openHubView} />
            </div>
          </div>

          {panneaux.course && (
          <CoursePanel
            course={course}
            width={courseWidth}
            grow={courseGrow}
            expanded={focus === 'course'}
            pageTarget={pageTarget}
            findOpen={findOpen}
            onCloseFind={() => setFindOpen(false)}
            onToggleExpand={() => toggleFocus('course')}
            onExplain={explainPassage}
            onReading={handleReading}
            onVisibleUnits={setVisibleUnits}
            goTo={courseGoTo}
          onConverted={handleMoved}
          />
          )}

          {/* Un separateur n'a de sens qu'entre deux sections presentes. Celui
              du milieu deplace la largeur du cours ; celui de droite, celle de
              l'assistant. Quand les notes sont masquees, il n'en reste qu'un
              entre le cours et l'assistant, et il ne deplace plus une largeur
              mais la part que chacun prend de l'ecran. */}
          {panneaux.course && panneaux.notes && (
            <Splitter onResize={handleCourseResize} label="Largeur du panneau cours" />
          )}
          {panneaux.course && !panneaux.notes && panneaux.chat && (
            <Splitter onResize={handlePartage} label="Partage entre le cours et l'assistant" />
          )}

          {panneaux.notes && (
          <NotesPanel
            course={course}
            saveRequest={saveRequest}
            insert={noteInsert}
            reading={reading}
            visibleUnits={visibleUnits}
            onGoTo={askCourse}
            onFollow={handleFollow}
            follow={notesFollow}
            syncOn={syncOn}
            onToggleSync={toggleSync}
            expanded={focus === 'notes'}
            onToggleExpand={() => toggleFocus('notes')}
            onSaveState={setSaveState}
            onTidy={tidyNotes}
            onProposalShown={revealNotes}
            autoApply={autoApply}
            onMention={mentionPassage}
            stageRef={setNotesStage}
          />
          )}

          {panneaux.notes && panneaux.chat && (
            <Splitter onResize={handleChatResize} label="Largeur du panneau IA" />
          )}

          {panneaux.chat && (
            <ChatPanel
              course={course}
              status={status}
              width={chatWidth}
              grow={chatGrow}
              expanded={focus === 'chat'}
              ask={chatAsk}
              onAsked={clearAsk}
              mention={chatMention}
              onMentioned={clearMention}
              notesStage={panneaux.notes ? notesStage : null}
              onToggleExpand={() => toggleFocus('chat')}
              onOpenPage={openPage}
              onInsertToNotes={insertResponse}
              autoApply={autoApply}
              onToggleAuto={toggleAutoApply}
            />
          )}
        </div>
      ) : (
        // La coque d'accueil : barre laterale a gauche, page a droite. La
        // page de matiere en fait partie au meme titre que les autres — seule
        // la section principale change, la laterale et le bandeau restent en
        // place, comme pour Flashcards.
        <div className="hub">
          <HubSidebar
            current={shownView === 'subject' ? 'dashboard' : (shownView as HubView)}
            onNavigate={openHubView}
          />
          {/* La plaque de verre est ce shell, pas la page : la page defile a
              l'interieur pendant que la forme, elle, ne bouge pas. */}
          <div className="hub-main">
            {shownView === 'subject' && activeSubjectData ? (
              <SubjectPage
                subject={activeSubjectData}
                onOpenCourse={openCourse}
                onImported={refresh}
                onMoved={handleMoved}
                onRemoved={handleRemoved}
              />
            ) : shownView === 'flashcards' ? (
              <FlashcardsPage screen={flashcardsScreen} onScreen={setFlashcardsScreen} />
            ) : shownView === 'memoire' ? (
              <MemoryPage open={memoryOpen} onOpen={setMemoryOpen} />
            ) : shownView === 'reglages' ? (
              <SettingsPage />
            ) : (
              <Dashboard subjects={subjects} onOpenSubject={openSubject} onImported={refresh} />
            )}
          </div>
        </div>
      )}

      {libraryOpen && (
        <Library
          subjects={subjects}
          currentId={course?.id ?? null}
          onSelect={openCourse}
          onClose={() => setLibraryOpen(false)}
          onImported={refresh}
          onMoved={handleMoved}
          onRemoved={handleRemoved}
        />
      )}

      {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}

      <DropZone subjects={subjects} onImported={handleDropped} />
    </div>
  )
}
