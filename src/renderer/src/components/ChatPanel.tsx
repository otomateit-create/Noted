import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import type {
  ChatEffort,
  ChatHistoryEntry,
  ChatMessage,
  ChatModel,
  ClaudeStatus,
  Course,
  MemoryTrace,
  QuizAnswer,
  QuizForm
} from '@shared/types'
import { QUIZ_CORRECTION_BRIEF, formatQuizCopy } from '@shared/quiz-copy'
import PanelLabel from './PanelLabel'
import QuizCard from './QuizCard'
import { QUIZ_TOOL, useChat } from '../hooks/useChat'
import { useSmoothText } from '../hooks/useSmoothText'
import { protectMath, restoreMath } from '../lib/math'
import '../styles/chat.css'

/**
 * Niveaux de reflexion, du plus rapide au plus profond. Un modele peut n'en
 * accepter qu'une partie ; il declare alors lesquels.
 *
 * Les etiquettes reprennent exactement celles de Claude Desktop (verifiees
 * dans ses fichiers de traduction) : c'est le meme reglage, on ne l'appelle
 * pas autrement d'une application a l'autre.
 */
const EFFORT_LEVELS: Array<{ value: ChatEffort; label: string; description: string }> = [
  { value: 'low', label: 'Faible', description: 'Répond sans déplier de raisonnement.' },
  { value: 'medium', label: 'Moyen', description: 'Un temps de réflexion mesuré.' },
  { value: 'high', label: 'Élevée', description: 'Raisonne longuement avant de répondre.' },
  { value: 'xhigh', label: 'Très élevé', description: 'Réflexion la plus poussée. Plus lent.' },
  { value: 'max', label: 'Max', description: 'Le maximum que ce modèle accepte.' }
]

/**
 * Entree que Claude Code declare pour son propre reglage courant. La choisir
 * revient a ne rien imposer.
 */
const DEFAULT_MODEL = 'default'

/**
 * Un choix qui survit au redemarrage. Le reglage est un confort d'usage, pas une
 * donnee de travail : il vit dans le navigateur, pas dans le vault.
 */
function usePersisted(key: string, fallback: string): [string, (value: string) => void] {
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

/**
 * Les amorces qui defilent dans la barre tant qu'elle est vide. Un champ muet
 * ne dit pas ce qu'on peut lui demander ; celles-ci le montrent.
 */
const PLACEHOLDER_PHRASES = [
  'Résume ce cours en dix points…',
  'Explique-moi la partie la plus difficile…',
  'Interroge-moi sur ce cours…',
  'Quels concepts dois-je maîtriser ici ?'
]

/** Le temps d'une lettre, puis celui de la phrase entiere avant la suivante. */
const TYPE_DELAY = 55
const HOLD_DELAY = 2200

/**
 * Le mouvement en moins pour qui l'a demande a son systeme. Les animations CSS
 * sont deja neutralisees globalement ; celle-ci vit en JavaScript et doit donc
 * poser la question elle-meme.
 */
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Ecrit l'amorce une lettre a la fois, s'arrete sur la phrase entiere, puis
 * passe a la suivante. Ne tourne que tant que la barre est vide : au-dela le
 * placeholder est cache, et un minuteur qui tourne pour rien n'a pas lieu
 * d'etre.
 */
function useTypewriter(enabled: boolean): string {
  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState('')

  useEffect(() => {
    if (!enabled) return

    const chars = Array.from(PLACEHOLDER_PHRASES[index % PLACEHOLDER_PHRASES.length])
    if (REDUCED_MOTION) {
      setShown(chars.join(''))
      return
    }

    let hold: number | undefined
    let typed = 0
    setShown('')

    const timer = window.setInterval(() => {
      typed += 1
      // Le curseur ne suit que pendant la frappe : sur la phrase achevee, il
      // ferait un second curseur a cote de celui du champ.
      const caret = typed < chars.length ? '|' : ''
      setShown(chars.slice(0, typed).join('') + caret)

      if (typed < chars.length) return
      window.clearInterval(timer)
      hold = window.setTimeout(() => setIndex((value) => value + 1), HOLD_DELAY)
    }, TYPE_DELAY)

    return () => {
      window.clearInterval(timer)
      window.clearTimeout(hold)
    }
  }, [enabled, index])

  return shown
}

/**
 * Un passage retenu dans la barre de saisie, en attente d'envoi.
 *
 * L'etendue est gardee vivante — et non recalculee a partir du texte — parce
 * que c'est elle qui peint le passage et qui place sa pastille : le meme mot
 * peut revenir trois fois dans une reponse, seule l'etendue sait lequel a ete
 * pris.
 */
interface PendingQuote {
  id: string
  /**
   * La reponse d'ou il vient : s'il quitte le fil, la citation part avec lui.
   * Null pour un passage mentionne depuis les notes, qui ne releve d'aucune
   * reponse et ne disparait donc pas quand le fil change.
   */
  messageId: string | null
  /**
   * D'ou vient le passage quand ce n'est pas du fil : « mes notes, p. 12 ».
   * C'est ce libelle qui part au modele dans le crochet de la citation.
   */
  source?: string
  text: string
  /**
   * Ou le peindre, a l'instant ou on le demande. Une reponse rend toujours la
   * meme etendue — son HTML est memorise, ses noeuds ne bougent pas ; la
   * feuille, elle, la recalcule depuis les positions qu'elle tient a jour.
   */
  locate: () => Range | null
}

/** Un passage retenu, avec le rang sous lequel il se lit partout. */
interface NumberedQuote extends PendingQuote {
  n: number
}

/** Le nom sous lequel le navigateur tient les passages cites, le temps de la saisie. */
const QUOTE_HIGHLIGHT = 'noted-chat-quote'

/**
 * Peint les passages cites, sans rien inserer dans le HTML.
 *
 * Le corps d'une reponse appartient a React, qui le repose entier a chaque
 * changement : des balises glissees dedans disparaitraient au token suivant.
 * Le registre de surlignage du navigateur — celui de la recherche ⌘F — peint
 * par-dessus sans y toucher, exactement comme les surlignages du cours.
 */
function paintQuotes(quotes: PendingQuote[]): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return

  // Un passage que la feuille ne sait plus situer — efface pendant qu'on
  // ecrivait la question — n'est simplement pas peint. Il reste dans la barre
  // de saisie : son texte, lui, a ete pris et ne depend plus de rien.
  const ranges = quotes.flatMap((quote) => {
    const range = quote.locate()
    return range && !range.collapsed ? [range] : []
  })

  if (ranges.length === 0) {
    CSS.highlights.delete(QUOTE_HIGHLIGHT)
    return
  }
  CSS.highlights.set(QUOTE_HIGHLIGHT, new Highlight(...ranges))
}

