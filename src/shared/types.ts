/**
 * Contrat partage entre le main process (Node) et le renderer (React).
 * Ce fichier ne doit importer ni Node ni React : il est charge des deux cotes.
 */

// ---------------------------------------------------------------------------
// Codes couleur semantiques
// ---------------------------------------------------------------------------

/**
 * Chaque couleur de surlignage porte un sens fixe. L'IA connait ces
 * conventions, ce qui rend possible « revise tout ce que j'ai marque rouge »
 * ou « genere des flashcards depuis mes surlignages verts ».
 */
export type HighlightColorId =
  | 'retenir'
  | 'incompris'
  | 'definition'
  | 'formule'
  | 'transversal'

export interface HighlightColor {
  id: HighlightColorId
  /** Nom court affiche dans la legende et la palette. */
  label: string
  /** Ce que la couleur signifie, affiche en clair dans la legende. */
  meaning: string
  /** Couleur pleine, utilisee pour la pastille de la legende. */
  hex: string
  /**
   * Meme couleur en translucide, pour peindre par-dessus le document ou le
   * texte des notes. L'opacite est reglee couleur par couleur : le jaune est
   * naturellement clair et demande plus de matiere que le rouge pour marquer
   * un fond creme.
   */
  wash: string
  /** Raccourci clavier associe (1..5). */
  shortcut: string
  /**
   * Un surlignage qui ne se voit pas : il est enregistre, il engendre ses
   * flashcards, mais le document reste vierge. « A retenir » marche ainsi —
   * c'est un geste d'envoi vers les cartes, pas une marque a relire.
   */
  hidden?: true
}

/**
 * Source de verite unique des codes couleur. Le renderer l'utilise pour la
 * legende et la palette ; le main process l'injecte dans le prompt systeme
 * pour que Claude sache ce que chaque couleur veut dire.
 */
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = [
  {
    id: 'retenir',
    label: 'À retenir',
    meaning: 'Point important — engendre une flashcard, sans trace dans le cours',
    hex: '#C99A12',
    wash: 'rgba(232, 185, 59, 0.42)',
    shortcut: '1',
    hidden: true
  },
  {
    id: 'incompris',
    label: 'Pas compris',
    meaning: 'À reprendre — alimente le mode révision',
    hex: '#C0392B',
    wash: 'rgba(220, 91, 76, 0.28)',
    shortcut: '2'
  },
  {
    id: 'definition',
    label: 'Définition',
    meaning: 'Terme ou concept défini — alimente les flashcards',
    hex: '#2E8B57',
    wash: 'rgba(76, 169, 122, 0.32)',
    shortcut: '3'
  },
  {
    id: 'formule',
    label: 'Formule / chiffre',
    meaning: 'Calcul, ratio ou donnée chiffrée clé',
    hex: '#2C6FAF',
    wash: 'rgba(61, 143, 209, 0.26)',
    shortcut: '4'
  },
  {
    id: 'transversal',
    label: 'À relier',
    meaning: 'Fait écho à un autre cours',
    hex: '#7E4FB0',
    wash: 'rgba(155, 107, 196, 0.28)',
    shortcut: '5'
  }
] as const

// ---------------------------------------------------------------------------
// Habillage des tableaux
// ---------------------------------------------------------------------------

/**
 * Un tableau porte deux reglages : sa facon de tracer ses traits, et une
 * couleur d'accent. Ils voyagent sur disque dans un commentaire pose juste
 * au-dessus — « <!-- tableau: encadre definition --> » — qu'Obsidian n'affiche
 * pas et qui laisse le tableau lui-meme en Markdown ordinaire.
 *
 * L'accent reprend les cinq codes semantiques plutot qu'une palette a lui :
 * un tableau vert est un tableau de definitions, dans les notes comme dans le
 * cours. « laiton » est la teinte neutre de l'application.
 */
export type TableDesign = 'sobre' | 'encadre' | 'registre' | 'grille'

export type TableAccent = 'laiton' | HighlightColorId

export const TABLE_DESIGNS: readonly { id: TableDesign; label: string; hint: string }[] = [
  {
    id: 'sobre',
    label: 'Sobre',
    hint: 'Filets d’un cheveu — le tableau se lit comme un paragraphe ordonné'
  },
  {
    id: 'encadre',
    label: 'Encadré',
    hint: 'Grille marquée, en-tête souligné — pour comparer colonne par colonne'
  },
  {
    id: 'registre',
    label: 'Registre',
    hint: 'Aucun filet vertical, double trait sous l’en-tête — l’esprit d’un relevé imprimé'
  },
  {
    id: 'grille',
    label: 'Grille',
    hint: 'Le même trait partout, aucune ligne mise en avant — pour un tableau sans hiérarchie'
  }
] as const

export const TABLE_ACCENTS: readonly TableAccent[] = [
  'laiton',
  'retenir',
  'incompris',
  'definition',
  'formule',
  'transversal'
] as const

export const DEFAULT_TABLE_DESIGN: TableDesign = 'sobre'
export const DEFAULT_TABLE_ACCENT: TableAccent = 'laiton'

export interface TableStyle {
  design: TableDesign
  accent: TableAccent
}

/** « <!-- tableau: encadre definition --> », seul sur sa ligne. */
export const TABLE_MARKER = /^<!--\s*tableau\s*:\s*([^>]*?)\s*-->$/

/** Une ligne debarrassee de son indentation et de ses chevrons de citation. */
export function bareLine(line: string): string {
  return line.replace(/^[ \t]*(?:>[ \t]?)*/, '').trim()
}

/**
 * Les mots d'un marqueur, dans n'importe quel ordre. Rend null des qu'un mot
 * n'est ni un design ni un accent connu : mieux vaut refuser le marqueur que
 * d'habiller un tableau au hasard.
 */
export function parseTableMarker(body: string): TableStyle | null {
  const style: TableStyle = { design: DEFAULT_TABLE_DESIGN, accent: DEFAULT_TABLE_ACCENT }
  const designs = new Set<string>(TABLE_DESIGNS.map((design) => design.id))
  const accents = new Set<string>(TABLE_ACCENTS)

  for (const word of body.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (designs.has(word)) style.design = word as TableDesign
    else if (accents.has(word)) style.accent = word as TableAccent
    else return null
  }

  return style
}

/** Le marqueur a ecrire, ou rien quand le tableau porte l'habillage par defaut. */
export function tableMarker(design: TableDesign, accent: TableAccent): string {
  const words = [
    design === DEFAULT_TABLE_DESIGN ? '' : design,
    accent === DEFAULT_TABLE_ACCENT ? '' : accent
  ].filter(Boolean)

  return words.length === 0 ? '' : `<!-- tableau: ${words.join(' ')} -->\n`
}

// ---------------------------------------------------------------------------
// Ancres : le lien entre un bloc de note et l'endroit du cours qu'il regarde
// ---------------------------------------------------------------------------

/**
 * Ou l'on en etait dans le cours quand un bloc de note a ete ecrit.
 *
 * Deux niveaux, qui ne repondent pas a la meme question. La page (ou la
 * section) dit *ou j'etais* : elle se capture toute seule, elle est toujours
 * la. Le passage dit *sur quoi j'ecris* : il se pose d'un geste, il est plus
 * fin qu'une page, et il l'emporte quand les deux existent.
 *
 * Rien n'est devine apres coup : tout est enregistre au moment de l'ecriture,
 * a partir de ce qui etait affiche. Aucun modele n'intervient.
 */
