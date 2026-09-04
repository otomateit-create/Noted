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
import { readDocx } from './docx'
import { readExtraction, saveExtraction } from './extraction-cache'
import { numberFigures } from './figures/markers'
import { readPreview, savePreview } from './preview-cache'
import { bindMemoryBridge, cancelMemoryTrace } from './memory/bridge'
import { removeEntry } from './memory/entries'
import { allMemoryEntries, invalidateMemoryIndex } from './memory/rag'
import { bindNotesBridge } from './notes-bridge'
import { bindQuizBridge } from './quiz-bridge'
import { isPromptId, listPromptSettings, setPromptSetting } from './prompts/catalog'
import { readNote, writeNote, writeNoteBackup } from './notes'
import { keepImage } from './media'
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

/** Tout ce que le selecteur laisse choisir, sans l'extension du point. */
const CHOOSABLE = [...IMPORTABLE].map((extension) => extension.slice(1))

/**
 * Recoit un lot de fichiers deja designes, d'ou qu'ils viennent — selecteur ou
 * glisser-deposer.
 *
 * Ce qui n'est pas un format de cours est ecarte en silence : un
 * glisser-deposer ramasse ce qui passe, un dossier, une archive, et le vault
 * n'a pas a en etre jonche.
 */
async function receiveFiles(
  paths: string[],
  subject: string,
  folder: string | null
): Promise<ImportResult> {
  const imported: string[] = []

  for (const file of paths) {
    if (typeof file !== 'string' || !file) continue
    if (!IMPORTABLE.has(path.extname(file).toLowerCase())) continue
    imported.push(await importCourseFile(file, subject, folder))
  }

  return { imported }
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
    if (!window) return { imported: [] }

    const result = await dialog.showOpenDialog(window, {
      title: `Ajouter des cours dans ${into ? `${target} › ${into}` : target}`,
      message: 'PDF, Word, PowerPoint, Markdown, HTML.',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Cours', extensions: CHOOSABLE }]
    })

    if (result.canceled) return { imported: [] }

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

  ipcMain.handle(CHANNELS.courseReadBytes, (_event, courseId: unknown) =>
    readCourseBytes(expectString(courseId, 'Identifiant de cours'))
  )

  ipcMain.handle(CHANNELS.courseReadMarkdown, (_event, courseId: unknown) =>
    fs.readFile(resolveCoursePath(expectString(courseId, 'Identifiant de cours')), 'utf8')
  )

  ipcMain.handle(CHANNELS.courseReadDocx, (_event, courseId: unknown) =>
    readDocx(expectString(courseId, 'Identifiant de cours'))
  )

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

  /**
   * Le texte que le renderer vient d'extraire d'un cours : garde sur le disque,
   * puis decoupe et vectorise tel quel, marqueurs `[figure]` compris.
   *
   * Rien ne s'interpose plus entre l'extraction et l'index : ce que les images
   * disent sera decrit apres la vectorisation, et n'a donc pas a etre attendu
   * ici. L'affichage, lui, n'attend rien de tout cela — il a eu lieu bien
   * avant, dans le renderer.
   */
  ipcMain.handle(CHANNELS.courseCacheExtraction, (_event, extracted: unknown) => {
    const raw = extracted as ExtractedCourse
    const courseId = expectString(raw?.courseId, 'Identifiant de cours')

    // Chaque marqueur recoit son rang ici, et une bonne fois : c'est la seule
    // etape qui voie le document entier. Plus loin, « lire » ne rend qu'une page
    // ou une section, et un compteur repris a zero sur ce morceau poserait la
    // description de la premiere image du cours sur la premiere figure de la
    // page. Le rang inscrit dans le marqueur survit a tous les decoupages.
    const payload = numberFigures(raw)

    // Rien n'attend cette ecriture — un cache qui n'aboutit pas ne coute qu'une
    // relecture.
    void saveExtraction(payload)

    // Le point rouge s'allume des maintenant, et non a la fin du decoupage :
    // celui-ci dure une demi-minute sur un gros cours, pendant laquelle rien ne
    // disait que le document etait en train d'etre traite.
    prepareCourse(courseId)

    try {
      claudeSession.cacheExtraction(payload)
    } catch (cause: unknown) {
      failPreparation(courseId, cause)
    }
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

  // --- Images ------------------------------------------------------------

  ipcMain.handle(CHANNELS.mediaKeep, (_event, bytes: unknown, contentType: unknown) => {
    if (!(bytes instanceof Uint8Array)) throw new Error('Image invalide')
    return keepImage(Buffer.from(bytes), expectString(contentType, 'Type d’image'))
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

  ipcMain.handle(CHANNELS.claudeDeleteSession, (_event, courseId: unknown, sessionId: unknown) => {
    return claudeSession.deleteSession(
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
