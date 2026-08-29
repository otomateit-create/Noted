/**
 * Le vault est le dossier ou vivent les cours, les notes et la memoire de l'IA.
 * Tout y est en texte brut ou en fichier d'origine : rien n'est enferme dans un
 * format proprietaire, et le dossier s'ouvre tel quel dans Obsidian.
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Course, CourseFormat, Subject, VaultPaths } from '../shared/types'

/**
 * Le dossier de code du projet s'appelle deja Noted/, donc les donnees vont
 * dans Documents/ : visible dans le Finder, et aucune collision avec les
 * sources de l'application.
 */
const VAULT_ROOT = path.join(os.homedir(), 'Documents', 'Noted')

/**
 * Matieres proposees au tout premier lancement, a titre d'exemple uniquement.
 * Elles ne sont ecrites nulle part ailleurs : l'application ne connait que les
 * dossiers reellement presents sous Cours/. Renommer, supprimer ou ajouter une
 * matiere se fait librement, depuis l'application ou depuis le Finder.
 */
const EXAMPLE_SUBJECTS = [
  'Private Equity',
  'Corporate Finance',
  'Investment Banking',
  'IA'
]

const COURSE_EXTENSIONS: Record<string, CourseFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.md': 'markdown',
  '.markdown': 'markdown',
  // Un cours ecrit en HTML — typiquement un artefact demande a Claude Desktop,
  // qui n'est rien d'autre qu'une page HTML autonome.
  '.html': 'html',
  '.htm': 'html'
}

export function vaultPaths(): VaultPaths {
  return {
    root: VAULT_ROOT,
    courses: path.join(VAULT_ROOT, 'Cours'),
    notes: path.join(VAULT_ROOT, 'Notes'),
    memory: path.join(VAULT_ROOT, 'Memoire'),
    annotations: path.join(VAULT_ROOT, 'Annotations'),
    flashcards: path.join(VAULT_ROOT, 'Flashcards'),
    prompts: path.join(VAULT_ROOT, 'Prompts'),
    originals: path.join(VAULT_ROOT, 'Originaux'),
    internal: path.join(VAULT_ROOT, '.noted')
  }
}

const README = `# Noted

Ce dossier contient tes cours, tes notes et la mémoire de l'IA.
Tout est en texte brut : tu peux l'ouvrir dans Obsidian, le sauvegarder,
le versionner, ou le lire dans n'importe quel éditeur.

    Cours/        les documents source (PDF, DOCX, PPTX, Markdown, HTML), par matière
    Notes/        tes notes, un fichier .md par cours, même arborescence
    Annotations/  tes surlignages, un fichier .json par cours, même arborescence
    Flashcards/   tes cartes de révision, un fichier .json par cours
    Prompts/      les consignes des trois agents IA, un .md chacun — ce sont
                  ces fichiers qui tournent, modifiables ici ou depuis l'écran
                  Paramètres de l'application
    Memoire/      ce que l'IA retient de toi et de chaque matière
    Originaux/    les documents scannés et les photos que Noted a reconstitués
                  en texte — l'original n'est jamais supprimé
    .noted/       cache technique de l'application — sans intérêt à la lecture

Pour ajouter un cours : dépose le fichier dans Cours/<Matière>/, ou utilise
le bouton d'import de l'application.
`

/**
 * Le global.md d'une installation neuve : une entree d'exemple, au format que
 * les outils de memoire ecrivent — un marqueur invisible portant identifiant
 * et date, un titre, quelques lignes. Genere plutot que fige : l'identifiant
 * doit etre unique et la date vraie.
 */