export interface NoteAnchor {
  /** Page du PDF. Null pour un document sans pagination. */
  page: number | null
  /** Titre de section, pour un document sans pagination. */
  section: string | null
  /** Fraction du document parcourue, seul recours d'un support sans titres. */
  progress: number | null
  /** Le passage vise, quand l'ancrage a ete pose a la main. */
  passage: Passage | null
  /**
   * Le rang de la figure d'ou vient le passage, ou null s'il vient du texte.
   *
   * Un document illustre porte deux sortes de contenu : ce qui s'ecrit, et ce
   * que les images disent. La lecture des captures (`ocr/figures.ts`) verse le
   * second dans l'index, a la place exacte du marqueur — c'est ce qui permet a
   * l'assistant de citer un tableau colle en capture. Mais ce texte-la n'est
   * nulle part a l'ecran : l'image y est restee une image. Un passage qui en
   * vient ne peut donc pas etre retrouve dans le document affiche, et c'est ce
   * rang qui dit alors quoi encadrer — la n-ieme image du document, dans
   * l'ordre ou elle apparait.
   *
   * Toujours null pour un PDF : ses figures sont peintes dans la page, il n'y a
   * pas d'element a designer, et l'ancre y ramene deja par son numero de page.
   */
  figure: number | null
}

/**
 * La place d'une ancre dans l'ordre du cours : l'unite du document — page,
 * ordinal de section ou fraction parcourue — puis le rang du passage dans
 * cette unite. Deux notes sur la meme page se rangent ainsi dans l'ordre des
 * passages qu'elles commentent. Le rang n'est jamais ecrit sur le disque : il
 * depend du decoupage du cours, et se recalcule depuis l'index fin.
 */
export type OrderKey = [number, number]

/** « <!-- ancre {"p":12} --> », seul sur sa ligne. */
export const ANCHOR_MARKER = /^<!--\s*ancre\s+(\{.*\})\s*-->$/

/**
 * Le marqueur ecrit dans le Markdown.
 *
 * Un commentaire HTML, comme l'habillage des tableaux : Obsidian ne l'affiche
 * pas, un editeur de texte le laisse tranquille, et la note reste un fichier
 * ordinaire. Les clefs sont courtes parce qu'il y en aura un par changement
 * d'ancre et qu'on n'ecrit pas un roman dans les marges.
 *
 * Le passage voyage dans le marqueur plutot que dans un fichier annexe : deux
 * cents caracteres tout au plus, et la note se suffit a elle-meme — elle suit
 * un cours renomme et part avec lui sans qu'on ait rien a synchroniser.
 */
export function anchorMarker(anchor: NoteAnchor): string {
  const body: Record<string, unknown> = {}

  if (anchor.page !== null) body.p = anchor.page
  if (anchor.section !== null) body.s = anchor.section
  if (anchor.progress !== null) body.y = Math.round(anchor.progress * 1000) / 1000
  if (anchor.passage) {
    body.t = anchor.passage.text
    body.b = anchor.passage.before
    body.a = anchor.passage.after
  }
  if (anchor.figure !== null) body.f = anchor.figure

  return `<!-- ancre ${JSON.stringify(body)} -->`
}

/** Relit un marqueur. Rend null sur tout ce qu'on ne sait pas relire. */
export function parseAnchorMarker(body: string): NoteAnchor | null {
  let raw: Record<string, unknown>

  try {
    raw = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }

  if (!raw || typeof raw !== 'object') return null

  const text = typeof raw.t === 'string' ? raw.t : null

  const anchor: NoteAnchor = {
    page: typeof raw.p === 'number' ? raw.p : null,
    section: typeof raw.s === 'string' ? raw.s : null,
    progress: typeof raw.y === 'number' ? raw.y : null,
    passage: text
      ? {
          text,
          before: typeof raw.b === 'string' ? raw.b : '',
          after: typeof raw.a === 'string' ? raw.a : ''
        }
      : null,
    // Une figure sans passage ne designe rien : c'est le texte de l'image qui
    // fait l'ancre, le rang ne fait que dire ou le montrer.
    figure: text && typeof raw.f === 'number' ? raw.f : null
  }

  // Une ancre qui ne designe rien n'est pas une ancre.
  if (anchor.page === null && anchor.section === null && anchor.progress === null) {
    return anchor.passage ? anchor : null
  }

  return anchor
}

/** Comment l'ancre se lit dans la marge des notes et dans les outils de l'IA. */
export function anchorLabel(anchor: NoteAnchor): string {
  if (anchor.page !== null) return `p. ${anchor.page}`
  if (anchor.section !== null) return anchor.section
  if (anchor.progress !== null) return `${Math.round(anchor.progress * 100)} %`
  return 'passage'
}

/** Deux ancres designent-elles le meme endroit ? */
export function sameAnchor(a: NoteAnchor | null, b: NoteAnchor | null): boolean {
  if (!a || !b) return a === b
  if (a.passage?.text !== b.passage?.text) return false
  return a.page === b.page && a.section === b.section
}

// ---------------------------------------------------------------------------
// Vault : cours, notes, memoire
// ---------------------------------------------------------------------------

export type CourseFormat = 'pdf' | 'docx' | 'pptx' | 'markdown'

/** Un document de cours present dans le vault. */
export interface Course {
  /** Identifiant stable, derive du chemin relatif. */
  id: string
  /** Nom affiche, derive du nom de fichier. */
  title: string
  /** Matiere = nom du dossier sous Cours/. */
  subject: string
  format: CourseFormat
  /** Chemin absolu du document source. */
  path: string
  /** Chemin absolu de la note associee (peut ne pas exister encore). */
  notePath: string
  /** Taille en octets, pour affichage. */
  sizeBytes: number
  /** Date de derniere modification du document source (ms epoch). */
  modifiedAt: number
  /**
   * Date d'arrivee du document dans le vault (ms epoch). L'import copie le
   * fichier : la date de naissance de la copie est donc bien le moment ou le
   * cours a rejoint Noted, et non celle du fichier d'origine. C'est elle qui
   * ordonne le tableau de bord — « mes derniers cours » veut dire ceux qu'on
   * vient d'ajouter, pas ceux qu'on a rouverts en dernier.
   */
  createdAt: number
}

/** Une matiere, regroupant plusieurs cours. */
export interface Subject {
  name: string
  courses: Course[]
}

/**
 * Un passage surligne dans le document, avec eventuellement une note ancree.
 *
 * Le passage n'est pas repere par un decalage dans le fichier — un PDF n'a pas
 * de decalage, et le texte d'un DOCX change de position au moindre changement
 * de convertisseur. Il est repere par ce qu'il dit : son texte exact, et le
 * voisinage immediat qui permet de distinguer la bonne occurrence des autres.
 * C'est la meme idee que l'ancre d'une citation, et cela survit a une
 * reouverture du document comme a une mise a jour de l'application.
 */
export interface Annotation {
  /** Identifiant stable, engendre a la creation. */
  id: string
  colour: HighlightColorId
  /** Page du PDF. Vaut null pour un document sans pagination. */
  page: number | null
  /** Titre de section le plus proche, pour un document sans pagination. */
  heading: string | null
  /** Texte exactement tel qu'il a ete selectionne a l'ecran. */
  text: string
  /** Ce qui precede et ce qui suit, pour lever l'ambiguite entre occurrences. */
  before: string
  after: string
  /** Note ancree a ce passage. Chaine vide tant qu'on n'en a pas ecrit. */
  comment: string
  /** ISO 8601. */
  createdAt: string
}

/**
 * Un passage du cours tel qu'on l'enregistre pour le retrouver : ce qu'il dit,
 * plus le voisinage qui distingue la bonne occurrence des autres. Ni un
 * decalage d'octets, ni un chemin dans le DOM — voir `lib/annotate.ts`.
 */
export type Passage = Pick<Annotation, 'text' | 'before' | 'after'>

/**
 * Sur quoi l'IA doit s'appuyer pour citer un passage. Un PDF a des pages
 * numerotees que l'utilisateur voit a l'ecran ; un DOCX ou un Markdown n'en a
 * pas, et inventer une pagination donnerait des references introuvables.
 */
export type CourseAnchor = 'page' | 'section'