/** Ce que la selection courante designe, si elle tient dans une seule reponse. */
function selectedPassage(): { messageId: string; text: string; range: Range; box: DOMRect } | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  // L'ancetre commun, et non le point de depart : une selection qui deborde
  // d'une reponse sur la suivante remonte alors jusqu'au fil, hors de toute
  // reponse, et n'est pas proposee — on ne cite pas deux messages a la fois.
  const node = range.commonAncestorContainer
  const element = node instanceof HTMLElement ? node : node.parentElement
  const root = element?.closest<HTMLElement>('.message-markdown[data-message-id]')

  const messageId = root?.dataset.messageId
  // Les blancs sont ramenes a un espace : une citation est une ligne, meme
  // prise a cheval sur deux paragraphes ou dans une liste a puces.
  const text = selection.toString().replace(/\s+/g, ' ').trim()
  if (!messageId || !text) return null

  return { messageId, text, range: range.cloneRange(), box: range.getBoundingClientRect() }
}

/**
 * Le bouton flottant ne monte pas plus haut : au-dela il passerait derriere
 * l'entete du panneau, et sur un passage pris tout en haut du fil il faudrait
 * deviner ou il est parti.
 */
const QUOTE_POP_MIN_TOP = 96

/**
 * La pastille se pose dans la marge, a gauche du passage : 15 px de disque et
 * 3 px de respiration, plus un pixel pour ne pas toucher le bord. Un passage
 * qui commence une ligne demarre au ras de la colonne — la pastille sortirait
 * alors du cadre, que le panneau rogne. On l'y ramene, quitte a ce qu'elle
 * touche le premier mot dans ce seul cas.
 */
const QUOTE_MARK_MIN_LEFT = 19

/**
 * Le bord gauche de la colonne de texte ou vit ce passage.
 *
 * Dans une feuille de notes, la pastille ne se colle pas au premier mot du
 * passage : un passage pris au milieu d'une phrase — le cas ordinaire quand on
 * relit ce qu'on vient d'ecrire — verrait alors son numero pose en plein texte,
 * par-dessus le mot d'avant. Elle se range dans la marge, la ou vivent deja les
 * reperes de page, et ne recouvre jamais ce qui a ete ecrit.
 */
function columnLeft(range: Range, fallback: number): number {
  const node = range.startContainer
  const element = node instanceof HTMLElement ? node : node.parentElement
  const block = element?.closest<HTMLElement>('.notes-editor > *')
  return block ? block.getBoundingClientRect().left : fallback
}

/**
 * Les pastilles numerotees posees sur les passages cites.
 *
 * Le registre de surlignage du navigateur ne sait peindre qu'une couleur : le
 * numero, lui, se pose en absolu au debut du passage. Le calque vit dans un
 * cadre `position: relative` qui suit le texte — le fil pour un passage pris
 * dans une reponse, la feuille pour un passage mentionne depuis les notes. Les
 * pastilles defilent donc avec lui, sans une ligne de code pour suivre le
 * defilement.
 *
 * `pulse` est ce dont le placement depend en plus des passages eux-memes : le
 * fil pour les reponses, puisqu'une reponse qui s'ecrit pousse ce qui la
 * precede vers le haut, et qu'une pastille laissee ou elle etait se
 * retrouverait au milieu d'un autre paragraphe.
 */
