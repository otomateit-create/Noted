import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2 } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { HIGHLIGHT_COLORS } from '@shared/types'
import type { Annotation, Course, CourseMove, HighlightColorId, NoteAnchor } from '@shared/types'
import type { ExtractedCourse, ExtractedPage, VectorStatus } from '@shared/types'
import AnnotationPalette from './AnnotationPalette'
import AnnotationsDrawer from './AnnotationsDrawer'
import DocumentFinder from './DocumentFinder'
import OcrBanner, { type OcrView } from './OcrBanner'
import OriginalView from './OriginalView'
import HighlightLegend from './HighlightLegend'
import PdfPage from './PdfPage'
import { useAnnotations } from '../hooks/useAnnotations'
import { useOcrConversion, type ConversionSource } from '../hooks/useOcrConversion'
import { useOcrResume } from '../hooks/useOcrResume'
import { describeSelection, locateAnnotation, type Passage } from '../lib/annotate'
import {
  annotationAt,
  contribute,
  flashFocus,
  withdraw,
  withdrawAll,
  type PaintedRange
} from '../lib/annotation-paint'
import {
  figuresFromMarkdown,
  htmlToContextText,
  mediaNames,
  prepareDocumentHtml,
  renderMarkdownCourse
} from '../lib/document'
import { HTML_COURSE_SCOPE, htmlCourseToContextText, prepareHtmlCourse } from '../lib/html-course'
import { withoutFrontMatter } from '../lib/markdown'
import { elementBox, passageBoxes, type Box } from '../lib/anchors'
import { headingAbove } from '../lib/find'
import { readOcrCourse, type OcrCourse } from '../lib/ocr-document'
import { extractCourse, loadDocument, type OpenDocument } from '../lib/pdf'
import { convertPptx } from '../lib/pptx'
import { readingSpot, rememberSpot } from '../lib/reading'
import {
  anchorAtLine,
  progressAtLine,
  readingLineY,
  scrollToAnchor,
  sectionAtLine,
  visibleSectionIndices,
  type ReadingAnchor
} from '../lib/reading-line'
import '../styles/anchors.css'
import '../styles/annotations.css'
import '../styles/course.css'

/**
 * En deca de quoi le curseur de defilement cesse d'etre un objet : trop court,
 * il ne se voit plus et ne s'attrape plus. Un cours de deux cents pages
 * l'amenerait a trois pixels si on le laissait suivre la proportion visible.
 */
const MIN_THUMB = 28

/**
 * Le rail et son curseur, mesures ensemble : les deux se posent au meme instant.
 *
 * Le rail est repere dans le bureau et non dans le panneau, parce qu'il ne vit
 * pas dans le panneau : il se pose dans la gouttiere qui le separe du panneau
 * voisin, et un panneau rogne ce qui deborde de lui.
 */
interface ScrollbarGeometry {
  /** La gouttiere, dans le repere du bureau. */
  trackLeft: number
  trackTop: number
  trackHeight: number
  /** Le curseur, dans le repere du rail. */
  thumbTop: number
  thumbHeight: number
}

/**
 * Emballage du contenu d'un document sans pagination. Word et Markdown n'ont
 * pas de pages : on n'en invente pas, et l'ancre « section » indique a l'IA de
 * citer les titres plutot que des numeros introuvables.
 */
function unpaginated(courseId: string, text: string): ExtractedCourse {
  // Les mentions de figures ne comptent pas comme du texte lu : un document
  // qui n'est qu'une suite d'images doit etre signale comme tel.
  const readable = text.replace(/\[figure[^\]]*\]/g, '').trim()

  return {
    courseId,
    anchor: 'section',
    pageCount: 1,
    pages: [{ page: 1, text }],
    markdown: text,
    approxTokens: Math.ceil(text.length / 3.6),
    looksScanned: readable.length < 200
  }
}

/**
 * Transmet le texte extrait au processus principal, sans jamais faire echouer
 * l'affichage.
 *
 * L'indexation est un supplement : le document se lit parfaitement sans elle.
 * Laisser son echec remonter donnait le resultat absurde d'un bandeau « ce
 * document est illisible » pose au-dessus d'un document parfaitement lisible.
 * C'est le point de vectorisation, et lui seul, qui dit ce qui manque a l'IA.
 */
async function transmettre(extracted: ExtractedCourse): Promise<void> {
  try {
    await window.noted.course.cacheExtraction(extracted)
  } catch {
    // Le processus principal publie deja l'etat du cours de son cote.
  }
}

/**
 * Deux listes d'unites identiques, dans le meme ordre.
 *
 * Les deux listes sont construites triees : l'ordre porte du sens, et comparer
 * le texte joint suffit — aucune cle d'unite ne contient de virgule. Sans ce
 * garde-fou, chaque cran de molette remonterait un tableau neuf au parent, qui
 * redessinerait les trois panneaux pour une liste qui n'a pas bouge.
 */
function sameUnits(a: string[], b: string[]): boolean {
  return a.join() === b.join()
}

/** Un passage vise : soit une selection pas encore posee, soit un surlignage. */
interface Target {
  /** Ou pointer la palette, en coordonnees de fenetre. */
  anchor: { x: number; y: number }
  /** Le surlignage existant, ou null pour une selection neuve. */
  id: string | null
  passage: Passage
  page: number | null
  heading: string | null
}

interface CoursePanelProps {
  course: Course | null
  width: number
  /**
   * Part de l'espace a prendre, quand ce panneau n'a plus de largeur a lui —
   * les notes masquees, il n'y a plus de panneau souple pour absorber le reste
   * et les sections restantes se partagent l'ecran. Absent : c'est `width` qui
   * commande, comme d'habitude.
   */
  grow?: number
  /** Vrai quand le panneau occupe l'ecran seul : sa largeur devient elastique. */
  expanded?: boolean
  /** Page demandee depuis une citation de l'assistant. */
  pageTarget: { page: number; nonce: number } | null
  /** Barre de recherche ouverte par ⌘F. */
  findOpen: boolean
  onCloseFind: () => void
  /** Bascule le mode concentration sur ce panneau. */
  onToggleExpand: () => void
  /** Envoie un passage a l'assistant. */
  onExplain: (text: string, reference: string) => void
  /** Ou l'on en est de la lecture, pour ancrer ce qui s'ecrit maintenant. */
  onReading: (reading: NoteAnchor | null, fromUser: boolean) => void
  /**
   * Ce que l'utilisateur a reellement sous les yeux, en unites de document —
   * « page:12 », « section:7 ». Different de `onReading`, qui ne designe qu'un
   * seul endroit, celui ou l'on en est : ici c'est tout ce qui est affiche, et
   * c'est un champ de recherche. Une note ecrite a cet instant commente
   * forcement quelque chose de visible — l'ancrage automatique cherchera le
   * passage commente parmi ces unites-la et nulle part ailleurs.
   */
  onVisibleUnits: (units: string[]) => void
  /**
   * Ou le panneau des notes demande d'aller. `signal` dit si la demande attend
   * qu'on montre l'endroit — un clic sur un repere d'ancrage — ou si elle ne
   * fait que suivre le defilement, auquel cas rien ne doit se voir.
   */
  goTo: { anchor: NoteAnchor; nonce: number; signal: boolean } | null
  /**
   * Un document illisible vient d'etre remplace par sa version lue. Son
   * identifiant a change — l'extension passe de .pdf a .md — et tout ce qui le
   * designe doit suivre.
   */
  onConverted: (moves: CourseMove[]) => void
}

interface DocumentState {
  document: PDFDocumentProxy
  pageCount: number
  aspectRatio: number
}

/**
 * La page occupe toute la largeur du panneau : il n'y a pas de gouttiere.
 *
 * C'est le cadre qui rogne le document, et c'est voulu. Le panneau a des
 * angles arrondis et `overflow: hidden` ; une page qui le remplit y perd les
 * quatre coins, ce qui est infime a cote de la bande de fond que laissait la
 * moindre marge. Le cours doit occuper la section qui lui est reservee.
 *
 * On mesure le panneau et non le corps, alors que c'est le corps qui peint.
 * Les deux valent la meme chose depuis que `course.css` a supprime la
 * gouttiere de la barre de defilement, et la nuance a son interet : mesurer
 * le corps ferait dependre la largeur de la page de la presence de la barre,
 * qui depend de la hauteur du contenu, qui depend de la largeur de la page.
 * Sur un document d'une page a peine plus haute que le panneau, la boucle
 * oscillerait.
 */

/** Bornes du grossissement. En deca on ne lit plus, au-dela on ne voit plus rien. */
const ZOOM_MIN = 0.6
const ZOOM_MAX = 3

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