/**
 * Version de l'extraction du texte des documents.
 *
 * **A incrementer des que la lecture d'un document change** — le regroupement
 * des fragments en lignes, le seuil de paragraphe, la detection des en-tetes
 * courants ou des sommaires, l'extraction des figures. Le texte extrait est
 * garde sur le disque d'une ouverture a l'autre, et c'est ce nombre qui dit au
 * cache que ce qu'il conserve a ete produit par une version depassee. L'oublier
 * ne casse rien de visible : cela laisse simplement tous les cours deja lus sur
 * leur ancien texte, indefiniment.
 */
export const EXTRACTION_VERSION = 1

/** Contenu d'un cours extrait en texte, pret pour le contexte de l'IA. */
export interface ExtractedCourse {
  courseId: string
  anchor: CourseAnchor
  /** Nombre de pages. Vaut 1 pour un document non pagine. */
  pageCount: number
  /** Texte de chaque page, dans l'ordre. Une seule entree si non pagine. */
  pages: ExtractedPage[]
  /** Markdown complet, avec les marqueurs de page, pret pour le contexte. */
  markdown: string
  /** Nombre approximatif de tokens, pour prevenir avant de charger. */
  approxTokens: number
  /** true si l'extraction a rendu tres peu de texte (PDF probablement scanne). */
  looksScanned: boolean
  /**
   * Les images du document posees sur le disque, dans l'ordre d'apparition.
   *
   * Le n-ieme `[figure]` du texte correspond au n-ieme nom de cette liste. C'est
   * par elle que la lecture des captures d'ecran retrouve sa place : sans elle,
   * le texte tire d'une image serait ajoute quelque part, pas exactement la ou
   * l'image se trouvait — et l'ancre de la citation designerait le mauvais
   * endroit du cours.
   */
  media?: string[]
  /**
   * Ce que les images du document ont dit, une fois lues.
   *
   * Rempli par `readFigures`, et par lui seul : le texte de chaque capture y
   * figure exactement comme il vient d'etre verse dans `pages` et `markdown`.
   * C'est ce qui permet au decoupage fin de reconnaitre un passage venu d'une
   * image sans avoir a suivre des positions a travers un texte qu'il redecoupe
   * et renettoie.
   *
   * Absent tant qu'aucune image n'a ete lue — moteur absent, images
   * decoratives, lecture infructueuse.
   */
  figures?: FigureReading[]
}

/** Ce qu'une image du document dit, et de quelle image il s'agit. */
export interface FigureReading {
  /** Rang de l'image dans `media`, donc dans le document affiche. */
  at: number
  /** Le texte verse a la place du marqueur, tel quel. */
  text: string
}

export interface ExtractedPage {
  /** 1-indexe, comme l'affichage. */
  page: number
  text: string
  /**
   * Titre de la section en cours, quand le document en porte un.
   *
   * Dans un PDF de cours, c'est l'en-tete courant : la meme ligne se repete en
   * haut de chaque page d'une section. Repetee, elle ne dit rien de la page ou
   * elle se trouve — mais elle dit exactement de quoi la page parle, ce qu'un
   * passage sorti de son document n'a aucun autre moyen de savoir.
   */
  section?: string | null
  /**
   * Vrai pour une page de sommaire. Son texte est du renvoi, pas du contenu :
   * « Le pont de creation de valeur ...... 16 » n'a rien a repondre a personne
   * et brouille la recherche par mots-cles.
   */
  toc?: boolean
}

/**
 * Ou en est la recherche par le sens sur un cours.
 *
 * `complet` est la seule valeur qui autorise le point vert, et elle exige les
 * deux : tous les passages vectorises, et la paire de fichiers ecrite sur le
 * disque. Un vecteur calcule mais non ecrit serait a refaire a la prochaine
 * ouverture — l'annoncer acquis serait faux.
 */
/**
 * Ou en est le traitement d'un document, dans l'ordre ou il se fait.
 *
 * `attente` et `calcul` couvrent le decoupage large — celui dont depend chaque
 * reponse de l'assistant. `affine` est le second round, plus fin, qui ne sert
 * qu'a poser les notes au bon paragraphe et qui ne demarre qu'une fois le
 * premier entierement ecrit sur le disque. `complet` dit que les deux sont
 * faits, et rien de moins.
 */
export type VectorPhase = 'attente' | 'calcul' | 'affine' | 'complet' | 'echec'

export interface VectorStatus {
  courseId: string
  phase: VectorPhase
  /** Passages vectorises et ecrits sur le disque. */
  done: number
  /** Passages du cours. */
  total: number
  /**
   * Pourquoi le calcul a echoue, quand il a echoue.
   *
   * Le moteur dit toujours ce qui lui manque. Ne pas remonter ce message a
   * l'ecran revient a remplacer un diagnostic par un point rouge muet, et a
   * transformer une correction de deux minutes en une enquete.
   */
  reason?: string
}

// ---------------------------------------------------------------------------
// Lecture par OCR
// ---------------------------------------------------------------------------

/**
 * Ou en est l'installation du moteur de lecture d'images.
 *
 * Le moteur pese 1,4 Go et arrive par une connexion qui n'est pas toujours
 * bonne. Ce n'est donc pas une case a cocher mais un etat qui dure, parfois des
 * heures, et que l'interface doit savoir raconter honnetement — d'ou le debit et
 * le temps restant, plutot qu'un tourniquet qui ne dit rien.
 */
export type OcrModelPhase = 'absent' | 'telechargement' | 'pret' | 'echec'

export interface OcrModelStatus {
  phase: OcrModelPhase
  /** Octets deja sur le disque, tous fichiers confondus. */
  received: number
  /** Octets attendus au total. Vaut 0 tant qu'on ne les connait pas. */
  total: number
  /** Debit recent, en octets par seconde. Zero a l'arret. */
  speed: number
  /** Secondes restantes, ou null tant que le debit ne permet pas de le dire. */
  eta: number | null
  /** Ce qui manque ou ce qui a echoue, en clair. */
  reason?: string
}

/**
 * Nombre total de pixels qu'une image envoyee au moteur de lecture ne doit pas
 * depasser.
 *
 * **En surface, et non en cote le plus long** — la nuance a coute une enquete.
 * La premiere calibration plafonnait le grand cote a 1280, mesure par dichotomie
 * sur une page de cours en portrait : 905×1280 passait, 996×1408 non. Mais une
 * capture d'ecran est large, pas haute : 1280×1190 respecte ce plafond tout en
 * faisant une fois et demie la surface de la page qui avait servi a l'etablir —
 * et l'encodeur visuel y epuisait a nouveau la memoire graphique
 * (`kIOGPUCommandBufferCallbackErrorOutOfMemory`). Le moteur rendait alors un
 * bloc vide, sans erreur, et les captures d'ecran restaient muettes.
 *
 * Ce qui compte est donc la surface : 905×1280 fait 1,16 Mpx et passe,
 * 996×1408 fait 1,40 Mpx et echoue. Verifie ensuite sur la capture fautive,
 * ramenee a 1111×1034 : plus d'erreur, et du texte enfin lu.
 *
 * On ne descend pas plus bas pour se rassurer : a surface trop reduite, le
 * modele rendait `\ell` la ou il fallait lire `t` en indice d'une somme. La
 * marge entre « illisible » et « faux » est mince.
 *
 * Vit ici parce que les deux fabricants d'images doivent s'y tenir : le
 * renderer, qui dessine les pages de PDF, et `ocr/photos.ts`, qui prepare les
 * photos et les captures.
 */
export const OCR_MAX_IMAGE_PIXELS = 1_100_000