function globalMemoryTemplate(): string {
  const id = `m-${randomBytes(4).toString('hex')}`
  const date = new Date().toISOString().slice(0, 10)

  return `---
type: memoire
niveau: global
---

# Mémoire globale

Ce que l'IA retient de toi, toutes matières confondues. Une entrée par fait,
datée, retrouvée par recherche. Ce fichier s'édite librement — garde
simplement la ligne de marqueur au-dessus de chaque entrée.

<!-- entree:${id} ${date} -->
## Profil

- Étudiant à HEC Paris.
`
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Cree l'arborescence si elle n'existe pas. Idempotent : appele a chaque
 * demarrage, il ne touche a rien si tout est deja en place.
 */
export async function ensureVault(): Promise<VaultPaths> {
  const paths = vaultPaths()

  // L'absence de Cours/ signale le tout premier lancement. C'est le seul
  // moment ou l'application cree des matieres : ensuite la liste appartient a
  // l'utilisateur, et une matiere supprimee ne doit pas reapparaitre au
  // demarrage suivant.
  const firstLaunch = !(await exists(paths.courses))

  await fs.mkdir(paths.courses, { recursive: true })
  await fs.mkdir(paths.notes, { recursive: true })
  await fs.mkdir(paths.memory, { recursive: true })
  await fs.mkdir(paths.annotations, { recursive: true })
  await fs.mkdir(paths.flashcards, { recursive: true })
  // Les fichiers eux-memes sont ecrits par prompts/store.ts, appele juste
  // apres : le vault ne connait pas les agents, il ne fait que la place.
  await fs.mkdir(paths.prompts, { recursive: true })

  if (firstLaunch) {
    for (const subject of EXAMPLE_SUBJECTS) {
      await fs.mkdir(path.join(paths.courses, subject), { recursive: true })
    }
  }

  const readmePath = path.join(paths.root, 'README.md')
  if (!(await exists(readmePath))) {
    await fs.writeFile(readmePath, README, 'utf8')
  }

  const globalMemoryPath = path.join(paths.memory, 'global.md')
  if (!(await exists(globalMemoryPath))) {
    await fs.writeFile(globalMemoryPath, globalMemoryTemplate(), 'utf8')
  }

  return paths
}

/**
 * L'identifiant d'un cours est son chemin relatif sous Cours/, en separateurs
 * POSIX. Lisible dans les logs, stable entre deux lancements, et directement
 * reutilisable comme wikilink Obsidian.
 */
function toCourseId(absolutePath: string): string {
  return path
    .relative(vaultPaths().courses, absolutePath)
    .split(path.sep)
    .join('/')
}

/**
 * Resout un identifiant recu du renderer vers un chemin absolu, en refusant
 * tout ce qui sortirait du vault. Le renderer est du code que nous ecrivons,
 * mais un identifiant peut venir d'un fichier cache corrompu ou d'une note
 * editee a la main : la verification n'est pas optionnelle.
 */
export function resolveCoursePath(courseId: string): string {
  const coursesRoot = vaultPaths().courses
  const resolved = path.resolve(coursesRoot, courseId)
  const relative = path.relative(coursesRoot, resolved)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Identifiant de cours hors du vault : ${courseId}`)
  }
  return resolved
}

/** Chemin de la note associee a un cours : meme arborescence, sous Notes/. */
export function resolveNotePath(courseId: string): string {
  const withoutExtension = courseId.replace(/\.[^./]+$/, '')
  const notesRoot = vaultPaths().notes
  const resolved = path.resolve(notesRoot, `${withoutExtension}.md`)
  const relative = path.relative(notesRoot, resolved)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Identifiant de cours hors du vault : ${courseId}`)
  }
  return resolved
}

/**
 * Copie de la note telle qu'elle etait avant la derniere ecriture de
 * l'assistant. Dans `.noted/` et non dans le vault visible : c'est un filet
 * de securite pour revenir en arriere, pas une donnee de travail — la note
 * courante, elle, reste toujours sous Notes/.
 */
export function resolveNoteVersionPath(courseId: string): string {
  const withoutExtension = courseId.replace(/\.[^./]+$/, '')
  const versionsRoot = path.join(vaultPaths().internal, 'versions')
  const resolved = path.resolve(versionsRoot, `${withoutExtension}.md`)
  const relative = path.relative(versionsRoot, resolved)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Identifiant de cours hors du vault : ${courseId}`)
  }
  return resolved
}

/** Chemin des surlignages d'un cours : meme arborescence, sous Annotations/. */
export function resolveAnnotationsPath(courseId: string): string {
  const withoutExtension = courseId.replace(/\.[^./]+$/, '')
  const annotationsRoot = vaultPaths().annotations
  const resolved = path.resolve(annotationsRoot, `${withoutExtension}.json`)
  const relative = path.relative(annotationsRoot, resolved)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Identifiant de cours hors du vault : ${courseId}`)
  }
  return resolved
}

/**
 * Verifie qu'un chemin resolu reste sous sa racine.
 *
 * Le renderer est du code que nous ecrivons, mais un nom de cours ou de matiere
 * vient de l'utilisateur : « ../../.ssh » est un nom de dossier parfaitement
 * valide tant qu'on ne le regarde pas.
 */
