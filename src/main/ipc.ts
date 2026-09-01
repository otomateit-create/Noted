/**
 * Enregistrement des canaux IPC.
 *
 * Chaque handler valide ce qu'il recoit avant de toucher au disque : le
 * renderer est du code que nous ecrivons, mais c'est aussi la surface la plus
 * exposee de l'application.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CHANNELS } from '../shared/channels'
import type {
  NoteAnchor,
  Annotation,
  ChatEffort,
  ChatSendInput,
  CoursePreview,
  ExtractedCourse,
  ImportResult,
  PhotoProposal,
  TutorSendInput
} from '../shared/types'
import { readAnnotations, writeAnnotations } from './annotations'
import { generationStatus, scheduleGeneration } from './flashcards/generation'
import {
  answer as answerCard,
  appendManualCards,
  bindFlashcardsNotifier,
  listCards,
  overview as flashcardsOverview,
  removeCard,
  reviewQueue,
  updateCard
} from './flashcards/store'
import { GENERAL_SET_BASENAME, isGeneralSetId } from '../shared/flashcards'
import * as claudeSession from './claude/session'
import { anchorBlocks } from './claude/tools'
import { warmEmbedder } from './rag/embedder'
import { supportedModels } from './claude/models'
import { claudeStatus } from './claude/provider'
import { tutorInterrupt, tutorReset, tutorSend } from './claude/tutor'
import {
  deleteCourse,
  deleteSubject,
  moveCourse,
  renameCourse,
  renameSubject
} from './courses'
import { convertDocxFile, readDocx } from './docx'
import { readExtraction, saveExtraction } from './extraction-cache'
import { readPreview, savePreview } from './preview-cache'
import { bindMemoryBridge, cancelMemoryTrace } from './memory/bridge'
import { removeEntry } from './memory/entries'
import { allMemoryEntries, invalidateMemoryIndex } from './memory/rag'
import { bindNotesBridge } from './notes-bridge'
import { bindQuizBridge } from './quiz-bridge'
import { isPromptId, listPromptSettings, setPromptSetting } from './prompts/catalog'
import { readNote, writeNote, writeNoteBackup } from './notes'
import { keepImage, mediaPath, readMedia } from './media'
import { cachedRead, keepRead } from './ocr/cache'
import { convertCourse, originalPath, patchCourse } from './ocr/convert'
import { DECORATIVE_BYTES, readFigures } from './ocr/figures'
import { isPhoto, PHOTO_EXTENSIONS, toPng } from './ocr/photos'
import {
  dismissConversion,
  importPhotos,
  proposePhotos,
  pendingConversions,
  watchPendingConversions
} from './ocr/photo-import'
import { yieldOcrToUser } from './ocr/engine'
import { readPage } from './ocr/page'
import { ensureOcrModel, imageFingerprint, ocrModelStatus, watchOcrModel } from './ocr/model'
import { anchorOrderKey, resolveAutoAnchor } from './rag/auto-anchor'
import { failPreparation, prepareCourse, vectorStatus, watchVectorStatus } from './rag/store'
import {
  createSubject,
  findCourse,
  importCourseFile,
  listSubjects,
  readCourseBytes,
  resolveCoursePath,
  vaultPaths
} from './vault'

/**
 * Ou macOS pose les trois feux de la fenetre, mesure depuis le coin haut
 * gauche jusqu'a celui du bouton de fermeture.
 *
 * Deux positions, parce que la barre de titre en a deux : plaquee contre le
 * bord dans l'espace de travail et sur les reglages, detachee en pilule de
 * verre sur la coque d'accueil. Les feux ne suivent pas tout seuls — c'est le
 * systeme qui les dessine, au-dessus de la page — et il faut donc leur
 * repeter le decalage.
 *
 * Au repos : la barre fait --titlebar-height (44px), le feu 12px, d'ou
 * (44 - 12) / 2 = 16 pour tomber sur son axe — celui-la meme ou .titlebar
 * { align-items: center } pose le nom et les chevrons. En pilule : la meme
 * chose decalee de --hub-gap (8px), l'ecart que la barre prend alors avec les
 * deux bords. Ces deux valeurs et --hub-gap se tiennent : modifier l'un sans
 * l'autre desaxe les feux, ce qui se voit tout de suite.
 *
 * C'est la seule definition — index.ts s'en sert a la creation de la fenetre
 * pour que le premier rendu soit deja au bon endroit.
 */
