/**
 * Noms des canaux IPC, declares une seule fois. Le preload et le main
 * importent cette table : une faute de frappe devient une erreur de
 * compilation au lieu d'un canal silencieusement mort au runtime.
 */
export const CHANNELS = {
  vaultPaths: 'vault:paths',
  vaultListSubjects: 'vault:list-subjects',
  vaultReveal: 'vault:reveal',
  vaultImportCourses: 'vault:import-courses',
  vaultImportPaths: 'vault:import-paths',
  vaultCreateSubject: 'vault:create-subject',
  vaultRenameSubject: 'vault:rename-subject',
  vaultDeleteSubject: 'vault:delete-subject',

  courseRename: 'course:rename',
  courseMove: 'course:move',
  courseDelete: 'course:delete',

  courseReadBytes: 'course:read-bytes',
  courseReadMarkdown: 'course:read-markdown',
  courseReadDocx: 'course:read-docx',
  /** Le texte deja extrait de ce document, s'il n'a pas bouge depuis. */
  courseReadExtraction: 'course:read-extraction',
  courseCacheExtraction: 'course:cache-extraction',
  /** L'apercu deja dessine de ce document, s'il n'a pas bouge depuis. */
  coursePreviewRead: 'course:preview-read',
  coursePreviewCache: 'course:preview-cache',

  notesRead: 'notes:read',
  notesWrite: 'notes:write',
  notesBackup: 'notes:backup',
  /** Le passage du cours dont un bloc de note parle, cherche par les vecteurs. */
  notesAnchorPassage: 'notes:anchor-passage',

  /** Sens main -> renderer : l'assistant demande la note telle qu'affichee. */
  notesLiveRequest: 'notes:live-request',
  /** Sens renderer -> main : le markdown de l'editeur, ou null si pas ouvert. */
  notesLiveReply: 'notes:live-reply',
  /** Sens main -> renderer : proposition d'ecriture de l'assistant. */
  notesProposal: 'notes:proposal',
  /** Sens renderer -> main : decision de l'utilisateur sur la proposition. */
  notesProposalReply: 'notes:proposal-reply',
  /** Sens main -> renderer : la proposition n'attend plus (tour interrompu). */
  notesProposalCancel: 'notes:proposal-cancel',
  /** Sens main -> renderer : le texte d'une ecriture de notes, pendant qu'elle se compose. */
  notesDraft: 'notes:draft',
  /** Sens main -> renderer : ce brouillon n'a plus lieu d'etre affiche. */
  notesDraftEnd: 'notes:draft-end',
  /** Une reponse recopiee dans la note : ses ancres, bloc par bloc. */
  notesAnchorBlocks: 'notes:anchor-blocks',
  /** La place de chaque ancre dans l'ordre du cours, pour ranger la note. */
  notesOrderKeys: 'notes:order-keys',

  /** Sens main -> renderer : l'assistant soumet un questionnaire. */
  quizAsk: 'quiz:ask',
  /** Sens renderer -> main : les reponses, ou le refus de repondre. */
  quizReply: 'quiz:reply',
  /** Sens main -> renderer : le quiz n'attend plus (tour interrompu). */
  quizCancel: 'quiz:cancel',

  annotationsRead: 'annotations:read',
  annotationsWrite: 'annotations:write',

  /** Etat de la vectorisation d'un cours, demande a l'ouverture du panneau. */
  ragStatus: 'rag:status',
  /** Sens main -> renderer : cet etat vient de changer. */
  ragChanged: 'rag:changed',

  claudeStatus: 'claude:status',
  claudeModels: 'claude:models',
  claudeSend: 'claude:send',
  /** La barre de l'assistant a pris le focus : chauffer le moteur de vecteurs. */
  claudeWarm: 'claude:warm',
  claudeInterrupt: 'claude:interrupt',
  claudeReset: 'claude:reset',
  /** Les conversations passees d'un cours, pour le picker d'historique. */
  claudeHistory: 'claude:history',
  /** Reprend une conversation passee comme fil actif du cours. */
  claudeOpenSession: 'claude:open-session',
  /** Efface definitivement une conversation passee du cours. */
  claudeDeleteSession: 'claude:delete-session',
  /** Reprend la derniere conversation d'un cours a la premiere ouverture. */
  claudeHydrate: 'claude:hydrate',
  /** Compacte la conversation en cours d'un cours. */
  claudeCompact: 'claude:compact',

  /** Sens main -> renderer : deltas de la reponse en cours. */
  claudeStream: 'claude:stream',

  /** Depose une image dans le dossier media et rend son nom. */
  mediaKeep: 'media:keep',

  /** Toutes les entrees de memoire, pour l'ecran de consultation. */
  memoireList: 'memoire:liste',
  /** Supprime une entree de memoire depuis l'ecran de consultation. */
  memoireForget: 'memoire:oublier',
  /** Annule une ecriture en memoire depuis sa trace. */
  memoireCancel: 'memoire:annuler',
  /** Sens main -> renderer : une ecriture en memoire vient d'avoir lieu. */
  memoireTrace: 'memoire:trace',

  /** Le tableau de bord des flashcards : stats et sets par matiere. */
  flashcardsOverview: 'flashcards:overview',
  /** La file d'une session de revision, ordonnee par la repetition espacee. */
  flashcardsQueue: 'flashcards:queue',
  /** Enregistre une reponse et rend la carte mise a jour. */
  flashcardsAnswer: 'flashcards:answer',
  /** Ajoute des cartes ecrites a la main — set d'un cours ou set general d'une matiere. */
  flashcardsImport: 'flashcards:import',
  /** Les cartes d'un set, dans l'ordre du fichier — l'ecran du deck. */
  flashcardsCards: 'flashcards:cards',
  /** Supprime une carte d'un set. */
  flashcardsRemoveCard: 'flashcards:remove-card',
  /** Reecrit le recto et le verso d'une carte. */
  flashcardsUpdateCard: 'flashcards:update-card',
  /** Un message au tuteur d'une carte en revision. */
  flashcardsTutorSend: 'flashcards:tutor-send',
  /** Arrete la reponse en cours du tuteur. */
  flashcardsTutorStop: 'flashcards:tutor-stop',
  /** Oublie la conversation du tuteur — la carte a change. */
  flashcardsTutorReset: 'flashcards:tutor-reset',
  /** Sens main -> renderer : la reponse du tuteur, au fil de l'eau. */
  flashcardsTutorStream: 'flashcards:tutor-stream',
  /** Sens main -> renderer : la generation en tache de fond a avance. */
  flashcardsChanged: 'flashcards:changed',

  /** Les prompts des agents, pour l'ecran Parametres. */
  reglagesPrompts: 'reglages:prompts',
  /** Remplace le prompt d'un agent, ou le rend a son defaut. */
  reglagesSetPrompt: 'reglages:set-prompt',

  /** Sens main -> renderer : le dossier Cours/ a bouge sur le disque. */
  vaultChanged: 'vault:changed',

  /**
   * La coque d'accueil detache sa barre du bord de la fenetre : les feux
   * macOS, places par le main, doivent suivre pour rester centres dedans.
   */
  fenetreFeux: 'fenetre:feux'
} as const

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]