function assertInside(root: string, target: string, label: string): string {
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} hors du vault`)
  }
  return target
}

/**
 * Nettoie un nom saisi par l'utilisateur, qui va devenir un nom de fichier ou
 * de dossier. On refuse plutot que de corriger en silence : voir son cours
 * renomme autrement qu'on ne l'a tape est plus deroutant qu'un refus.
 */
export function cleanName(raw: unknown, what: string): string {
  if (typeof raw !== 'string') throw new Error(`Nom ${what} invalide`)

  const clean = raw.trim().replace(/\s+/g, ' ')

  if (!clean) throw new Error(`Donne un nom ${what}.`)
  if (clean.length > 80) throw new Error('Ce nom est trop long (80 caractères au maximum).')
  if (clean.startsWith('.')) throw new Error('Un nom ne peut pas commencer par un point.')
  if (/[/\\:]/.test(clean)) {
    throw new Error('Un nom ne peut pas contenir « / », « \\ » ni « : ».')
  }
  return clean
}

/** Dossier d'une matiere sous Cours/. */
export function resolveSubjectPath(name: string): string {
  const coursesRoot = vaultPaths().courses
  const target = path.resolve(coursesRoot, name)

  assertInside(coursesRoot, target, 'Matière')
  // Une matiere est un enfant direct de Cours/, jamais un sous-dossier.
  if (path.dirname(target) !== coursesRoot) throw new Error(`Nom de matière invalide : ${name}`)
  return target
}

/** Dossier de notes d'une matiere, meme arborescence que sous Cours/. */
export function resolveSubjectNotesPath(name: string): string {
  const notesRoot = vaultPaths().notes
  const target = path.resolve(notesRoot, name)

  assertInside(notesRoot, target, 'Matière')
  if (path.dirname(target) !== notesRoot) throw new Error(`Nom de matière invalide : ${name}`)
  return target
}

/** Dossier de surlignages d'une matiere, meme arborescence que sous Cours/. */
export function resolveSubjectAnnotationsPath(name: string): string {
  const annotationsRoot = vaultPaths().annotations
  const target = path.resolve(annotationsRoot, name)

  assertInside(annotationsRoot, target, 'Matière')
  if (path.dirname(target) !== annotationsRoot) throw new Error(`Nom de matière invalide : ${name}`)
  return target
}

/** Chemin du set de flashcards d'un cours : meme arborescence, sous Flashcards/. */
export function resolveFlashcardsPath(courseId: string): string {
  const withoutExtension = courseId.replace(/\.[^./]+$/, '')
  const flashcardsRoot = vaultPaths().flashcards
  const resolved = path.resolve(flashcardsRoot, `${withoutExtension}.json`)
  const relative = path.relative(flashcardsRoot, resolved)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Identifiant de cours hors du vault : ${courseId}`)
  }
  return resolved
}

/** Dossier de flashcards d'une matiere, meme arborescence que sous Cours/. */
export function resolveSubjectFlashcardsPath(name: string): string {
  const flashcardsRoot = vaultPaths().flashcards
  const target = path.resolve(flashcardsRoot, name)

  assertInside(flashcardsRoot, target, 'Matière')
  if (path.dirname(target) !== flashcardsRoot) throw new Error(`Nom de matière invalide : ${name}`)
  return target
}

/** Titre lisible : nom de fichier sans extension, tirets et underscores adoucis. */
function toTitle(fileName: string): string {
  return fileName
    .replace(/\.[^./]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function readCourse(absolutePath: string, subject: string): Promise<Course | null> {
  const format = COURSE_EXTENSIONS[path.extname(absolutePath).toLowerCase()]
  if (!format) return null

  const stats = await fs.stat(absolutePath)
  const id = toCourseId(absolutePath)

  return {
    id,
    title: toTitle(path.basename(absolutePath)),
    subject,
    format,
    path: absolutePath,
    notePath: resolveNotePath(id),
    sizeBytes: stats.size,
    modifiedAt: stats.mtimeMs,
    // APFS date les naissances de fichier ; d'autres systemes rendent zero.
    // La date de modification prend alors le relais : elle vaut mieux qu'un
    // 1er janvier 1970 qui renverrait tous les cours en fin de liste.
    createdAt: stats.birthtimeMs || stats.mtimeMs
  }
}

/**
 * Noms des matieres presentes, sans parcourir les fichiers. Une matiere est un
 * dossier direct sous Cours/ — rien de plus. Aucune liste n'est tenue ailleurs :
 * le disque fait foi, et c'est ce qui permet d'en ajouter ou d'en retirer
 * depuis le Finder pendant que l'application tourne.
 */
export async function listSubjectNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(vaultPaths().courses, { withFileTypes: true })

    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'fr'))
  } catch {
    // Cours/ peut avoir ete mis a la corbeille depuis le Finder pendant que
    // l'application tourne. Un dossier absent ne contient aucune matiere :
    // c'est une reponse juste, pas une erreur a faire remonter jusqu'a l'ecran.
    return []
  }
}