export const FEUX_REPOS = { x: 18, y: 16 } as const
export const FEUX_PILULE = { x: FEUX_REPOS.x + 8, y: FEUX_REPOS.y + 8 } as const

/** Niveaux de reflexion acceptes, pour filtrer ce qui vient du renderer. */
const EFFORTS: ChatEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Formats qui deviennent un cours par simple copie, sans etre lus. */
const IMPORTABLE = new Set(['.pdf', '.docx', '.pptx', '.md', '.markdown', '.html', '.htm'])

/**
 * Tout ce que le selecteur laisse choisir, sans l'extension du point.
 *
 * Une seule entree, et non deux menus deroulants : celui qui importe a des
 * fichiers, pas des categories. Une capture d'ecran grisee dans le selecteur
 * ne dit pas « ce n'est pas un cours », elle dit « cette application ne marche
 * pas » — et c'est exactement ce qui s'est produit.
 */
const CHOOSABLE = [...IMPORTABLE, ...PHOTO_EXTENSIONS].map((extension) => extension.slice(1))

/**
 * Ce qu'un lot de fichiers contient, une fois departage.
 *
 * Les images ne sont pas des cours et ne peuvent pas etre copiees comme telles :
 * il faut les lire, ce qui prend des minutes et demande d'abord de confirmer
 * leur ordre. Elles suivent donc l'autre chemin — celui de `photo-import` —
 * pendant que les documents entrent tout de suite. Le reste est ecarte en
 * silence : un glisser-deposer ramasse ce qui passe, un dossier, une archive,
 * et le vault n'a pas a en etre jonche.
 */
function sortSelection(paths: string[]): { documents: string[]; photos: string[] } {
  const documents: string[] = []
  const photos: string[] = []

  for (const file of paths) {
    if (typeof file !== 'string' || !file) continue
    if (isPhoto(file)) photos.push(file)
    else if (IMPORTABLE.has(path.extname(file).toLowerCase())) documents.push(file)
  }

  return { documents, photos }
}

/**
 * Recoit un lot de fichiers deja designes, d'ou qu'ils viennent — selecteur ou
 * glisser-deposer.
 *
 * Les documents sont copies ici meme et leurs identifiants rendus. Les images,
 * elles, ne sont que **proposees** : rien n'est ecrit, l'ordre revient a
 * l'ecran, et c'est l'utilisateur qui lance la lecture ou l'abandonne.
 */
