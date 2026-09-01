/**
 * Pont entre le renderer et le main process.
 *
 * Le renderer n'a jamais acces a Node ni au systeme de fichiers : il ne voit
 * que les fonctions listees ici, et chacune passe par le main qui valide ses
 * entrees. C'est ce qui permet de garder contextIsolation actif.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CHANNELS } from '../shared/channels'
import type {
  Flashcard,
  FlashcardsOverview,
  ReviewGrade,
  ReviewQueueItem,
  ReviewQueueOptions
} from '../shared/flashcards'
import type {
  Annotation,
  ChatHistoryEntry,
  ChatMessage,
  ChatSendInput,
  ChatStreamEvent,
  CompactOutcome,
  CourseMove,
  DocxDocument,
  CoursePreview,
  ExtractedCourse,
  ImportResult,
  MemoryEntry,
  MemoryTrace,
  Note,
  NoteAnchor,
  OrderKey,
  NoteDraft,
  NoteDraftEnd,
  NoteLiveRequest,
  NoteProposal,
  NoteProposalStatus,
  NotedApi,
  OcrDocument,
  OcrModelStatus,
  OcrRead,
  PendingConversion,
  PhotoProposal,
  PromptId,
  PromptSetting,
  QuizForm,
  QuizOutcome,
  Subject,
  TutorSendInput,
  VaultPaths,
  VectorStatus
} from '../shared/types'

const api: NotedApi = {
  vault: {
    paths: (): Promise<VaultPaths> => ipcRenderer.invoke(CHANNELS.vaultPaths),
    listSubjects: (): Promise<Subject[]> => ipcRenderer.invoke(CHANNELS.vaultListSubjects),
    reveal: (target: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.vaultReveal, target),
    importCourses: (subject: string, folder?: string | null): Promise<ImportResult> =>
      ipcRenderer.invoke(CHANNELS.vaultImportCourses, subject, folder ?? null),
    importPaths: (paths: string[], subject: string, folder?: string | null): Promise<ImportResult> =>
      ipcRenderer.invoke(CHANNELS.vaultImportPaths, paths, subject, folder ?? null),
    createSubject: (name: string): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.vaultCreateSubject, name),
    renameSubject: (name: string, title: string): Promise<{ name: string; moved: CourseMove[] }> =>
      ipcRenderer.invoke(CHANNELS.vaultRenameSubject, name, title),
    deleteSubject: (name: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.vaultDeleteSubject, name),

    /**
     * Abonne le renderer aux changements du dossier Cours/. Renvoie la
     * fonction de desabonnement — a appeler au demontage, sinon les listeners
     * s'accumulent.
     */
    onChanged: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on(CHANNELS.vaultChanged, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.vaultChanged, listener)
      }
    }
  },

  /**
   * Seule fonction du pont a ne pas passer par le main : traduire un objet File
   * en chemin est justement ce qu'Electron reserve au preload, le renderer
   * n'ayant aucun acces au systeme de fichiers.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  course: {
    rename: (courseId: string, title: string): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.courseRename, courseId, title),
    move: (courseId: string, subject: string, folder?: string | null): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.courseMove, courseId, subject, folder ?? null),
    remove: (courseId: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.courseDelete, courseId),
    readBytes: (courseId: string): Promise<Uint8Array> =>
      ipcRenderer.invoke(CHANNELS.courseReadBytes, courseId),
    readMarkdown: (courseId: string): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.courseReadMarkdown, courseId),
    readDocx: (courseId: string): Promise<DocxDocument> =>
      ipcRenderer.invoke(CHANNELS.courseReadDocx, courseId),
    readExtraction: (courseId: string): Promise<ExtractedCourse | null> =>
      ipcRenderer.invoke(CHANNELS.courseReadExtraction, courseId),
    cacheExtraction: (extracted: ExtractedCourse): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.courseCacheExtraction, extracted),
    readPreview: (courseId: string): Promise<CoursePreview | null> =>
      ipcRenderer.invoke(CHANNELS.coursePreviewRead, courseId),
    cachePreview: (courseId: string, preview: CoursePreview): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.coursePreviewCache, courseId, preview)
  },

  notes: {
    read: (courseId: string): Promise<Note> => ipcRenderer.invoke(CHANNELS.notesRead, courseId),
    write: (courseId: string, markdown: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.notesWrite, courseId, markdown),
    backup: (courseId: string, markdown: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.notesBackup, courseId, markdown),
    anchorPassage: (
      courseId: string,
      text: string,
      unitKeys: string[]
    ): Promise<NoteAnchor | null> =>
      ipcRenderer.invoke(CHANNELS.notesAnchorPassage, courseId, text, unitKeys),

    /**
     * Dialogue avec les outils de l'assistant : il demande la note affichee,
     * ou propose une modification que l'utilisateur accepte ou refuse. Les
     * reponses partent en `send` — le main les attend, il n'y a rien a
     * recevoir en retour.
     */
    onLiveRequest: (handler: (request: NoteLiveRequest) => void): (() => void) => {
      const listener = (_event: unknown, payload: NoteLiveRequest): void => handler(payload)
      ipcRenderer.on(CHANNELS.notesLiveRequest, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.notesLiveRequest, listener)
      }
    },
    replyLive: (requestId: string, markdown: string | null): void => {
      ipcRenderer.send(CHANNELS.notesLiveReply, requestId, markdown)
    },
    onProposal: (handler: (proposal: NoteProposal) => void): (() => void) => {
      const listener = (_event: unknown, payload: NoteProposal): void => handler(payload)
      ipcRenderer.on(CHANNELS.notesProposal, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.notesProposal, listener)
      }
    },
    respondProposal: (
      proposalId: string,
      status: NoteProposalStatus,
      detail?: string
    ): void => {
      ipcRenderer.send(CHANNELS.notesProposalReply, proposalId, status, detail)
    },
    onProposalCancel: (handler: (proposalId: string) => void): (() => void) => {
      const listener = (_event: unknown, proposalId: string): void => handler(proposalId)
      ipcRenderer.on(CHANNELS.notesProposalCancel, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.notesProposalCancel, listener)
      }
    },
    onDraft: (handler: (draft: NoteDraft) => void): (() => void) => {
      const listener = (_event: unknown, payload: NoteDraft): void => handler(payload)
      ipcRenderer.on(CHANNELS.notesDraft, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.notesDraft, listener)
      }
    },
    onDraftEnd: (handler: (end: NoteDraftEnd) => void): (() => void) => {
      const listener = (_event: unknown, payload: NoteDraftEnd): void => handler(payload)
      ipcRenderer.on(CHANNELS.notesDraftEnd, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.notesDraftEnd, listener)
      }
    },
    anchorBlocks: (courseId: string, content: string): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.notesAnchorBlocks, courseId, content),
    orderKeys: (courseId: string, anchors: NoteAnchor[]): Promise<(OrderKey | null)[]> =>
      ipcRenderer.invoke(CHANNELS.notesOrderKeys, courseId, anchors)
  },

  /**
   * Le questionnaire que l'assistant soumet, et la copie qu'on lui rend. La
   * reponse part en `send` : le main l'attend, il n'y a rien a recevoir en
   * retour.
   */
  quiz: {
    onAsk: (handler: (form: QuizForm) => void): (() => void) => {
      const listener = (_event: unknown, payload: QuizForm): void => handler(payload)
      ipcRenderer.on(CHANNELS.quizAsk, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.quizAsk, listener)
      }
    },
    reply: (quizId: string, outcome: QuizOutcome): void => {
      ipcRenderer.send(CHANNELS.quizReply, quizId, outcome)
    },
    onCancel: (handler: (quizId: string) => void): (() => void) => {
      const listener = (_event: unknown, quizId: string): void => handler(quizId)
      ipcRenderer.on(CHANNELS.quizCancel, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.quizCancel, listener)
      }
    }
  },

  annotations: {
    read: (courseId: string): Promise<Annotation[]> =>
      ipcRenderer.invoke(CHANNELS.annotationsRead, courseId),
    write: (courseId: string, annotations: Annotation[]): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.annotationsWrite, courseId, annotations)
  },

  flashcards: {
    overview: (): Promise<FlashcardsOverview> =>
      ipcRenderer.invoke(CHANNELS.flashcardsOverview),
    queue: (courseIds: string[], options?: ReviewQueueOptions): Promise<ReviewQueueItem[]> =>
      ipcRenderer.invoke(CHANNELS.flashcardsQueue, courseIds, options),
    answer: (courseId: string, cardId: string, grade: ReviewGrade): Promise<Flashcard | null> =>
      ipcRenderer.invoke(CHANNELS.flashcardsAnswer, courseId, cardId, grade),
    import: (
      setId: string,
      cards: { recto: string; verso: string }[]
    ): Promise<{ added: number; total: number }> =>
      ipcRenderer.invoke(CHANNELS.flashcardsImport, setId, cards),
    cards: (setId: string): Promise<Flashcard[]> =>
      ipcRenderer.invoke(CHANNELS.flashcardsCards, setId),
    removeCard: (setId: string, cardId: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.flashcardsRemoveCard, setId, cardId),
    updateCard: (
      setId: string,
      cardId: string,
      faces: { recto: string; verso: string }
    ): Promise<Flashcard | null> =>
      ipcRenderer.invoke(CHANNELS.flashcardsUpdateCard, setId, cardId, faces),
    tutorSend: (input: TutorSendInput): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.flashcardsTutorSend, input),
    tutorStop: (): Promise<void> => ipcRenderer.invoke(CHANNELS.flashcardsTutorStop),
    tutorReset: (): Promise<void> => ipcRenderer.invoke(CHANNELS.flashcardsTutorReset),
    onTutorStream: (handler: (event: ChatStreamEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: ChatStreamEvent): void => handler(payload)
      ipcRenderer.on(CHANNELS.flashcardsTutorStream, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.flashcardsTutorStream, listener)
      }
    },

    /**
     * Abonne le renderer aux avancees de la generation en tache de fond.
     * Renvoie la fonction de desabonnement — a appeler au demontage.
     */
    onChanged: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on(CHANNELS.flashcardsChanged, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.flashcardsChanged, listener)
      }
    }
  },

  ocr: {
    modelStatus: (): Promise<OcrModelStatus> => ipcRenderer.invoke(CHANNELS.ocrModelStatus),
    install: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.ocrInstall),
    readImage: (png: Uint8Array): Promise<OcrRead | null> =>
      ipcRenderer.invoke(CHANNELS.ocrReadImage, png),
    convert: (
      courseId: string,
      pages: { page: number; markdown: string }[],
      report?: { missing: number[]; pageCount: number }
    ): Promise<{ courseId: string; document: OcrDocument }> =>
      ipcRenderer.invoke(CHANNELS.ocrConvert, courseId, pages, report),
    patch: (
      courseId: string,
      pages: { page: number; markdown: string }[]
    ): Promise<{ missing: number[] }> => ipcRenderer.invoke(CHANNELS.ocrPatch, courseId, pages),
    mediaPng: (name: string): Promise<Uint8Array | null> =>
      ipcRenderer.invoke(CHANNELS.ocrMediaPng, name),
    readOriginal: (relative: string): Promise<Uint8Array> =>
      ipcRenderer.invoke(CHANNELS.ocrReadOriginal, relative),
    readOriginalDocx: (relative: string): Promise<DocxDocument> =>
      ipcRenderer.invoke(CHANNELS.ocrReadOriginalDocx, relative),
    listOriginal: (relative: string): Promise<string[]> =>
      ipcRenderer.invoke(CHANNELS.ocrListOriginal, relative),
    importPhotos: (proposal: PhotoProposal): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.ocrImportPhotos, proposal),
    pending: (): Promise<PendingConversion[]> => ipcRenderer.invoke(CHANNELS.ocrPending),
    dismiss: (id: string): Promise<void> => ipcRenderer.invoke(CHANNELS.ocrDismiss, id),

    onPendingChanged: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on(CHANNELS.ocrPendingChanged, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.ocrPendingChanged, listener)
      }
    },

    onModelChanged: (handler: (status: OcrModelStatus) => void): (() => void) => {
      const listener = (_event: unknown, payload: OcrModelStatus): void => handler(payload)
      ipcRenderer.on(CHANNELS.ocrModelChanged, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.ocrModelChanged, listener)
      }
    }
  },

  media: {
    keep: (bytes: Uint8Array, contentType: string): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.mediaKeep, bytes, contentType)
  },

  rag: {
    status: (courseId: string): Promise<VectorStatus | null> =>
      ipcRenderer.invoke(CHANNELS.ragStatus, courseId),

    /**
     * Abonne le renderer aux changements d'etat de la vectorisation. Renvoie
     * la fonction de desabonnement — a appeler au demontage, sinon les
     * listeners s'accumulent a chaque changement de cours.
     */
    onChanged: (handler: (status: VectorStatus) => void): (() => void) => {
      const listener = (_event: unknown, payload: VectorStatus): void => handler(payload)
      ipcRenderer.on(CHANNELS.ragChanged, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.ragChanged, listener)
      }
    }
  },

  claude: {
    status: () => ipcRenderer.invoke(CHANNELS.claudeStatus),
    models: () => ipcRenderer.invoke(CHANNELS.claudeModels),
    warm: (): Promise<void> => ipcRenderer.invoke(CHANNELS.claudeWarm),
    send: (input: ChatSendInput): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.claudeSend, input),
    interrupt: (courseId: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.claudeInterrupt, courseId),
    reset: (courseId: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.claudeReset, courseId),
    history: (courseId: string): Promise<ChatHistoryEntry[]> =>
      ipcRenderer.invoke(CHANNELS.claudeHistory, courseId),
    openSession: (courseId: string, sessionId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke(CHANNELS.claudeOpenSession, courseId, sessionId),
    hydrate: (
      courseId: string
    ): Promise<{ sessionId: string; messages: ChatMessage[] } | null> =>
      ipcRenderer.invoke(CHANNELS.claudeHydrate, courseId),
    compact: (courseId: string): Promise<CompactOutcome> =>
      ipcRenderer.invoke(CHANNELS.claudeCompact, courseId),

    /**
     * Abonne le renderer au flux de reponse. Renvoie la fonction de
     * desabonnement — a appeler au demontage du composant, sinon les
     * listeners s'accumulent a chaque changement de cours.
     */
    onStream: (handler: (event: ChatStreamEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: ChatStreamEvent): void => handler(payload)
      ipcRenderer.on(CHANNELS.claudeStream, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.claudeStream, listener)
      }
    }
  },

  memoire: {
    list: (): Promise<MemoryEntry[]> => ipcRenderer.invoke(CHANNELS.memoireList),
    forget: (entryId: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.memoireForget, entryId),
    cancel: (traceId: string): Promise<MemoryTrace | null> =>
      ipcRenderer.invoke(CHANNELS.memoireCancel, traceId),

    /**
     * Abonne le renderer aux ecritures en memoire de l'assistant, pour
     * afficher leur trace sous la reponse. Renvoie la fonction de
     * desabonnement.
     */
    onTrace: (handler: (trace: MemoryTrace) => void): (() => void) => {
      const listener = (_event: unknown, payload: MemoryTrace): void => handler(payload)
      ipcRenderer.on(CHANNELS.memoireTrace, listener)
      return () => {
        ipcRenderer.removeListener(CHANNELS.memoireTrace, listener)
      }
    }
  },

  reglages: {
    prompts: (): Promise<PromptSetting[]> => ipcRenderer.invoke(CHANNELS.reglagesPrompts),
    setPrompt: (id: PromptId, texte: string | null): Promise<PromptSetting[]> =>
      ipcRenderer.invoke(CHANNELS.reglagesSetPrompt, id, texte)
  },

  fenetre: {
    feux: (flottants: boolean): void => {
      ipcRenderer.send(CHANNELS.fenetreFeux, flottants)
    }
  }
}

contextBridge.exposeInMainWorld('noted', api)