function QuoteMarks({
  quotes,
  frame,
  pulse,
  gutter
}: {
  quotes: NumberedQuote[]
  frame: HTMLElement | null
  pulse?: unknown
  gutter?: boolean
}): React.JSX.Element | null {
  const [marks, setMarks] = useState<Array<{ id: string; n: number; left: number; top: number }>>(
    []
  )

  useLayoutEffect(() => {
    const element = frame
    if (!element || quotes.length === 0) {
      setMarks([])
      return
    }

    const measure = (): void => {
      const base = element.getBoundingClientRect()
      setMarks(
        quotes.flatMap((quote) => {
          const range = quote.locate()
          // Le premier rectangle : celui de la premiere ligne du passage, la ou
          // le regard entre. Un passage sur trois lignes en a trois.
          const box = range?.getClientRects()[0]
          if (!range || !box) return []
          return [
            {
              id: quote.id,
              n: quote.n,
              left: Math.max(
                (gutter ? columnLeft(range, box.left) : box.left) -
                  base.left +
                  element.scrollLeft,
                QUOTE_MARK_MIN_LEFT
              ),
              // Le milieu de la ligne, pas son sommet : la pastille se centre
              // dessus quelle que soit la hauteur du texte cite — un titre, un
              // paragraphe, une ligne de code.
              top: box.top + box.height / 2 - base.top + element.scrollTop
            }
          ]
        })
      )
    }

    measure()
    // La largeur du panneau change au glissement de la poignee : le texte se
    // recompose, les passages bougent.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [quotes, pulse, frame, gutter])

  if (marks.length === 0) return null

  return (
    <div className="quote-marks" aria-hidden="true">
      {marks.map((mark) => (
        <span key={mark.id} className="quote-mark" style={{ left: mark.left, top: mark.top }}>
          {mark.n}
        </span>
      ))}
    </div>
  )
}

/** Une question posee depuis ailleurs — « Expliquer » sur un passage surligne. */
export interface ChatAsk {
  prompt: string
}

/**
 * Un passage des notes accroche a la question en cours — « Mentionner » sur une
 * selection de la feuille.
 *
 * A la difference de `ChatAsk`, rien ne part tout de suite : le passage rejoint
 * la barre de saisie et attend la question qu'on veut poser dessus. C'est la
 * meme mecanique que citer une reponse, prise a l'autre bout de l'ecran.
 *
 * L'etendue voyage avec le texte : c'est elle qui peint le passage dans la
 * feuille et qui y place sa pastille, le temps que la question s'ecrive.
 */
export interface ChatMention {
  text: string
  /** « mes notes, p. 12 » — ce que le crochet de la citation dira au modele. */
  source: string
  /**
   * Ou le passage se trouve dans la feuille, a l'instant ou on le demande, ou
   * null s'il n'y est plus.
   *
   * Une fonction et non une etendue : dans un editeur, aucun noeud n'est
   * stable. Perdre le focus suffit a ce que le bloc soit repose — le plugin
   * d'ancrage y fige alors la page qu'on lisait — et une etendue gardee telle
   * quelle se replie aussitot sur le vide. Les notes suivent donc leur passage
   * en positions de document, qui traversent les modifications, et n'en tirent
   * une etendue qu'au moment de peindre.
   */
  locate: () => Range | null
}

interface ChatPanelProps {
  course: Course | null
  status: ClaudeStatus | null
  width: number
  /**
   * Part de l'espace a prendre, quand ce panneau n'a plus de largeur a lui —
   * les notes masquees, il n'y a plus de panneau souple pour absorber le reste
   * et les sections restantes se partagent l'ecran. Absent : c'est `width` qui
   * commande, comme d'habitude.
   */
  grow?: number
  expanded: boolean
  /** Question venue du panneau du cours. */
  ask: ChatAsk | null
  /** Previent qu'elle est partie, pour qu'elle ne reparte pas au rendu suivant. */
  onAsked: () => void
  /** Passage des notes a accrocher a la question en cours. */
  mention: ChatMention | null
  /** Previent qu'il est pris, pour qu'il ne soit pas repris au rendu suivant. */
  onMentioned: () => void
  /**
   * Le cadre de la feuille de notes, ou se posent les pastilles des passages
   * mentionnes. Null quand le panneau des notes est replie : les passages
   * restent alors dans la barre de saisie, sans repere en face.
   */
  notesStage: HTMLElement | null
  onToggleExpand: () => void
  onOpenPage?: (page: number) => void
  /** Recopie une reponse en fin de note. */
  onInsertToNotes: (markdown: string) => void
  /** Les ecritures de notes s'appliquent sans validation. */
  autoApply: boolean
  onToggleAuto: () => void
}

/**
 * La taille du panneau : rien en mode concentration, ou le CSS l'etale ; une
 * part de l'espace quand il en partage un ; sa largeur sinon.
 */
function panelStyle(
  expanded: boolean,
  width: number,
  grow: number | undefined
): React.CSSProperties | undefined {
  if (expanded) return undefined
  if (grow !== undefined) return { flex: `${grow} 1 0` }
  return { width }
}

export default function ChatPanel({
  course,
  status,
  width,
  grow,
  expanded,
  ask,
  onAsked,
  mention,
  onMentioned,
  notesStage,
  onToggleExpand,
  onOpenPage,
  onInsertToNotes,
  autoApply,
  onToggleAuto
}: ChatPanelProps): React.JSX.Element {
  const {
    messages,
    busy,
    compacting,
    send,
    stop,
    clear,
    cancelTrace,
    answerQuiz,
    skipQuiz,
    history,
    openSession,
    compact
  } =
    useChat(course?.id ?? null)
  const [draft, setDraft] = useState('')

  /**
   * Les passages auxquels la question en cours repond, dans l'ordre ou ils ont
   * ete pris — c'est ce rang qu'on lit dans les pastilles.
   */
  const [quotes, setQuotes] = useState<PendingQuote[]>([])
  /** La selection en attente, et le bouton « Citer » pose au-dessus d'elle. */
  const [cite, setCite] = useState<{
    messageId: string
    text: string
    range: Range
    anchor: { x: number; y: number }
  } | null>(null)
  const nextQuoteId = useRef(0)

  // Modeles proposes par Claude Code, selon l'abonnement. La chaine vide
  // signifie « ne rien imposer » : c'est alors le reglage par defaut qui joue.
  const [models, setModels] = useState<ChatModel[]>([])
  const [model, setModel] = usePersisted('noted.chat.model', '')
  const [effort, setEffort] = usePersisted('noted.chat.effort', '')

  useEffect(() => {
    // Un echec ici laisse simplement le selecteur sur « Automatique ».
    void window.noted.claude.models().then(setModels).catch(() => undefined)
  }, [])

  const scrollRef = useRef<HTMLDivElement>(null)
  /**
   * Le meme element que `scrollRef`, mais tenu en etat : le calque des
   * pastilles se place a la mesure, ce qu'un ref seul ne saurait pas declencher.
   * Le rappel est fige : une fonction recreee a chaque rendu ferait detacher
   * puis rattacher le noeud sans fin.
   */
  const [thread, setThread] = useState<HTMLDivElement | null>(null)
  const attachThread = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element
    setThread(element)
  }, [])

  /**
   * Ce qui identifie le fil affiche : le cours, et le premier message.
   *
   * Le cours seul ne suffit pas — reprendre une conversation dans
   * l'historique, ou repartir a neuf, remplace tout le fil sans changer de
   * cours. Le premier message, lui, change a chaque fois : une reprise en
   * apporte un autre, « Nouvelle conversation » n'en laisse aucun. Pendant
   * qu'une reponse s'ecrit, en revanche, il ne bouge pas — les messages
   * s'ajoutent a la fin.
   */
  const threadKey = `${course?.id ?? ''}|${messages[0]?.id ?? ''}`
  const lastThread = useRef<string | null>(null)

  /**
   * Ou se place le fil quand il change.
   *
   * Deux situations, et une seule regle ne peut pas servir les deux. Un fil
   * qu'on vient d'ouvrir — arrivee sur un cours, retour sur un cours deja lu,
   * reprise d'historique — s'ouvre sur sa fin : c'est le dernier echange qu'on
   * revient lire, jamais le premier. Sans cela le fil s'ouvrait en haut, et il
   * fallait le derouler entierement pour retrouver ou on en etait.
   *
   * Une reponse qui s'ecrit, elle, respecte la position : si l'utilisateur est
   * remonte relire un passage, la suivre de force lui arracherait sa lecture.
   * D'ou le seuil — on ne suit que celui qui etait deja au bas du fil.
   *
   * `useLayoutEffect` plutot que `useEffect` : le saut se fait avant que
   * l'ecran soit peint, sinon on verrait le haut de la conversation une image
   * durant.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const ouverture = lastThread.current !== threadKey
    lastThread.current = threadKey

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight
    if (ouverture || distanceFromBottom < 140) {
      element.scrollTop = element.scrollHeight
    }
  }, [messages, threadKey])

  // « default » est l'entree que Claude Code declare lui-meme pour son reglage
  // courant : on la traduit par une absence de choix, plutot que de la
  // transmettre au SDK comme s'il s'agissait d'un modele.
  const chosenModel = model || DEFAULT_MODEL

  const choice = useMemo(
    () => ({
      model: chosenModel === DEFAULT_MODEL ? undefined : chosenModel,
      // Un niveau envoye a un modele qui n'en accepte pas serait refuse. Le
      // garde-fou est ici plutot que dans l'interface : il tient meme si le
      // choix a ete fait avant que la liste des modeles soit connue.
      effort:
        effort && supportsEffort(models, chosenModel)
          ? (effort as ChatEffort)
          : undefined
    }),
    [chosenModel, effort, models]
  )

  const submit = useCallback(() => {
    if (!draft.trim() || busy) return
    // Le rang est fixe ici, a l'envoi : retirer la citation 2 renumerote les
    // suivantes, et ce qui part au modele doit dire la meme chose que ce qu'on
    // vient de lire a l'ecran.
    void send(
      draft,
      choice,
      quotes.map((quote, index) => ({ n: index + 1, text: quote.text, source: quote.source }))
    )
    setDraft('')
    setQuotes([])
  }, [draft, busy, send, choice, quotes])

  /**
   * La copie d'un quiz. Tant que le tour ecoute, elle lui revient comme
   * resultat d'outil et la correction s'enchaine dans la meme reponse. Quand
   * il ne repond plus, elle part comme message ordinaire : c'est moins elegant
   * mais rien n'est perdu, et l'assistant corrige quand meme.
   */
  const submitQuiz = useCallback(
    (messageId: string, quiz: QuizForm, answers: QuizAnswer[], orphaned: boolean) => {
      answerQuiz(messageId, quiz.id, answers)
      if (!orphaned) return

      const copy = formatQuizCopy(quiz.questions, answers, 'Ma réponse')
      void send(
        `Voici ma copie du quiz${quiz.titre ? ` « ${quiz.titre} »` : ''}. ${QUIZ_CORRECTION_BRIEF}\n\n${copy}`,
        choice
      )
    },
    [answerQuiz, send, choice]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Entree envoie, Maj+Entree passe a la ligne : la convention des
      // messageries, plus rapide que de viser un bouton.
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submit()
        return
      }

      // Sur un champ vide, la correction remonte a la citation precedente,
      // comme elle le ferait sur le mot precedent.
      if (event.key === 'Backspace' && !draft && quotes.length > 0) {
        event.preventDefault()
        setQuotes((current) => current.slice(0, -1))
      }
    },
    [submit, draft, quotes.length]
  )

  // Les citations « (p. 12) » des reponses ramenent au bon endroit du cours.
  const handleAnswerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = (event.target as HTMLElement).closest('[data-page]')
      if (!target) return
      const page = Number(target.getAttribute('data-page'))
      if (Number.isFinite(page)) onOpenPage?.(page)
    },
    [onOpenPage]
  )

  /**
   * Proposer de citer ce qu'on vient de selectionner.
   *
   * Tout se decide au relachement : c'est le seul moment ou la selection est
   * arretee. L'ecoute est posee sur le document plutot que sur le fil, sans quoi
   * un glissement parti d'une reponse et termine dans les notes — le geste
   * ordinaire quand on selectionne jusqu'en bas — ne serait jamais vu.
   */
  useEffect(() => {
    const onUp = (event: MouseEvent): void => {
      // Le bouton « Citer » est lui-meme relache a la souris : le laisser
      // relancer ce calcul le ferait reapparaitre juste apres son propre clic.
      if (event.target instanceof Element && event.target.closest('.quote-pop')) return

      // Reporte d'un tour : cliquer dans une selection ne la defait qu'apres
      // les ecouteurs, et le passage semblerait encore pris.
      window.setTimeout(() => {
        const passage = selectedPassage()
        if (!passage) {
          setCite(null)
          return
        }
        setCite({
          messageId: passage.messageId,
          text: passage.text,
          range: passage.range,
          anchor: { x: (passage.box.left + passage.box.right) / 2, y: passage.box.top }
        })
      }, 0)
    }

    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [])

  const addQuote = useCallback(() => {
    if (!cite) return

    setQuotes((current) => {
      // Deux fois le meme passage n'apporte rien et brouille la numerotation.
      const already = current.some(
        (quote) => quote.messageId === cite.messageId && quote.text === cite.text
      )
      if (already) return current

      nextQuoteId.current += 1
      const range = cite.range
      return [
        ...current,
        {
          id: `q-${nextQuoteId.current}`,
          messageId: cite.messageId,
          text: cite.text,
          locate: () => range
        }
      ]
    })

    // La selection a fait son office : elle laisse la place au surlignage de la
    // citation, qui serait sinon recouvert par le bleu du systeme.
    window.getSelection()?.removeAllRanges()
    setCite(null)
    inputRef.current?.focus()
  }, [cite])

  const dropQuote = useCallback((id: string) => {
    setQuotes((current) => current.filter((quote) => quote.id !== id))
  }, [])

  /**
   * Le rang se calcule une fois, sur la liste entiere, puis se distribue aux
   * deux cadres. C'est ce qui fait qu'un passage des notes et une phrase de
   * l'assistant portent des numeros qui se suivent dans un meme message —
   * numeroter chaque cadre pour lui-meme donnerait deux « 1 » a l'ecran.
   */
  const numbered = useMemo<NumberedQuote[]>(
    () => quotes.map((quote, index) => ({ ...quote, n: index + 1 })),
    [quotes]
  )
  const answerMarks = useMemo(
    () => numbered.filter((quote) => quote.messageId !== null),
    [numbered]
  )
  const noteMarks = useMemo(
    () => numbered.filter((quote) => quote.messageId === null),
    [numbered]
  )

  /**
   * Ce qui fait redessiner les passages de la feuille quand elle bouge sous
   * eux.
   *
   * Leurs positions se mettent a jour toutes seules — la feuille les suit a
   * travers les modifications — mais rien ne dit ici qu'il faut les repeindre.
   * Le premier changement arrive des le clic sur « Mentionner » : le focus part
   * a la barre de saisie, l'editeur repose le bloc quitte, et une etendue
   * calculee avant ce moment-la ne montrerait rien.
   *
   * L'observateur n'est arme que tant qu'un passage attend, et se contente de
   * compter : un rendu par salve de modifications, pas un par noeud touche.
   */
  const [pulse, setPulse] = useState(0)
  useEffect(() => {
    if (!notesStage || noteMarks.length === 0) return undefined

    let queued = false
    const observer = new MutationObserver(() => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        setPulse((tick) => tick + 1)
      })
    })
    observer.observe(notesStage, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [notesStage, noteMarks.length])

  useEffect(() => {
    paintQuotes(quotes)
    return () => paintQuotes([])
  }, [quotes, pulse])

  /**
   * Une citation ne survit pas a la reponse d'ou elle vient : « Nouveau », une
   * reprise d'historique ou un changement de cours emportent le message, et son
   * etendue ne designe plus rien a l'ecran.
   */
  useEffect(() => {
    setQuotes((current) => {
      const kept = current.filter(
        (quote) =>
          // Un passage des notes ne releve d'aucune reponse : il survit a
          // « Nouveau » comme a une reprise d'historique, puisque la feuille,
          // elle, n'a pas bouge.
          quote.messageId === null ||
          messages.some((message) => message.id === quote.messageId)
      )
      return kept.length === current.length ? current : kept
    })
  }, [messages])

  /**
   * Changer de cours emporte les passages des notes : la feuille est remplacee,
   * leur etendue ne designe plus rien, et la question qu'on ecrivait portait sur
   * un autre cours. Ceux du fil partent d'eux-memes avec la conversation.
   */
  useEffect(() => {
    setQuotes((current) => {
      const kept = current.filter((quote) => quote.messageId !== null)
      return kept.length === current.length ? current : kept
    })
  }, [course?.id])

  /**
   * Un passage des notes vient d'etre mentionne : il rejoint la barre de saisie
   * et lui rend la main, pour que la question s'ecrive dans la foulee.
   *
   * Meme garde que pour `ask`, et pour la meme raison : l'effet peut retourner
   * entre l'ajout et le rendu qui rend la demande — il le fait deux fois
   * d'affilee en developpement — et le passage entrerait alors en double.
   */
  const mentioned = useRef<ChatMention | null>(null)
  useEffect(() => {
    if (!mention || mentioned.current === mention) return
    mentioned.current = mention
    onMentioned()

    setQuotes((current) => {
      const already = current.some(
        (quote) => quote.messageId === null && quote.text === mention.text
      )
      if (already) return current

      nextQuoteId.current += 1
      return [
        ...current,
        {
          id: `q-${nextQuoteId.current}`,
          messageId: null,
          source: mention.source,
          text: mention.text,
          locate: mention.locate
        }
      ]
    })

    inputRef.current?.focus()
  }, [mention, onMentioned])

  /**
   * Une question venue du panneau du cours. Elle est rendue des qu'elle est
   * partie, plutot que retenue par un compteur : « Expliquer » ouvre
   * l'assistant en meme temps qu'il pose la question, donc ce panneau nait
   * avec la demande deja en main — un compteur initialise au montage la
   * prendrait pour deja traitee, et la toute premiere question serait perdue.
   */
  const asked = useRef<ChatAsk | null>(null)
  useEffect(() => {
    // Sur l'objet lui-meme, et pas seulement sur sa presence : entre l'envoi et
    // le rendu qui rend la demande, l'effet peut retourner — il le fait deux
    // fois d'affilee en developpement — et la question partait alors en double.
    if (!ask || asked.current === ask) return
    asked.current = ask
    onAsked()
    void send(ask.prompt, choice)
  }, [ask, onAsked, send, choice])

  const disabled = !course || !status?.ready

  // L'amorce ne defile que sur une barre vide et disponible.
  const typed = useTypewriter(!draft && !disabled)

  const inputRef = useRef<HTMLTextAreaElement>(null)

  /**
   * Prendre la barre, c'est annoncer une question : le moteur de vecteurs se
   * charge pendant la frappe, pour que le premier message trouve un moteur
   * chaud — le rappel de memoire choisit alors ses entrees par le sens, et la
   * premiere recherche du modele n'attend pas non plus. Une fois par demi-
   * minute suffit : le moteur reste chaud entre deux questions.
   */
  const lastWarm = useRef(0)
  const warmEngine = useCallback(() => {
    const now = Date.now()
    if (now - lastWarm.current < 30_000) return
    lastWarm.current = now
    void window.noted.claude.warm().catch(() => undefined)
  }, [])

  /**
   * Toute la pilule ramene au champ : l'orbe, le filet et les marges ne sont
   * pas des cibles de saisie, mais on clique dessus en visant la barre.
   */
  const focusField = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    // Le rond d'envoi garde son clic, et le champ garde le placement du curseur.
    if (target === inputRef.current || target.closest('.composer-round-send')) return
    event.preventDefault()
    inputRef.current?.focus()
  }, [])

  return (
    <section className="panel panel--chat" style={panelStyle(expanded, width, grow)}>
      <header className="panel-head">
        <PanelLabel
          label="Assistant"
          shortcut="⌘3"
          expanded={expanded}
          onToggle={onToggleExpand}
        />
        <div className="panel-head-actions">
          {/* Les ecritures de notes s'appliquent sans validation quand il est
              actif. Le garde-fou devient la visibilite : la carte reste
              affichee dans le panneau des notes, avec « Annuler ». */}
          <button
            className="icon-button"
            data-active={autoApply}
            onClick={onToggleAuto}
            title={
              autoApply
                ? 'Auto actif : les modifications de notes proposées par l’assistant s’appliquent sans validation. L’annulation reste possible. Cliquer pour revenir à la validation.'
                : 'Appliquer automatiquement les modifications de notes proposées par l’assistant, sans validation à chaque fois'
            }
            aria-pressed={autoApply}
          >
            Auto
          </button>

          <HistoryPicker
            disabled={!course}
            loadHistory={history}
            onPick={(sessionId) => void openSession(sessionId)}
          />

          {messages.length > 0 && (
            <button
              className="icon-button"
              onClick={() => void compact()}
              disabled={compacting || busy}
              title="Compacter : résume l'échange précédent pour alléger les prochains messages, sans rien retirer de ce fil"
            >
              {compacting ? 'Compaction…' : 'Compacter'}
            </button>
          )}

          {messages.length > 0 && (
            <button
              className="icon-button"
              onClick={clear}
              title="Nouvelle conversation : l'actuelle reste consultable dans l'historique"
            >
              Nouveau
            </button>
          )}
        </div>
      </header>

      <div className="panel-body chat-body" ref={attachThread}>
        {!status?.ready && status && (
          <div className="chat-notice" data-tone="error">
            {status.detail}
          </div>
        )}

        {messages.length === 0 && status?.ready && (
          <ChatIntro course={course} onPick={(text) => void send(text, choice)} />
        )}

        {messages.map((message) => (
          <Message
            key={message.id}
            message={message}
            onClick={handleAnswerClick}
            onInsert={onInsertToNotes}
            onCancelTrace={cancelTrace}
            onAnswerQuiz={submitQuiz}
            onSkipQuiz={skipQuiz}
          />
        ))}

        <QuoteMarks quotes={answerMarks} frame={thread} pulse={messages} />
      </div>

      {/* Les pastilles des passages mentionnes se posent dans la feuille, pas
          ici : c'est la que se trouve le texte qu'elles numerotent. Le calque
          est envoye dans le cadre des notes, qui defile avec le texte comme le
          fil defile avec les reponses. */}
      {notesStage && noteMarks.length > 0
        ? createPortal(
            <QuoteMarks quotes={noteMarks} frame={notesStage} pulse={pulse} gutter />,
            notesStage
          )
        : null}

      {cite && (
        <button
          type="button"
          className="quote-pop"
          style={{ left: cite.anchor.x, top: Math.max(cite.anchor.y, QUOTE_POP_MIN_TOP) }}
          // Sans cela, l'appui sur le bouton defait la selection avant meme que
          // le clic parte : on citerait le vide.
          onMouseDown={(event) => event.preventDefault()}
          onClick={addQuote}
          title="Répondre à ce passage : il rejoint la barre de saisie, numéroté"
        >
          <span className="quote-pop-glyph" aria-hidden="true">
            ❝
          </span>
          Citer
        </button>
      )}

      <div className="composer">
        {quotes.length > 0 && (
          <div className="composer-quotes">
            {quotes.map((quote, index) => (
              <div className="composer-quote" key={quote.id}>
                <span className="composer-quote-n" aria-hidden="true">
                  {index + 1}
                </span>
                {quote.source && <span className="quote-source">{quote.source}</span>}
                <span className="composer-quote-text">{quote.text}</span>
                <button
                  type="button"
                  className="composer-quote-drop"
                  onClick={() => dropQuote(quote.id)}
                  title="Retirer cette citation"
                  aria-label={`Retirer la citation ${index + 1}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composer-field" onMouseDown={focusField}>
          <textarea
            ref={inputRef}
            className="composer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={warmEngine}
            placeholder={disabled ? 'Assistant indisponible' : typed}
            rows={1}
            disabled={disabled}
          />
          <button
            type="button"
            className="composer-round-send"
            data-visible={busy || Boolean(draft.trim())}
            data-tone={busy ? 'stop' : undefined}
            onClick={busy ? stop : submit}
            disabled={busy ? false : disabled || !draft.trim()}
            title={busy ? 'Arrêter' : 'Envoyer'}
            aria-label={busy ? 'Arrêter' : 'Envoyer'}
          >
            <span aria-hidden="true">{busy ? '■' : '↑'}</span>
          </button>
        </div>
        <div className="composer-actions">
          <div className="composer-settings">
            <Picker
              label={modelLabel(models, chosenModel)}
              title="Modèle utilisé pour répondre"
              disabled={models.length === 0}
              options={models.map((entry) => ({
                value: entry.value,
                label: entry.displayName,
                description: entry.description
              }))}
              selected={chosenModel}
              onSelect={setModel}
            />

            <Picker
              label={effortLabel(effort)}
              title="Niveau de réflexion avant la réponse"
              disabled={!supportsEffort(models, chosenModel)}
              options={[
                {
                  value: '',
                  label: 'Automatique',
                  description: 'Le niveau par défaut de ce modèle.'
                },
                ...availableLevels(models, chosenModel).map((level) => ({
                  value: level.value as string,
                  label: level.label,
                  description: level.description
                }))
              ]}
              selected={effort}
              onSelect={setEffort}
            />
          </div>

          {busy && <span className="composer-hint">Claude répond…</span>}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Choix du modele et du niveau de reflexion
// ---------------------------------------------------------------------------

function selectedModel(models: ChatModel[], value: string): ChatModel | null {
  return models.find((entry) => entry.value === value) ?? null
}

function modelLabel(models: ChatModel[], value: string): string {
  const found = selectedModel(models, value)
  if (found) return found.displayName
  // Avant que la liste soit connue, ou si un modele choisi disparait de
  // l'abonnement : on montre la valeur brute plutot qu'un libelle vide.
  return value === DEFAULT_MODEL ? 'Par défaut' : value
}

function effortLabel(value: string): string {
  // « Auto », comme Claude Desktop l'appelle : plus court que « Reflexion
  // auto », ce qui laisse de la place aux deux puces dans un panneau etroit.
  if (!value) return 'Auto'
  return EFFORT_LEVELS.find((level) => level.value === value)?.label ?? value
}

/**
 * Un modele qui ne declare aucun niveau n'en accepte pas — c'est le cas de
 * Haiku. Tant que la liste n'est pas chargee, on n'en propose pas non plus :
 * mieux vaut un selecteur grise une seconde qu'un niveau refuse a l'envoi.
 */
function availableLevels(models: ChatModel[], value: string): typeof EFFORT_LEVELS {
  const found = selectedModel(models, value)
  if (!found || found.supportsEffort === false) return []

  const allowed = found.supportedEffortLevels ?? []
  return EFFORT_LEVELS.filter((level) => allowed.includes(level.value))
}

function supportsEffort(models: ChatModel[], value: string): boolean {
  return availableLevels(models, value).length > 0
}

interface PickerOption {
  value: string
  label: string
  description: string
}

/**
 * Petit selecteur de la barre de chat. Il s'ouvre vers le haut : le composeur
 * est colle au bas du panneau, un menu vers le bas sortirait de la fenetre.
 */
function Picker({
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

/**
 * Le picker d'historique de l'entete : les conversations passees de ce
 * cours, chargees a l'ouverture plutot que gardees a jour en continu — un
 * menu qu'on rouvre rarement n'a pas besoin de suivre le fil en direct.
 */
function HistoryPicker({
  disabled,
  loadHistory,
  onPick
}: {
  disabled: boolean
  loadHistory: () => Promise<ChatHistoryEntry[]>
  onPick: (sessionId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<ChatHistoryEntry[] | null>(null)
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

  const toggle = useCallback(() => {
    setOpen((value) => {
      const next = !value
      if (next) {
        setEntries(null)
        void loadHistory().then(setEntries)
      }
      return next
    })
  }, [loadHistory])

  return (
    <div className="history-picker" ref={ref}>
      <button
        className="icon-button"
        data-active={open}
        onClick={toggle}
        disabled={disabled}
        title="Reprendre une conversation passée de ce cours"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        Historique
      </button>

      {open && (
        <div className="history-menu" role="listbox">
          {entries === null && <div className="history-empty">Chargement…</div>}
          {entries?.length === 0 && (
            <div className="history-empty">Aucune conversation enregistrée pour ce cours.</div>
          )}
          {entries?.map((entry) => (
            <button
              key={entry.sessionId}
              className="history-item"
              role="option"
              aria-selected={entry.active}
              data-active={entry.active}
              onClick={() => {
                onPick(entry.sessionId)
                setOpen(false)
              }}
            >
              <span className="history-item-title">{entry.title}</span>
              <span className="history-item-date">{historyLabel(entry.lastModified)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** « aujourd'hui a 14:32 », « hier a 09:05 », « il y a 5 j » — comme le reste de l'app. */
function historyLabel(lastModified: number): string {
  const then = new Date(lastModified)
  const now = new Date()
  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  const time = then.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

  if (days <= 0) return `aujourd'hui à ${time}`
  if (days === 1) return `hier à ${time}`
  if (days < 7) return `il y a ${days} j`
  return then.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

/** Un chiffre rond plutot qu'un compte exact : ce qui compte est l'ordre de grandeur. */
function formatDroppedTokens(tokens: number): string {
  const rounded = Math.max(100, Math.round(tokens / 100) * 100)
  return `${rounded.toLocaleString('fr-FR')} tokens`
}

/** Quelques amorces, pour ne pas ouvrir sur un champ vide. */
function ChatIntro({
  course,
  onPick
}: {
  course: Course | null
  onPick: (prompt: string) => void
}): React.JSX.Element {
  const suggestions = [
    'Résume ce cours en dix points',
    'Quels sont les concepts à maîtriser absolument ici ?',
    'Explique-moi la partie que tu juges la plus difficile',
    'Interroge-moi sur ce cours'
  ]

  return (
    <div className="chat-intro">
      <p className="chat-intro-title">
        {course ? `J'ai lu « ${course.title} » en entier.` : 'Aucun cours ouvert.'}
      </p>
      <p className="chat-intro-hint">
        Pose une question, ou commence par l'une de celles-ci.
      </p>
      <div className="chat-suggestions">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            className="chat-suggestion"
            onClick={() => onPick(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Les gestes d'ecriture en memoire ont leur propre carte, plus riche et
 * annulable : leur ligne d'appel d'outil ferait doublon. « se_souvenir », lui,
 * est une lecture ordinaire et garde sa ligne.
 */
/**
 * Les appels dont la ligne d'etape n'est pas affichee. Les ecritures en
 * memoire ont leur propre trace, plus riche et annulable ; le quiz a sa carte,
 * autrement plus parlante qu'une ligne « Quiz · 5 questions ».
 */
const HIDDEN_TOOLS = new Set([
  'mcp__memoire__memoire_noter',
  'mcp__memoire__memoire_corriger',
  'mcp__memoire__memoire_oublier',
  'mcp__memoire__memoire_lier',
  QUIZ_TOOL
])

function Message({
  message,
  onClick,
  onInsert,
  onCancelTrace,
  onAnswerQuiz,
  onSkipQuiz
}: {
  message: ChatMessage
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void
  onInsert: (markdown: string) => void
  onCancelTrace: (traceId: string) => void
  onAnswerQuiz: (
    messageId: string,
    quiz: QuizForm,
    answers: QuizAnswer[],
    orphaned: boolean
  ) => void
  onSkipQuiz: (messageId: string, quizId: string) => void
}): React.JSX.Element {
  // Le texte recu arrive par bouffees ; on le laisse apparaitre a cadence
  // reguliere pour que la lecture suive sans a-coups.
  const visible = useSmoothText(message.text, Boolean(message.streaming))

  /**
   * Ou la carte de quiz se pose dans le corps de la reponse. `quizAt` est la
   * longueur du texte au moment ou l'outil a ete appele : la phrase qui
   * annonce le quiz reste au-dessus, la correction s'ecrit en dessous. Tant
   * que le texte revele n'a pas atteint ce point, la carte attend — elle
   * arrive donc pile quand l'annonce finit de s'ecrire.
   */
  const quizAt =
    message.quiz && message.quizAt !== undefined && visible.length >= message.quizAt
      ? message.quizAt
      : null

  /**
   * Une carte dont plus personne n'attend la copie. Un appel d'outil retient
   * le tour tant qu'il n'a pas rendu : si le tour est fini alors que la carte
   * n'a pas ete envoyee, c'est que l'appel est mort en route — le moteur l'a
   * coupe, ou la reponse a echoue. L'envoi bascule alors sur le repli.
   */
  const orphaned = Boolean(message.quiz) && !message.streaming && !message.quizAnswers

  const html = useMemo(
    () =>
      message.role === 'assistant'
        ? renderAnswer(quizAt === null ? visible : visible.slice(0, quizAt))
        : null,
    [message.role, visible, quizAt]
  )

  /** Ce qui s'ecrit apres la carte : la correction de la copie. */
  const htmlAfter = useMemo(
    () => (quizAt === null ? null : renderAnswer(visible.slice(quizAt))),
    [visible, quizAt]
  )

  /**
   * L'objet passe a `dangerouslySetInnerHTML`, garde d'un rendu a l'autre.
   *
   * React compare les proprietes par identite avant de les reposer : un objet
   * fabrique dans le JSX est neuf a chaque rendu, et le corps de la reponse
   * etait donc reecrit a chaque fois, meme quand le HTML n'avait pas bouge d'un
   * caractere. Les noeuds de texte etaient alors detruits et refaits — et avec
   * eux toute etendue qui pointait dedans : la selection d'une reponse
   * disparaissait a chaque token de la suivante, et les passages cites
   * perdaient leur place. Memoriser l'objet suffit a ce que React n'y touche
   * plus tant que le texte est le meme.
   */
  const inner = useMemo(() => (html ? { __html: html } : null), [html])
  const innerAfter = useMemo(() => (htmlAfter ? { __html: htmlAfter } : null), [htmlAfter])

  /**
   * Accuse de reception de l'insertion. Le geste agit dans un autre panneau :
   * sans ce retour sur le bouton lui-meme, rien ne dirait qu'il a porte.
   */
  const [inserted, setInserted] = useState(false)
  const insert = useCallback(() => {
    onInsert(message.text)
    setInserted(true)
    window.setTimeout(() => setInserted(false), 2000)
  }, [onInsert, message.text])

  if (message.role === 'system') {
    return (
      <div className="message message--system" data-tone={message.error ? 'error' : undefined}>
        <span className="message-system-line" aria-hidden="true" />
        <span className="message-system-text">
          {message.error
            ? `Compaction impossible — ${message.error}`
            : typeof message.compactedTokens === 'number' && message.compactedTokens > 0
              ? `Conversation compactee · ${formatDroppedTokens(message.compactedTokens)} liberes`
              : 'Conversation compactee'}
        </span>
        <span className="message-system-line" aria-hidden="true" />
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className="message message--user">
        {/* Ce a quoi la question repondait. Sans elles, « developpe les deux »
            relu trois jours plus tard ne veut plus rien dire. */}
        {message.quotes && message.quotes.length > 0 && (
          <div className="message-quotes">
            {message.quotes.map((quote) => (
              <div className="message-quote" key={quote.n}>
                <span className="message-quote-n" aria-hidden="true">
                  {quote.n}
                </span>
                {quote.source && <span className="quote-source">{quote.source}</span>}
                <span className="message-quote-text">{quote.text}</span>
              </div>
            ))}
          </div>
        )}
        <p className="message-text">{message.text}</p>
      </div>
    )
  }

  return (
    <div className="message message--assistant">
      {message.thinking && (
        <Step
          label="Réflexion"
          running={Boolean(message.streaming) && !message.text}
          sections={[{ title: null, body: message.thinking }]}
        />
      )}

      {message.toolCalls
        ?.filter((call) => !HIDDEN_TOOLS.has(call.name))
        .map((call) => (
          <Step
            key={call.id}
            label={call.summary}
            running={Boolean(call.running)}
            sections={[
              { title: 'Demande', body: call.detail },
              { title: 'Résultat', body: call.result }
            ]}
          />
        ))}

      {message.memoryTraces?.map((trace) => (
        <MemoryTraceRow key={trace.id} trace={trace} onCancel={onCancelTrace} />
      ))}

      {inner && (
        <div
          className="message-text message-markdown"
          // Ce qui rattache un passage selectionne a la reponse d'ou il vient.
          data-message-id={message.id}
          onClick={onClick}
          dangerouslySetInnerHTML={inner}
        />
      )}

      {message.quiz && quizAt !== null && (
        <QuizCard
          quiz={message.quiz}
          answers={message.quizAnswers}
          orphaned={orphaned}
          onSubmit={(answers) => onAnswerQuiz(message.id, message.quiz!, answers, orphaned)}
          onSkip={() => onSkipQuiz(message.id, message.quiz!.id)}
        />
      )}

      {innerAfter && (
        <div
          className="message-text message-markdown"
          data-message-id={message.id}
          onClick={onClick}
          dangerouslySetInnerHTML={innerAfter}
        />
      )}

      {!message.streaming && !message.error && message.text.trim() && (
        <div className="message-actions">
          <button
            className="message-action"
            onClick={insert}
            disabled={inserted}
            title="Recopier cette réponse dans mes notes, à sa place dans l'ordre du cours"
          >
            {inserted ? 'Insérée dans les notes ✓' : 'Insérer dans mes notes'}
          </button>
        </div>
      )}

      {message.streaming && !visible && <Thinking tokens={message.tokens} />}

      {message.error && <div className="message-error">{message.error}</div>}
    </div>
  )
}

/**
 * Une etape intermediaire : recherche, lecture, detour par le web. Repliee,
 * elle tient sur une ligne ; depliee, elle montre ce qui a ete demande et ce
 * qui a ete obtenu — de quoi juger une reponse plutot que de la croire.
 */
function Step({
  label,
  running,
  sections
}: {
  label: string
  running: boolean
  sections: Array<{ title: string | null; body?: string }>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const filled = sections.filter((section) => section.body?.trim())
  const expandable = filled.length > 0

  return (
    <div className="step" data-open={open}>
      <button
        className="step-head"
        onClick={() => expandable && setOpen((value) => !value)}
        data-expandable={expandable}
        aria-expanded={expandable ? open : undefined}
        title={expandable ? 'Voir le détail' : label}
      >
        <span className="step-marker" data-running={running} aria-hidden="true" />
        <span className="step-label">{label}</span>
        {expandable && (
          <span className="step-caret" aria-hidden="true">
            ›
          </span>
        )}
      </button>

      {open && (
        <div className="step-body">
          {filled.map((section, index) => (
            <div key={section.title ?? index} className="step-section">
              {section.title && <div className="step-section-title">{section.title}</div>}
              <pre className="step-section-body">{section.body}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Ce que la trace dit du geste, dans la langue de l'utilisateur. */
const TRACE_LABELS: Record<MemoryTrace['action'], string> = {
  noter: 'Mémoire · retenu',
  corriger: 'Mémoire · corrigé',
  oublier: 'Mémoire · oublié',
  lier: 'Mémoire · relié'
}

const TRACE_LEVEL_LABELS: Record<MemoryTrace['level'], string> = {
  global: 'mémoire globale',
  matiere: 'mémoire de la matière',
  cours: 'mémoire de ce cours'
}

/**
 * La trace d'une ecriture en memoire : le garde-fou du systeme. Meme allure
 * que les appels d'outils — une ligne repliee, un detail au clic — plus le
 * bouton qui annule le geste apres coup.
 */
function MemoryTraceRow({
  trace,
  onCancel
}: {
  trace: MemoryTrace
  onCancel: (traceId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className="step memory-trace" data-open={open} data-cancelled={Boolean(trace.cancelled)}>
      <div className="memory-trace-head">
        <button
          className="step-head"
          onClick={() => setOpen((value) => !value)}
          data-expandable="true"
          aria-expanded={open}
          title="Voir ce qui a été retenu"
        >
          <span className="step-marker" aria-hidden="true" />
          <span className="step-label">
            {TRACE_LABELS[trace.action]} « {trace.title} »
            {trace.cancelled ? ' — annulé' : ''}
          </span>
          <span className="step-caret" aria-hidden="true">
            ›
          </span>
        </button>
        {trace.cancellable && !trace.cancelled && (
          <button
            className="memory-trace-cancel"
            onClick={() => onCancel(trace.id)}
            title={
              trace.action === 'oublier'
                ? 'Restaurer cette entrée de la mémoire'
                : trace.action === 'corriger'
                  ? 'Revenir à la version précédente de cette entrée'
                  : trace.action === 'lier'
                    ? 'Défaire ce lien entre deux entrées'
                    : 'Retirer cette entrée de la mémoire'
            }
          >
            Annuler
          </button>
        )}
      </div>

      {open && (
        <div className="step-body">
          <div className="step-section">
            <div className="step-section-title">
              {TRACE_LEVEL_LABELS[trace.level]} · {trace.entryId}
            </div>
            <pre className="step-section-body">
              {/* Une liaison ne montre pas l'entree mais ce qu'elle vient de
                  relier : le corps n'a pas bouge. */}
              {trace.action === 'lier' ? trace.body : `## ${trace.title}\n\n${trace.body}`}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * L'attente, rendue lisible : un scintillement qui parcourt le mot, le temps
 * ecoule, et le nombre de tokens deja produits. Une reponse documentee peut
 * demander une minute ; sans ce signe, on croit l'application bloquee.
 */
function Thinking({ tokens }: { tokens?: number }): React.JSX.Element {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(
      () => setSeconds(Math.round((Date.now() - started) / 1000)),
      1000
    )
    return () => window.clearInterval(timer)
  }, [])

  const parts = [seconds > 0 ? `${seconds} s` : null, tokens ? `${tokens} tokens` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="thinking" role="status">
      <span className="thinking-glyph" aria-hidden="true">
        ✳
      </span>
      <span className="thinking-label">Réflexion</span>
      {parts && <span className="thinking-meta">{parts}</span>}
    </div>
  )
}

/**
 * Rend la reponse : Markdown mis en forme, formules composees, references de
 * page transformees en boutons.
 *
 * L'injection est sure ici : la politique de securite du document interdit
 * tout script en ligne, donc le HTML issu du Markdown ne peut rien executer.
 */
function renderAnswer(markdown: string): string {
  if (!markdown) return ''

  // Les formules sortent du texte avant l'analyse Markdown, qui prendrait
  // leurs underscores pour de l'italique.
  const { text, formulas } = protectMath(markdown)

  const html = marked.parse(text, { async: false, gfm: true })
  if (typeof html !== 'string') return ''

  return restoreMath(linkCitations(html), formulas)
}

/**
 * Un renvoi de page, sous ses deux formes.
 *
 * Seule dans sa parenthese — « (p. 64) » —, la reference l'emporte avec elle :
 * la pastille englobe les parentheses, et rien ne vient s'intercaler entre
 * elles et le chiffre. Partagee avec autre chose — « (Exhibit 1.42, p. 93-94) »
 * —, elle se prend seule, sans quoi le clic emmenerait la phrase entiere.
 */
const CITATION = /\((pp?\.\s*(\d+)(?:\s*[–—-]\s*\d+)?)\)|\b(pp?\.\s*(\d+)(?:\s*[–—-]\s*\d+)?)/g

/**
 * Transforme les renvois de page en boutons.
 *
 * Une regle qui exigeait la parenthese entiere laissait en texte mort tous les
 * renvois qui partagent leur parenthese avec autre chose — « (tranche 4 de
 * l'Exhibit 1.42, p. 93-94) », « (p. 63, notes 30 et 31 ; p. 65) » —, a cote de
 * « (p. 64) » cliquables : le meme geste marchait une fois sur deux.
 *
 * Le balayage distingue le texte du balisage. Sans quoi un « p. » tombe dans un
 * attribut y verrait s'ouvrir une balise au milieu d'une autre. Les extraits de
 * code sont sautes en entier, avec leur contenu : ce qu'ils citent est du code,
 * pas une page du cours.
 */
function linkCitations(html: string): string {
  return html.replace(/<(pre|code)\b[\s\S]*?<\/\1>|<[^>]*>|[^<]+/g, (part) =>
    part.startsWith('<')
      ? part
      : part.replace(
          CITATION,
          (match, _alone: string, alone: string, _shared: string, shared: string) => {
            const page = alone ?? shared
            return `<button class="citation" data-page="${page}" title="Aller à la page ${page}">${match}</button>`
          }
        )
  )
}