export default function CoursePanel({
  course,
  width,
  grow,
  expanded = false,
  pageTarget,
  findOpen,
  onCloseFind,
  onToggleExpand,
  onExplain,
  onReading,
  onVisibleUnits,
  goTo,
  onConverted
}: CoursePanelProps): React.JSX.Element {
  const [state, setState] = useState<DocumentState | null>(null)
  /** Rendu des formats sans pagination — Word et Markdown. */
  const [documentHtml, setDocumentHtml] = useState<string | null>(null)
  /**
   * Le corps du document, dans un objet stable.
   *
   * React reecrit `dangerouslySetInnerHTML` des que l'objet qui le porte change
   * d'identite — il ne compare pas les chaines. Ecrit en clair dans le JSX, cet
   * objet etait neuf a chaque rendu : le moindre changement d'etat du panneau,
   * un cran de defilement, un survol, reconstruisait les trente-deux mille
   * caracteres du cours Word. Cela coutait cher, et surtout cela detruisait les
   * noeuds sous la selection en cours — un passage selectionne a la souris se
   * perdait au relachement, avant meme qu'on ait pu le copier.
   */
  const documentBody = useMemo(
    () => (documentHtml === null ? null : { __html: documentHtml }),
    [documentHtml]
  )
  const [warnings, setWarnings] = useState<string[]>([])
  /**
   * Ce qu'un cours HTML apporte en plus de son corps : sa feuille de style,
   * confinee au conteneur, et les classes qu'il posait sur sa page. Null pour
   * les autres formats — c'est aussi ce qui choisit le conteneur au rendu.
   */
  const [documentSkin, setDocumentSkin] = useState<{ css: string; bodyClass: string } | null>(
    null
  )
  const [currentPage, setCurrentPage] = useState(1)
  const [scrollbar, setScrollbar] = useState<ScrollbarGeometry | null>(null)
  const [extraction, setExtraction] = useState<{ done: number; total: number } | null>(null)
  /** Ou en est la vectorisation du cours, telle que le main la rapporte. */
  const [vectors, setVectors] = useState<VectorStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Halo bref a l'arrivee sur une page. Le compteur permet de le rejouer sur la
   * meme page deux fois de suite — deux occurrences sur la page 16 doivent
   * chacune signaler leur arrivee.
   */
  const [flash, setFlash] = useState<{ page: number; nonce: number } | null>(null)
  /** Texte du PDF, garde pour la recherche une fois la lecture terminee. */
  const [pages, setPages] = useState<ExtractedPage[] | null>(null)
  /**
   * Cours dont le document est reellement a l'ecran.
   *
   * Different de `course`, qui change des le clic : le temps que le nouveau
   * document se charge, l'ancien est encore affiche. Sans cette distinction, la
   * reprise de lecture s'appliquerait au document precedent, et le signet du
   * nouveau cours serait ecrase par une page qui n'est pas la sienne.
   */
  const [loadedId, setLoadedId] = useState<string | null>(null)
  /**
   * L'element du document HTML, tenu en etat et non en reference : la barre de
   * recherche doit se redessiner quand il apparait, ce qu'une reference seule
   * ne declenche pas.
   */
  const [htmlRoot, setHtmlRoot] = useState<HTMLElement | null>(null)
  /**
   * Renseigne quand le cours affiche a ete reconstitue par lecture d'images.
   * Null pour tous les autres, c'est-a-dire l'immense majorite.
   */
  const [ocrCourse, setOcrCourse] = useState<OcrCourse | null>(null)
  /**
   * L'onglet affiche. « Texte lu » au premier abord, puis le choix contraire est
   * retenu par cours : basculer sur l'original pour verifier un schema ne doit
   * pas etre a refaire a chaque ouverture.
   */
  const [ocrView, setOcrView] = useState<OcrView>('ocr')
  /**
   * Vrai quand l'extraction du texte n'a presque rien rendu : le document est
   * un scan, une suite de photos, ou un support fait d'images. C'est cette
   * mesure — et non une supposition sur le nom ou le format — qui declenche la
   * lecture par OCR.
   */
  const [scanned, setScanned] = useState(false)

  /**
   * Les images lisibles du document — celles du dossier media, dans l'ordre du
   * texte. C'est la source de conversion d'un Word ou d'un Markdown fait
   * d'images, qui n'ont pas de pages a dessiner : chaque image en devient une.
   */
  const [figureMedia, setFigureMedia] = useState<string[] | null>(null)

  /** Grossissement du document, 1 valant la largeur du panneau. */
  const [zoom, setZoom] = useState(1)
  const [drawerOpen, setDrawerOpen] = useState(false)

  /**
   * La barre de commandes du cours est un tiroir : rentree par defaut pour
   * laisser toute la place a la page, elle sort et rentre par l'encoche qui
   * depasse en haut de la section.
   */
  const [controlsOpen, setControlsOpen] = useState(false)
  const [target, setTarget] = useState<Target | null>(null)

  const { annotations, add, remove, comment, recolour } = useAnnotations(course?.id ?? null)

  /**
   * D'ou la conversion tirerait ses pages : le PDF ouvert, ou les images du
   * document. Memoise, parce que l'effet de conversion en depend — un objet
   * neuf a chaque rendu relancerait la lecture depuis le debut.
   */
  const conversionSource = useMemo<ConversionSource | null>(() => {
    if (state?.document) return { kind: 'pdf', document: state.document }
    if (figureMedia && figureMedia.length > 0) return { kind: 'media', names: figureMedia }
    return null
  }, [state?.document, figureMedia])

  /**
   * La lecture d'un document illisible, en arriere-plan. Elle ne retarde rien :
   * le document reste affiche et parcourable pendant que ses pages sont lues.
   */
  const conversion = useOcrConversion(
    loadedId,
    conversionSource,
    scanned,
    onConverted
  )

  /** La reprise d'un cours reconstitue dont des pages manquent. */
  const resume = useOcrResume(loadedId, ocrCourse)

  const bodyRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)

  /**
   * La largeur reellement occupee, plutot que celle demandee : en mode
   * concentration le panneau prend toute la place et n'a plus de largeur fixe.
   */
  const [measured, setMeasured] = useState(width)
  useEffect(() => {
    const element = panelRef.current
    if (!element) return

    // Zero signale un panneau replie par le mode concentration, pas un panneau
    // devenu minuscule : repeindre les pages a cette largeur-la serait du
    // travail jete, et le retour a l'ecran redemanderait tout.
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setMeasured(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const pageWidth = Math.max(200, measured * zoom)

  // --- Chargement du document ---------------------------------------------
  //
  // Cet effet suit l'identifiant du cours, et non l'objet qui le decrit. La
  // nuance a une consequence lourde : `useVault` reconstruit tous ses objets a
  // chaque evenement du dossier Cours/ — un PDF depose depuis le Finder, une
  // matiere mise a la corbeille. Suivre l'objet revenait donc a tout annuler et
  // tout reprendre au moindre remous dans le vault, y compris provoque par un
  // autre cours, et la lecture en cours partait a la poubelle une ligne avant
  // d'etre transmise. Chaque cours doit avancer pour son propre compte.
  const courseId = course?.id ?? null
  const courseFormat = course?.format ?? null
  // La date de modification fait partie de la cle, et pas par exces de zele :
  // sans elle, remplacer sur le disque le document qu'on est en train de lire
  // ne rechargerait plus rien, et l'on continuerait a lire une version qui
  // n'existe plus. Elle ne bouge que si le fichier bouge — la reconstruction
  // des objets par le vault la laisse identique, donc elle ne ramene pas le
  // defaut qu'on vient de corriger.
  const courseModifiedAt = course?.modifiedAt ?? null

  useEffect(() => {
    if (!courseId || !courseFormat) {
      setState(null)
      setDocumentHtml(null)
      return
    }

    let cancelled = false
    let opened: OpenDocument | null = null

    setState(null)
    setDocumentHtml(null)
    setDocumentSkin(null)
    setOcrCourse(null)
    setScanned(false)
    setFigureMedia(null)
    // L'onglet est repris avant meme de savoir si ce cours en a un : le lire ici
    // le pose en meme temps que le reste, et il ne sert a rien tant qu'aucun
    // bandeau ne s'affiche.
    setOcrView(readingSpot(courseId)?.view ?? 'ocr')
    setWarnings([])
    setError(null)
    setCurrentPage(1)
    setExtraction(null)
    setPages(null)
    setLoadedId(null)
    setTarget(null)
    // Les etendues peintes visent des noeuds du document precedent : elles ne
    // designent plus rien des qu'il quitte l'ecran.
    withdrawAll()

    void (async () => {
      try {
        if (courseFormat === 'markdown') {
          const text = await window.noted.course.readMarkdown(courseId)

          // Un cours reconstitue par OCR est un Markdown comme les autres, a
          // deux commentaires pres. On les retire de ce qui est rendu et de ce
          // qui part a l'indexation : l'en-tete n'est pas du cours, et les
          // reperes de page ne doivent pas etre lus comme du texte.
          const reconstitue = readOcrCourse(text)
          if (!cancelled) setOcrCourse(reconstitue)

          const body = withoutFrontMatter(reconstitue ? reconstitue.body : text)

          // L'affichage d'abord, la transmission ensuite — et sans `return`
          // entre les deux. L'ecran ne doit pas attendre l'indexation, et
          // l'indexation ne doit pas etre perdue parce que l'ecran est passe a
          // autre chose : une lecture menee a son terme vaut pour le cours, pas
          // pour le panneau qui l'affichait.
          if (!cancelled) {
            setDocumentHtml(renderMarkdownCourse(body))
            setLoadedId(courseId)
          }

          // Un cours deja reconstitue par OCR ne repasse jamais a la mesure :
          // il est le resultat d'une conversion, pas un candidat a une autre.
          if (reconstitue) {
            await transmettre(unpaginated(courseId, body))
            return
          }

          // Les images du cours deviennent des marqueurs de figure, comme au
          // chemin Word : c'est ce qui permet a la lecture par OCR de poser le
          // texte de chaque image a sa place, et a la mesure de dire qu'un
          // Markdown fait d'images est un document a convertir.
          const figured = figuresFromMarkdown(body)
          const extracted: ExtractedCourse = {
            ...unpaginated(courseId, figured.text),
            ...(figured.media.length > 0 ? { media: figured.media } : {})
          }

          if (!cancelled) {
            setScanned(extracted.looksScanned)
            setFigureMedia(figured.media.filter(Boolean))
          }

          await transmettre(extracted)
          return
        }

        if (courseFormat === 'docx') {
          const converted = await window.noted.course.readDocx(courseId)
          const clean = prepareDocumentHtml(converted.html)

          if (!cancelled) {
            setDocumentHtml(clean)
            setLoadedId(courseId)
            setWarnings(converted.warnings)
          }

          // Le texte envoye a Claude est tire du HTML nettoye, donc de ce que
          // l'utilisateur a exactement sous les yeux — pas d'une seconde
          // lecture du fichier qui pourrait en differer.
          // La liste des images part avec le texte : c'est elle qui permet au
          // processus principal de rendre chaque capture a sa place exacte,
          // avant le decoupage en passages.
          const extractedDocx: ExtractedCourse = {
            ...unpaginated(courseId, htmlToContextText(clean)),
            media: mediaNames(clean)
          }

          // Un Word fait d'images est un document a convertir, exactement
          // comme un PDF scanne : la mesure est la meme, seule la source des
          // pages change — ses images, puisqu'il n'a pas de pages a dessiner.
          if (!cancelled) {
            setScanned(extractedDocx.looksScanned)
            setFigureMedia((extractedDocx.media ?? []).filter(Boolean))
          }

          await transmettre(extractedDocx)
          return
        }

        if (courseFormat === 'pptx') {
          // La conversion tourne ici, cote renderer, pour la meme raison que
          // l'extraction des PDF : le navigateur sait deja ouvrir une archive
          // et lire du XML, quand le processus principal demanderait deux
          // bibliotheques de plus.
          const slides = await window.noted.course.readBytes(courseId)
          if (cancelled) return

          const converted = await convertPptx(slides)
          const cleanSlides = prepareDocumentHtml(converted.html)

          if (!cancelled) {
            setDocumentHtml(cleanSlides)
            setLoadedId(courseId)
            setWarnings(converted.warnings)
          }

          // Meme contrat que le chemin Word : le texte part de ce que
          // l'utilisateur a sous les yeux, et la liste des images permet a la
          // lecture par OCR de rendre chaque schema a sa place.
          const extractedPptx: ExtractedCourse = {
            ...unpaginated(courseId, htmlToContextText(cleanSlides)),
            media: mediaNames(cleanSlides)
          }

          if (!cancelled) {
            setScanned(extractedPptx.looksScanned)
            setFigureMedia((extractedPptx.media ?? []).filter(Boolean))
          }

          await transmettre(extractedPptx)
          return
        }

        if (courseFormat === 'html') {
          // Le canal lit un fichier texte, quel qu'il soit : un .html en est un.
          const raw = await window.noted.course.readMarkdown(courseId)
          if (cancelled) return

          // Un artefact est une page entiere : son style est confine au
          // panneau, son corps nettoye de ce qui pourrait agir. Le tout reste
          // dans le meme DOM que l'application, pour que surlignages, ancres et
          // ligne de lecture marchent exactement comme sur un Word.
          const prepared = prepareHtmlCourse(raw)

          if (!cancelled) {
            setDocumentSkin({ css: prepared.css, bodyClass: prepared.bodyClass })
            setDocumentHtml(prepared.html)
            setLoadedId(courseId)
            setWarnings(prepared.warnings)
          }

          // Pas de lecture d'images ici : un graphique d'un cours HTML est du
          // code, et c'est ce code que le texte donne a lire. Un cours tres
          // visuel, pauvre en texte, n'est donc pas un scan a convertir.
          const extractedHtml: ExtractedCourse = {
            ...unpaginated(courseId, htmlCourseToContextText(prepared.html)),
            looksScanned: false
          }

          await transmettre(extractedHtml)
          return
        }

        const bytes = await window.noted.course.readBytes(courseId)
        if (cancelled) return

        const handle = await loadDocument(bytes)
        if (cancelled) {
          void handle.close()
          return
        }
        opened = handle
        const document = handle.document

        // On suppose que toutes les pages ont le format de la premiere, ce qui
        // est vrai de tout support de cours. Cela evite d'ouvrir les
        // quarante-cinq pages juste pour reserver la bonne hauteur.
        const first = await document.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        first.cleanup()

        if (cancelled) return
        setState({
          document,
          pageCount: document.numPages,
          aspectRatio: viewport.height / viewport.width
        })
        setLoadedId(courseId)

        // Deuxieme ouverture et suivantes : le texte est deja sur le disque, tel
        // que la premiere lecture l'a rendu. Rien a relire, aucune barre a faire
        // defiler — l'assistant a le cours avant meme que la premiere page soit
        // peinte. Le document reste ouvert : c'est lui qu'on affiche.
        // Un cache qui ne se lit pas n'est pas un document illisible : on le
        // relit, et le bandeau d'erreur reste pour ce qui le merite.
        const cached = await window.noted.course
          .readExtraction(courseId)
          .catch(() => null)
        if (cached) {
          if (!cancelled) {
            setPages(cached.pages)
            setScanned(cached.looksScanned)
          }
          await transmettre(cached)
          return
        }

        // L'extraction tourne apres l'affichage : l'utilisateur peut lire son
        // cours pendant que Claude recoit le texte.
        setExtraction({ done: 0, total: document.numPages })
        // On ne remonte la progression qu'au changement de pourcent : une barre
        // large de deux cents pixels n'a rien de plus a montrer, et chaque
        // remontee redessine le panneau.
        let lastPercent = -1
        const extracted = await extractCourse(
          courseId,
          document,
          (done, total) => {
            if (cancelled) return
            const percent = Math.floor((done / total) * 100)
            if (percent === lastPercent && done !== total) return
            lastPercent = percent
            setExtraction({ done, total })
          },
          () => cancelled
        )

        if (!cancelled) {
          // Le texte reste ici aussi : c'est lui, et non le canvas, que ⌘F
          // interroge — une page peinte n'a pas de texte a chercher.
          setPages(extracted.pages)
          setScanned(extracted.looksScanned)
          setExtraction(null)
        }

        // Transmis quoi qu'il arrive au panneau : `extractCourse` ne rend un
        // document que s'il l'a lu en entier, et une lecture complete vaut pour
        // le cours, pas pour l'ecran qui l'affichait.
        await transmettre(extracted)
      } catch (cause) {
        if (cancelled) return
        // La barre de lecture doit disparaitre avec l'echec. Laissee en place,
        // elle reste figee a l'ecran et annonce indefiniment un travail qui ne
        // reprendra pas.
        setExtraction(null)
        setError(cause instanceof Error ? cause.message : 'Document illisible.')
      }
    })()

    return () => {
      cancelled = true
      // Liberer le document evite de garder plusieurs PDF en memoire quand on
      // passe d'un cours a l'autre.
      if (opened) void opened.close()
    }
  }, [courseId, courseFormat, courseModifiedAt])

  // --- Etat de la vectorisation -------------------------------------------
  //
  // L'etat est demande une fois a l'arrivee sur le cours, puis suivi par les
  // annonces du main. La demande initiale n'est pas redondante : l'index peut
  // etre pret depuis longtemps — cours deja ouvert dans la session, ou vecteurs
  // relus du disque — et aucune annonce ne viendra plus.
  // Sur l'identifiant, comme le chargement du document, et pour la meme raison :
  // suivre l'objet faisait repasser cet effet a chaque remous du vault, donc
  // remettre l'etat a null, donc faire disparaitre puis reapparaitre le point —
  // y compris en plein calcul, et y compris pour un evenement provoque par un
  // tout autre cours.
  useEffect(() => {
    setVectors(null)
    if (!courseId) return

    let cancelled = false
    void window.noted.rag.status(courseId).then((status) => {
      // Une annonce a pu arriver pendant la lecture : elle est plus fraiche.
      if (!cancelled) setVectors((known) => known ?? status)
    })

    const unsubscribe = window.noted.rag.onChanged((status) => {
      if (status.courseId === courseId) setVectors(status)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [courseId])

  /**
   * Les blocs du document affiche, parmi lesquels chercher la ligne de lecture.
   *
   * Un PDF les a tout prets, un par page ; les autres formats partagent le meme
   * rendu HTML, et ce sont alors ses elements de premier niveau — un titre, un
   * paragraphe, une liste. Le choix est ici et pas dans reading-line.ts parce
   * qu'il n'est pas devinable depuis le DOM : un cours reconstitue par lecture
   * d'images a les deux rendus en meme temps, et seul le panneau sait lequel
   * est a l'ecran.
   */
  const readingBlocks = useCallback((): HTMLElement[] => {
    const body = bodyRef.current
    if (!body) return []
    if (state) return Array.from(body.querySelectorAll<HTMLElement>('[data-page]'))
    if (!htmlRoot) return []
    // Un cours HTML tient souvent tout entier dans un seul conteneur : ses
    // enfants directs ne feraient qu'un bloc. On descend jusqu'aux blocs de
    // texte, ou qu'ils soient.
    if (documentSkin) {
      return Array.from(
        htmlRoot.querySelectorAll<HTMLElement>(
          'h1, h2, h3, h4, h5, h6, p, li, pre, table, figure, blockquote, dt, dd, summary'
        )
      )
    }
    return Array.from(htmlRoot.children) as HTMLElement[]
  }, [state, htmlRoot, documentSkin])

  /**
   * Un lien interne d'un cours HTML — « #covenants » — vise un endroit du
   * document. Laisse au navigateur, il changerait l'adresse de la page de
   * l'application ; on amene l'endroit sur la ligne de lecture, comme un renvoi.
   */
  const followInternalLink = useCallback(
    (event: React.MouseEvent) => {
      const link = (event.target as HTMLElement).closest?.('a[href^="#"]')
      const body = bodyRef.current
      if (!link || !body || !htmlRoot) return
      event.preventDefault()

      const id = decodeURIComponent(link.getAttribute('href')?.slice(1) ?? '')
      if (!id) return
      const target =
        htmlRoot.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ??
        htmlRoot.querySelector<HTMLElement>(`a[name="${CSS.escape(id)}"]`)
      if (!target) return

      body.scrollTop += target.getBoundingClientRect().top - readingLineY(body)
    },
    [htmlRoot]
  )

  const goToPage = useCallback((page: number) => {
    const body = bodyRef.current
    if (!body) return
    const target = body.querySelector<HTMLElement>(`[data-page='${page}']`)
    // Deplacement immediat, jamais « smooth ». Les pages ne sont peintes qu'a
    // l'approche du cadre : pendant une animation de defilement, leur hauteur
    // change sous les pieds du navigateur, qui abandonne alors le mouvement —
    // le clic sur une citation ne menait nulle part. Et sur trente pages
    // d'ecart, arriver d'un coup vaut mieux qu'un long glissement : c'est le
    // halo laiton qui indique ou l'on a atterri.
    target?.scrollIntoView({ block: 'start' })
  }, [])

  /** Va a une page et signale l'arrivee — pour une citation ou une occurrence. */
  const jumpToPage = useCallback(
    (page: number) => {
      goToPage(page)
      setFlash((previous) => ({ page, nonce: (previous?.nonce ?? 0) + 1 }))
    },
    [goToPage]
  )

  // Le halo s'efface tout seul : il sert a localiser la page a l'arrivee,
  // pas a rester.
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 1400)
    return () => clearTimeout(timer)
  }, [flash])

  // Une citation cliquee dans une reponse ramene au bon endroit du document.
  useEffect(() => {
    if (!pageTarget || !state) return
    if (pageTarget.page < 1 || pageTarget.page > state.pageCount) return

    jumpToPage(pageTarget.page)
  }, [pageTarget, state, jumpToPage])

  // --- Reprise de la lecture ---------------------------------------------
  //
  // Le retour a la position precedente doit precede toute memorisation :
  // au moment ou le document s'affiche, la page courante vaut encore 1, et
  // l'enregistrer effacerait justement ce qu'on s'apprete a relire.

  /** Cours dont la position a deja ete retablie. */
  const restored = useRef<string | null>(null)

  useEffect(() => {
    const body = bodyRef.current
    if (!course || !body) return
    if (restored.current === course.id) return
    // Le document affiche doit etre celui du cours demande, et pas celui qu'on
    // vient de quitter : le chargement prend quelques centaines de millisecondes
    // pendant lesquelles l'ancien reste a l'ecran.
    if (loadedId !== course.id) return

    restored.current = course.id
    const spot = readingSpot(course.id)
    setZoom(spot?.zoom ?? 1)
    if (!spot) return

    if (state && spot.page && spot.page > 1 && spot.page <= state.pageCount) {
      // Pas de halo : il signale une arrivee demandee, pas une reprise.
      goToPage(spot.page)
      setCurrentPage(spot.page)
      // Le grossissement retenu, pose juste au-dessus, va changer la hauteur de
      // toutes les pages a la trame suivante. Sans ancre posee ici, la reprise
      // partirait a la derive avant meme le premier coup de molette.
      anchor.current = anchorAtLine(body, readingBlocks())
    } else if (documentHtml && spot.scroll) {
      // Une trame laisse le temps a la mise en page de se poser : les images
      // d'un Word arrivent en base64 et changent la hauteur du document.
      requestAnimationFrame(() => {
        body.scrollTop = spot.scroll ?? 0
        // Le grossissement retenu recompose le texte, et rien ne dit qu'il
        // soit deja pose : l'ancre tient l'endroit quoi qu'il arrive ensuite.
        anchor.current = anchorAtLine(body, readingBlocks())
      })
    }
  }, [course, loadedId, state, documentHtml, goToPage, readingBlocks])

  useEffect(() => {
    if (!course || loadedId !== course.id || restored.current !== course.id) return
    if (state) rememberSpot(course.id, { page: currentPage })
  }, [course, loadedId, state, currentPage])

  // Un document sans pagination n'a pas de page a retenir : c'est son
  // defilement qui tient lieu de signet.
  useEffect(() => {
    const body = bodyRef.current
    if (!course || !body || !documentHtml || loadedId !== course.id) return

    let timer: ReturnType<typeof setTimeout> | null = null
    const onScroll = (): void => {
      if (timer) return
      // Une ecriture par demi-seconde suffit largement, la ou un defilement en
      // produirait des centaines.
      timer = setTimeout(() => {
        timer = null
        if (restored.current === course.id) {
          rememberSpot(course.id, { scroll: body.scrollTop })
        }
      }, 500)
    }

    body.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (timer) clearTimeout(timer)
      body.removeEventListener('scroll', onScroll)
    }
  }, [course, loadedId, documentHtml])

  // --- Ou l'on en est de la lecture ----------------------------------------
  //
  // La page courante, la section courante : tout se decide a la ligne de
  // lecture, et le compteur de pages comme l'ancre des notes lisent la meme
  // reponse. L'application n'a pas d'opinion cachee sur l'endroit ou l'on est —
  // elle enregistre ce qu'elle affiche.

  const [reading, setReading] = useState<NoteAnchor | null>(null)
  /**
   * Le dernier endroit pose sur la ligne de lecture, tenu dans une reference
   * parce qu'il doit etre lisible pendant la phase de mise en page, avant
   * qu'un rendu ait eu lieu.
   */
  const anchor = useRef<ReadingAnchor | null>(null)
  /**
   * Vrai le temps d'un defilement que nous avons provoque. C'est le garde-fou
   * anti-boucle : un defilement venu de la synchronisation ne doit pas en
   * declencher un autre en retour, sinon les deux panneaux se poursuivent.
   */
  const driven = useRef<ReturnType<typeof setTimeout> | null>(null)

  const markDriven = useCallback(() => {
    if (driven.current) clearTimeout(driven.current)
    driven.current = setTimeout(() => {
      driven.current = null
    }, 400)
  }, [])

  /**
   * Suit un renvoi du document : sommaire, retour au sommaire, note de bas de
   * page.
   *
   * La destination est un point dans une page, pas une page entiere : on amene
   * donc ce point a la ligne de lecture, comme le fait deja tout ce qui rejoint
   * un endroit precis du cours. Le calcul tient sans que la page visee soit
   * peinte — son emplacement a la hauteur qu'il aura, reservee des l'ouverture.
   *
   * Le halo laiton reste : d'un sommaire de cinquante entrees, on ne sait pas
   * autrement ou l'on a atterri.
   */
  const followLink = useCallback(
    (page: number, offset: number) => {
      const body = bodyRef.current
      const slot = body?.querySelector<HTMLElement>(`[data-page='${page}']`)
      if (!body || !slot) return

      markDriven()
      const box = slot.getBoundingClientRect()
      body.scrollTop += box.top + offset * box.height - readingLineY(body)
      setFlash((previous) => ({ page, nonce: (previous?.nonce ?? 0) + 1 }))
    },
    [markDriven]
  )

  /**
   * Les pages du cadre, tenues dans une reference et non dans un etat.
   *
   * Les pages entrent et sortent une par une, dans un ordre quelconque, et
   * chaque annonce doit lire le total a jour sans attendre le rendu suivant :
   * un ensemble qu'on modifie sur place repond a cela, la ou un etat obligerait
   * a enchainer les mises a jour fonctionnelles. Un ensemble, aussi, parce qu'on
   * en retire autant qu'on en ajoute et qu'une meme page peut etre annoncee
   * deux fois.
   */
  const inFrame = useRef(new Set<number>())

  /**
   * Ce qui est affiche, en unites de document. Deux sources qui ne coexistent
   * jamais : les annonces des pages pour un PDF, la mesure faite plus bas pour
   * les documents a titres — un document a l'un ou l'autre, jamais les deux.
   */
  const [visibleUnits, setVisibleUnits] = useState<string[]>([])

  /**
   * L'entree et la sortie du cadre d'une page, telles que PdfPage les annonce.
   *
   * Sans aucune dependance, donc de reference stable pour toute la vie du
   * panneau, et ce n'est pas un detail : PdfPage est memoise, et une fonction
   * neuve a chaque rendu ferait repasser les cinquante pages du document par un
   * rendu complet — precisement ce que le memo existe pour eviter. Pire, leur
   * observateur se referait a chaque fois en annoncant une sortie avant une
   * entree, et la liste serait vide un instant sur deux, y compris a l'instant
   * ou on la lit.
   */
  const handlePageVisible = useCallback((page: number, visible: boolean) => {
    if (visible) inFrame.current.add(page)
    else inFrame.current.delete(page)

    const units = Array.from(inFrame.current)
      .sort((a, b) => a - b)
      .map((number) => `page:${number}`)
    setVisibleUnits((current) => (sameUnits(current, units) ? current : units))
  }, [])

  /**
   * Le cours change : ce qu'on avait sous les yeux appartenait au precedent.
   *
   * La mesure plus bas ne reprend qu'une fois le nouveau document charge, et
   * cet intervalle est le piege. Un PDF s'en sort tout seul — ses pages se
   * demontent et annoncent leur sortie — mais un ordinal de section, lui,
   * survit sans rien signaler : la section 4 existe aussi dans le cours
   * suivant, et une note ecrite pendant le chargement s'y ancrerait avec
   * assurance, au mauvais endroit d'un autre document. On vide donc des
   * l'annonce, quitte a chercher partout le temps que l'affichage rattrape.
   */
  useEffect(() => {
    inFrame.current.clear()
    // L'ancre aussi : la page 40 du cours precedent n'est pas un endroit du
    // cours qui arrive.
    anchor.current = null
    setVisibleUnits((current) => (current.length === 0 ? current : []))
  }, [course?.id])

  const measureReading = useCallback(() => {
    const body = bodyRef.current
    if (!body || !course || loadedId !== course.id) return

    // L'ancre sert deux fois : pour un PDF elle dit la page courante, et dans
    // tous les cas elle garde de quoi revenir au meme endroit quand la mise en
    // page change de taille sous les yeux.
    const point = anchorAtLine(body, readingBlocks())
    if (point) anchor.current = point

    const next: NoteAnchor = state
      ? {
          page: Number(point?.element.dataset.page) || 1,
          section: null,
          progress: null,
          passage: null,
          figure: null
        }
      : {
          page: null,
          section: htmlRoot ? sectionAtLine(htmlRoot, body) : null,
          progress: null,
          passage: null,
          figure: null
        }

    // Un support ecrit d'un seul bloc n'a ni page ni titre : la fraction
    // parcourue est tout ce qui reste a rattacher a une note.
    if (next.page === null && next.section === null) {
      next.progress = Math.round(progressAtLine(body) * 200) / 200
    }

    if (next.page !== null) setCurrentPage(next.page)

    setReading((current) =>
      current &&
      current.page === next.page &&
      current.section === next.section &&
      current.progress === next.progress
        ? current
        : next
    )

    // Un document pagine annonce ses pages de lui-meme, une par une, y compris
    // quand c'est la mise en page qui bouge et non le defilement. Les autres
    // formats — Word, PowerPoint, Markdown, qui empruntent tous le meme rendu
    // HTML — n'ont pas d'equivalent : leur contenu est peint d'un bloc. On les
    // releve donc ici, au meme instant que la ligne de lecture, pour que les
    // deux informations parlent du meme moment de la lecture.
    // Rien d'affiche du tout — l'original d'un cours reconstitue, un document
    // qui n'a pas fini de charger — ne restreint rien : mieux vaut une liste
    // vide, que l'ancrage lira comme « cherche partout », qu'une liste heritee
    // du document precedent qui l'enverrait ailleurs avec assurance.
    if (!state) {
      const units = htmlRoot
        ? visibleSectionIndices(htmlRoot, body).map((index) => `section:${index}`)
        : []
      setVisibleUnits((current) => (sameUnits(current, units) ? current : units))
    }
  }, [course, loadedId, state, htmlRoot, readingBlocks])

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return

    let frame = 0
    const onScroll = (): void => {
      // Tant qu'un defilement que nous avons provoque court, chacun de ses
      // crans repousse la fin de la fenetre : sa fin ne doit pas etre prise
      // pour un geste de l'utilisateur et renvoyer les notes en retour.
      if (driven.current) markDriven()
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measureReading()
      })
    }

    measureReading()
    body.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      body.removeEventListener('scroll', onScroll)
    }
  }, [measureReading, markDriven, zoom, pageWidth])

  // --- Ou l'on en est dans le defilement -----------------------------------
  //
  // Le panneau du cours cache la barre de defilement du navigateur, et pour une
  // raison qui tient toujours : stylee, elle occupe onze pixels de largeur
  // reelle — elle n'est jamais flottante —, et la page ne pouvait plus toucher
  // le bord droit du cadre. Mais la cacher a coute la seule chose qui disait
  // « tu es ici », et un cours long est alors un cours sans horizon.
  //
  // Celle-ci se pose donc par-dessus le document plutot qu'a cote : elle ne
  // prend aucune largeur, la page touche toujours le bord, et l'on retrouve le
  // curseur qui descend a mesure qu'on lit.

  const measureScrollbar = useCallback(() => {
    const body = bodyRef.current
    const panel = panelRef.current
    const desk = panel?.parentElement
    if (!body || !panel || !desk) return

    const travel = body.scrollHeight - body.clientHeight
    // Rien a montrer quand tout tient dans le cadre : un rail plein sur toute
    // la hauteur ne dirait rien, et il y a assez de choses a l'ecran.
    if (travel < 4) {
      setScrollbar(null)
      return
    }

    const track = body.clientHeight
    // La proportion visible donne la longueur du curseur, mais un cours de
    // deux cents pages la reduirait a trois pixels : en dessous du plancher, le
    // curseur cesse d'etre saisissable et de se voir.
    const thumbHeight = Math.max(MIN_THUMB, (body.clientHeight / body.scrollHeight) * track)
    const thumbTop = (body.scrollTop / travel) * (track - thumbHeight)

    const deskBox = desk.getBoundingClientRect()
    const panelBox = panel.getBoundingClientRect()
    const bodyBox = body.getBoundingClientRect()

    const next = {
      // Le bord droit du panneau : le rail commence ou le panneau finit, donc
      // dans la gouttiere et non dessus.
      trackLeft: panelBox.right - deskBox.left,
      trackTop: bodyBox.top - deskBox.top,
      trackHeight: track,
      thumbTop,
      thumbHeight
    }

    // Un cran de molette qui ne deplace pas le curseur d'un demi-pixel ne doit
    // pas redessiner les trois panneaux.
    setScrollbar((current) =>
      current &&
      current.trackLeft === next.trackLeft &&
      current.trackTop === next.trackTop &&
      current.trackHeight === next.trackHeight &&
      current.thumbHeight === next.thumbHeight &&
      Math.abs(current.thumbTop - next.thumbTop) < 0.5
        ? current
        : next
    )
  }, [])

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return

    let frame = 0
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measureScrollbar()
      })
    }

    schedule()
    body.addEventListener('scroll', schedule, { passive: true })
    // Le panneau qu'on elargit, le cours qui finit de se peindre, une image qui
    // arrive : la hauteur bouge sans que personne ne defile.
    const observer = new ResizeObserver(schedule)
    observer.observe(body)
    for (const child of Array.from(body.children)) observer.observe(child)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      body.removeEventListener('scroll', schedule)
      observer.disconnect()
    }
  }, [measureScrollbar, loadedId, zoom, pageWidth, documentHtml])

  /**
   * Saisir le curseur pour parcourir le cours.
   *
   * Une pilule qu'on ne peut pas attraper serait une demi-barre de defilement :
   * on la voit descendre, on n'en fait rien. Le rapport est celui du rail au
   * document — un pixel parcouru ici en vaut autant la-bas.
   */
  const dragScrollbar = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const body = bodyRef.current
      if (!body || !scrollbar) return

      event.preventDefault()
      const handle = event.currentTarget
      handle.setPointerCapture(event.pointerId)

      const startY = event.clientY
      const startTop = body.scrollTop
      const travel = body.scrollHeight - body.clientHeight
      const room = scrollbar.trackHeight - scrollbar.thumbHeight
      if (room <= 0) return

      const move = (moved: PointerEvent): void => {
        body.scrollTop = startTop + ((moved.clientY - startY) / room) * travel
      }
      const stop = (): void => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', stop)
        handle.removeEventListener('pointercancel', stop)
      }

      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', stop)
      handle.addEventListener('pointercancel', stop)
    },
    [scrollbar]
  )

  useEffect(() => {
    onReading(reading, driven.current === null)
  }, [reading, onReading])

  useEffect(() => {
    onVisibleUnits(visibleUnits)
  }, [visibleUnits, onVisibleUnits])

  // --- Ce que la synchronisation demande -----------------------------------

  /**
   * Le document dans lequel chercher un passage : la couche de texte de sa
   * page pour un PDF, le corps du document sinon. Une page qui n'a pas encore
   * ete peinte n'a pas de texte a fouiller — on retombera sur son numero.
   */
  const rootForPage = useCallback(
    (page: number | null): HTMLElement | null => {
      if (page === null) return htmlRoot
      return bodyRef.current?.querySelector<HTMLElement>(`[data-page='${page}'] .textLayer`) ?? null
    },
    [htmlRoot]
  )

  /**
   * Le passage qu'on vient de designer, encadre le temps de le retrouver.
   *
   * Un contour, et non un aplat : le halo de `flashFocus` repeint le texte en
   * laiton opaque, ce qui se lit comme un surlignage pose sur le cours alors
   * qu'on n'a fait que cliquer.
   */
  const [spot, setSpot] = useState<Box[]>([])
  const spotTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (spotTimer.current) clearTimeout(spotTimer.current)
    },
    []
  )

  /**
   * Rejoint la n-ieme image du document, et l'encadre.
   *
   * Le pendant de `goToPassage` pour un passage venu d'une capture d'ecran. Son
   * texte a ete lu par le moteur d'OCR et verse dans l'index a la place du
   * marqueur, mais le document, lui, a garde l'image : il n'y a pas un
   * caractere a chercher, seulement un element a montrer.
   *
   * Le rang suffit a le retrouver parce que les deux listes sont construites du
   * meme parcours : `media` est ecrit en parcourant les `img` du document
   * converti, dans l'ordre, et c'est ce meme document qui est affiche. Le jour
   * ou l'un des deux filtrerait une image que l'autre garde, tout ce qui suit
   * se decalerait d'un cran — d'ou le soin pris, cote conversion, a laisser un
   * nom vide plutot qu'a retirer une entree.
   */
  const goToFigure = useCallback(
    (rank: number, signal: boolean): boolean => {
      const body = bodyRef.current
      if (!body || !htmlRoot) return false

      const image = htmlRoot.querySelectorAll<HTMLImageElement>('img')[rank]
      if (!image) return false

      const rect = image.getBoundingClientRect()
      const frame = body.getBoundingClientRect()
      if (rect.top < frame.top || rect.bottom > frame.bottom) {
        markDriven()
        body.scrollTop += rect.top - readingLineY(body)
      }

      if (signal) {
        setSpot([elementBox(body, image)])
        if (spotTimer.current) clearTimeout(spotTimer.current)
        spotTimer.current = setTimeout(() => setSpot([]), 3000)
      }

      return true
    },
    [htmlRoot, markDriven]
  )

  /**
   * Rejoint un passage precis du document affiche.
   *
   * `signal` distingue les deux demandeurs : la synchronisation des defilements
   * ne fait que suivre et doit rester muette, tandis qu'un clic sur un repere
   * d'ancrage attend qu'on lui montre lequel.
   */
  const goToPassage = useCallback(
    (passage: Passage, page: number | null, signal: boolean): boolean => {
      const body = bodyRef.current
      const root = rootForPage(page)
      if (!body || !root) return false

      const ranges = locateAnnotation(root, passage)
      if (ranges.length === 0) return false

      const rect = ranges[0].getBoundingClientRect()
      // Rien ne bouge si le passage est deja sous les yeux : la synchronisation
      // corrige un ecart, elle ne recentre pas en permanence.
      const frame = body.getBoundingClientRect()
      if (rect.top < frame.top || rect.bottom > frame.bottom) {
        markDriven()
        body.scrollTop += rect.top - readingLineY(body)
      }

      // Un passage deja visible se signale quand meme : c'est justement pour
      // savoir duquel il s'agit qu'on a clique.
      if (signal) {
        setSpot(passageBoxes(body, root, passage))
        if (spotTimer.current) clearTimeout(spotTimer.current)
        spotTimer.current = setTimeout(() => setSpot([]), 3000)
      }

      return true
    },
    [rootForPage, markDriven]
  )

  useEffect(() => {
    if (!goTo) return
    const body = bodyRef.current
    if (!body) return

    // La figure d'abord : le texte d'un tel passage n'est nulle part dans le
    // document, et le chercher reviendrait a parcourir tout le cours pour ne
    // rien trouver.
    if (goTo.anchor.figure !== null && goToFigure(goTo.anchor.figure, goTo.signal)) return

    if (goTo.anchor.passage && goToPassage(goTo.anchor.passage, goTo.anchor.page, goTo.signal))
      return

    /*
     * Le passage est sur une page qui n'est pas encore peinte : les pages d'un
     * PDF ne se dessinent qu'a l'approche du cadre, et leur couche de texte
     * n'existe pas avant. On rejoint la page tout de suite, puis on retente le
     * temps qu'elle arrive — sans quoi le clic sur un point d'ancrage menait a
     * la bonne page mais l'encadre ne se montrait jamais.
     */
    if (goTo.anchor.passage && goTo.anchor.page !== null) {
      const passage = goTo.anchor.passage
      const page = goTo.anchor.page
      if (page !== currentPage) {
        markDriven()
        goToPage(page)
      }
      let restants = 20
      const retente = setInterval(() => {
        restants -= 1
        if (goToPassage(passage, page, goTo.signal) || restants <= 0) clearInterval(retente)
      }, 150)
      return () => clearInterval(retente)
    }

    if (goTo.anchor.page !== null) {
      if (goTo.anchor.page === currentPage) return
      markDriven()
      goToPage(goTo.anchor.page)
      return
    }

    if (goTo.anchor.section !== null && htmlRoot) {
      const heading = Array.from(htmlRoot.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).find(
        (element) => element.textContent?.trim() === goTo.anchor.section
      )
      if (heading) {
        markDriven()
        body.scrollTop += heading.getBoundingClientRect().top - readingLineY(body)
      }
      return
    }

    if (goTo.anchor.progress !== null) {
      markDriven()
      body.scrollTop = goTo.anchor.progress * (body.scrollHeight - body.clientHeight)
    }
    // `goTo.nonce` seul declenche : redemander le meme endroit doit y ramener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTo?.nonce])

  // --- Grossissement -------------------------------------------------------
  //
  // Le pincement du trackpad arrive au navigateur sous la forme d'une molette
  // touche Ctrl enfoncee : c'est la convention de macOS, et c'est aussi ce que
  // Chromium interpreterait comme un zoom de la page entiere si on le laissait
  // passer — d'ou le refus explicite de l'evenement.

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()

      setZoom((current) => {
        // Multiplicatif, sinon un meme geste grossit beaucoup a petite echelle
        // et presque pas a grande.
        const next = current * Math.exp(-event.deltaY / 180)
        return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
      })
    }

    body.addEventListener('wheel', onWheel, { passive: false })
    return () => body.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    if (!course || restored.current !== course.id) return
    rememberSpot(course.id, { zoom })
  }, [course, zoom])

  /**
   * Rester au meme endroit quand la mise en page change de taille.
   *
   * Grossir un document de cinquante pages change la hauteur des cinquante,
   * pas seulement de celle qu'on regarde : tout ce qui est au-dessus s'allonge
   * ou se tasse, et le defilement, lui, reste au meme nombre de pixels. Ouvert
   * a la page 40, un pincement de trackpad en faisait donc perdre vingt d'un
   * coup. Un Word ou un Markdown va plus loin encore : le texte se recompose,
   * et grossir remontait le document — on avancait dans le cours en zoomant.
   *
   * Le meme calcul vaut pour le separateur des deux panneaux, qui change la
   * largeur du cours sans qu'on ait rien demande au document.
   *
   * On repose donc, apres coup, l'endroit qui etait sur la ligne de lecture.
   * En effet de mise en page et non ordinaire : il s'execute avant que
   * l'affichage soit peint, si bien qu'on ne voit jamais le saut qu'il
   * rattrape. Les pages ont deja pris leur nouvelle hauteur a cet instant —
   * les effets des enfants passent avant celui du parent, et c'est la que
   * chaque page etire son image.
   *
   * Les deux causes, et elles seules : le grossissement demande, et la largeur
   * du panneau. Un defilement ordinaire ne passe pas par ici.
   */
  useLayoutEffect(() => {
    const body = bodyRef.current
    const point = anchor.current
    // Pas d'ancre : le document vient d'ouvrir, ou l'on change de cours. Il n'y
    // a pas d'avant a retrouver, et c'est le seul cas ou l'on ne fait rien.
    if (!body || !point) return

    markDriven()
    scrollToAnchor(body, point)
  }, [zoom, measured, markDriven])

  // --- Surlignages ---------------------------------------------------------

  /** Les surlignages ranges par page, pour que chaque page ne peigne que les siens. */
  const byPage = useMemo(() => {
    const map = new Map<number, Annotation[]>()
    for (const annotation of annotations) {
      if (annotation.page === null) continue
      const list = map.get(annotation.page)
      if (list) list.push(annotation)
      else map.set(annotation.page, [annotation])
    }
    return map
  }, [annotations])

  // Un document sans pagination est peint d'un bloc : son HTML est entier dans
  // la page, contrairement aux pages d'un PDF qui vont et viennent.
  useEffect(() => {
    if (!htmlRoot || annotations.length === 0) {
      withdraw('html')
      return
    }

    const painted: PaintedRange[] = []
    for (const annotation of annotations) {
      const ranges = locateAnnotation(htmlRoot, annotation)
      if (ranges.length > 0) painted.push({ id: annotation.id, colour: annotation.colour, ranges })
    }
    contribute('html', painted)

    return () => withdraw('html')
  }, [htmlRoot, annotations])

  /**
   * Le document dans lequel se trouve un noeud, et sa reference.
   *
   * Une selection ne vaut que dans un seul document : la couche de texte d'une
   * page de PDF, ou le corps d'un Word. On refuse tout le reste — l'en-tete du
   * panneau, la liste des surlignages — plutot que de citer un fragment
   * d'interface comme s'il venait du cours.
   */
  const rootOf = useCallback(
    (node: Node): { element: HTMLElement; page: number | null } | null => {
      const start = node instanceof HTMLElement ? node : node.parentElement
      if (!start) return null

      const layer = start.closest<HTMLElement>('.textLayer')
      if (layer) {
        const slot = layer.closest<HTMLElement>('[data-page]')
        return { element: layer, page: Number(slot?.dataset.page) || null }
      }

      if (htmlRoot && htmlRoot.contains(start)) return { element: htmlRoot, page: null }
      return null
    },
    [htmlRoot]
  )

  /**
   * Ce que le clic vient de designer : un passage selectionne, un surlignage
   * deja pose, ou rien. Tout se decide au relachement de la souris — c'est le
   * seul moment ou la selection est arretee.
   *
   * `inside` distingue un relachement dans le panneau d'un glissement parti du
   * cours et termine ailleurs : dans le second cas, une selection compte encore,
   * mais un clic a vide ne doit rien fermer — l'utilisateur n'a pas clique ici.
   */
  const resolvePointerUp = useCallback(
    (clientX: number, clientY: number, inside: boolean) => {
      const selection = window.getSelection()

      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        const root = rootOf(range.startContainer)
        const passage = root ? describeSelection(range, root.element, selection.toString()) : null

        if (root && passage) {
          const box = range.getBoundingClientRect()
          setTarget({
            anchor: { x: (box.left + box.right) / 2, y: box.top },
            id: null,
            passage,
            page: root.page,
            heading: root.page === null ? headingAbove(range.startContainer, root.element) : null
          })
          return
        }
      }

      if (!inside) return

      // Pas de selection : peut-etre a-t-on clique sur un passage deja surligne.
      const id = annotationAt(clientX, clientY)
      const found = id ? annotations.find((entry) => entry.id === id) : null

      if (found) {
        setTarget({
          anchor: { x: clientX, y: clientY - 8 },
          id: found.id,
          passage: { text: found.text, before: found.before, after: found.after },
          page: found.page,
          heading: found.heading
        })
        return
      }

      setTarget(null)
    },
    [annotations, rootOf]
  )

  /** Vrai entre un appui dans le cours et le relachement qui le termine. */
  const dragging = useRef(false)

  /*
   * Le relachement s'ecoute sur le document, pas sur le panneau. Un glissement
   * qui descend vers le bas de la page, ou qui deborde sur les notes, se termine
   * hors du cadre : l'evenement n'arrivait alors jamais, la selection existait
   * mais la palette ne s'ouvrait pas — ce qui se lisait comme une selection
   * ratee. On ne prend en compte que les glissements partis du cours, pour qu'un
   * clic ailleurs dans l'application ne rouvre pas une palette refermee.
   */
  useEffect(() => {
    const onUp = (event: MouseEvent): void => {
      const body = bodyRef.current
      if (!body) return

      const inside = event.target instanceof Node && body.contains(event.target)
      if (!inside && !dragging.current) return

      dragging.current = false
      resolvePointerUp(event.clientX, event.clientY, inside)
    }

    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [resolvePointerUp])

  /** Le surlignage vise, relu depuis la liste : la palette suit ses changements. */
  const targeted = useMemo(
    () => (target?.id ? (annotations.find((entry) => entry.id === target.id) ?? null) : null),
    [target, annotations]
  )

  const applyColour = useCallback(
    (colour: HighlightColorId) => {
      if (!target) return

      if (target.id) {
        recolour(target.id, colour)
        return
      }

      const created = add({
        ...target.passage,
        colour,
        page: target.page,
        heading: target.heading
      })
      // La selection a fait son office : on la rend, sans quoi le passage reste
      // barre de bleu par-dessus sa nouvelle couleur.
      window.getSelection()?.removeAllRanges()

      // Une couleur cachee ne laisse rien a l'ecran : le passage part vers les
      // flashcards, et la palette n'a plus rien a montrer. On signale
      // brievement l'envoi a l'endroit du passage, pour que le geste ne
      // ressemble pas a un clic dans le vide.
      if (HIGHLIGHT_COLORS.find((entry) => entry.id === colour)?.hidden) {
        const body = bodyRef.current
        const root = rootForPage(target.page)
        if (body && root) {
          setSpot(passageBoxes(body, root, target.passage))
          if (spotTimer.current) clearTimeout(spotTimer.current)
          spotTimer.current = setTimeout(() => setSpot([]), 1200)
        }
        setTarget(null)
        return
      }

      // La palette reste ouverte sur le surlignage qui vient de naitre : c'est
      // la qu'on lui accroche une note, sans avoir a le reselectionner.
      setTarget((current) => (current ? { ...current, id: created.id } : current))
    },
    [target, add, recolour, rootForPage]
  )

  /** La reference d'un passage, telle qu'elle sera citee dans une note ou a l'IA. */
  const referenceOf = useCallback(
    (page: number | null, heading: string | null): string =>
      page !== null ? `p. ${page}` : (heading ?? course?.title ?? ''),
    [course]
  )

  // Les chiffres surlignent, tant qu'un passage est vise. Ils ne valent que
  // la : ailleurs, 1 a 5 sont des chiffres qu'on tape dans ses notes.
  useEffect(() => {
    if (!target) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'Escape') {
        setTarget(null)
        return
      }

      const colour = HIGHLIGHT_KEYS[event.key]
      if (!colour) return

      // Un passage peut rester vise alors qu'on ecrit ailleurs — on a
      // selectionne dans le cours, puis on est alle taper dans ses notes. Le
      // « 1 » appartient alors a la phrase en cours, pas a la palette.
      const where = event.target as HTMLElement | null
      if (where?.isContentEditable || where instanceof HTMLTextAreaElement || where instanceof HTMLInputElement) {
        return
      }

      event.preventDefault()
      applyColour(colour)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [target, applyColour])

  /**
   * Un clic ailleurs referme la palette. Le panneau du cours ne voit pas ces
   * clics-la : sans cette ecoute, la palette resterait ouverte au-dessus du
   * document pendant qu'on ecrit dans ses notes, comme un post-it oublie.
   */
  useEffect(() => {
    if (!target) return

    const onPointerDown = (event: PointerEvent): void => {
      const where = event.target as HTMLElement | null
      if (where?.closest('.palette') || where?.closest('.panel--course')) return
      setTarget(null)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [target])

  /** Rejoint un passage depuis la liste. */
  const goToAnnotation = useCallback(
    (annotation: Annotation) => {
      if (annotation.page !== null) {
        jumpToPage(annotation.page)
        return
      }

      const body = bodyRef.current
      if (!htmlRoot || !body) return
      const ranges = locateAnnotation(htmlRoot, annotation)
      if (ranges.length === 0) return

      const rect = ranges[0].getBoundingClientRect()
      const frame = body.getBoundingClientRect()
      // Au tiers superieur : on relit un passage avec ce qui le precede.
      body.scrollTop += rect.top - frame.top - body.clientHeight / 3
      flashFocus(ranges)
    },
    [htmlRoot, jumpToPage]
  )

  return (
    <section
      className="panel panel--course"
      ref={panelRef}
      style={panelStyle(expanded, width, grow)}
      data-expanded={expanded}
    >
      {/* Plus de bandeau : la page prend toute la hauteur. Les commandes — le
          point de vectorisation, le zoom, la pagination, les surlignages, la
          legende et l'agrandissement (l'ancienne etiquette « Cours ») — vivent
          dans un tiroir centre en haut, rentre par defaut : seule l'encoche
          depasse, et un clic le fait sortir ou rentrer. Le `overflow: hidden`
          du panneau rogne la barre rentree au bord superieur. */}
      <div className="course-float" data-open={controlsOpen}>
        <div className="course-float-bar">
        {course && <VectorDot status={vectors} />}

        {zoom !== 1 && (
          <button
            className="icon-button zoom-badge"
            onClick={() => setZoom(1)}
            title="Revenir à la taille du panneau"
          >
            {Math.round(zoom * 100)} %
          </button>
        )}

        {state && (
          <div className="pager">
            <button
              className="icon-button"
              onClick={() => goToPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              title="Page précédente"
            >
              ‹
            </button>
            <PagerPosition
              current={currentPage}
              total={state.pageCount}
              onGoToPage={goToPage}
            />
            <button
              className="icon-button"
              onClick={() => goToPage(Math.min(state.pageCount, currentPage + 1))}
              disabled={currentPage >= state.pageCount}
              title="Page suivante"
            >
              ›
            </button>
          </div>
        )}

        {course && (
          <button
            className="icon-button drawer-toggle"
            onClick={() => setDrawerOpen((open) => !open)}
            data-active={drawerOpen}
            title="Tous les surlignages de ce cours"
          >
            Surlignages
            {annotations.length > 0 && (
              <span className="drawer-count">{annotations.length}</span>
            )}
          </button>
        )}

        {course && <HighlightLegend />}

        <button
          className="icon-button"
          onClick={onToggleExpand}
          data-active={expanded}
          title={expanded ? 'Rétablir les trois sections (⌘1)' : 'Agrandir le cours (⌘1)'}
          aria-label={expanded ? 'Rétablir les trois sections' : 'Agrandir le cours'}
        >
          {expanded ? (
            <Minimize2 size={13} aria-hidden="true" />
          ) : (
            <Maximize2 size={13} aria-hidden="true" />
          )}
        </button>
        </div>

        <button
          className="course-float-notch"
          onClick={() => setControlsOpen((open) => !open)}
          aria-expanded={controlsOpen}
          title={controlsOpen ? 'Ranger les commandes du cours' : 'Commandes du cours'}
          aria-label={controlsOpen ? 'Ranger les commandes du cours' : 'Commandes du cours'}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      {findOpen && (
        <DocumentFinder
          pages={pages}
          htmlRoot={htmlRoot}
          body={bodyRef.current}
          onGoToPage={jumpToPage}
          onClose={onCloseFind}
        />
      )}

      {drawerOpen && course && (
        <AnnotationsDrawer
          annotations={annotations}
          onGoTo={goToAnnotation}
          onRemove={remove}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      {/* Hors de la zone defilante, a dessein. Pose a l'interieur, ce bandeau
          etait le premier enfant d'un conteneur que la reprise de lecture fait
          aussitot defiler vers la page ou l'on s'etait arrete : le seul message
          expliquant l'echec sortait de l'ecran juste apres etre apparu. */}
      {error && (
        <div className="course-error" role="alert">
          <strong>Impossible de lire ce document</strong>
          <span>{error}</span>
        </div>
      )}

      {/* Hors de la zone defilante, comme le message d'erreur : le bandeau doit
          rester visible quand on parcourt le cours, sinon le retour a l'original
          n'est accessible qu'en remontant tout en haut. */}
      {(ocrCourse || conversion.running || conversion.asking > 0) && (
        <OcrBanner
          view={conversion.running ? 'original' : ocrView}
          onChange={(next) => {
            setOcrView(next)
            if (courseId) rememberSpot(courseId, { view: next })
          }}
          original={ocrCourse?.document.original ?? course?.title ?? ''}
          progress={conversion.running ? conversion : null}
          asking={
            conversion.asking > 0
              ? {
                  count: conversion.asking,
                  accept: conversion.accept,
                  decline: conversion.decline
                }
              : null
          }
        />
      )}

      {/* Un cours reconstitue auquel il manque des pages le dit, au meme
          endroit que le bandeau : hors de la zone defilante, pour que la
          reprise reste a portee de clic ou qu'on en soit dans le cours. */}
      {ocrCourse?.document.missing && ocrCourse.document.missing.length > 0 && (
        <div className="ocr-missing" role="status">
          <span className="ocr-note">
            {ocrCourse.document.missing.length === 1
              ? `La page ${ocrCourse.document.missing[0]} n’a pas pu être lue`
              : `${ocrCourse.document.missing.length} pages n’ont pas pu être lues`}
            {ocrCourse.document.pageCount ? ` sur ${ocrCourse.document.pageCount}` : ''} — le
            cours est incomplet.
            {resume.error ? ` ${resume.error}` : ''}
          </span>
          <button className="ocr-choice ocr-choice--go" onClick={resume.start} disabled={resume.running}>
            {resume.running
              ? `Lecture — page ${resume.done} sur ${resume.total}`
              : 'Poursuivre la lecture'}
          </button>
        </div>
      )}

      <div
        className="panel-body course-body"
        ref={bodyRef}
        onMouseDown={() => {
          dragging.current = true
        }}
      >
        {!course && (
          <div className="empty">
            <p className="empty-title">Aucun cours ouvert</p>
            <p className="empty-hint">Appuie sur ⌘K pour en choisir un.</p>
          </div>
        )}

        {ocrCourse && ocrView === 'original' && (
          <OriginalView original={ocrCourse.document.original} width={pageWidth} />
        )}

        {documentHtml !== null && ocrView === 'ocr' && documentSkin !== null && (
          /* Un cours HTML se dessine avec son propre style, pas celui du
             panneau : le conteneur tient lieu de page, et le zoom passe par la
             propriete CSS du meme nom — un artefact ecrit en pixels ne
             suivrait pas une taille de police. Le <style> est place a cote du
             corps et non dedans : la recherche de texte parcourt le corps, et
             y lirait la feuille de style.

             Le cadre autour porte le zoom et sert de conteneur aux requetes de
             largeur du document, traduites par `scopeCss` : c'est lui qu'elles
             mesurent, et il ne peut pas etre l'article, qu'elles habillent. */
          <div className="document-html-frame" style={{ zoom }}>
            <article
              className={`${HTML_COURSE_SCOPE} ${documentSkin.bodyClass}`.trim()}
              onClick={followInternalLink}
            >
              {warnings.length > 0 && (
                <p className="document-warning" title={warnings.join('\n')}>
                  {warnings.length === 1
                    ? 'Un élément du cours a été ignoré — survole pour savoir lequel.'
                    : `${warnings.length} éléments du cours ont été ignorés — survole pour savoir lesquels.`}
                </p>
              )}
              <style>{documentSkin.css}</style>
              <div ref={setHtmlRoot} dangerouslySetInnerHTML={documentBody ?? undefined} />
            </article>
          </div>
        )}

        {documentHtml !== null && ocrView === 'ocr' && documentSkin === null && (
          <article className="document-render" style={{ fontSize: `${zoom}em` }}>
            {warnings.length > 0 && (
              <p className="document-warning" title={warnings.join('\n')}>
                {warnings.length === 1
                  ? '1 élément de mise en forme n’a pas pu être converti depuis Word.'
                  : `${warnings.length} éléments de mise en forme n’ont pas pu être convertis depuis Word.`}
              </p>
            )}
            {/* Le HTML a ete passe par sanitiseHtml juste avant d'arriver ici :
                seules des balises de document subsistent, sans script ni style. */}
            <div ref={setHtmlRoot} dangerouslySetInnerHTML={documentBody ?? undefined} />
          </article>
        )}

        {/* Origine de taille nulle : ses enfants se placent dans le repere du
            contenu et defilent donc avec lui, sans un calcul par cran de
            molette. Une couche a `inset: 0` serait, elle, collee a l'ecran. */}
        <div className="course-marks" aria-hidden="true">
          {spot.map((box, index) => (
            <span
              key={`spot-${index}`}
              className="course-spot"
              style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
            />
          ))}
        </div>

        {state &&
          Array.from({ length: state.pageCount }, (_, index) => (
            <div
              key={index + 1}
              data-page={index + 1}
              data-flashed={flash?.page === index + 1}
              className="pdf-page-slot"
            >
              <PdfPage
                document={state.document}
                pageNumber={index + 1}
                width={pageWidth}
                aspectRatio={state.aspectRatio}
                annotations={byPage.get(index + 1)}
                onVisible={handlePageVisible}
                onFollowLink={followLink}
              />
            </div>
          ))}
      </div>

      {target && (
        <AnnotationPalette
          anchor={target.anchor}
          annotation={targeted}
          onPick={applyColour}
          onComment={(text) => target.id && comment(target.id, text)}
          onRemove={() => {
            if (target.id) remove(target.id)
            setTarget(null)
          }}
          onExplain={() => {
            onExplain(target.passage.text, referenceOf(target.page, target.heading))
            setTarget(null)
          }}
          onClose={() => setTarget(null)}
        />
      )}

      {/* Ou l'on en est dans le defilement, pour un cours HTML — le seul format
          qui n'avait rien.

          Le rail se pose dans la gouttiere qui separe le panneau de son voisin,
          et non sur le document : c'est pour cela qu'il passe par un portail
          vers le bureau. Un panneau rogne ce qui deborde de lui, et le
          separateur est son frere, pas son enfant. */}
      {scrollbar &&
        documentSkin !== null &&
        panelRef.current?.parentElement &&
        createPortal(
          <div
            className="course-scroll"
            style={{
              left: scrollbar.trackLeft,
              top: scrollbar.trackTop,
              height: scrollbar.trackHeight
            }}
          >
            <div
              className="course-scroll-thumb"
              style={{ top: scrollbar.thumbTop, height: scrollbar.thumbHeight }}
              onPointerDown={dragScrollbar}
              role="presentation"
            />
          </div>,
          panelRef.current.parentElement
        )}

      {extraction && (
        <div className="extraction-bar" title="Le texte est transmis à Claude au fur et à mesure">
          <div
            className="extraction-fill"
            style={{ width: `${(extraction.done / extraction.total) * 100}%` }}
          />
          <span className="extraction-label">
            Lecture du cours · {extraction.done}/{extraction.total}
          </span>
        </div>
      )}
    </section>
  )
}

/** Les touches nues, dans l'ordre de la legende. */
const HIGHLIGHT_KEYS: Record<string, HighlightColorId> = {
  '1': 'retenir',
  '2': 'incompris',
  '3': 'definition',
  '4': 'formule',
  '5': 'transversal'
}

/**
 * L'etat de la recherche par le sens, en un point de sept pixels.
 *
 * Sans lui, un cours mal vectorise se comporte exactement comme un cours bien
 * vectorise : l'assistant repond, cite des pages, et rien ne trahit qu'il a
 * cherche avec les seuls mots-cles. Le point ne devient vert que lorsque tous
 * les passages sont calcules et ecrits sur le disque — c'est la seule promesse
 * qu'il tienne, et il la tient entierement.
 */
function VectorDot({ status }: { status: VectorStatus | null }): React.JSX.Element | null {
  if (!status) return null

  const echec =
    status.total === 0
      ? 'Aucun texte extrait de ce document : l’IA ne peut pas le consulter'
      : `Vectorisation interrompue à ${status.done}/${status.total} — rouvre le cours pour reprendre`

  const label = {
    attente: 'Traitement du document : préparation…',
    calcul: `Recherche par le sens : ${status.done} passages sur ${status.total}`,
    // L'orange dit une chose precise : l'assistant sait deja chercher dans ce
    // cours, et ce qui reste ne concerne que l'ancrage des notes.
    affine: status.reason
      ? `Recherche par le sens active. Affinage interrompu : ${status.reason}`
      : `Recherche par le sens active · affinage des passages ${status.done}/${status.total}`,
    complet: `Document entièrement traité · ${status.total} passages affinés`,
    // La raison donnee par le moteur passe en premier : c'est elle qui dit quoi
    // faire, quand le reste ne dit que l'endroit ou l'on s'est arrete.
    echec: status.reason ? `${status.reason}\n${echec}` : echec
  }[status.phase]

  return <span className="vector-dot" data-phase={status.phase} title={label} aria-label={label} />
}

/**
 * Le compteur de pages, qui sert aussi a s'y rendre.
 *
 * Un sommaire annonce « 4.4 L'EBITDA ajuste ... 16 » : sans ce champ, y aller
 * demande quinze clics sur la fleche. Le numero affiche est deja la cible du
 * regard — c'est donc lui qu'on rend cliquable, plutot que d'ajouter un bouton.
 */
function PagerPosition({
  current,
  total,
  onGoToPage
}: {
  current: number
  total: number
  onGoToPage: (page: number) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const open = (): void => {
    setDraft(String(current))
    setEditing(true)
  }

  const submit = (): void => {
    const page = Number.parseInt(draft, 10)
    setEditing(false)
    if (Number.isFinite(page)) {
      // Une page hors du document ramene au bord le plus proche, plutot que de
      // ne rien faire sans rien dire.
      onGoToPage(Math.min(total, Math.max(1, page)))
    }
  }

  if (editing) {
    return (
      <span className="pager-position">
        <input
          ref={inputRef}
          className="pager-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') submit()
            if (event.key === 'Escape') setEditing(false)
          }}
          onBlur={submit}
          inputMode="numeric"
          aria-label={`Aller à une page, sur ${total}`}
        />
        <span className="pager-total">/ {total}</span>
      </span>
    )
  }

  return (
    <button className="pager-position" onClick={open} title="Aller à une page">
      <span className="pager-current">{current}</span>
      <span className="pager-total">/ {total}</span>
    </button>
  )
}
