import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import Placeholder from '@tiptap/extension-placeholder'
import TextAlign from '@tiptap/extension-text-align'
import { TableKit } from '@tiptap/extension-table'
import { Color, TextStyle } from '@tiptap/extension-text-style'
import {
  anchorLabel,
  sameAnchor,
  type Course,
  type NoteAnchor,
  type NoteDraft,
  type NoteProposal
} from '@shared/types'
import { noteAnchors, sortAnchoredNote } from '@shared/note-order'
import BlockTools from './BlockTools'
import type { ChatMention } from './ChatPanel'
import NotesGutter from './NotesGutter'
import NotesToolbar from './NotesToolbar'
import PanelLabel from './PanelLabel'
import { ANCHORED, AnchorAttribute, effectiveAnchor } from '../lib/editor-anchor'
import { Callout } from '../lib/editor-callout'
import { StyledTable } from '../lib/editor-table'
import { Diagram, mountMindmap, renderDiagram, validateDiagram } from '../lib/editor-diagram'
import { mathExtensions } from '../lib/editor-math'
import { FontSize } from '../lib/editor-font-size'
import {
  aiMarkdownToHtml,
  checkTables,
  diagramSources,
  htmlToMarkdown,
  markdownToHtml,
  renderAiPreview
} from '../lib/markdown'
import '../styles/anchors.css'
import '../styles/notes.css'

export type SaveState = 'idle' | 'pending' | 'saved' | 'error'

/** Une reponse de l'assistant, recopiee dans la note sur clic explicite. */
export interface NoteInsert {
  text: string
  /** Deux clics de suite doivent produire deux insertions. */
  nonce: number
}

/** Le temps d'ecran de la carte « Modification appliquee » : lu, elle s'en va. */
const APPLIED_CARD_TIMEOUT = 2_000

/**
 * Ou en est la proposition d'ecriture de l'assistant. `writing` montre le
 * texte pendant qu'il se compose, avant meme que l'outil ne soit appele ;
 * `pending` attend la decision ; `applied` garde la note d'avant, pour
 * l'annulation en un geste ; `stale` dit pourquoi rien n'a ete applique.
 */
type ProposalState =
  | {
      stage: 'writing'
      draft: NoteDraft
      /** La note au moment ou l'ecriture a commence, pour neutraliser les balises. */
      base: string
    }
  | {
      stage: 'pending'
      proposal: NoteProposal
      /** La note au moment de l'arrivee : l'apercu neutralise les balises contre elle. */
      base: string
    }
  | { stage: 'applied'; previous: string; auto: boolean }
  | { stage: 'stale' }

interface NotesPanelProps {
  course: Course | null
  /** Compteur d'enregistrements demandes depuis la barre de titre. */
  saveRequest: number
  /** Reponse de l'assistant a recopier en fin de note. */
  insert: NoteInsert | null
  /** Ou l'on en est de la lecture du cours : l'ancre par defaut de ce qu'on ecrit. */
  reading: NoteAnchor | null
  /**
   * Les unites du document que le cours affiche a cet instant — « page:12 »,
   * « section:7 ». Elles restreindront les candidats de l'ancrage automatique
   * a ce qui est sous les yeux : un bloc qu'on vient d'ecrire commente ce qu'on
   * regarde, et le chercher dans les quarante autres pages du cours ne
   * ramenerait que des faux voisins.
   */
  visibleUnits: string[]
  /**
   * Les titres du cours affiche, dans l'ordre. C'est l'echelle qui range les
   * ancres de ce panneau : une ancre nomme sa section, elle ne dit pas ou
   * cette section tombe dans le cours, et c'est le rang du titre dans cette
   * liste qui le dit. Vide pour un PDF, dont les pages se comparent seules.
   */
  sections: string[]
  /** La synchronisation des deux defilements, et son interrupteur. */
  syncOn: boolean
  onToggleSync: () => void
  /**
   * Demande au cours de rejoindre cet endroit. `signal` dit si l'endroit doit
   * etre montre — un clic sur un repere — ou seulement rejoint.
   */
  onGoTo: (anchor: NoteAnchor, signal?: boolean) => void
  /** Le defilement des notes entraine le cours. */
  onFollow: (anchor: NoteAnchor) => void
  /** Le cours a defile : les notes suivent. */
  follow: { anchor: NoteAnchor; nonce: number } | null
  expanded: boolean
  onToggleExpand: () => void
  /**
   * Decoche dans le bandeau : la feuille quitte l'ecran mais reste montee.
   * C'est par ce panneau que passent les outils d'ecriture de l'assistant, le
   * ⌘S de la barre de titre et l'insertion depuis le chat — demonte, il
   * n'ecoute plus rien et ces gestes tombent dans le vide.
   */
  hidden: boolean
  /** Remonte l'etat pour que le bouton de la barre de titre dise la verite. */
  onSaveState: (state: SaveState) => void
  /** Demande a l'assistant de mettre la note au propre. */
  onTidy: () => void
  /** Une proposition vient d'arriver : le panneau doit etre visible. */
  onProposalShown: () => void
  /**
   * Mode « Auto » : les propositions s'appliquent sans validation. Le
   * garde-fou n'est plus la confirmation prealable, c'est la visibilite — la
   * carte reste affichee avec « Annuler » — et les memes verifications de
   * caducite qu'au clic.
   */
  autoApply: boolean
  /**
   * Un passage de la feuille part vers la barre de saisie de l'assistant.
   *
   * Rien n'est envoye : le passage y attend la question qu'on veut poser
   * dessus, exactement comme un passage cite d'une reponse.
   */
  onMention: (mention: ChatMention) => void
  /**
   * Le cadre de la feuille, remonte pour que l'assistant y pose les pastilles
   * des passages mentionnes. Un rappel plutot qu'un ref : celui qui les rend
   * doit etre averti quand le cadre apparait ou disparait.
   */
  stageRef: (element: HTMLElement | null) => void
}

/** Delai d'inactivite avant enregistrement automatique. */
const SAVE_DELAY = 700

/**
 * Le bouton « Mentionner » ne monte pas plus haut : au-dela il passerait
 * derriere l'entete du panneau et la barre d'outils, et sur un passage pris
 * tout en haut de la feuille il faudrait deviner ou il est parti.
 */
const MENTION_POP_MIN_TOP = 148

/**
 * Longueur en deca de laquelle un groupe ne designe plus rien.
 *
 * « Important ! », « a revoir », « cf. supra » : ce sont des marques de
 * lecture, pas des propos. Les vectoriser reviendrait a demander au cours
 * lequel de ses passages ressemble le plus a un point d'exclamation, et comme
 * le meilleur score gagne toujours — il n'y a pas de seuil au moment du choix
 * — on obtiendrait une reponse, forcement arbitraire. Sans ancre fine, le bloc
 * releve de la page qu'on lisait : c'est moins precis, et c'est vrai.
 */
const ANCRAGE_MIN = 40

/** Les blocs qui contiennent leurs propres puces, et qu'on finit en en sortant. */
const LISTES = ['bulletList', 'orderedList']

/**
 * Ou se trouve, maintenant, le bloc qui porte cette identite.
 *
 * On ne retrouve jamais un bloc par la position d'ou l'on est parti. Entre
 * l'envoi de son texte et la reponse il s'ecoule un aller-retour avec le
 * modele — plusieurs secondes s'il demarre a froid — et rien n'empeche
 * d'ecrire trois lignes plus haut pendant ce temps : toutes les positions
 * ProseMirror ont alors glisse, et celle du depart designe un voisin, ou le
 * milieu d'un autre paragraphe. On y poserait l'ancre trouvee sans que rien
 * ne le signale. L'identite, elle, suit le bloc ou qu'il aille.
 *
 * Null dit que le bloc n'existe plus — efface, ou emporte par une reecriture
 * complete de la note. Il n'y a alors rien a ancrer, et rien a dire.
 */
function findBloc(doc: ProseMirrorNode, id: string): number | null {
  // Un objet plutot qu'une variable : TypeScript ne suit pas une affectation
  // faite dans un rappel, et la croirait restee nulle.
  const found: { at: number | null } = { at: null }

  doc.descendants((node, pos) => {
    if (found.at !== null) return false
    if (node.attrs.blocId === id) found.at = pos
    return found.at === null
  })

  return found.at
}

/**
 * Ce qui, dans une proposition, l'empeche d'etre montree : une grille qui ne
 * se relira pas en tableau, un schema dont la syntaxe ne compile pas. Rend la
 * raison, ou null si tout tient debout.
 *
 * La verification a lieu avant l'apercu, et sa raison repart au modele : une
 * faute de syntaxe se corrige entre eux, sans deranger l'utilisateur.
 */
async function validateProposal(content: string): Promise<string | null> {
  const tables = checkTables(content)
  if (tables) return tables

  for (const source of diagramSources(content)) {
    const failure = await validateDiagram(source)
    if (failure) {
      return `le schema mermaid « ${source.split('\n')[0]?.trim()} » ne compile pas (${failure})`
    }
  }

  return null
}

/**
 * L'endroit du cours qu'une ancre designe, le passage mis de cote.
 *
 * `sameAnchor` compare aussi le passage, et c'est ce qu'il faut partout
 * ailleurs : deux notes d'une meme page ne commentent pas la meme phrase. Mais
 * la ligne de lecture, elle, ne designe qu'un lieu et n'a jamais de passage —
 * tandis qu'un bloc de note ancre finement en porte toujours un. Les comparer
 * avec `sameAnchor` renvoyait donc faux pour exactement les blocs qui
 * comptent, et le panneau ne suivait plus rien.
 */
function placeOf(anchor: NoteAnchor | null): string | null {
  if (!anchor) return null
  if (anchor.page !== null) return `page:${anchor.page}`
  if (anchor.section !== null) return `section:${anchor.section}`
  return anchor.progress === null ? null : `progress:${anchor.progress}`
}