/** Le contenu d'une matiere, sous-dossiers compris. */
function listFiles(subjectRoot: string) {
  return fs.readdir(subjectRoot, { recursive: true, withFileTypes: true })
}

/**
 * Liste les matieres et leurs cours. Les sous-dossiers d'une matiere sont
 * parcourus aussi, ce qui laisse la liberte de classer par seance ou par theme.
 */
export async function listSubjects(): Promise<Subject[]> {
  const coursesRoot = vaultPaths().courses
  const names = await listSubjectNames()
  const subjects: Subject[] = []

  for (const name of names) {
    const subjectRoot = path.join(coursesRoot, name)
    const courses: Course[] = []

    // La matiere a pu disparaitre entre le moment ou on a lu la liste et celui
    // ou on l'ouvre : une suppression depuis le Finder n'attend pas notre tour
    // de boucle. On la passe alors, plutot que d'interrompre tout l'inventaire
    // pour un dossier de moins.
    let files: Awaited<ReturnType<typeof listFiles>>
    try {
      files = await listFiles(subjectRoot)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.isFile() || file.name.startsWith('.')) continue
      const absolutePath = path.join(file.parentPath ?? subjectRoot, file.name)
      const course = await readCourse(absolutePath, name)
      if (course) courses.push(course)
    }

    courses.sort((a, b) => a.title.localeCompare(b.title, 'fr'))
    subjects.push({ name, courses })
  }

  return subjects
}

/**
 * Cree une matiere, c'est-a-dire un dossier sous Cours/. Le nom vient de
 * l'utilisateur et devient un nom de dossier : on refuse tout ce qui en ferait
 * autre chose qu'un enfant direct de Cours/.
 */
export async function createSubject(name: string): Promise<string> {
  const clean = cleanName(name, 'à la matière')
  const target = resolveSubjectPath(clean)

  if (await exists(target)) {
    throw new Error(`La matière « ${clean} » existe déjà.`)
  }

  await fs.mkdir(target)
  return clean
}

/**
 * Retrouve un cours a partir de son identifiant. Leve si le fichier a disparu
 * du disque entre-temps — ce qui arrive si l'utilisateur reorganise son vault
 * dans le Finder pendant que l'application tourne.
 */
export async function findCourse(courseId: string): Promise<Course> {
  const absolutePath = resolveCoursePath(courseId)
  const subject = courseId.split('/')[0] ?? ''
  const course = await readCourse(absolutePath, subject)

  if (!course) {
    throw new Error(`Ce format de fichier n'est pas pris en charge : ${courseId}`)
  }
  return course
}

/** Lit le document source en octets — utilise pour le rendu PDF cote renderer. */
export async function readCourseBytes(courseId: string): Promise<Uint8Array> {
  const buffer = await fs.readFile(resolveCoursePath(courseId))
  return new Uint8Array(buffer)
}

/** Copie un fichier dans une matiere du vault. Renvoie le nouvel identifiant. */
export async function importCourseFile(sourcePath: string, subject: string): Promise<string> {
  const destinationDir = path.join(vaultPaths().courses, subject)
  await fs.mkdir(destinationDir, { recursive: true })

  const fileName = path.basename(sourcePath)
  const destination = path.join(destinationDir, fileName)

  // Deux cours de meme nom sous deux extensions — « LBO.md » et « LBO.html » —
  // partageraient la meme note, les memes surlignages, les memes cartes et la
  // meme memoire : tous ces chemins derivent du nom sans extension. Plutot que
  // de laisser deux documents ecrire au meme endroit sans que rien ne le dise,
  // on refuse le second et on explique.
  const stem = fileName.replace(/\.[^./]+$/, '').toLowerCase()
  for (const existing of await fs.readdir(destinationDir)) {
    if (existing === fileName) continue
    if (existing.replace(/\.[^./]+$/, '').toLowerCase() !== stem) continue
    if (!COURSE_EXTENSIONS[path.extname(existing).toLowerCase()]) continue
    throw new Error(
      `« ${existing} » existe déjà dans ${subject} : deux cours de même nom partageraient la même note. Renomme l'un des deux.`
    )
  }
  await fs.copyFile(sourcePath, destination)
  return toCourseId(destination)
}