async function receiveFiles(
  paths: string[],
  subject: string,
  folder: string | null
): Promise<ImportResult> {
  const { documents, photos } = sortSelection(paths)

  const imported: string[] = []
  for (const file of documents) {
    imported.push(await importCourseFile(file, subject, folder))
  }

  // Les photos ne suivent pas le dossier de classement : leur import passe par
  // une file d'attente qui se repere deja par un chemin `matiere/dossier`, ou
  // « dossier » designe l'archive des originaux. Un cours lu depuis des photos
  // arrive donc a la racine de la matiere, et se range ensuite comme un autre.
  return { imported, photos: photos.length > 0 ? await proposePhotos(photos, subject) : null }
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} invalide`)
  }
  return value
}

/** Un argument facultatif : absent, vide ou d'un autre type valent « rien ». */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // Les outils de l'assistant dialoguent avec la note affichee par ce pont.
  bindNotesBridge(getWindow)
  bindQuizBridge(getWindow)

  // Et les traces de ses ecritures en memoire arrivent a l'ecran par celui-ci.
  bindMemoryBridge(getWindow)

  // --- Vault -------------------------------------------------------------

  ipcMain.handle(CHANNELS.vaultPaths, () => vaultPaths())

  ipcMain.handle(CHANNELS.vaultListSubjects, () => listSubjects())

  ipcMain.handle(CHANNELS.vaultReveal, (_event, target: unknown) => {
    const requested = expectString(target, 'Chemin')
    const root = vaultPaths().root

    // On n'ouvre que ce qui est dans le vault : un chemin arbitraire ne doit
    // pas pouvoir declencher l'ouverture d'un fichier quelconque du disque.
    if (requested !== root && !requested.startsWith(`${root}/`)) {
      throw new Error('Chemin hors du vault')
    }
    shell.showItemInFolder(requested)
  })

  ipcMain.handle(CHANNELS.vaultImportCourses, async (_event, subject: unknown, folder: unknown) => {
    const target = expectString(subject, 'Matière')
    const into = optionalString(folder)
    const window = getWindow()
    if (!window) return { imported: [], photos: null }

    const result = await dialog.showOpenDialog(window, {
      title: `Ajouter des cours dans ${into ? `${target} › ${into}` : target}`,
      message:
        'PDF, Word, PowerPoint, Markdown, HTML — ou des photos et captures d’écran, qui deviendront un seul cours.',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Cours, photos et captures d’écran', extensions: CHOOSABLE }]
    })

    if (result.canceled) return { imported: [], photos: null }

    return receiveFiles(result.filePaths, target, into)
  })

  ipcMain.handle(
    CHANNELS.vaultImportPaths,
    async (_event, paths: unknown, subject: unknown, folder: unknown) => {
      const target = expectString(subject, 'Matière')
      if (!Array.isArray(paths)) throw new Error('Liste de fichiers invalide')

      return receiveFiles(paths, target, optionalString(folder))
    }
  )

  ipcMain.handle(CHANNELS.vaultCreateSubject, (_event, name: unknown) =>
    createSubject(expectString(name, 'Nom de matière'))
  )

  ipcMain.handle(CHANNELS.vaultRenameSubject, (_event, name: unknown, title: unknown) =>
    renameSubject(expectString(name, 'Nom de matière'), expectString(title, 'Nouveau nom'))
  )

  ipcMain.handle(CHANNELS.vaultDeleteSubject, (_event, name: unknown) =>
    deleteSubject(expectString(name, 'Nom de matière'))
  )

  // --- Documents ---------------------------------------------------------

  // Ces trois appels ont tous la meme cause : l'utilisateur vient d'ouvrir un
  // cours. La lecture d'images s'efface donc devant eux — voir `yieldOcrToUser`,
  // qui explique pourquoi ceder la place vaut mieux que baisser la priorite.
  ipcMain.handle(CHANNELS.courseReadBytes, (_event, courseId: unknown) => {
    yieldOcrToUser()
    return readCourseBytes(expectString(courseId, 'Identifiant de cours'))
  })

  ipcMain.handle(CHANNELS.courseReadMarkdown, (_event, courseId: unknown) => {
    yieldOcrToUser()
    return fs.readFile(resolveCoursePath(expectString(courseId, 'Identifiant de cours')), 'utf8')
  })

  ipcMain.handle(CHANNELS.courseReadDocx, (_event, courseId: unknown) => {
    yieldOcrToUser()
    return readDocx(expectString(courseId, 'Identifiant de cours'))
  })

  // Une lecture de figures par cours a la fois. Rouvrir un document pendant
  // que ses captures se lisent encore relancait un second passage complet, en
  // parallele du premier : les memes images, pas encore en cache, etaient
  // lues deux fois — vingt secondes chacune. Chainer les passages d'un meme
  // cours suffit : le second repart du cache et ne coute plus rien.
  const figuresRuns = new Map<string, Promise<void>>()

  ipcMain.handle(CHANNELS.coursePreviewRead, (_event, courseId: unknown) =>
    readPreview(expectString(courseId, 'Identifiant de cours'))
  )

  ipcMain.handle(CHANNELS.coursePreviewCache, (_event, courseId: unknown, preview: unknown) => {
    // Comme l'extraction : l'image part sur le disque sans que rien ne l'attende.
    void savePreview(expectString(courseId, 'Identifiant de cours'), preview as CoursePreview)
  })

  ipcMain.handle(CHANNELS.courseReadExtraction, (_event, courseId: unknown) =>
    readExtraction(expectString(courseId, 'Identifiant de cours'))
  )

  ipcMain.handle(CHANNELS.courseCacheExtraction, (_event, extracted: unknown) => {
    const payload = extracted as ExtractedCourse
    const courseId = expectString(payload?.courseId, 'Identifiant de cours')

    // Le texte part sur le disque tel qu'il arrive, avant la lecture des
    // figures : c'est ce que la prochaine ouverture voudra relire, et la lecture
    // des images, elle, a son propre cache. Rien n'attend cette ecriture — un
    // cache qui n'aboutit pas ne coute qu'une relecture.
    void saveExtraction(payload)

    // Le point rouge s'allume des maintenant, et non a la fin du decoupage :
    // la lecture des figures et le decoupage qui suivent durent une demi-minute
    // sur un gros cours, pendant laquelle rien ne disait que le document etait
    // en train d'etre traite.
    prepareCourse(courseId)

    // Les captures d'ecran sont lues **ici**, avant que le texte ne parte au
    // decoupage et a la vectorisation. C'est le seul moment ou cela a un sens :
    // apres, le texte tire d'une image n'aurait plus de passage ou entrer, donc
    // ni ancre ni vecteur. L'affichage, lui, n'attend rien de tout cela — il a
    // eu lieu bien avant, dans le renderer.
    const previous = figuresRuns.get(courseId) ?? Promise.resolve()
    const run = previous.then(async () => {
      claudeSession.cacheExtraction(await readFigures(payload))
    })

    const chained = run.catch((cause: unknown) => failPreparation(courseId, cause))
    figuresRuns.set(courseId, chained)
    void chained.then(() => {
      if (figuresRuns.get(courseId) === chained) figuresRuns.delete(courseId)
    })
    return run
  })

  // --- Gestion des cours -------------------------------------------------

  ipcMain.handle(CHANNELS.courseRename, (_event, courseId: unknown, title: unknown) =>
    renameCourse(expectString(courseId, 'Identifiant de cours'), expectString(title, 'Nouveau nom'))
  )

  ipcMain.handle(
    CHANNELS.courseMove,
    (_event, courseId: unknown, subject: unknown, folder: unknown) =>
      moveCourse(
        expectString(courseId, 'Identifiant de cours'),
        expectString(subject, 'Matière'),
        optionalString(folder)
      )
  )

  ipcMain.handle(CHANNELS.courseDelete, (_event, courseId: unknown) =>
    deleteCourse(expectString(courseId, 'Identifiant de cours'))
  )

  // --- Notes -------------------------------------------------------------

  ipcMain.handle(CHANNELS.notesRead, async (_event, courseId: unknown) => {
    const course = await findCourse(expectString(courseId, 'Identifiant de cours'))
    return readNote(course)
  })

  ipcMain.handle(
    CHANNELS.notesWrite,
    async (_event, courseId: unknown, markdown: unknown) => {
      const course = await findCourse(expectString(courseId, 'Identifiant de cours'))
      if (typeof markdown !== 'string') throw new Error('Contenu de note invalide')

      // Le cours vient de gagner ou de perdre sa note : la page de matiere
      // affiche une pastille qui en depend, et Notes/ n'est pas surveille.
      // On ne previent qu'a la bascule — a chaque sauvegarde, ce serait
      // relire tout le vault a chaque pause de frappe.
      if (await writeNote(course, markdown)) {
        const window = getWindow()
        if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.vaultChanged)
      }
    }
  )

  ipcMain.handle(
    CHANNELS.notesBackup,
    async (_event, courseId: unknown, markdown: unknown) => {
      const id = expectString(courseId, 'Identifiant de cours')
      if (typeof markdown !== 'string') throw new Error('Contenu de note invalide')
      await writeNoteBackup(id, markdown)
    }
  )

  ipcMain.handle(CHANNELS.notesAnchorBlocks, (_event, courseId: unknown, content: unknown) => {
    const id = expectString(courseId, 'Identifiant de cours')
    const text = expectString(content, 'Texte à insérer')
    return anchorBlocks(id, text)
  })

  ipcMain.handle(CHANNELS.notesOrderKeys, (_event, courseId: unknown, anchors: unknown) => {
    const id = expectString(courseId, 'Identifiant de cours')
    if (!Array.isArray(anchors)) throw new Error('Ancres invalides')
    // Une entree illisible rend null a sa place : le panneau range par
    // position, et sauter une entree decalerait toutes les suivantes.
    return anchors.map((anchor) =>
      anchor && typeof anchor === 'object' ? anchorOrderKey(id, anchor as NoteAnchor) : null
    )
  })

  ipcMain.handle(
    CHANNELS.notesAnchorPassage,
    (_event, courseId: unknown, text: unknown, unitKeys: unknown) => {
      const id = expectString(courseId, 'Identifiant de cours')

      // Le texte n'est pas passe a `expectString` : celui-ci refuse la chaine
      // vide, or un bloc vide en est une parfaitement legitime — c'est l'etat
      // de tout paragraphe qu'on vient d'ouvrir. Le refuser ici ferait remonter
      // une exception dans l'editeur au moment ou l'on appuie sur Entree.
      // `resolveAutoAnchor` s'en charge et rend null, ce qui est la reponse
      // juste.
      if (typeof text !== 'string') throw new Error('Texte de note invalide')

      // Meme partage que pour `cleanPages` : l'absence de tableau est une faute
      // de l'appelant, qu'on refuse tout de suite, tandis qu'une entree mal
      // formee ne coute qu'un candidat de moins. Un tableau vide est legitime —
      // fenetre pas encore mesuree, tour d'IA sans citation — et `FineIndex`
      // balaie alors l'index entier plutot que de rendre les mains vides.
      if (!Array.isArray(unitKeys)) throw new Error('Unités de cours invalides')
      const units = unitKeys.filter((key): key is string => typeof key === 'string')

      return resolveAutoAnchor(id, text, units)
    }
  )

  // --- Surlignages -------------------------------------------------------

  ipcMain.handle(CHANNELS.annotationsRead, (_event, courseId: unknown) =>
    readAnnotations(expectString(courseId, 'Identifiant de cours'))
  )

  ipcMain.handle(
    CHANNELS.annotationsWrite,
    async (_event, courseId: unknown, list: unknown) => {
      const id = expectString(courseId, 'Identifiant de cours')
      if (!Array.isArray(list)) throw new Error('Liste de surlignages invalide')
      await writeAnnotations(id, list as Annotation[])

      // De nouveaux surlignages jaunes, verts ou bleus deviendront des
      // flashcards — en tache de fond, apres un delai qui laisse finir de
      // surligner. Le declencheur relit le fichier : rien a transporter.
      scheduleGeneration(id)
    }
  )

  // --- Flashcards ---------------------------------------------------------

  ipcMain.handle(CHANNELS.flashcardsOverview, async () =>
    flashcardsOverview(await generationStatus())
  )

  ipcMain.handle(
    CHANNELS.flashcardsQueue,
    (_event, courseIds: unknown, options: unknown) => {
      if (!Array.isArray(courseIds)) throw new Error('Liste de cours invalide')
      const ids = courseIds.map((id) => expectString(id, 'Identifiant de cours'))
      const raw = (options ?? {}) as Record<string, unknown>
      return reviewQueue(ids, {
        shuffle: raw.shuffle === true,
        ahead: raw.ahead === true,
        scope: raw.scope === 'all' || raw.scope === 'difficult' ? raw.scope : 'due'
      })
    }
  )

  ipcMain.handle(CHANNELS.flashcardsCards, (_event, setId: unknown) =>
    listCards(expectString(setId, 'Identifiant de set'))
  )

  ipcMain.handle(CHANNELS.flashcardsRemoveCard, (_event, setId: unknown, cardId: unknown) =>
    removeCard(
      expectString(setId, 'Identifiant de set'),
      expectString(cardId, 'Identifiant de carte')
    )
  )

  ipcMain.handle(
    CHANNELS.flashcardsUpdateCard,
    (_event, setId: unknown, cardId: unknown, faces: unknown) => {
      const raw = (faces ?? {}) as Record<string, unknown>
      return updateCard(
        expectString(setId, 'Identifiant de set'),
        expectString(cardId, 'Identifiant de carte'),
        { recto: expectString(raw.recto, 'Recto'), verso: expectString(raw.verso, 'Verso') }
      )
    }
  )

  // Le tuteur d'une carte en revision : sa propre conversation, son propre
  // canal de flux — rien de commun avec la session du cours ouvert.
  ipcMain.handle(CHANNELS.flashcardsTutorSend, (_event, input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>
    const card = (raw.card ?? {}) as Record<string, unknown>
    const clean: TutorSendInput = {
      messageId: expectString(raw.messageId, 'Identifiant de message'),
      prompt: expectString(raw.prompt, 'Message'),
      card: {
        setId: expectString(card.setId, 'Identifiant de set'),
        recto: expectString(card.recto, 'Recto de carte'),
        verso: expectString(card.verso, 'Verso de carte')
      }
    }
    return tutorSend(clean, (event) => {
      const window = getWindow()
      if (window && !window.isDestroyed()) {
        window.webContents.send(CHANNELS.flashcardsTutorStream, event)
      }
    })
  })

  ipcMain.handle(CHANNELS.flashcardsTutorStop, () => tutorInterrupt())

  ipcMain.handle(CHANNELS.flashcardsTutorReset, () => tutorReset())

  ipcMain.handle(
    CHANNELS.flashcardsAnswer,
    (_event, courseId: unknown, cardId: unknown, grade: unknown) => {
      const id = expectString(courseId, 'Identifiant de cours')
      const card = expectString(cardId, 'Identifiant de carte')
      if (
        grade !== 'encore' &&
        grade !== 'difficile' &&
        grade !== 'bien' &&
        grade !== 'facile'
      ) {
        throw new Error('Réponse de révision invalide')
      }
      return answerCard(id, card, grade)
    }
  )

  // La feuille de collage : des cartes ecrites a la main, deja decoupees par
  // le renderer (parseSheet), vers le set d'un cours ou le set general d'une
  // matiere. Toutes portent la pastille « A retenir » — le standard Q:/R:
  // n'a pas de typage, par choix.
  ipcMain.handle(
    CHANNELS.flashcardsImport,
    async (_event, setId: unknown, cards: unknown) => {
      const id = expectString(setId, 'Identifiant de set')
      if (!Array.isArray(cards) || cards.length === 0) {
        throw new Error('Aucune carte à ajouter')
      }
      const clean = cards.map((card) => {
        const raw = (card ?? {}) as Record<string, unknown>
        const recto = expectString(raw.recto, 'Recto de carte').trim()
        const verso = expectString(raw.verso, 'Verso de carte').trim()
        if (!recto || !verso) throw new Error('Carte incomplète')
        return { recto, verso, colour: 'retenir' as const, page: null, heading: null }
      })

      // La cible doit encore exister — matiere ou cours — sinon on
      // fabriquerait un fichier orphelin dans le vault.
      if (isGeneralSetId(id)) {
        const subject = id.slice(0, -(GENERAL_SET_BASENAME.length + 1))
        const subjects = await listSubjects()
        if (!subjects.some((entry) => entry.name === subject)) {
          throw new Error(`Matière introuvable : ${subject}`)
        }
      } else {
        await findCourse(id)
      }

      return appendManualCards(id, clean)
    }
  )

  // La page Flashcards se rafraichit quand les sets bougent — generation en
  // fond ou cartes creees par l'assistant — sans interroger en boucle.
  bindFlashcardsNotifier(() => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(CHANNELS.flashcardsChanged)
    }
  })

  // --- Memoire de l'IA ---------------------------------------------------

  ipcMain.handle(CHANNELS.memoireList, () => allMemoryEntries())

  ipcMain.handle(CHANNELS.memoireForget, async (_event, entryId: unknown) => {
    await removeEntry(expectString(entryId, 'Identifiant d’entrée'))
    invalidateMemoryIndex()
  })

  ipcMain.handle(CHANNELS.memoireCancel, (_event, traceId: unknown) =>
    cancelMemoryTrace(expectString(traceId, 'Identifiant de trace'))
  )

  // --- Fenetre ------------------------------------------------------------

  // Sur l'accueil, la barre se detache du bord en pilule de verre : les feux
  // suivent son decalage (--hub-gap, 8px) pour rester centres dedans.
  ipcMain.on(CHANNELS.fenetreFeux, (_event, flottants: unknown) => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    window.setWindowButtonPosition(flottants === true ? FEUX_PILULE : FEUX_REPOS)
  })

  // --- Recherche par le sens ---------------------------------------------

  ipcMain.handle(CHANNELS.ragStatus, (_event, courseId: unknown) =>
    vectorStatus(expectString(courseId, 'Identifiant de cours'))
  )

  // Le panneau du cours demande l'etat a l'ouverture, puis se contente de ces
  // annonces : la vectorisation dure des minutes, l'interroger en boucle pour
  // n'apprendre presque jamais rien serait du gachis.
  watchVectorStatus((status) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(CHANNELS.ragChanged, status)
    }
  })

  // --- Lecture par OCR ---------------------------------------------------

  ipcMain.handle(CHANNELS.ocrModelStatus, () => ocrModelStatus())

  ipcMain.handle(CHANNELS.ocrInstall, () => ensureOcrModel())

  ipcMain.handle(CHANNELS.ocrReadImage, async (_event, png: unknown) => {
    if (!(png instanceof Uint8Array)) throw new Error('Image invalide')

    // Le cache est interroge ici plutot que dans le moteur : c'est le seul
    // endroit qui voit passer toutes les images, d'ou qu'elles viennent — une
    // capture d'ecran d'un Word comme une page de PDF dessinee par le renderer.
    const fingerprint = imageFingerprint(png)
    const known = await cachedRead(fingerprint)
    if (known) return known

    // `keepFigures` : une page de PDF scanne ne laisse aucune autre trace de
    // ses schemas — ils n'existent que dans l'image de la page.
    const read = await readPage(Buffer.from(png), { keepFigures: true })
    if (read) await keepRead(fingerprint, read)
    return read
  })

  const cleanPages = (pages: unknown): { page: number; markdown: string }[] => {
    if (!Array.isArray(pages)) throw new Error('Pages invalides')

    return pages.flatMap((page) => {
      if (!page || typeof page !== 'object') return []
      const { page: number, markdown } = page as Record<string, unknown>
      if (typeof number !== 'number' || typeof markdown !== 'string') return []

      return [{ page: number, markdown }]
    })
  }

  ipcMain.handle(
    CHANNELS.ocrConvert,
    async (_event, courseId: unknown, pages: unknown, report: unknown) => {
      const id = expectString(courseId, 'Identifiant de cours')

      // Le rapport de pages manquantes est repris tel quel s'il a la forme
      // promise, ignore sinon : une conversion sans rapport reste une
      // conversion complete.
      let cleanedReport: { missing: number[]; pageCount: number } | undefined
      if (report && typeof report === 'object') {
        const { missing, pageCount } = report as Record<string, unknown>
        if (
          Array.isArray(missing) &&
          missing.every((page) => typeof page === 'number' && Number.isInteger(page) && page > 0) &&
          typeof pageCount === 'number' &&
          Number.isInteger(pageCount)
        ) {
          cleanedReport = { missing, pageCount }
        }
      }

      return convertCourse(id, cleanPages(pages), cleanedReport)
    }
  )

  ipcMain.handle(CHANNELS.ocrPatch, (_event, courseId: unknown, pages: unknown) =>
    patchCourse(expectString(courseId, 'Identifiant de cours'), cleanPages(pages))
  )

  ipcMain.handle(CHANNELS.ocrMediaPng, async (_event, name: unknown) => {
    const file = mediaPath(expectString(name, 'Nom d’image'))
    if (!file) return null

    // Le meme ecart que pour les figures : une image trop petite pour porter
    // du texte est une decoration, et la donner a lire couterait vingt
    // secondes pour rendre une ligne vide.
    const bytes = await readMedia(expectString(name, 'Nom d’image'))
    if (!bytes || bytes.length < DECORATIVE_BYTES) return null

    const png = await toPng(file)
    return png ? new Uint8Array(png) : null
  })

  ipcMain.handle(CHANNELS.mediaKeep, (_event, bytes: unknown, contentType: unknown) => {
    if (!(bytes instanceof Uint8Array)) throw new Error('Image invalide')
    return keepImage(Buffer.from(bytes), expectString(contentType, 'Type d’image'))
  })

  ipcMain.handle(CHANNELS.ocrReadOriginal, async (_event, relative: unknown) => {
    const buffer = await fs.readFile(originalPath(expectString(relative, 'Chemin de l’original')))
    return new Uint8Array(buffer)
  })

  ipcMain.handle(CHANNELS.ocrReadOriginalDocx, (_event, relative: unknown) =>
    convertDocxFile(originalPath(expectString(relative, 'Chemin de l’original')))
  )

  ipcMain.handle(CHANNELS.ocrListOriginal, async (_event, relative: unknown) => {
    const target = originalPath(expectString(relative, 'Chemin de l’original'))

    try {
      const entries = await fs.readdir(target, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort()
    } catch {
      // Un fichier unique, et non un dossier : c'est le cas d'un PDF scanne.
      return []
    }
  })

  ipcMain.handle(CHANNELS.ocrImportPhotos, (_event, proposal: unknown) => {
    // Sans attendre : la lecture dure des minutes, et la fenetre doit rendre la
    // main tout de suite. C'est la ligne d'attente qui rend compte de la suite.
    void importPhotos(proposal as PhotoProposal)
  })

  ipcMain.handle(CHANNELS.ocrPending, () => pendingConversions())

  ipcMain.handle(CHANNELS.ocrDismiss, (_event, id: unknown) =>
    dismissConversion(expectString(id, 'Identifiant'))
  )

  watchPendingConversions(() => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(CHANNELS.ocrPendingChanged)
    }
  })

  watchOcrModel((status) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(CHANNELS.ocrModelChanged, status)
    }
  })

  // --- Claude ------------------------------------------------------------

  ipcMain.handle(CHANNELS.claudeStatus, () => claudeStatus())

  ipcMain.handle(CHANNELS.claudeModels, () => supportedModels())

  ipcMain.handle(CHANNELS.claudeWarm, () => warmEmbedder())

  ipcMain.handle(CHANNELS.claudeSend, async (_event, input: unknown) => {
    const payload = input as ChatSendInput
    const courseId = expectString(payload?.courseId, 'Identifiant de cours')
    const messageId = expectString(payload?.messageId, 'Identifiant de message')
    expectString(payload?.prompt, 'Message')

    // Le modele et le niveau de reflexion partent vers le SDK : on ne laisse
    // passer que ce qu'on reconnait, plutot qu'une chaine arbitraire.
    const model = typeof payload?.model === 'string' ? payload.model : undefined
    const effort = EFFORTS.includes(payload?.effort as ChatEffort)
      ? (payload.effort as ChatEffort)
      : undefined

    const course = await findCourse(courseId)

    await claudeSession.send({ courseId, messageId, prompt: payload.prompt, model, effort }, course, (event) => {
      // La fenetre peut avoir ete fermee pendant que la reponse arrivait.
      const window = getWindow()
      if (window && !window.isDestroyed()) {
        window.webContents.send(CHANNELS.claudeStream, event)
      }
    })
  })

  ipcMain.handle(CHANNELS.claudeInterrupt, (_event, courseId: unknown) => {
    claudeSession.interrupt(expectString(courseId, 'Identifiant de cours'))
  })

  ipcMain.handle(CHANNELS.claudeReset, (_event, courseId: unknown) => {
    claudeSession.reset(expectString(courseId, 'Identifiant de cours'))
  })

  ipcMain.handle(CHANNELS.claudeHistory, (_event, courseId: unknown) => {
    return claudeSession.historyFor(expectString(courseId, 'Identifiant de cours'))
  })

  ipcMain.handle(CHANNELS.claudeOpenSession, (_event, courseId: unknown, sessionId: unknown) => {
    return claudeSession.openSession(
      expectString(courseId, 'Identifiant de cours'),
      expectString(sessionId, 'Identifiant de session')
    )
  })

  ipcMain.handle(CHANNELS.claudeHydrate, (_event, courseId: unknown) => {
    return claudeSession.hydrate(expectString(courseId, 'Identifiant de cours'))
  })

  ipcMain.handle(CHANNELS.claudeCompact, async (_event, courseId: unknown) => {
    const id = expectString(courseId, 'Identifiant de cours')
    const course = await findCourse(id)
    return claudeSession.compactSession(id, course)
  })

  // --- Parametres ---------------------------------------------------------

  ipcMain.handle(CHANNELS.reglagesPrompts, () => listPromptSettings())

  ipcMain.handle(CHANNELS.reglagesSetPrompt, (_event, id: unknown, texte: unknown) => {
    if (!isPromptId(id)) throw new Error('Agent inconnu')

    // `null` rend le prompt a son defaut ; tout le reste doit etre du texte.
    if (texte !== null && typeof texte !== 'string') throw new Error('Prompt invalide')

    return setPromptSetting(id, texte)
  })
}