/**
 * Surface totale accordee a une page une fois decoupee en regions.
 *
 * Deux fois le plafond d'une image seule, et ce choix a ete arrete avec
 * l'utilisateur. Il repond a un defaut precis du regime precedent : une capture
 * d'ecran Retina plein cadre etait ramenee a 38 % de sa taille pour tenir dans
 * `OCR_MAX_IMAGE_PIXELS`, et un tableau dense y devenait illisible bien avant
 * que le modele n'ait son mot a dire.
 *
 * Decoupee, la meme page n'a plus a tout faire tenir dans une seule image : les
 * regions utiles gardent leur resolution d'origine, les blancs et les pieds de
 * page ne coutent plus rien. Ce budget dit jusqu'ou l'on va — au-dela, tout est
 * reduit d'un meme facteur, pour que la chauffe reste bornee quelle que soit la
 * page. Aucune region ne depasse jamais `OCR_MAX_IMAGE_PIXELS` a elle seule :
 * c'est le plafond mesure au-dela duquel l'encodeur visuel epuise la memoire
 * graphique.
 */
export const OCR_PAGE_PIXEL_BUDGET = 2_200_000

/**
 * Les dimensions a donner a une **page** avant de la decouper en regions.
 *
 * A ne pas confondre avec `fitToOcrBudget`, qui prepare une image destinee au
 * modele. Celle-ci n'est jamais envoyee telle quelle : elle sert de source aux
 * decoupes, et l'ecraser d'avance rendrait tout l'etage de mise en page inutile
 * — on decouperait dans une image deja perdue. Le plafond ne sert donc qu'a
 * borner la memoire, pas la qualite.
 */