/** Le meme endroit du cours, au sens du defilement. */
function samePlace(a: NoteAnchor | null, b: NoteAnchor | null): boolean {
  const place = placeOf(a)
  return place !== null && place === placeOf(b)
}

/**
 * La place d'une ancre dans l'ordre du cours, pour savoir laquelle vient
 * avant l'autre.
 *
 * Trois echelles, jamais melangees au sein d'un meme document : le numero de
 * page d'un PDF, le rang du titre pour un document a sections, la fraction
 * parcourue d'un support d'un seul bloc. La deuxieme est celle qui manquait —
 * un titre n'a pas d'ordre en lui-meme, il le tient de sa place dans le
 * document, que le panneau du cours nous donne.
 *
 * Rendre null n'est pas une erreur : une ancre sans lieu, un titre disparu
 * d'un cours refait. Elle ne classe rien, elle n'empeche rien non plus.
 */
function placeRank(anchor: NoteAnchor | null, sections: string[]): number | null {
  if (!anchor) return null
  if (anchor.page !== null) return anchor.page
  if (anchor.section !== null) {
    const at = sections.indexOf(anchor.section)
    return at === -1 ? null : at
  }
  return anchor.progress
}

export default function NotesPanel({
  course,
  saveRequest,
  insert,
  reading,
  visibleUnits,
  sections,
  syncOn,
  onToggleSync,
  onGoTo,
  onFollow,
  follow,
  expanded,
  onToggleExpand,
  hidden,
  onSaveState,
  onTidy,
  onProposalShown,
  autoApply,
  onMention,
  stageRef
}: NotesPanelProps): React.JSX.Element {
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [counts, setCounts] = useState({ words: 0, characters: 0 })
  const [proposal, setProposal] = useState<ProposalState | null>(null)
  /** Miroir de l'etat, pour repondre au main depuis les nettoyages d'effets. */
  const proposalRef = useRef<ProposalState | null>(null)
  proposalRef.current = proposal
  /**
   * Compteur d'accuses de reception de ⌘S. Un nombre plutot qu'un booleen :
   * deux ⌘S de suite doivent produire deux confirmations, ce qu'un booleen
   * deja vrai ne saurait pas signaler.
   */
  const [confirmed, setConfirmed] = useState(0)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Le cours dont le contenu est actuellement dans l'editeur. Sert a
  // enregistrer au bon endroit lors d'un changement de cours.
  const loadedCourseId = useRef<string | null>(null)

  /**
   * Indirection indispensable : le callback passe a `useEditor` est fige a la
   * creation de l'editeur, c'est-a-dire au rendu ou `editor` vaut encore null.
   * Sans cette reference, la sauvegarde automatique appellerait pour toujours
   * une version de la fonction qui n'a pas d'editeur — et n'ecrirait jamais rien.
   */
  const scheduleSaveRef = useRef<() => void>(() => {})

  /** L'ancre que porterait un bloc ecrit maintenant : la page qu'on lit. */
  const currentAnchor = useRef<NoteAnchor | null>(null)
  currentAnchor.current = reading

  /**
   * Faux le temps d'une ecriture qui n'est pas de la frappe — chargement d'une
   * note, application d'une proposition de l'assistant, annulation. Ce qui
   * s'ecrit alors n'a pas ete tape en face du cours et n'a rien a ancrer : les
   * blocs de l'assistant heritent de leur voisin, comme convenu.
   */
  const anchoring = useRef(true)

  const withoutAnchoring = useCallback((write: () => void) => {
    anchoring.current = false
    try {
      write()
    } finally {
      anchoring.current = true
    }
  }, [])

  /** Les rappels appeles depuis des fonctions memoisees, sans les faire changer. */
  const onFollowRef = useRef(onFollow)
  onFollowRef.current = onFollow

  const bodyRef = useRef<HTMLDivElement>(null)
  /** Le temps d'un defilement que nous avons provoque : le garde-fou anti-boucle. */
  const driven = useRef<ReturnType<typeof setTimeout> | null>(null)

  const markDriven = useCallback(() => {
    if (driven.current) clearTimeout(driven.current)
    driven.current = setTimeout(() => {
      driven.current = null
    }, 400)
  }, [])

  /**
   * Le groupe qui attend son passage, et ce que le cours montrait quand il a
   * commence.
   *
   * Les unites sont capturees a l'ouverture du groupe, jamais a sa fermeture :
   * entre les deux on a pu faire defiler le cours ailleurs, et on chercherait
   * la phrase commentee dans une page que personne n'avait sous les yeux en
   * l'ecrivant.
   */
  const pendingBloc = useRef<{ id: string; units: string[] } | null>(null)

  /**
   * Le bloc encore sous la frappe, dont le repere de lieu reste vivant.
   *
   * L'ancre de page se pose au premier caractere, mais la ligne n'est pas
   * finie : ecrire trois lettres, se raviser, tourner deux pages et reprendre
   * doit laisser le repere sur ce qu'on regarde, pas sur la page du premier
   * caractere. Tant qu'on n'a pas quitte le bloc, son lieu suit donc la
   * lecture ; le geste qui le quitte — Entree, clic ailleurs, Echap, perte du
   * focus — le fige en l'etat.
   */
  const vif = useRef<string | null>(null)

  /**
   * Les blocs nes sous cette frappe, et eux seuls.
   *
   * Tous les blocs ont une identite, y compris ceux qu'on relit d'un fichier :
   * elle ne suffit donc plus a distinguer ce qu'on vient d'ecrire de ce qu'on
   * rouvre un mois plus tard. Ce registre le dit, et c'est ce qui garantit
   * qu'une note ancienne ne se reancre pas parce qu'on y corrige une faute.
   */
  const nesIci = useRef(new Set<string>())

  /** Ce que le cours affiche a l'instant, lisible depuis les rappels figes. */
  const visibleRef = useRef(visibleUnits)
  visibleRef.current = visibleUnits
  /** Lue depuis le suivi du defilement, qui ne se redeclenche que sur son compteur. */
  const sectionsRef = useRef(sections)
  sectionsRef.current = sections

  /**
   * Meme indirection que `scheduleSaveRef`, et pour la meme raison : ces deux
   * rappels partent dans la configuration de l'editeur, figee au rendu ou
   * `editor` vaut encore null. Sans le detour par une reference, ils
   * appelleraient pour toujours une version d'eux-memes sans editeur.
   */
  const watchBlocRef = useRef<(transaction: Transaction) => void>(() => {})
  const flushBlocRef = useRef<() => void>(() => {})

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false }
      }),
      TextStyle,
      Color,
      FontSize,
      Highlight.configure({ multicolor: true }),
      // `listItem` compte autant que le paragraphe : sans lui, l'alignement se
      // posait sur le paragraphe interne de la puce, un niveau trop bas pour
      // que le marqueur en tienne compte — le texte se centrait, la puce
      // restait a gauche.
      TextAlign.configure({ types: ['heading', 'paragraph', 'listItem'] }),
      // Un tableau se redimensionne a la souris : dans une colonne de lecture
      // etroite, la largeur des colonnes se regle au cas par cas. Le tableau
      // de TipTap cede la place au notre, qui lui ajoute son habillage.
      TableKit.configure({ table: false }),
      StyledTable.configure({ resizable: true }),
      // Les encadres semantiques et les schemas, ecrits par l'assistant comme
      // par l'utilisateur, et enregistres en Markdown ordinaire.
      Callout,
      Diagram,
      // Les formules se composent pendant la frappe : taper $x^2$ donne x²,
      // pas la suite de symboles. Indispensable pour un cours de finance, ou
      // une definition sur deux est une formule.
      ...mathExtensions,
      // Le lien vivant avec le cours : chaque bloc retient en face de quoi il
      // a ete ecrit, et le retient une seule fois, au premier caractere.
      AnchorAttribute.configure({
        current: () => currentAnchor.current,
        enabled: () => anchoring.current
      }),
      Placeholder.configure({
        placeholder: 'Prends tes notes ici…'
      })
    ],
    editorProps: {
      attributes: {
        class: 'notes-editor',
        spellcheck: 'true'
      },
      // Echap ne veut rien dire de particulier pour l'editeur, et tout pour
      // qui ecrit : « ce bloc-la est fini ». On va chercher son passage sans
      // attendre que la minuterie tombe, et on rend la touche a qui en aurait
      // l'usage — elle sert ailleurs, il n'y a aucune raison de la retenir.
      handleKeyDown: (_view, event) => {
        if (event.key === 'Escape') {
          flushBlocRef.current()
          vif.current = null
        }
        return false
      },
      // Un clic sous la derniere ligne atterrit toujours au meme endroit —
      // la fin du texte — quelle que soit la hauteur visee, faute d'un
      // caractere a cet endroit pour l'accueillir. On complete alors la
      // feuille de lignes vides jusqu'a la hauteur cliquee, comme le ferait
      // Word : le curseur se retrouve au niveau demande, pret a ecrire.
      //
      // Une ligne vide est un paragraphe, jamais un saut de ligne dans un
      // paragraphe commun. Un remplissage en sauts de ligne posait bien le
      // curseur au bon endroit, mais il en faisait un seul bloc de vingt
      // lignes : la citation appliquee ensuite enveloppait le bloc entier et
      // son filet courait sur toute sa hauteur, la puce d'une liste se posait
      // sur sa premiere ligne — vingt lignes au-dessus du curseur — et ces
      // sauts partaient sur le disque, ou ils revenaient a chaque ouverture.
      // Un paragraphe par ligne rend au contraire chaque commande de bloc
      // exacte : elle ne saisit que la ligne ou l'on est.
      handleClick: (view, _pos, event) => {
        const { state } = view
        const endPos = state.doc.content.size
        const endCoords = view.coordsAtPos(endPos)
        const lineHeight = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 24

        // En dessous de la moitie d'une ligne, on laisse ProseMirror placer
        // le curseur lui-meme : c'est encore un clic sur le texte existant.
        const gap = event.clientY - endCoords.bottom
        if (gap < lineHeight * 0.6) return false

        // Combien de lignes vides faut-il pour atteindre la hauteur cliquee ?
        // Des sondes jetables, posees un instant dans la feuille reelle, le
        // disent avec certitude : elles heritent exactement des regles de
        // style en jeu — hauteur de ligne, et marge entre deux paragraphes,
        // que la feuille annule justement entre deux paragraphes vides. Un
        // calcul a partir des seules metriques CSS ne les reproduirait pas.
        const probes: HTMLElement[] = []
        while (probes.length < 120) {
          const line = document.createElement('p')
          line.appendChild(document.createElement('br'))
          view.dom.appendChild(line)
          probes.push(line)
          if (line.getBoundingClientRect().bottom >= event.clientY) break
        }
        const lines = probes.length
        for (const line of probes) line.remove()
        if (lines === 0) return false

        const { paragraph } = state.schema.nodes
        const fill = Array.from({ length: lines }, () => paragraph.create())
        const tr = state.tr.insert(endPos, fill)
        view.dispatch(
          tr.setSelection(TextSelection.near(tr.doc.resolve(tr.doc.content.size)))
        )
        view.focus()
        return true
      }
    },
    onUpdate: ({ transaction }) => {
      scheduleSaveRef.current()
      watchBlocRef.current(transaction)
    },
    // Deplacer le curseur hors du bloc sous la frappe fige son repere : des
    // qu'on ecrit ou clique ailleurs, ce qu'il montre devient un fait.
    onSelectionUpdate: ({ editor: courant }) => {
      if (!vif.current) return
      const from = courant.state.selection.$from
      const id = from.depth > 0 ? courant.state.doc.nodeAt(from.before(1))?.attrs.blocId : null
      if (id !== vif.current) vif.current = null
    },
    // Quitter l'editeur ferme le groupe en cours, au meme titre qu'en ouvrir un
    // autre. C'est meme le seul signal disponible quand on part lire le cours,
    // repondre a l'assistant ou changer de document sans avoir touche au
    // clavier : sans lui, le dernier groupe ecrit attendrait un passage que
    // plus rien ne viendrait lui chercher.
    onBlur: () => {
      flushBlocRef.current()
      vif.current = null
    }
  })

  /** Ecrit le contenu courant sur disque, pour le cours actuellement charge. */
  const save = useCallback(async () => {
    const targetId = loadedCourseId.current
    if (!editor || !targetId) return

    try {
      const markdown = htmlToMarkdown(editor.getHTML())
      await window.noted.notes.write(targetId, markdown)
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [editor])

  /**
   * Recompte les mots. Volontairement appele au meme rythme que
   * l'enregistrement, et non a chaque frappe : le decompte se lit dans une
   * pause, jamais au milieu d'un mot, et le mettre a jour a chaque touche
   * redessinerait le panneau des centaines de fois par minute.
   */
  const measure = useCallback(() => {
    if (!editor) return
    const text = editor.getText()

    setCounts({
      // Un mot commence par une lettre ou un chiffre, quelle que soit la
      // langue, et peut porter apostrophes et traits d'union : « aujourd'hui »
      // et « coût-bénéfice » comptent chacun pour un.
      words: (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length,
      characters: text.length
    })
  }, [editor])

  const scheduleSave = useCallback(() => {
    setSaveState('pending')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void save()
      measure()
    }, SAVE_DELAY)
  }, [save, measure])

  useEffect(() => {
    scheduleSaveRef.current = scheduleSave
  }, [scheduleSave])

  // Charge la note du cours ouvert, apres avoir enregistre la precedente.
  //
  // L'effet suit l'identifiant, jamais l'objet, pour la raison que CoursePanel
  // documente de son cote : `useVault` reconstruit tous ses `Course` a chaque
  // remous du vault. Suivre l'objet rechargerait la note depuis le disque et
  // rendrait le curseur au debut du document — au premier mot ecrit dans une
  // note vierge, precisement, puisque c'est la que la pastille bascule et que
  // l'ecran est prevenu.
  const openCourseId = course?.id ?? null

  useEffect(() => {
    if (!editor) return
    let cancelled = false

    void (async () => {
      // Un changement de cours ne doit jamais perdre une frappe en attente.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
        await save()
      }

      if (!openCourseId) {
        loadedCourseId.current = null
        withoutAnchoring(() => editor.commands.setContent('', { emitUpdate: false }))
        measure()
        return
      }

      const note = await window.noted.notes.read(openCourseId)
      if (cancelled) return

      loadedCourseId.current = openCourseId
      // emitUpdate: false, sinon le simple chargement declencherait une
      // sauvegarde et reecrirait le fichier a chaque ouverture.
      withoutAnchoring(() =>
        editor.commands.setContent(markdownToHtml(note.markdown), { emitUpdate: false })
      )
      setSaveState('idle')
      measure()
    })()

    return () => {
      cancelled = true
    }
  }, [openCourseId, editor, save, measure, withoutAnchoring])

  // Enregistrement de securite a la fermeture de la fenetre.
  useEffect(() => {
    const flush = (): void => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
        void save()
      }
    }

    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [save])

  /**
   * Enregistrer sur commande, alors que tout s'enregistre deja tout seul.
   *
   * Le reflexe est plus ancien que l'enregistrement automatique, et le contredire
   * ne le fera pas disparaitre : mieux vaut lui repondre. Le geste ne double
   * donc pas la mecanique d'ecriture — il avance simplement l'echeance du
   * minuteur et rend le resultat visible, pour qu'il ne tombe pas dans le vide.
   */
  const forceSave = useCallback(() => {
    if (!loadedCourseId.current) return

    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    void save()
    measure()
    setConfirmed((tick) => tick + 1)
  }, [save, measure])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.key !== 's') return
      event.preventDefault()
      forceSave()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [forceSave])

  /**
   * Le bouton de la barre de titre passe par ce compteur. On retient la valeur
   * deja traitee plutot que de reagir a tout declenchement de l'effet : celui-ci
   * retourne aussi quand `forceSave` change d'identite, ce qui ecrirait un
   * fichier que personne n'a demande.
   */
  const handledRequest = useRef(saveRequest)
  useEffect(() => {
    if (saveRequest === handledRequest.current) return
    handledRequest.current = saveRequest
    forceSave()
  }, [saveRequest, forceSave])

  useEffect(() => {
    onSaveState(saveState)
  }, [saveState, onSaveState])

  /**
   * Une reponse de l'assistant recopiee dans la note — le clic sur « Inserer
   * dans mes notes » vaut accord, il n'y a pas d'apercu a confirmer en plus.
   *
   * Elle ne s'empile plus en fin de note : le main lui donne ses ancres et sa
   * place dans l'ordre du cours, exactement comme a un ajout de l'assistant
   * par le brouillon — les pages qu'elle cite disent de quoi elle parle.
   * La fin de note reste le repli, note sans marqueurs ou endroit illisible :
   * c'est le comportement qu'avait le bouton.
   */
  const handledInsert = useRef(insert?.nonce ?? 0)
  useEffect(() => {
    if (!editor || !insert || insert.nonce === handledInsert.current) return
    handledInsert.current = insert.nonce

    const courseId = loadedCourseId.current
    if (!courseId) return

    let cancelled = false
    void (async () => {
      let content = insert.text
      try {
        content = await window.noted.notes.anchorBlocks(courseId, insert.text)
      } catch {
        // Sans ancres, la reponse va en fin de note, telle quelle.
      }
      if (cancelled || loadedCourseId.current !== courseId) return

      // La note a pu bouger pendant l'aller-retour : on relit avant d'ecrire.
      const now = htmlToMarkdown(editor.getHTML())
      const next = await sortedNote(courseId, now ? `${now}\n\n${content}` : content)
      if (cancelled || loadedCourseId.current !== courseId) return
      withoutAnchoring(() => {
        editor.commands.setContent(aiMarkdownToHtml(next, now), { emitUpdate: true })
      })
      revealBlock(bodyRef.current, content)
    })()

    return () => {
      cancelled = true
    }
  }, [insert, editor, withoutAnchoring])

  // -------------------------------------------------------------------------
  // Le lien vivant avec le cours
  // -------------------------------------------------------------------------

  /**
   * Le defilement des notes entraine le cours — a la molette, jamais pendant la
   * frappe : le cours ne doit pas bouger sous les yeux de qui ecrit. On envoie
   * l'ancre dont releve le premier bloc visible.
   */
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !editor) return

    /*
     * Ce qui fait d'un defilement un geste : la molette, ou la barre qu'on
     * tire. La feuille defile aussi toute seule — le caret qui descend sous le
     * bord a chaque Entree, au bas d'une note un peu longue — et ce
     * defilement-la n'est pas un geste. Pris pour tel, il envoyait le cours a
     * la page du premier bloc visible, quatre pages plus haut, pendant qu'on
     * ecrivait : la note qui naissait ensuite prenait cette page-la.
     *
     * La molette s'entend tant qu'elle tourne, elan compris ; la barre se
     * reconnait a ce qu'un clic dessus vise le conteneur lui-meme, jamais son
     * contenu.
     */
    const gesture = { wheelAt: 0, dragging: false }
    const onWheel = (): void => {
      gesture.wheelAt = performance.now()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target === body) gesture.dragging = true
    }
    const onPointerUp = (): void => {
      gesture.dragging = false
    }

    let frame = 0
    const onScroll = (): void => {
      // Un defilement amorti dure plus longtemps qu'un delai fixe : tant qu'il
      // court, chacun de ses crans repousse la fin de la fenetre. Sans cela, sa
      // fin etait prise pour un geste de l'utilisateur et renvoyait le cours
      // en arriere — les deux panneaux se poursuivaient.
      if (driven.current) {
        markDriven()
        return
      }
      if (!gesture.dragging && performance.now() - gesture.wheelAt > 400) return
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (driven.current) return

        const top = body.getBoundingClientRect().top + body.clientHeight / 3
        const children = editor.view.dom.children
        // Un objet plutot que des variables : TypeScript ne suit pas une
        // affectation faite dans un rappel, et les croirait restees nulles.
        const seen: { inherited: NoteAnchor | null; found: NoteAnchor | null } = {
          inherited: null,
          found: null
        }
        let index = 0

        editor.state.doc.forEach((node) => {
          const element = children[index] as HTMLElement | undefined
          index += 1
          const anchor = node.attrs.ancre as NoteAnchor | null
          if (anchor) seen.inherited = anchor
          if (!element) return
          if (element.getBoundingClientRect().top <= top) seen.found = seen.inherited
        })

        if (seen.found) onFollowRef.current(seen.found)
      })
    }

    body.addEventListener('scroll', onScroll, { passive: true })
    body.addEventListener('wheel', onWheel, { passive: true })
    body.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      body.removeEventListener('scroll', onScroll)
      body.removeEventListener('wheel', onWheel)
      body.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [editor, markDriven])

  /**
   * Le cours a defile : les notes suivent. On cherche le premier bloc rattache
   * a cet endroit ; a defaut, le dernier ecrit avant lui — on voit toujours ou
   * l'on en etait, jamais un panneau qui saute en arriere.
   *
   * Les deux questions se posent sur le *lieu* seul — page ou section — et
   * jamais sur le passage : la ligne de lecture du cours n'en designe aucun,
   * et un bloc ancre finement en porte toujours un. C'est le sens de
   * `samePlace` et de `placeRank`, la ou l'on comparait des ancres entieres.
   */
  useEffect(() => {
    const body = bodyRef.current
    if (!follow || !editor || !body) return

    const rank = placeRank(follow.anchor, sectionsRef.current)
    const children = editor.view.dom.children
    const seen: {
      inherited: NoteAnchor | null
      target: HTMLElement | null
      fallback: HTMLElement | null
    } = { inherited: null, target: null, fallback: null }
    let index = 0

    editor.state.doc.forEach((node) => {
      const element = children[index] as HTMLElement | undefined
      index += 1
      const anchor = node.attrs.ancre as NoteAnchor | null
      if (anchor) seen.inherited = anchor
      if (!element) return

      if (!seen.target && samePlace(seen.inherited, follow.anchor)) seen.target = element
      // A defaut, le dernier bloc ecrit avant cet endroit du cours : on voit
      // toujours ou l'on en etait, jamais un panneau qui saute en arriere.
      const at = placeRank(seen.inherited, sectionsRef.current)
      if (at !== null && rank !== null && at <= rank) seen.fallback = element
    })

    const destination = seen.target ?? seen.fallback
    if (!destination) return

    const frame = body.getBoundingClientRect()
    const box = destination.getBoundingClientRect()
    if (box.top >= frame.top && box.bottom <= frame.bottom) return

    markDriven()
    body.scrollTo({ top: body.scrollTop + box.top - frame.top - body.clientHeight / 3, behavior: 'smooth' })
    // Le compteur seul declenche : suivre deux fois le meme endroit est legitime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow?.nonce])

  // -------------------------------------------------------------------------
  // L'ancrage fin : le passage du cours dont un groupe de blocs parle
  // -------------------------------------------------------------------------

  /**
   * Le groupe auquel appartient le bloc de premier niveau d'indice donne.
   *
   * Un paragraphe n'est pas une idee. On en ouvre un pour aerer, pour poser
   * une puce, pour reprendre son souffle — et trois paragraphes de suite
   * commentent le plus souvent le meme endroit du cours. Les ancrer un par un
   * revenait a poser trois reperes la ou il en fallait un, parfois a trois
   * endroits differents du document, faute que chacun pris isolement en dise
   * assez.
   *
   * Le groupe commence donc au dernier bloc qui porte une ancre a lui — c'est
   * la que l'endroit du cours a change, donc la qu'une idee commence — et court
   * jusqu'a la prochaine frontiere. Trois choses font frontiere : une ligne
   * vide (on a fini son idee), un autre bloc ancre (on a change de page), et le
   * texte relu d'un fichier (il a ete pense un autre jour). Seule la premiere
   * est un geste ; les deux autres sont des faits que la note porte deja.
   *
   * Rend null quand il n'y a pas de groupe a fermer : le curseur est au-dessus
   * de toute identite, ou une frontiere le separe de la sienne.
   */
  function groupeAt(
    doc: ProseMirrorNode,
    index: number
  ): { id: string; text: string; tete: number; fin: number } | null {
    const blocs: ProseMirrorNode[] = []
    doc.forEach((node) => blocs.push(node))
    if (index < 0 || index >= blocs.length) return null

    /**
     * Ce qui separe deux idees.
     *
     * Un seul geste le fait volontairement : sauter une ligne. C'est deja celui
     * qu'on fait pour separer deux idees, il ne demande donc rien de neuf a
     * apprendre — la ou une pause de frappe ou un titre ne disent rien de ce
     * qu'on a voulu.
     *
     * S'y ajoute une frontiere qu'on ne trace pas soi-meme : le texte relu d'un
     * fichier. Un bloc ecrit sous la frappe recoit une identite, un bloc relu
     * n'en a pas, et c'est ce qui empeche de reancrer d'un coup toutes les
     * notes anciennes a la reouverture d'un cours. Hier s'arrete donc la ou
     * cette identite manque.
     *
     * La condition ne vaut que pour les blocs qui *peuvent* en porter une : un
     * tableau ou une image n'en recoivent jamais, et lire leur silence comme
     * une frontiere couperait un groupe en deux sans raison.
     */
    const frontiere = (node: ProseMirrorNode): boolean =>
      node.textContent.trim() === '' ||
      (ANCHORED.includes(node.type.name) && typeof node.attrs.blocId !== 'string')

    // En remontant : le bloc qui porte l'identite, sauf si une rupture s'est
    // glissee entre lui et nous. Le bloc du curseur ne se rompt pas lui-meme —
    // il est vide a l'instant ou on l'ouvre, et c'est justement la qu'on ecrit.
    // La tete est le bloc qui porte une ancre a lui : c'est la que l'endroit du
    // cours a change, donc la qu'une idee commence. L'identite, elle, ne dit
    // rien de la structure — tous les blocs neufs en ont une.
    let tete = 0
    for (let at = index; at >= 0; at -= 1) {
      // La frontiere se lit avant l'ancre, et l'ordre compte, pour deux raisons
      // qui se ressemblent.
      //
      // La ligne vide qui ferme un groupe recoit une ancre de protection, pour
      // que ce qu'on ecrira dessous ne soit pas rattache au passage qu'on vient
      // de poser. Lue comme une tete, cette ligne vide n'a pas d'identite — et
      // plus aucun bloc de la note ne pouvait s'ouvrir apres le premier.
      //
      // Le texte relu d'un fichier porte lui aussi son ancre, et n'a pas
      // davantage d'identite : on renoncait au groupe entier, emportant le bloc
      // neuf ecrit juste dessous. La protection du passe interdisait donc
      // d'ancrer le present des qu'il le touchait — reprendre une note d'hier
      // en continuant sous sa derniere ligne n'ancrait plus jamais rien.
      //
      // Dans les deux cas la reponse est la meme : ce bloc-la ne commence rien,
      // il finit. Et une frontiere ne ferme pas seulement le groupe d'avant,
      // elle ouvre celui d'apres — sans quoi ce qui la suit n'aurait aucune
      // tete, donc rien a quoi rattacher son passage.
      if (at < index && frontiere(blocs[at])) {
        tete = at + 1
        break
      }
      if (blocs[at].attrs.ancre) {
        tete = at
        break
      }
      tete = at
    }

    // Une tete relue d'un fichier n'a pas d'identite : la note a ete rouverte,
    // et il n'est pas question de reancrer ce qui a ete pense un autre jour.
    const id = blocs[tete].attrs.blocId
    if (typeof id !== 'string') return null

    // En redescendant : tout ce que la tete regit, jusqu'a la rupture.
    const parts: string[] = []
    let fin = blocs.length
    for (let at = tete; at < blocs.length; at += 1) {
      if (at > tete && (blocs[at].attrs.ancre || frontiere(blocs[at]))) {
        fin = at
        break
      }
      const texte = blocs[at].textContent.trim()
      if (texte) parts.push(texte)
    }

    return { id, text: parts.join(' '), tete, fin }
  }

  /**
   * Rend au groupe l'ancre que sa tete vient de recevoir.
   *
   * `ancrerBloc` protege ce qui suit une ancre neuve : il fixe au bloc d'apres
   * l'ancre dont il relevait deja, pour qu'une ancre posee au milieu d'une note
   * ne reattribue pas d'un geste tout ce qui est ecrit en dessous. La regle est
   * juste pour un bloc isole ; pour un groupe, elle tombe un cran trop tot — le
   * bloc suivant fait partie du groupe, et doit heriter du passage plutot que
   * retomber sur la page. On deplace donc la protection a la fin du groupe : ce
   * qu'il regit herite, ce qui vient apres est preserve.
   */
  const recolleGroupe = useCallback(
    (tete: number, fin: number, ancienne: NoteAnchor | null): void => {
      if (!editor || editor.isDestroyed || !ancienne) return

      editor.commands.command(({ tr, state, dispatch }) => {
        if (!dispatch) return true

        const positions: number[] = []
        state.doc.forEach((_node, offset) => positions.push(offset))

        // Les membres du groupe reprennent leur silence : ils relevent de la
        // tete, qui porte desormais le passage.
        for (let at = tete + 1; at < fin && at < positions.length; at += 1) {
          const node = state.doc.nodeAt(positions[at])
          const own = node?.attrs.ancre as NoteAnchor | null
          if (own && sameAnchor(own, ancienne)) tr.setNodeAttribute(positions[at], 'ancre', null)
        }

        // Et le premier bloc d'apres recoit la protection qu'on vient de lui
        // reprendre, s'il n'en portait pas deja une a lui.
        if (fin < positions.length) {
          const apres = state.doc.nodeAt(positions[fin])
          if (apres && !apres.attrs.ancre) tr.setNodeAttribute(positions[fin], 'ancre', ancienne)
        }

        return true
      })
    },
    [editor]
  )

  /**
   * Va chercher le passage du cours dont ce groupe parle, et le pose sur sa
   * tete.
   *
   * L'ancre recue a la naissance du bloc dit la page ; celle-ci dit la phrase.
   * C'est toute la difference entre « cette note vient de la page 12 » et
   * « cette note commente ce paragraphe-la », et c'est ce qui permet a la
   * marge de rallumer d'un coup d'oeil tout ce qu'on a ecrit sur un passage.
   *
   * Une reponse nulle n'est pas un echec : c'est l'etat normal tant que
   * l'index fin du cours n'est pas calcule, ou que le modele d'embedding n'est
   * pas la. Le groupe reste alors ancre a sa page, ce qu'il a toujours ete.
   */
  const anchorBloc = useCallback(
    async (id: string, units: string[]) => {
      if (!editor || editor.isDestroyed) return
      const courseId = loadedCourseId.current
      if (!courseId) return

      const at = findBloc(editor.state.doc, id)
      if (at === null) return

      const groupe = groupeAt(editor.state.doc, editor.state.doc.resolve(at).index(0))
      if (!groupe || groupe.id !== id) return
      if (groupe.text.length < ANCRAGE_MIN) return

      const anchor = await window.noted.notes.anchorPassage(courseId, groupe.text, units)

      // On revient dans un present qu'on n'a pas vu passer : le cours a pu
      // changer, le panneau etre ferme, le groupe etre efface. Ces trois choses
      // disent la meme : il n'y a plus rien a ancrer, et c'est sans gravite.
      if (!anchor || editor.isDestroyed || loadedCourseId.current !== courseId) return
      const now = findBloc(editor.state.doc, id)
      if (now === null) return

      // Le groupe est relu ici, et non repris de tout a l'heure : entre l'envoi
      // et la reponse, il a pu s'allonger d'un paragraphe ou en perdre un.
      const alors = groupeAt(editor.state.doc, editor.state.doc.resolve(now).index(0))
      if (!alors || alors.id !== id) return
      // L'ancre dont la tete relevait, et non celle qu'elle portait en propre :
      // c'est celle-la que `ancrerBloc` va deposer en protection, donc celle-la
      // qu'il faudra reconnaitre pour la deplacer a la fin du groupe. Une tete
      // qui herite — le cas de tous les blocs sauf le premier — n'a pas d'ancre
      // propre, et la protection restait alors plantee au milieu du groupe.
      const ancienne = effectiveAnchor(editor.state.doc, alors.tete)

      // `ancrerBloc` remonte de la position qu'on lui donne au bloc de premier
      // niveau qui la contient : il lui faut donc une position a l'interieur
      // du bloc, la ou le parcours du document donne celle du noeud lui-meme.
      //
      // L'ecriture passe par `withoutAnchoring` comme toute ecriture qui n'est
      // pas de la frappe : cette transaction ne doit ni reveiller le plugin
      // d'ancrage, ni etre prise pour un bloc qu'on vient de taper.
      withoutAnchoring(() => {
        editor.commands.ancrerBloc(now + 1, anchor)
        recolleGroupe(alors.tete, alors.fin, ancienne)
      })
    },
    [editor, withoutAnchoring, recolleGroupe]
  )

  /** Le groupe en attente ne l'attend plus : on va chercher son passage. */
  const flushBloc = useCallback(() => {
    const target = pendingBloc.current
    pendingBloc.current = null
    if (target) void anchorBloc(target.id, target.units).catch(() => undefined)
  }, [anchorBloc])

  /**
   * A chaque frappe : quel groupe est ouvert, et lequel vient de se fermer.
   *
   * Il n'y a plus de minuterie. Elle demandait a une pause de la frappe de
   * signifier « j'ai fini », ce qu'une pause ne dit pas : on s'arrete pour
   * relire, pour chercher un mot, pour regarder le cours. Le texte partait
   * alors a moitie ecrit, et comme un groupe ne s'ancre qu'une fois, la
   * seconde moitie n'y changeait plus rien.
   *
   * Ce qui dit vraiment qu'un groupe est fini, c'est qu'on l'a quitte : on
   * ecrit ailleurs, on saute une ligne, on ouvre un titre, on passe au cours.
   * Le prix de ce choix est assume : tant qu'on reste dans son paragraphe, la
   * marge ne montre rien.
   */
  const watchBloc = useCallback(
    (transaction: Transaction) => {
      // Meme garde que le plugin d'ancrage, pour la meme raison : ce qui
      // s'ecrit pendant le chargement d'une note ou l'application d'une
      // proposition n'a pas ete tape en face du cours.
      if (!editor || !anchoring.current || !loadedCourseId.current) return

      const here = editor.state.selection.$from
      if (here.depth === 0) return

      const groupe = groupeAt(editor.state.doc, here.index(0))

      // Aucun groupe ouvert : le curseur est au-dessus de toute identite, ou
      // une rupture l'en separe. Celui qui attendait est donc bel et bien
      // quitte.
      if (!groupe) {
        flushBloc()
        return
      }

      /*
       * Sortir d'une liste la termine.
       *
       * Une liste entiere est un seul bloc : ses puces sont dedans, et sauter
       * une ligne au milieu ne fait qu'une puce de plus. Il faut donc en sortir
       * pour la finir — et l'editeur consomme deja deux Entree pour cela, la
       * premiere ouvrant une puce vide, la seconde la quittant. Attendre en
       * plus une ligne vide revenait a demander une troisieme Entree pour une
       * liste la ou deux suffisent pour un paragraphe : la regle cessait d'etre
       * la meme partout, sans que rien ne le signale.
       *
       * On lit la sortie a ce qu'elle laisse : un bloc vide, juste sous une
       * liste. Quand on arrete de faire des puces, la liste est finie.
       */
      const place = here.index(0)
      const dessus = place > 0 ? editor.state.doc.child(place - 1) : null
      if (
        dessus &&
        LISTES.includes(dessus.type.name) &&
        editor.state.doc.child(place).textContent.trim() === ''
      ) {
        flushBloc()
        return
      }

      if (pendingBloc.current?.id === groupe.id) return

      /*
       * `transaction.before` est le document d'avant la frappe : l'identite
       * d'un bloc qui vient de naitre n'y figure pas encore, celle d'un bloc
       * qu'on relit y figure deja. C'est a cet instant precis, et au seul
       * endroit ou le curseur se trouve, qu'on sait qu'un bloc est ne sous
       * cette frappe.
       *
       * Un bloc qu'on avait vide renait de la meme facon. Il a garde son
       * identite, mais ce qu'on y ecrit maintenant n'a rien a voir avec ce
       * qu'on en a efface : le plugin lui redonne la page qu'on lit, et il
       * doit redevenir vivant pour la suivre — sans quoi le repere restait
       * fige sur la page d'avant des qu'un clic dans le cours l'avait quitte.
       */
      const ici = editor.state.doc.nodeAt(here.before(1))?.attrs.blocId
      if (typeof ici === 'string') {
        const avant = findBloc(transaction.before, ici)
        const ne = avant === null || transaction.before.nodeAt(avant)?.textContent.trim() === ''
        if (ne) {
          nesIci.current.add(ici)
          // C'est ici qu'un bloc nait sous la frappe : son repere de lieu
          // restera vivant jusqu'au geste qui le quitte.
          vif.current = ici
        }
      }

      // Deux raisons de ne rien ouvrir, qui disent la meme chose : ce groupe
      // n'a pas ete ecrit maintenant. Soit sa tete vient d'un fichier relu,
      // soit elle porte deja son passage — un groupe s'ancre une fois, le jour
      // ou il a ete pense.
      const tete = findBloc(editor.state.doc, groupe.id)
      const ancre =
        tete === null ? null : (editor.state.doc.nodeAt(tete)?.attrs.ancre as NoteAnchor | null)

      if (!nesIci.current.has(groupe.id) || ancre?.passage) {
        flushBloc()
        return
      }

      // Le groupe precedent n'aura pas de meilleure occasion : on ne quitte le
      // sien que pour en ouvrir un autre.
      flushBloc()
      pendingBloc.current = { id: groupe.id, units: visibleRef.current }
    },
    [editor, flushBloc]
  )

  watchBlocRef.current = watchBloc
  flushBlocRef.current = flushBloc

  /**
   * Changer de cours, ou fermer le panneau, abandonne le groupe en attente.
   *
   * Rien ne se perd : il garde l'ancre de page recue a sa naissance. Aller
   * chercher son passage maintenant serait de toute facon vain — la reponse
   * reviendrait pour un cours qui n'est plus charge, et serait refusee. Ce qui
   * rattrape ce cas est la perte du focus, plus haut : quitter l'editeur pour
   * la bibliotheque ou le panneau du cours ferme le groupe avant que le cours
   * ne change.
   */
  useEffect(() => {
    return () => {
      pendingBloc.current = null
      vif.current = null
    }
  }, [course])

  /**
   * Le repere du bloc sous la frappe suit la lecture.
   *
   * `reading` bouge a chaque defilement du cours : si un bloc est encore
   * vivant, on recale son ancre de lieu sur ce qui est desormais sous les
   * yeux — page d'un PDF ou section d'un Markdown, c'est la meme donnee. Un
   * passage deja pose, lui, est un fait : on n'y touche jamais.
   *
   * Hors de l'historique d'annulation : ces recalages viennent de la molette,
   * pas du clavier, et ⌘Z doit defaire la frappe, jamais un defilement.
   */
  useEffect(() => {
    if (!editor || !reading) return
    const id = vif.current
    if (!id) return

    const at = findBloc(editor.state.doc, id)
    if (at === null) return
    const own = (editor.state.doc.nodeAt(at)?.attrs.ancre as NoteAnchor | null) ?? null
    if (own?.passage) return

    // Meme regle qu'a la naissance du bloc : une ancre qui repete ce dont il
    // releverait deja n'apprend rien a personne, on la laisse muette.
    const index = editor.state.doc.resolve(at).index(0)
    const inherited = effectiveAnchor(editor.state.doc, index - 1)
    const next = sameAnchor(reading, inherited) ? null : reading
    if (sameAnchor(own, next)) return

    withoutAnchoring(() => {
      editor.commands.command(({ tr, dispatch }) => {
        if (dispatch) tr.setNodeAttribute(at, 'ancre', next).setMeta('addToHistory', false)
        return true
      })
    })
  }, [editor, reading, withoutAnchoring])

  // -------------------------------------------------------------------------
  // Dialogue avec les outils de l'assistant
  // -------------------------------------------------------------------------

  /**
   * « note_lire » lit ce qui est a l'ecran, pas le dernier fichier enregistre :
   * on rend le markdown de l'editeur, a condition que le cours demande soit
   * bien celui qui est charge. Sinon le main se rabat sur le disque.
   */
  useEffect(() => {
    return window.noted.notes.onLiveRequest(({ requestId, courseId }) => {
      const markdown =
        editor && loadedCourseId.current === courseId ? htmlToMarkdown(editor.getHTML()) : null
      window.noted.notes.replyLive(requestId, markdown)
    })
  }, [editor])

  /**
   * Applique une proposition — le seul chemin par lequel l'assistant ecrit
   * dans la note. En mode normal il passe par un clic de l'utilisateur ; en
   * mode Auto il s'execute a l'arrivee. Dans les deux cas la cible est
   * verifiee sur le contenu courant : si la note a change, la proposition est
   * declaree caduque plutot que d'ecraser une frappe recente. Tout ce qui
   * separe cette verification de l'ecriture est synchrone — rien ne peut
   * s'intercaler.
   */
  /**
   * Le bouton « Trier par page » : la note telle qu'elle est, rangee. Pas de
   * carte a accepter — c'est un geste du lecteur, et ⌘Z le defait.
   */
  const sortNote = useCallback(() => {
    const courseId = loadedCourseId.current
    if (!editor || !courseId) return
    void (async () => {
      const before = htmlToMarkdown(editor.getHTML())
      const next = await sortedNote(courseId, before)
      if (editor.isDestroyed || loadedCourseId.current !== courseId || next === before) return
      if (htmlToMarkdown(editor.getHTML()) !== before) return
      withoutAnchoring(() => {
        editor.commands.setContent(aiMarkdownToHtml(next, before), { emitUpdate: true })
      })
    })()
  }, [editor, withoutAnchoring])

  const applyIncoming = useCallback(
    async (incoming: NoteProposal, auto: boolean) => {
      if (!editor) return

      if (loadedCourseId.current !== incoming.courseId) {
        window.noted.notes.respondProposal(incoming.id, 'not-open')
        setProposal(null)
        return
      }

      const before = htmlToMarkdown(editor.getHTML())

      // « remplacer » vise une cible, « inserer » peut etre ancre apres un
      // passage : dans les deux cas ce texte doit encore exister, une seule fois.
      if (incoming.target !== undefined) {
        const occurrences = incoming.target ? before.split(incoming.target).length - 1 : 0
        if (occurrences !== 1) {
          window.noted.notes.respondProposal(incoming.id, 'stale')
          setProposal({ stage: 'stale' })
          return
        }
      }
      if (incoming.kind === 'reecrire' && incoming.base !== undefined && incoming.base !== before) {
        window.noted.notes.respondProposal(incoming.id, 'stale')
        setProposal({ stage: 'stale' })
        return
      }

      /**
       * Le texte d'apres, calcule sur le Markdown quand la note doit etre
       * rangee ensuite (`trier`) ou quand le changement vise un endroit
       * precis ; l'ajout au curseur reste un geste de l'editeur, seul a savoir
       * ou est le curseur. Un ajout en fin de note sans tri passe aussi par
       * l'editeur : c'est le geste le plus leger.
       */
      let next: string | null = null
      if (incoming.kind === 'inserer' && incoming.target) {
        // Ancre : le contenu prend place juste apres le passage vise, le
        // reste de la note n'est pas touche. Une fonction, pas une chaine :
        // `$` y serait un motif special, et les formules LaTeX en sont pleines.
        next = before.replace(incoming.target, () => `${incoming.target}\n\n${incoming.content}`)
      } else if (incoming.kind === 'inserer' && incoming.position !== 'curseur' && incoming.trier) {
        next = before ? `${before}\n\n${incoming.content}` : incoming.content
      } else if (incoming.kind === 'remplacer') {
        next = before.replace(incoming.target ?? '', () => incoming.content)
      } else if (incoming.kind === 'reecrire') {
        next = incoming.content
      }

      if (next !== null && incoming.trier) {
        next = await sortedNote(incoming.courseId, next)
        // Le tri a demande sa cle a chaque ancre, un aller-retour pendant
        // lequel la note a pu bouger : ce qui etait vrai avant ne l'est plus.
        if (editor.isDestroyed || htmlToMarkdown(editor.getHTML()) !== before) {
          window.noted.notes.respondProposal(incoming.id, 'stale')
          setProposal({ stage: 'stale' })
          return
        }
      }

      withoutAnchoring(() => {
        if (next !== null) {
          editor.commands.setContent(aiMarkdownToHtml(next, before), { emitUpdate: true })
        } else {
          const html = aiMarkdownToHtml(incoming.content, before)
          if (incoming.position === 'curseur') {
            editor.chain().focus().insertContent(html).run()
          } else {
            editor.commands.insertContentAt(editor.state.doc.content.size, html)
          }
        }
      })

      // La version d'avant part sur le disque apres coup, avec l'etat capture
      // avant l'ecriture. Pas avant : un await entre la verification et
      // l'application ouvrirait une fenetre ou une frappe s'intercale et se
      // fait ecraser. Le filet en memoire, lui, est deja tendu.
      void window.noted.notes.backup(incoming.courseId, before).catch(() => undefined)

      window.noted.notes.respondProposal(incoming.id, 'applied')
      setProposal({ stage: 'applied', previous: before, auto })
    },
    [editor, withoutAnchoring]
  )

  /** Une proposition d'ecriture arrive, ou cesse d'attendre. */
  useEffect(() => {
    const offProposal = window.noted.notes.onProposal((incoming) => {
      // Un autre cours que celui affiche : la proposition n'a nulle part ou
      // s'appliquer, on repond tout de suite plutot que de la laisser pourrir.
      if (loadedCourseId.current !== incoming.courseId) {
        window.noted.notes.respondProposal(incoming.id, 'not-open')
        return
      }

      void (async () => {
        // Un tableau sans ligne de separation ou un schema dont la syntaxe ne
        // compile pas n'a rien a faire sous les yeux de l'utilisateur : la
        // proposition repart au modele, qui corrige et repropose. C'est le
        // seul refus que l'application prononce toute seule.
        const complaint = await validateProposal(incoming.content)
        if (complaint) {
          window.noted.notes.respondProposal(incoming.id, 'invalid', complaint)
          return
        }

        // Le cours a pu changer pendant la verification.
        if (loadedCourseId.current !== incoming.courseId) {
          window.noted.notes.respondProposal(incoming.id, 'not-open')
          return
        }

        // En mode Auto, pas de salle d'attente : la proposition s'applique et
        // la carte raconte ce qui vient de se passer, annulation comprise.
        //
        // `direct` fait de meme sans que le mode soit actif. C'est la pose d'un
        // brouillon : l'assistant l'a compose passage par passage sous les yeux
        // de l'utilisateur, dans le fil du chat, et une carte de confirmation a
        // l'arrivee lui redemanderait une decision sur un texte qu'il a deja lu.
        // La carte d'apres-coup, elle, reste — c'est par elle qu'on annule.
        if (autoApply || incoming.direct) {
          void applyIncoming(incoming, true)
        } else {
          setProposal({
            stage: 'pending',
            proposal: incoming,
            base: editor ? htmlToMarkdown(editor.getHTML()) : ''
          })
        }
        onProposalShown()
      })()
    })

    const offCancel = window.noted.notes.onProposalCancel((proposalId) => {
      setProposal((current) =>
        current?.stage === 'pending' && current.proposal.id === proposalId ? null : current
      )
    })

    return () => {
      offProposal()
      offCancel()
    }
  }, [onProposalShown, autoApply, applyIncoming, editor])

  /**
   * Le texte d'une ecriture de l'assistant, pendant qu'il se compose. La
   * carte le montre au fil de l'eau sans rien proposer : la proposition
   * reelle suivra et prendra sa place — ou ne viendra pas (syntaxe refusee,
   * note fermee), et le brouillon s'efface a la fin de l'appel d'outil.
   */
  const revealedDraft = useRef<string | null>(null)
  useEffect(() => {
    const offDraft = window.noted.notes.onDraft((draft) => {
      if (loadedCourseId.current !== draft.courseId) return
      setProposal((current) => {
        // Une proposition qui attend sa decision n'est pas recouverte : elle
        // compte plus que ce qui s'ecrit derriere elle.
        if (current?.stage === 'pending') return current
        if (current?.stage === 'writing') return { ...current, draft }
        return { stage: 'writing', draft, base: editor ? htmlToMarkdown(editor.getHTML()) : '' }
      })
      // Le panneau se montre a la premiere ligne, comme pour une proposition.
      if (revealedDraft.current !== draft.id) {
        revealedDraft.current = draft.id
        onProposalShown()
      }
    })

    const offEnd = window.noted.notes.onDraftEnd(({ courseId, id }) => {
      setProposal((current) =>
        current?.stage === 'writing' &&
        current.draft.courseId === courseId &&
        (id === null || current.draft.id === id)
          ? null
          : current
      )
    })

    return () => {
      offDraft()
      offEnd()
    }
  }, [editor, onProposalShown])

  /**
   * Changer de cours ou fermer le panneau retire l'apercu : la proposition
   * vise une note qui n'est plus a l'ecran. Le tour de l'assistant reprend
   * avec un refus explicite plutot que d'attendre dix minutes dans le vide.
   */
  useEffect(() => {
    return () => {
      const current = proposalRef.current
      if (current?.stage === 'pending') {
        window.noted.notes.respondProposal(current.proposal.id, 'not-open')
      }
      setProposal(null)
    }
  }, [course])

  /**
   * La carte « Modification appliquee » s'efface d'elle-meme : deux secondes
   * suffisent a la lire, et la laisser exigeait un clic de menage apres
   * chaque ecriture de l'assistant. L'annulation ne part pas avec elle : ⌘Z
   * defait l'application comme n'importe quelle frappe. La comparaison
   * d'identite protege la carte suivante — si une nouvelle proposition
   * remplace celle-ci pendant l'attente, le minuteur perime ne touche a rien.
   */
  useEffect(() => {
    if (proposal?.stage !== 'applied') return undefined
    const timer = setTimeout(() => {
      setProposal((current) => (current === proposal ? null : current))
    }, APPLIED_CARD_TIMEOUT)
    return () => clearTimeout(timer)
  }, [proposal])

  const refuseProposal = useCallback(() => {
    const current = proposalRef.current
    if (current?.stage !== 'pending') return
    window.noted.notes.respondProposal(current.proposal.id, 'refused')
    setProposal(null)
  }, [])

  /** Le clic « Appliquer » sur la proposition en attente. */
  const applyProposal = useCallback(() => {
    const current = proposalRef.current
    if (current?.stage !== 'pending') return
    void applyIncoming(current.proposal, false)
  }, [applyIncoming])

  /** L'annulation en un geste, meme apres coup : la note d'avant revient. */
  const undoProposal = useCallback(() => {
    const current = proposalRef.current
    if (current?.stage !== 'applied' || !editor) return
    withoutAnchoring(() =>
      editor.commands.setContent(markdownToHtml(current.previous), { emitUpdate: true })
    )
    setProposal(null)
  }, [editor, withoutAnchoring])

  /**
   * Le passage que la selection designe dans la feuille, et le bouton pose
   * au-dessus d'elle.
   *
   * Tout se decide au relachement de la souris : c'est le seul moment ou la
   * selection est arretee. L'ecoute est posee sur le document plutot que sur la
   * feuille, sans quoi un glissement parti des notes et termine dans le cours ou
   * dans le fil — le geste ordinaire quand on selectionne jusqu'au bord — ne
   * serait jamais vu.
   */
  const [cite, setCite] = useState<{
    text: string
    range: Range
    anchor: { x: number; y: number }
  } | null>(null)
  const nextMentionId = useRef(0)

  useEffect(() => {
    if (!editor) return undefined

    const onUp = (event: MouseEvent): void => {
      // Le bouton est lui-meme relache a la souris : le laisser relancer ce
      // calcul le ferait reapparaitre juste apres son propre clic.
      if (event.target instanceof Element && event.target.closest('.quote-pop')) return

      // Reporte d'un tour : cliquer dans une selection ne la defait qu'apres
      // les ecouteurs, et le passage semblerait encore pris.
      window.setTimeout(() => {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          setCite(null)
          return
        }

        const range = selection.getRangeAt(0)
        // L'ancetre commun, et non le point de depart : une selection partie de
        // la feuille et finie ailleurs remonte alors au-dessus d'elle, et n'est
        // pas proposee — on ne mentionne que ce qui tient dans les notes.
        const node = range.commonAncestorContainer
        const element = node instanceof HTMLElement ? node : node.parentElement
        if (!element || !editor.view.dom.contains(element)) {
          setCite(null)
          return
        }

        // Les blancs sont ramenes a un espace : un passage est une ligne, meme
        // pris a cheval sur deux paragraphes ou dans une liste a puces.
        const text = selection.toString().replace(/\s+/g, ' ').trim()
        if (!text) {
          setCite(null)
          return
        }

        const box = range.getBoundingClientRect()
        setCite({
          text,
          range: range.cloneRange(),
          anchor: { x: (box.left + box.right) / 2, y: box.top }
        })
      }, 0)
    }

    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [editor])

  /**
   * La provenance que le passage annonce a l'assistant.
   *
   * Elle se lit sur le bloc ou la selection commence : son ancre, ou a defaut
   * la derniere posee au-dessus de lui — la meme regle que la marge, pour que
   * ce qu'on lit en face du passage soit ce qui part au modele. Une feuille
   * ecrite sans le cours en face n'a rien a ancrer : le passage dit alors
   * seulement d'ou il vient, ce qui est deja l'essentiel.
   */
  const mentionSource = useCallback((): string => {
    if (!editor) return 'mes notes'
    const anchor = effectiveAnchor(editor.state.doc, editor.state.selection.$from.index(0))
    if (!anchor) return 'mes notes'
    const label = anchorLabel(anchor)
    // « passage » ne nomme aucun endroit : c'est ce que rend une ancre qui n'a
    // ni page, ni section, ni progression. Mieux vaut ne rien ajouter.
    return label === 'passage' ? 'mes notes' : `mes notes, ${label}`
  }, [editor])

  /**
   * Ou se trouvent, maintenant, les passages mentionnes a l'assistant.
   *
   * En positions de document et non en etendues DOM : dans un editeur, aucun
   * noeud n'est stable. Il suffit de quitter le bloc pour que le plugin
   * d'ancrage y fige la page qu'on lisait, donc que ProseMirror le repose — et
   * une etendue gardee telle quelle se replie aussitot sur le vide. Les
   * positions, elles, traversent les modifications : chaque transaction dit ou
   * elles ont glisse.
   *
   * Un registre muet, tenu dans une reference : il change a chaque frappe, et
   * en faire un etat rendrait tout le panneau pour deux entiers que personne
   * n'affiche.
   */
  const mentions = useRef(new Map<string, { from: number; to: number }>())

  useEffect(() => {
    if (!editor) return undefined

    const follow = ({ transaction }: { transaction: Transaction }): void => {
      if (!transaction.docChanged || mentions.current.size === 0) return

      for (const [id, span] of mentions.current) {
        // Les deux bornes se replient vers l'interieur du passage : un ajout
        // colle a son bord appartient au texte d'a cote, pas a ce qu'on a pris.
        const from = transaction.mapping.map(span.from, 1)
        const to = transaction.mapping.map(span.to, -1)
        // Le passage a ete efface : il n'y a plus rien a montrer. La citation
        // reste dans la barre de saisie, ou son texte a deja ete pris.
        if (to <= from) mentions.current.delete(id)
        else mentions.current.set(id, { from, to })
      }
    }

    editor.on('transaction', follow)
    return () => {
      editor.off('transaction', follow)
    }
  }, [editor])

  /**
   * L'etendue d'un passage mentionne, telle qu'elle est a cet instant.
   *
   * Une liste d'une etendue au plus : c'est ce que l'assistant attend de tous
   * ses passages, un passage du cours pouvant en demander plusieurs. Ici le
   * texte est continu dans un seul editeur, une etendue suffit.
   */
  const locateMention = useCallback(
    (id: string): Range[] => {
      const span = mentions.current.get(id)
      if (!editor || !span) return []

      try {
        const start = editor.view.domAtPos(span.from)
        const end = editor.view.domAtPos(span.to)
        const range = document.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        return [range]
      } catch {
        // `domAtPos` refuse une position que le document ne contient plus.
        return []
      }
    },
    [editor]
  )

  const mention = useCallback(() => {
    if (!cite || !editor) return

    const id = `m-${nextMentionId.current++}`
    const { from, to } = editor.state.selection
    mentions.current.set(id, { from, to })

    onMention({
      text: cite.text,
      source: mentionSource(),
      origin: 'notes',
      locate: () => locateMention(id)
    })

    // La selection a fait son office : elle laisse la place au surlignage du
    // passage retenu, que le bleu du systeme recouvrirait sinon.
    window.getSelection()?.removeAllRanges()
    setCite(null)
  }, [cite, editor, mentionSource, onMention, locateMention])

  return (
    <section className="panel panel--notes" hidden={hidden}>
      <header className="panel-head">
        <PanelLabel label="Notes" shortcut="⌘2" expanded={expanded} onToggle={onToggleExpand} />
        {course && (
          <div className="notes-status">
            <button
              className="icon-button"
              onClick={onToggleSync}
              data-active={syncOn}
              title={
                syncOn
                  ? 'Les deux panneaux se suivent — cliquer pour les détacher'
                  : 'Les deux panneaux défilent chacun de leur côté — cliquer pour les relier'
              }
            >
              Synchro
            </button>
            {counts.words > 0 && (
              <button
                className="icon-button notes-tidy"
                onClick={onTidy}
                title="Demander à l'assistant de structurer et corriger cette note — un aperçu s'affichera avant toute modification"
              >
                Mettre au propre
              </button>
            )}
            {counts.words > 0 && (
              <button
                className="icon-button notes-sort"
                onClick={sortNote}
                title="Ranger les blocs dans l'ordre du cours — page, puis passage — sans rien réécrire (⌘Z pour revenir)"
              >
                Trier par page
              </button>
            )}
            <span
              className="notes-count"
              title={`${counts.characters} signes, espaces comprises`}
            >
              {counts.words === 0
                ? ''
                : counts.words === 1
                  ? '1 mot'
                  : `${counts.words.toLocaleString('fr-FR')} mots`}
            </span>
            <SaveIndicator state={saveState} confirmed={confirmed} />
          </div>
        )}
      </header>

      <NotesToolbar editor={editor} />

      {course && proposal && (
        <ProposalCard
          state={proposal}
          onApply={() => void applyProposal()}
          onRefuse={refuseProposal}
          onUndo={undoProposal}
          onDismiss={() => setProposal(null)}
        />
      )}

      <div className="panel-body notes-body" ref={bodyRef}>
        {course ? (
          // Le cadre des commandes flottantes : elles se posent en absolu
          // dedans, et defilent donc avec le texte.
          <div className="notes-stage" ref={stageRef}>
            <EditorContent editor={editor} className="notes-sheet" />
            <NotesGutter editor={editor} onGoTo={onGoTo} />
            <BlockTools editor={editor} />
          </div>
        ) : (
          <div className="empty">
            <p className="empty-title">Pas de notes sans cours</p>
            <p className="empty-hint">Ouvre un document pour commencer à écrire.</p>
          </div>
        )}
      </div>

      {cite && (
        <button
          type="button"
          className="quote-pop"
          style={{ left: cite.anchor.x, top: Math.max(cite.anchor.y, MENTION_POP_MIN_TOP) }}
          // Sans cela, l'appui sur le bouton defait la selection avant meme que
          // le clic parte : on mentionnerait le vide.
          onMouseDown={(event) => event.preventDefault()}
          onClick={mention}
          title="Accrocher ce passage à la question posée à l’assistant"
        >
          <span className="quote-pop-glyph" aria-hidden="true">
            ❝
          </span>
          Mentionner
        </button>
      )}
    </section>
  )
}

/** Ce que la proposition ferait, dit dans les mots de l'utilisateur. */
/** Ce que l'assistant est en train d'ecrire, dans les mots de l'utilisateur. */
function draftLabel(kind: NoteDraft['kind']): string {
  switch (kind) {
    case 'inserer':
      return 'Ajout aux notes'
    case 'remplacer':
      return 'Retouche d’un passage'
    case 'reecrire':
      return 'Réécriture de la note'
  }
}

/** Les pages qu'une reponse cite, « (p. 12) » ou « (p. 12-14) », sans doublon. */
/**
 * La note rangee dans l'ordre du cours — page, puis rang du passage.
 *
 * Les cles viennent du main, seul a tenir l'index fin qui sait ou chaque
 * passage tombe dans sa page ; le decoupage et le tri sont partages
 * (`sortAnchoredNote`). Sans reponse — index pas charge, cours ferme entre
 * temps —, le texte revient tel quel : ne pas ranger n'abime rien.
 */
async function sortedNote(courseId: string, markdown: string): Promise<string> {
  const anchors = noteAnchors(markdown)
  if (anchors.length < 2) return markdown
  try {
    const keys = await window.noted.notes.orderKeys(
      courseId,
      anchors.map(
        (anchor) => anchor ?? { page: null, section: null, progress: null, passage: null }
      )
    )
    return sortAnchoredNote(markdown, keys)
  } catch {
    return markdown
  }
}

function revealBlock(container: HTMLElement | null, content: string): void {
  if (!container) return
  const lead = content
    .split('\n')
    .filter((line) => !line.startsWith('<!--'))
    .map((line) => line.replace(/^[#>*\-\d.\s|]+/, '').replace(/[*_`~=]+/g, '').trim())
    .find((line) => line.length >= 12)
  if (!lead) return
  const needle = lead.slice(0, 40)

  // Apres le rendu de l'editeur, pas avant.
  window.requestAnimationFrame(() => {
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('.notes-editor > *'))
    const hit = blocks.find((block) => (block.textContent ?? '').includes(needle))
    hit?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

function proposalLabel(proposal: NoteProposal): string {
  switch (proposal.kind) {
    case 'inserer': {
      if (proposal.target) return 'Ajout après un passage'
      if (proposal.trier) return 'Ajout à sa place dans le cours'
      return proposal.position === 'curseur' ? 'Ajout au curseur' : 'Ajout en fin de note'
    }
    case 'remplacer':
      // Un remplacement par rien est une suppression : c'est par la que
      // l'assistant retire un tableau ou un schema.
      return proposal.content.trim() ? "Remplacement d'un passage" : 'Suppression'
    case 'reecrire':
      // « note_trier » propose la note telle quelle, a ranger : le dire.
      return proposal.trier && proposal.content === proposal.base
        ? "Tri de la note dans l'ordre du cours"
        : 'Nouvelle version complète de la note'
  }
}

/**
 * L'apercu d'une proposition de l'assistant, et ses suites.
 *
 * Rien ne s'applique sans le clic « Appliquer » : c'est la garantie que
 * l'assistant n'ecrit jamais pendant qu'on tape, et que l'on peut refuser
 * d'un geste. Apres application, la carte reste un instant pour offrir
 * l'annulation — la note d'avant est gardee telle quelle.
 */
function ProposalCard({
  state,
  onApply,
  onRefuse,
  onUndo,
  onDismiss
}: {
  state: ProposalState
  onApply: () => void
  onRefuse: () => void
  onUndo: () => void
  onDismiss: () => void
}): React.JSX.Element {
  /**
   * Les schemas de l'apercu. Le HTML de la carte ne porte que leur syntaxe :
   * l'image est dessinee ici, une fois le moteur charge — et il n'y a rien a
   * rattraper en cas d'echec, une syntaxe fautive ayant deja ete refusee avant
   * d'arriver jusqu'ici.
   */
  const card = useRef<HTMLDivElement>(null)
  const pendingId = state.stage === 'pending' ? state.proposal.id : null

  useEffect(() => {
    const root = card.current
    if (!root) return undefined
    let cancelled = false

    for (const holder of Array.from(root.querySelectorAll<HTMLElement>('[data-type="diagram"]'))) {
      const source = holder.getAttribute('data-source') ?? ''

      // Une carte mentale se dessine par markmap, monte dans le conteneur.
      if (/^\s*mindmap\b/.test(source)) {
        void mountMindmap(holder, source).catch(() => undefined)
        continue
      }

      void renderDiagram(source).then(
        (svg) => {
          if (!cancelled) holder.innerHTML = svg
        },
        () => undefined
      )
    }

    return () => {
      cancelled = true
    }
  }, [pendingId])

  // Le brouillon grandit par le bas : c'est la qu'est la nouveaute, on la suit.
  const writingText = state.stage === 'writing' ? state.draft.text : null
  useEffect(() => {
    if (writingText === null) return
    const preview = card.current?.querySelector<HTMLElement>('.note-proposal-preview--writing')
    if (preview) preview.scrollTop = preview.scrollHeight
  }, [writingText])

  if (state.stage === 'writing') {
    const { draft, base } = state
    return (
      <div className="note-proposal" data-stage="writing" ref={card}>
        <div className="note-proposal-head">
          <span className="note-proposal-title">L&rsquo;assistant écrit…</span>
          <span className="note-proposal-kind">{draftLabel(draft.kind)}</span>
        </div>
        {draft.text.trim() && (
          <div className="note-proposal-section">
            <div
              className="note-proposal-preview note-proposal-preview--writing"
              dangerouslySetInnerHTML={{ __html: renderAiPreview(draft.text, base) }}
            />
          </div>
        )}
      </div>
    )
  }

  if (state.stage === 'applied') {
    return (
      <div className="note-proposal" data-stage="applied">
        <div className="note-proposal-head">
          <span className="note-proposal-title">
            {state.auto ? 'Modification appliquée automatiquement' : 'Modification appliquée'}
          </span>
          <span className="note-proposal-actions-inline">
            <button className="note-proposal-undo" onClick={onUndo}>
              Annuler
            </button>
            <button className="note-proposal-close" onClick={onDismiss} title="Fermer">
              ✕
            </button>
          </span>
        </div>
      </div>
    )
  }

  if (state.stage === 'stale') {
    return (
      <div className="note-proposal" data-stage="stale">
        <div className="note-proposal-head">
          <span className="note-proposal-title">
            La note a changé entre-temps — rien n&rsquo;a été modifié
          </span>
          <span className="note-proposal-actions-inline">
            <button className="note-proposal-close" onClick={onDismiss} title="Fermer">
              ✕
            </button>
          </span>
        </div>
      </div>
    )
  }

  const { proposal, base } = state
  return (
    <div className="note-proposal" data-stage="pending" ref={card}>
      <div className="note-proposal-head">
        <span className="note-proposal-title">Proposition de l&rsquo;assistant</span>
        <span className="note-proposal-kind">{proposalLabel(proposal)}</span>
      </div>

      {proposal.target && (
        <div className="note-proposal-section">
          <div className="note-proposal-section-title">
            {proposal.kind === 'remplacer' ? 'Remplacé' : 'Après'}
          </div>
          <div
            className="note-proposal-preview note-proposal-preview--old"
            dangerouslySetInnerHTML={{ __html: renderAiPreview(proposal.target, base) }}
          />
        </div>
      )}

      {/* Une suppression n'a pas de « par » : il n'y a rien apres. */}
      {proposal.content.trim() && (
        <div className="note-proposal-section">
          {proposal.kind === 'remplacer' && <div className="note-proposal-section-title">Par</div>}
          <div
            className="note-proposal-preview"
            dangerouslySetInnerHTML={{ __html: renderAiPreview(proposal.content, base) }}
          />
        </div>
      )}

      <div className="note-proposal-actions">
        <button className="note-proposal-refuse" onClick={onRefuse}>
          Refuser
        </button>
        <button className="note-proposal-apply" onClick={onApply}>
          Appliquer
        </button>
      </div>
    </div>
  )
}

/**
 * L'etat de l'enregistrement, visible en permanence.
 *
 * Il disparaissait auparavant au repos, ce qui laissait la question sans
 * reponse : apres une pause, rien ne disait si la note etait sur le disque.
 * Un enregistrement qu'on ne declenche pas soi-meme demande d'autant plus a
 * etre affirme.
 */
function SaveIndicator({
  state,
  confirmed
}: {
  state: SaveState
  confirmed: number
}): React.JSX.Element {
  const label =
    state === 'pending'
      ? 'Enregistrement…'
      : state === 'saved'
        ? 'Enregistré'
        : state === 'error'
          ? 'Échec de l’enregistrement'
          : 'À jour'

  return (
    <span className="save-indicator" data-state={state}>
      {/* Remonte a chaque ⌘S : c'est ce remplacement qui rejoue l'animation,
          la meme valeur de classe ne la relancerait pas. */}
      {confirmed > 0 && <span key={confirmed} className="save-pulse" aria-hidden="true" />}
      {label}
    </span>
  )
}