export function fitToPageBudget(
  width: number,
  height: number
): { width: number; height: number } {
  const pixels = width * height
  if (pixels <= 0 || pixels <= OCR_PAGE_PIXEL_BUDGET) return { width, height }

  const scale = Math.sqrt(OCR_PAGE_PIXEL_BUDGET / pixels)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/**
 * Les dimensions a donner a une image pour qu'elle tienne dans ce budget, en
 * conservant ses proportions. Une image deja assez petite n'est pas agrandie.
 */
export function fitToOcrBudget(
  width: number,
  height: number
): { width: number; height: number } {
  const pixels = width * height
  if (pixels <= 0 || pixels <= OCR_MAX_IMAGE_PIXELS) return { width, height }

  const scale = Math.sqrt(OCR_MAX_IMAGE_PIXELS / pixels)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/**
 * Ce qu'a rendu la lecture d'une image.
 *
 * Une seule valeur, et c'est deliberé. Il y avait ici une confiance destinee a
 * une pastille de qualite ; le seul chemin qui fonctionne dans llama.cpp ne rend
 * pas les nombres qui l'auraient rendue honnete, et une mesure de complaisance
 * aurait invite a se fier a une lecture jamais mesuree. Ce qui restait —
 * detecter une page ou le modele a visiblement perdu pied — est devenu une
 * decision du moteur plutot qu'un affichage : une page qui boucle n'est pas
 * rendue du tout.
 */
export interface OcrRead {
  /** Markdown rendu par le modele. */
  markdown: string
}

/**
 * Ce qu'on sait d'un cours issu d'une lecture par OCR.
 *
 * Ces informations vivent dans le document lui-meme, en tete, sous forme de
 * commentaire — comme l'habillage des tableaux et les ancres des notes. Elles
 * pourraient tenir dans `.noted/`, mais elles n'y seraient qu'a moitie chez
 * elles : le lien vers l'original n'est pas du cache, et un cours qui perd la
 * trace de sa source ne sait plus proposer l'onglet qui la montre.
 */
export interface OcrDocument {
  /** Identite du modele qui a lu ce document, quantisation comprise. */
  model: string
  /** Chemin de l'original, relatif a `Originaux/`. */
  original: string
  /**
   * Pages de l'original dont la lecture a echoue, quand il y en a. Le cours
   * est utilisable sans elles, mais il est incomplet, et c'est ce champ qui
   * permet de le dire a l'ecran et de proposer de poursuivre la lecture.
   */
  missing?: number[]
  /** Nombre de pages de l'original, quand des pages manquent. */
  pageCount?: number
}

/** « <!-- noted-ocr {"model":"…"} --> », seul sur sa ligne, en tete du document. */
export const OCR_MARKER = /^<!--\s*noted-ocr\s+(\{.*\})\s*-->$/

export function ocrMarker(document: OcrDocument): string {
  return `<!-- noted-ocr ${JSON.stringify(document)} -->`
}

export function parseOcrMarker(body: string): OcrDocument | null {
  try {
    const raw = JSON.parse(body) as Partial<OcrDocument>
    if (typeof raw.model !== 'string' || typeof raw.original !== 'string') return null

    const document: OcrDocument = { model: raw.model, original: raw.original }

    // Les pages manquantes ne sont reprises que si elles ont la forme promise :
    // un en-tete abime ne doit pas faire echouer la lecture du cours entier.
    if (
      Array.isArray(raw.missing) &&
      raw.missing.length > 0 &&
      raw.missing.every((page) => typeof page === 'number' && Number.isInteger(page) && page > 0)
    ) {
      document.missing = raw.missing
      if (typeof raw.pageCount === 'number' && Number.isInteger(raw.pageCount)) {
        document.pageCount = raw.pageCount
      }
    }

    return document
  } catch {
    return null
  }
}

/**
 * « <!-- page 13 --> », seul sur sa ligne.
 *
 * C'est ce repere qui rend au Markdown ce que la conversion lui avait pris. Un
 * document lu page par page sait ou chaque page commence : l'inscrire coute un
 * commentaire invisible, et cela permet aux citations de continuer a dire
 * « p. 13 » plutot que de se rabattre sur les titres, a la bascule entre
 * l'original et la version lue de rester au meme endroit, et a la pastille de
 * qualite de designer la page fautive plutot que le document entier.
 */
export const PAGE_MARKER = /^<!--\s*page\s+(\d+)\s*-->$/

export function pageMarker(page: number): string {
  return `<!-- page ${page} -->`
}

/**
 * Un cours en cours de fabrication a partir de photos.
 *
 * Il n'existe pas encore comme fichier : c'est une ligne d'attente dans la
 * bibliotheque, qui dit qu'un cours arrive et ou en est sa lecture. Elle
 * disparait quand le cours devient reel, ou porte la raison de son echec.
 */
export interface PendingConversion {
  /** Identifiant provisoire : « <matiere>/<dossier> ». */
  id: string
  subject: string
  title: string
  /** Photos lues, et photos a lire. */
  done: number
  total: number
  /** Renseigne quand la fabrication a echoue. */
  failed?: string
}

/**
 * L'ordre dans lequel des photos deviendront un cours, avant qu'on le lance.
 *
 * Il est montre parce qu'il est devinable mais pas garanti : des photos
 * transferees perdent parfois leur date, et c'est alors le nom de fichier qui
 * decide. Une page a l'envers dans un cours de trente pages se corrige mal
 * apres coup ; la voir avant coute un regard.
 */
export interface PhotoProposal {
  subject: string
  /** Le titre que portera le cours. */
  title: string
  /** Les photos dans l'ordre retenu. */
  photos: { path: string; name: string }[]
  /** Vrai quand l'ordre vient des dates de prise de vue, faux quand il vient des noms. */
  byDate: boolean
}

/**
 * Ce qu'un import a produit — un seul geste, deux natures de fichiers.
 *
 * Il n'y a qu'un bouton « Importer », et c'est deliberé : celui qui importe a
 * des fichiers sous la main, pas des categories. C'est l'application qui
 * reconnait ce qu'on lui donne. Les formats qu'elle sait deja ouvrir sont
 * copies aussitot et reviennent dans `imported` ; les images, qui ne sont pas
 * des cours tant qu'elles n'ont pas ete lues, reviennent en proposition dont
 * l'ordre reste a confirmer. Un lot peut contenir les deux : les deux champs
 * sont alors renseignes.
 */
export interface ImportResult {
  /** Identifiants des cours copies dans le vault, dans l'ordre du choix. */
  imported: string[]
  /** Les images du meme lot, prêtes a devenir un cours. Null s'il n'y en avait pas. */
  photos: PhotoProposal | null
}

/** Resultat de la conversion d'un document Word. */
export interface DocxDocument {
  /** HTML structure : titres, listes, tableaux, images en base64. */
  html: string
  /** Ce que le convertisseur n'a pas su traduire, a afficher discretement. */
  warnings: string[]
}

/** Une note, telle que stockee sur disque. */
export interface Note {
  courseId: string
  path: string
  /** Corps de la note en markdown (sans le frontmatter). */
  markdown: string
  frontmatter: NoteFrontmatter
}

export interface NoteFrontmatter {
  cours: string
  matiere: string
  /** Chemin relatif du document source, pour le wikilink Obsidian. */
  source: string
  tags: string[]
  /** ISO 8601. */
  modifie: string
}

// ---------------------------------------------------------------------------
// Propositions d'ecriture de l'assistant dans les notes
// ---------------------------------------------------------------------------

/**
 * Une modification des notes proposee par l'assistant. Rien ne s'ecrit tant
 * que l'utilisateur n'a pas accepte : la proposition s'affiche en apercu dans
 * le panneau des notes, et le tour de conversation attend sa decision.
 */
export interface NoteProposal {
  /** Identifiant de la proposition, pour apparier la reponse. */
  id: string
  courseId: string
  kind: 'inserer' | 'remplacer' | 'reecrire'
  /** Le Markdown propose : ajout, remplacement, ou note entiere. */
  content: string
  /** Pour « inserer » : ou placer le contenu. Ignore si `target` est fourni. */
  position?: 'fin' | 'curseur'
  /**
   * Pour « remplacer » : le passage exact a remplacer. Pour « inserer » : le
   * passage exact apres lequel inserer — l'ancrage qui permet d'ajouter au
   * milieu d'une note sans la reecrire.
   */
  target?: string
  /**
   * Une fois le changement applique, la note entiere est rangee dans l'ordre
   * du cours — page, puis rang du passage. C'est le rang du passage dans le
   * cours qui decide de la place d'une note, pas son ordre d'arrivee : une
   * note sur la p. 60 s'intercale entre celles des pp. 58 et 61. Absent quand
   * l'utilisateur a demande une place precise (curseur, fin, apres un
   * passage) : sa consigne prime sur l'ordre du cours.
   */
  trier?: boolean
  /**
   * Pour « reecrire » : la note au moment de la proposition. Si elle a change
   * quand l'utilisateur clique, la proposition est caduque — appliquer une
   * reecriture calculee sur un texte perime ecraserait ce qu'il vient de taper.
   */
  base?: string
}

/**
 * Ce qu'est devenue une proposition, renvoye a l'assistant. « invalid » est le
 * seul statut qui n'atteint jamais l'ecran : une syntaxe fautive est renvoyee
 * au modele avant que l'apercu ne s'affiche, pour qu'il la corrige lui-meme.
 */
export type NoteProposalStatus = 'applied' | 'refused' | 'stale' | 'not-open' | 'invalid'

/** L'issue d'une proposition, avec la raison quand il y en a une a donner. */
export interface NoteProposalOutcome {
  status: NoteProposalStatus
  detail?: string
}

/** Demande du main : « quel est le markdown de la note affichee ? ». */
export interface NoteLiveRequest {
  requestId: string
  courseId: string
}

/**
 * Une ecriture de notes en train de se composer : le texte de la proposition
 * tel qu'il arrive, avant meme que l'outil ne soit appele. Il n'y a rien a
 * decider dessus — la proposition suivra, ou pas (syntaxe refusee, note
 * fermee) ; le brouillon ne fait que montrer ce qui vient.
 */
export interface NoteDraft {
  /** L'identifiant de l'appel d'outil, qui sert aussi a retirer le brouillon. */
  id: string
  courseId: string
  kind: NoteProposal['kind']
  /** Le texte lu jusqu'ici. Vide tant que le champ n'a pas commence. */
  text: string
}

/** Un brouillon a retirer — celui-la, ou tous ceux du cours quand `id` est null. */
export interface NoteDraftEnd {
  courseId: string
  id: string | null
}


// ---------------------------------------------------------------------------
// Les quiz que l'assistant fait passer
// ---------------------------------------------------------------------------

/**
 * Une question d'un quiz. Deux formes seulement : un QCM, dont les options
 * sont a cocher, et une question ouverte, a laquelle on repond au clavier.
 */
export interface QuizQuestion {
  /** Rang dans le questionnaire, a partir de 1. C'est ce numero qu'on lit. */
  n: number
  type: 'qcm' | 'libre'
  /** L'enonce, en Markdown restreint — formules en $…$. */
  question: string
  /** Les options d'un QCM, dans l'ordre. Vide pour une question ouverte. */
  options: string[]
  /** QCM : plusieurs cases peuvent etre justes. Faux par defaut. */
  multiple: boolean
}

/**
 * Un questionnaire soumis par l'assistant, affiche comme une carte dans le
 * fil. L'appel d'outil reste en attente tant que la carte n'a pas ete
 * envoyee : le modele ne reprend la main qu'avec les reponses en main.
 */
export interface QuizForm {
  id: string
  courseId: string
  /** Titre de la carte. Absent, la carte s'annonce simplement « Quiz ». */
  titre?: string
  questions: QuizQuestion[]
}

/** Ce qu'on a repondu a une question, dans la forme qu'elle appelait. */
export interface QuizAnswer {
  n: number
  /** QCM : les rangs des options cochees, dans l'ordre. */
  choisis?: number[]
  /** Question ouverte : le texte saisi. */
  texte?: string
}

/**
 * L'issue d'un quiz, rendue a l'assistant. « skipped » quand on passe la
 * carte, « cancelled » quand le tour a ete interrompu, « not-open » quand
 * aucune fenetre ne pouvait l'afficher.
 */
export interface QuizOutcome {
  status: 'answered' | 'skipped' | 'cancelled' | 'not-open'
  answers?: QuizAnswer[]
}


// ---------------------------------------------------------------------------
// Memoire de l'IA
// ---------------------------------------------------------------------------

/** Les trois niveaux de la memoire : partout, une matiere, un cours. */
export type MemoryLevel = 'global' | 'matiere' | 'cours'

/**
 * Une entree de memoire : un fait court, date, avec un identifiant stable.
 * L'entree vit dans un fichier Markdown sous Memoire/, lisible dans Obsidian ;
 * l'identifiant et la date tiennent dans un commentaire invisible au-dessus.
 */
export interface MemoryEntry {
  id: string
  /** Date de derniere ecriture, AAAA-MM-JJ. */
  date: string
  title: string
  /** Le corps de l'entree, en Markdown, sans le titre. */
  body: string
  level: MemoryLevel
  /** La matiere concernee — null au niveau global. */
  subject: string | null
  /** Chemin du fichier sous Memoire/, en separateurs POSIX. */
  file: string
  /**
   * Les entrees que celle-ci designe, sous la forme `fichier#titre` — ce que
   * porte la ligne « Voir : [[…]] » en fin d'entree. Les liens entrants ne sont
   * pas stockes : ils se resolvent a la volee (voir shared/memory-links).
   */
  links: string[]
}

/**
 * La trace d'une ecriture en memoire, affichee sous la reponse de l'assistant.
 * C'est le garde-fou du systeme : pas de confirmation prealable, mais rien
 * d'invisible — et chaque geste s'annule apres coup depuis cette trace.
 */
export interface MemoryTrace {
  /** Identifiant de la trace, celui que prend l'annulation. */
  id: string
  /** Le cours dont la conversation a produit cette ecriture. */
  courseId: string
  action: 'noter' | 'corriger' | 'oublier' | 'lier'
  entryId: string
  level: MemoryLevel
  title: string
  /**
   * Le texte de l'entree apres l'action — avant, pour un oubli ; pour une
   * liaison, la phrase qui dit ce qui vient d'etre relie.
   */
  body: string
  /** Faux quand l'annulation n'est plus possible. */
  cancellable: boolean
  /** Vrai une fois le geste annule depuis la trace. */
  cancelled?: boolean
}

// ---------------------------------------------------------------------------
// Conversation avec Claude
// ---------------------------------------------------------------------------

/** « system » ne sert qu'au repere de compaction affiche dans le fil. */
export type ChatRole = 'user' | 'assistant' | 'system'

/**
 * Un passage d'une reponse auquel la question repond.
 *
 * On en cite plusieurs a la fois : le numero est le rang d'apparition, celui
 * qu'on lit dans la pastille posee sur le passage comme sur la citation.
 */
export interface ChatQuote {
  /** 1, 2, 3 — le rang, dans l'ordre ou les passages ont ete pris. */
  n: number
  /** Le passage cite, blancs normalises sur une seule ligne. */
  text: string
  /**
   * D'ou vient le passage, quand ce n'est pas d'une reponse de l'assistant :
   * « mes notes, p. 12 ». Absent pour un passage pris dans le fil — c'est le
   * cas ordinaire, et le modele n'a pas besoin qu'on lui dise qu'il se cite.
   */
  source?: string
}

export interface ChatMessage {
  id: string
  role: ChatRole
  /** Texte affiche. Se remplit progressivement pendant le streaming. */
  text: string
  /** Passages de la reponse precedente auxquels cette question repond. */
  quotes?: ChatQuote[]
  /** Outils appeles par Claude pendant ce tour, pour affichage discret. */
  toolCalls?: ToolCallTrace[]
  /** Ecritures en memoire faites pendant ce tour, annulables depuis la trace. */
  memoryTraces?: MemoryTrace[]
  /** Raisonnement intermediaire, quand le modele en produit. */
  thinking?: string
  /** Tokens produits, mis a jour pendant la reponse. */
  tokens?: number
  /** true tant que la reponse est en cours de reception. */
  streaming?: boolean
  /** Message d'erreur si le tour a echoue. */
  error?: string
  /** Present uniquement sur le repere « role: system » d'une compaction. */
  compactedTokens?: number
  /** Le questionnaire pose pendant ce tour, affiche comme une carte. */
  quiz?: QuizForm
  /** Ce qui a ete repondu a ce questionnaire. Absent tant qu'il attend. */
  quizAnswers?: QuizAnswer[]
  /**
   * Longueur du texte au moment ou le quiz a ete pose. La carte se glisse a
   * cet endroit du corps de la reponse : ce qui l'annonce reste au-dessus,
   * la correction qui suivra s'ecrit en dessous.
   */
  quizAt?: number
}

/** Une conversation passee, pour le picker d'historique du panneau. */
export interface ChatHistoryEntry {
  sessionId: string
  /** Titre custom, resume genere, ou premier message — dans cet ordre. */
  title: string
  lastModified: number
  /** true si c'est la conversation actuellement active pour ce cours. */
  active: boolean
}

/** Resultat d'une compaction manuelle, demandee depuis le panneau. */
export type CompactOutcome =
  | { ok: true; droppedTokens?: number }
  | { ok: false; error: string }

export interface ToolCallTrace {
  id: string
  name: string
  /** Resume court de l'appel, affiche sur la ligne repliee. */
  summary: string
  /** Ce que l'IA a demande, en clair. Visible une fois la ligne depliee. */
  detail?: string
  /** Ce que l'outil a repondu. Arrive apres coup. */
  result?: string
  /** true tant que l'outil n'a pas rendu sa reponse. */
  running?: boolean
}

/**
 * Niveau de reflexion. Il guide la profondeur du raisonnement avant la reponse :
 * « low » repond vite, « xhigh » prend le temps de deplier un raisonnement long.
 */
export type ChatEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Un modele propose dans le selecteur, tel que Claude Code le declare. */
export interface ChatModel {
  /** Valeur transmise au SDK : un alias (« opus ») ou un identifiant complet. */
  value: string
  displayName: string
  description: string
  /** Faux pour un modele qui ne prend pas de niveau de reflexion. */
  supportsEffort?: boolean
  /** Niveaux acceptes par ce modele, quand la liste est connue. */
  supportedEffortLevels?: ChatEffort[]
}

/** Evenements pousses du main vers le renderer pendant un tour de chat. */
export type ChatStreamEvent =
  | { kind: 'text'; messageId: string; delta: string }
  | { kind: 'thinking'; messageId: string; delta: string }
  | { kind: 'tool'; messageId: string; call: ToolCallTrace }
  | { kind: 'tool-result'; messageId: string; toolId: string; result: string }
  | { kind: 'tokens'; messageId: string; tokens: number }
  | { kind: 'done'; messageId: string }
  | { kind: 'error'; messageId: string; message: string }

// ---------------------------------------------------------------------------
// Etat de l'authentification Claude
// ---------------------------------------------------------------------------

export type AuthMode = 'subscription' | 'api-key'

export interface ClaudeStatus {
  ready: boolean
  mode: AuthMode
  /** Chemin resolu du binaire claude, ou null s'il est introuvable. */
  executablePath: string | null
  /** Explication lisible quand ready vaut false. */
  detail: string
}

// ---------------------------------------------------------------------------
// API exposee au renderer par le preload
// ---------------------------------------------------------------------------

export interface VaultPaths {
  root: string
  courses: string
  notes: string
  memory: string
  /** Les surlignages, un fichier JSON par cours, meme arborescence que Notes/. */
  annotations: string
  /** Les flashcards, un fichier JSON par cours, meme arborescence que Notes/. */
  flashcards: string
  /**
   * Les prompts des agents, un fichier Markdown chacun. Ce sont eux qui
   * tournent : l'ecran Parametres et Obsidian editent les memes fichiers.
   */
  prompts: string
  /**
   * Les documents d'origine des cours reconstitues par OCR : PDF scannes,
   * photos de notes manuscrites.
   *
   * A cote de `Cours/` et non dedans, ou le dossier serait pris pour une
   * matiere. Et hors de `.noted/`, qui est du cache jetable : une photo de
   * notes manuscrites est une donnee, la seule qui existe, et rien ne permet
   * de la recalculer.
   */
  originals: string
  internal: string
}

/** Un cours dont l'identifiant a change, parce qu'il a ete renomme ou deplace. */
export interface CourseMove {
  previousId: string
  nextId: string
}

export interface ChatSendInput {
  courseId: string
  messageId: string
  prompt: string
  /** Modele choisi dans la barre de chat. Absent = celui par defaut. */
  model?: string
  /** Niveau de reflexion choisi. Absent = celui par defaut du modele. */
  effort?: ChatEffort
}

/** Un message au tuteur de flashcards, avec la carte dont il parle. */
export interface TutorSendInput {
  messageId: string
  prompt: string
  card: {
    /** Set d'origine : identifiant de cours, ou set general (`generalSetId`). */
    setId: string
    recto: string
    verso: string
  }
}

/**
 * Les agents dont le prompt se regle depuis l'ecran Parametres. Un agent, un
 * texte : c'est l'identifiant qui fait le lien entre le fichier de reglages,
 * le code qui construit l'appel et la ligne affichee a l'ecran.
 */
export type PromptId = 'assistant' | 'tuteur' | 'generateur' | 'memoire'

/**
 * Un bloc que l'application ajoute d'elle-meme autour du prompt d'un agent.
 * Son texte n'est pas une description : c'est le bloc reel, produit par le
 * code qui l'ajoute, sur un cours et une carte d'exemple. Le decrire a la main
 * le ferait mentir des la premiere evolution.
 */
export interface PromptAnnexe {
  /** Ou et quand ce bloc s'ajoute. */
  titre: string
  /** Le texte, tel qu'il part au modele. */
  texte: string
}

/** Un prompt d'agent, tel que l'ecran Parametres le montre et le modifie. */
export interface PromptSetting {
  id: PromptId
  /** Le nom de l'agent, en clair. */
  label: string
  /** Ce qu'il fait, et a quel moment il parle. */
  description: string
  /** Le texte livre avec l'application — ce que « Restaurer » remet. */
  defaut: string
  /** Le fichier qui porte ce prompt, pour l'ouvrir dans le Finder. */
  chemin: string
  /** Le texte en vigueur : celui du reglage s'il existe, sinon le defaut. */
  texte: string
  /** Vrai quand le fichier s'ecarte du texte livre avec l'application. */
  personnalise: boolean
  /**
   * Ce que l'application ajoute d'elle-meme autour de ce prompt a chaque
   * appel — le plan du cours ouvert, la carte revisee, la liste des
   * surlignages. Non modifiable : ce sont des donnees, pas des consignes.
   */
  annexes: PromptAnnexe[]
}

export interface NotedApi {
  vault: {
    paths(): Promise<VaultPaths>
    listSubjects(): Promise<Subject[]>
    /** Ouvre un fichier ou un dossier du vault dans le Finder. */
    reveal(target: string): Promise<void>
    /**
     * Ouvre le selecteur de fichiers et recoit ce qui a ete choisi. Documents
     * et images passent par la meme porte : voir `ImportResult`.
     */
    importCourses(subject: string): Promise<ImportResult>
    /**
     * Importe des fichiers deja designes — ceux d'un glisser-deposer. Meme
     * partage que pour le selecteur ; les formats inconnus sont ignores en
     * silence.
     */
    importPaths(paths: string[], subject: string): Promise<ImportResult>
    /** Cree un dossier de matiere. Renvoie le nom retenu, une fois normalise. */
    createSubject(name: string): Promise<string>
    /**
     * Renomme une matiere. Tous ses cours changent d'identifiant : la
     * correspondance revient pour que l'interface suive celui qui etait ouvert.
     */
    renameSubject(name: string, title: string): Promise<{ name: string; moved: CourseMove[] }>
    /** Envoie a la corbeille une matiere, ses cours et ses notes. */
    deleteSubject(name: string): Promise<void>
    /**
     * Previent quand le dossier Cours/ change sur le disque : un PDF depose
     * depuis le Finder, une matiere mise a la corbeille. Renvoie la fonction
     * de desabonnement.
     */
    onChanged(handler: () => void): () => void
  }
  course: {
    /** Renomme le document. Renvoie son nouvel identifiant. */
    rename(courseId: string, title: string): Promise<string>
    /** Deplace le document dans une autre matiere. Renvoie son nouvel identifiant. */
    move(courseId: string, subject: string): Promise<string>
    /** Envoie a la corbeille le document et sa note, et efface ses vecteurs. */
    remove(courseId: string): Promise<void>
    /** Octets bruts du document, pour le rendu pdf.js cote renderer. */
    readBytes(courseId: string): Promise<Uint8Array>
    /** Contenu texte direct, pour les cours deja en Markdown. */
    readMarkdown(courseId: string): Promise<string>
    /** Conversion d'un .docx en HTML, faite dans le main process. */
    readDocx(courseId: string): Promise<DocxDocument>
    /**
     * Le texte deja extrait de ce document lors d'une ouverture precedente, ou
     * null s'il faut le relire. Ne rend jamais rien pour les formats dont la
     * conversion sert de toute facon a l'affichage.
     */
    readExtraction(courseId: string): Promise<ExtractedCourse | null>
    /**
     * Le renderer extrait le texte du PDF pendant qu'il le rend, puis le
     * depose ici. Le main le conserve pour alimenter le contexte de Claude.
     */
    cacheExtraction(extracted: ExtractedCourse): Promise<void>
  }
  /**
   * Chemin d'un fichier depose sur la fenetre. Le renderer n'a pas acces au
   * systeme de fichiers : seul le preload sait traduire un objet File en
   * chemin, et il ne fait que cela.
   */
  pathForFile(file: File): string
  notes: {
    read(courseId: string): Promise<Note>
    write(courseId: string, markdown: string): Promise<void>
    /**
     * Garde une copie de la note telle qu'elle etait avant une ecriture de
     * l'assistant, dans `.noted/versions/`. Un seul fichier par cours : c'est
     * un filet pour le dernier geste, pas un historique.
     */
    backup(courseId: string, markdown: string): Promise<void>
    /**
     * Le passage du cours dont ce texte parle le plus, cherche par les
     * vecteurs. `unitKeys` (« page:12 », « section:7 ») dit d'ou la note vient
     * vraisemblablement — les pages visibles a l'ecran : c'est un filtre
     * d'attention, jamais une condition, et une liste vide fait balayer le
     * cours entier. Rend null tant que l'index fin du cours n'est pas pret,
     * auquel cas le bloc reste simplement sans ancre.
     */
    anchorPassage(courseId: string, text: string, unitKeys: string[]): Promise<NoteAnchor | null>
    /** L'assistant demande la note affichee. Repondre par replyLive. */
    onLiveRequest(handler: (request: NoteLiveRequest) => void): () => void
    replyLive(requestId: string, markdown: string | null): void
    /** Une proposition d'ecriture arrive. Repondre par respondProposal. */
    onProposal(handler: (proposal: NoteProposal) => void): () => void
    respondProposal(proposalId: string, status: NoteProposalStatus, detail?: string): void
    /** La proposition n'attend plus de reponse (tour interrompu). */
    onProposalCancel(handler: (proposalId: string) => void): () => void
    /** Le texte d'une ecriture de notes, pendant qu'elle se compose. */
    onDraft(handler: (draft: NoteDraft) => void): () => void
    /** Le brouillon n'a plus lieu d'etre affiche. */
    onDraftEnd(handler: (end: NoteDraftEnd) => void): () => void
    /**
     * Une reponse recopiee dans la note, avec ses ancres — memes regles que
     * pour un ajout de l'assistant : bloc par bloc, les pages que chaque bloc
     * cite en premier. Rend le Markdown pret a inserer.
     */
    anchorBlocks(courseId: string, content: string): Promise<string>
    /**
     * La place de chaque ancre dans l'ordre du cours, dans le meme ordre —
     * null pour une ancre que le cours ne connait plus ou tant que l'index fin
     * n'est pas charge. C'est ce qui permet au panneau de ranger la note.
     */
    orderKeys(courseId: string, anchors: NoteAnchor[]): Promise<(OrderKey | null)[]>
  }
  quiz: {
    /** Un questionnaire arrive. Repondre par `reply` — le tour attend. */
    onAsk(handler: (form: QuizForm) => void): () => void
    reply(quizId: string, outcome: QuizOutcome): void
    /** Le quiz n'attend plus de reponse (tour interrompu, delai depasse). */
    onCancel(handler: (quizId: string) => void): () => void
  }
  annotations: {
    read(courseId: string): Promise<Annotation[]>
    /**
     * Ecrit la liste entiere. Elle tient dans quelques kilo-octets meme sur un
     * cours copieusement surligne : une ecriture globale evite d'inventer une
     * API de modification pour un fichier qu'on relit de toute facon en entier.
     */
    write(courseId: string, annotations: Annotation[]): Promise<void>
  }
  flashcards: {
    /** Le tableau de bord : stats globales, sets par matiere, generation. */
    overview(): Promise<import('./flashcards').FlashcardsOverview>
    /**
     * La file d'une session de revision, deja ordonnee par la repetition
     * espacee — un set (un cours) ou toute une matiere (plusieurs cours).
     */
    queue(
      courseIds: string[],
      options?: import('./flashcards').ReviewQueueOptions
    ): Promise<import('./flashcards').ReviewQueueItem[]>
    /**
     * Enregistre une reponse et rend la carte mise a jour — si son echeance
     * est toujours passee (« encore »), elle est a remontrer dans la session.
     */
    answer(
      courseId: string,
      cardId: string,
      grade: import('./flashcards').ReviewGrade
    ): Promise<import('./flashcards').Flashcard | null>
    /**
     * Ajoute des cartes ecrites a la main via la feuille de collage — dans le
     * set d'un cours ou le set general d'une matiere (`generalSetId`). Elles
     * entrent dans la repetition espacee, dues immediatement.
     */
    import(
      setId: string,
      cards: { recto: string; verso: string }[]
    ): Promise<{ added: number; total: number }>
    /** Les cartes d'un set, dans l'ordre du fichier — pour l'ecran du deck. */
    cards(setId: string): Promise<import('./flashcards').Flashcard[]>
    /**
     * Supprime une carte — geste definitif, l'historique de repetition part
     * avec elle. Rend faux si elle avait deja disparu.
     */
    removeCard(setId: string, cardId: string): Promise<boolean>
    /**
     * Reecrit le recto et le verso d'une carte ; la repetition espacee et
     * l'historique restent. Rend la carte mise a jour, ou null si elle a
     * disparu ou si une face est vide.
     */
    updateCard(
      setId: string,
      cardId: string,
      faces: { recto: string; verso: string }
    ): Promise<import('./flashcards').Flashcard | null>
    /** Un message au tuteur de la carte en cours de revision. */
    tutorSend(input: TutorSendInput): Promise<void>
    /** Arrete la reponse en cours du tuteur. */
    tutorStop(): Promise<void>
    /** Oublie la conversation du tuteur — a l'ouverture pour une nouvelle carte. */
    tutorReset(): Promise<void>
    /** La reponse du tuteur, au fil de l'eau. Renvoie la fonction de desabonnement. */
    onTutorStream(handler: (event: ChatStreamEvent) => void): () => void
    /**
     * Previent quand une generation en tache de fond vient d'ecrire des
     * cartes ou de changer d'etat. Renvoie la fonction de desabonnement.
     */
    onChanged(handler: () => void): () => void
  }
  ocr: {
    /** Ou en est l'installation du moteur de lecture d'images. */
    modelStatus(): Promise<OcrModelStatus>
    /**
     * Lance l'installation. Rend vrai quand tout est en place — ce qui peut
     * demander des heures sur une liaison lente, la progression arrivant
     * entre-temps par `onModelChanged`.
     */
    install(): Promise<boolean>
    /**
     * Lit une image et rend son Markdown. Rend null quand la lecture n'a pas
     * abouti : a l'appelant de continuer sans, jamais d'echouer.
     *
     * L'image arrive en PNG. C'est le renderer qui la fabrique, parce que c'est
     * lui qui sait dessiner une page de PDF — pdf.js y est chez lui, et ajouter
     * un moteur de rendu cote Node pour refaire le meme travail serait une
     * dependance native de plus pour rien.
     */
    readImage(png: Uint8Array): Promise<OcrRead | null>
    /**
     * Remplace un cours illisible par sa version reconstituee : le Markdown
     * prend sa place dans la bibliotheque, l'original part dans `Originaux/`,
     * et la note comme les surlignages suivent le nouvel identifiant.
     */
    convert(
      courseId: string,
      pages: { page: number; markdown: string }[],
      report?: { missing: number[]; pageCount: number }
    ): Promise<{ courseId: string; document: OcrDocument }>
    /**
     * Complete un cours reconstitue dont des pages manquaient : les pages
     * fournies s'inserent a leur place, et l'en-tete oublie ce qui est lu.
     */
    patch(
      courseId: string,
      pages: { page: number; markdown: string }[]
    ): Promise<{ missing: number[] }>
    /**
     * Une image du dossier media, reduite a la taille que le moteur de lecture
     * accepte. Null quand l'image est introuvable ou trop petite pour porter
     * du texte — une decoration, pas une page.
     */
    mediaPng(name: string): Promise<Uint8Array | null>
    /** Octets de l'original archive, pour l'afficher dans l'onglet « Original ». */
    readOriginal(relative: string): Promise<Uint8Array>
    /**
     * Un original Word archive, converti en HTML comme le fait le panneau de
     * cours — l'onglet « Original » doit montrer le document, pas s'excuser.
     */
    readOriginalDocx(relative: string): Promise<DocxDocument>
    /**
     * Les fichiers d'un original qui est un dossier — le cas d'un cours fait de
     * photos. Rend une liste vide quand l'original est un fichier unique.
     */
    listOriginal(relative: string): Promise<string[]>
    /**
     * Lance la fabrication du cours a partir d'une proposition acceptee. Rend
     * la main aussitot : c'est la ligne d'attente qui rend compte de la suite.
     */
    importPhotos(proposal: PhotoProposal): Promise<void>
    /** Les cours en cours de fabrication a partir de photos. */
    pending(): Promise<PendingConversion[]>
    /** Ecarte une ligne d'attente en echec. */
    dismiss(id: string): Promise<void>
    /** Previent quand la liste des fabrications en cours change. */
    onPendingChanged(handler: () => void): () => void
    /** Previent a chaque changement d'etat de l'installation. */
    onModelChanged(handler: (status: OcrModelStatus) => void): () => void
  }
  media: {
    /**
     * Depose une image dans le dossier media et rend son nom. C'est le meme
     * dossier que celui des images de Word : le nom est l'empreinte du contenu,
     * donc une image deja connue ne s'ecrit pas deux fois.
     */
    keep(bytes: Uint8Array, contentType: string): Promise<string>
  }
  rag: {
    /** Ou en est la vectorisation du cours, ou null s'il n'est pas ouvert. */
    status(courseId: string): Promise<VectorStatus | null>
    /**
     * Previent a chaque changement d'etat. Renvoie la fonction de
     * desabonnement.
     */
    onChanged(handler: (status: VectorStatus) => void): () => void
  }
  claude: {
    status(): Promise<ClaudeStatus>
    /** Modeles proposes dans la barre de chat, declares par Claude Code. */
    models(): Promise<ChatModel[]>
    /** Demarre un tour de conversation. Les deltas arrivent via onStream. */
    /**
     * Une question se prepare : lance le chargement du moteur de vecteurs sans
     * attendre, pour que le premier message trouve un moteur chaud.
     */
    warm(): Promise<void>
    send(input: ChatSendInput): Promise<void>
    interrupt(courseId: string): Promise<void>
    reset(courseId: string): Promise<void>
    onStream(handler: (event: ChatStreamEvent) => void): () => void
    /** Les conversations passees de ce cours, la plus recente d'abord. */
    history(courseId: string): Promise<ChatHistoryEntry[]>
    /** Reprend une conversation choisie dans l'historique ; rend son fil. */
    openSession(courseId: string, sessionId: string): Promise<ChatMessage[]>
    /**
     * A l'ouverture d'un cours dont le fil n'est pas deja en memoire : reprend
     * la derniere conversation si elle existe, ou rend null s'il n'y en a
     * aucune.
     */
    hydrate(courseId: string): Promise<{ sessionId: string; messages: ChatMessage[] } | null>
    /** Compacte la conversation en cours pour ce cours. */
    compact(courseId: string): Promise<CompactOutcome>
  }
  memoire: {
    /** Toutes les entrees de memoire, pour l'ecran de consultation. */
    list(): Promise<MemoryEntry[]>
    /** Supprime une entree depuis l'ecran de consultation. */
    forget(entryId: string): Promise<void>
    /** Annule un geste depuis sa trace. Rend la trace mise a jour, ou null. */
    cancel(traceId: string): Promise<MemoryTrace | null>
    /** Previent qu'une ecriture vient d'avoir lieu, pour afficher sa trace. */
    onTrace(handler: (trace: MemoryTrace) => void): () => void
  }
  reglages: {
    /** Les prompts des agents : leur defaut, leur texte en vigueur. */
    prompts(): Promise<PromptSetting[]>
    /**
     * Remplace le prompt d'un agent, ou le rend a son defaut avec `null`.
     * Rend la liste a jour, pour que l'ecran n'ait pas a la redemander.
     */
    setPrompt(id: PromptId, texte: string | null): Promise<PromptSetting[]>
  }
  fenetre: {
    /**
     * Recentre les feux macOS selon la barre du moment : detachee en pilule
     * sur l'accueil, collee au bord dans l'espace de travail et les matieres.
     */
    feux(flottants: boolean): void
  }
}
