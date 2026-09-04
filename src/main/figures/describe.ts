/**
 * Ce que les images d'un cours disent, demande a Haiku.
 *
 * **Apres la vectorisation, et jamais avant.** Un cours illustre est indexe et
 * interrogeable des la fin des deux rounds ; les descriptions arrivent ensuite,
 * pour ne rien retarder de ce dont chaque reponse depend. Elles n'entrent pas
 * dans les vecteurs — c'est `lire` qui les substitue aux marqueurs quand
 * l'assistant ouvre une page (voir `markers.ts`).
 *
 * **Deux niveaux de detail.** La description dit le type de l'image et ce qu'on
 * y lit : le plus souvent, cela suffit a repondre. Quand un chiffre precis
 * compte, l'assistant ouvre le PNG reduit avec son outil « Read » — d'ou le
 * chemin donne dans chaque marqueur enrichi. Aucun outil dedie : celui du SDK
 * sait deja montrer une image au modele.
 *
 * **Rien de tout cela n'est indispensable.** CLI absent, hors ligne, quota
 * epuise : on abandonne les descriptions pour cette ouverture, on l'ecrit dans
 * la console, et le cours passe au vert comme si de rien n'etait. Un cours dont
 * les images ne sont pas decrites reste un cours parfaitement utilisable.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PromptAnnexe } from '../../shared/types'
import { childEnvironment, resolveExecutable } from '../claude/provider'
import { loadSdk } from '../claude/sdk'
import { mediaPath } from '../media'
import { composePrompt } from '../prompts/store'
import { vaultPaths } from '../vault'
import type { FigureDescription } from './markers'

const run = promisify(execFile)

/**
 * Le modele qui decrit, inscrit dans chaque entree du cache.
 *
 * Ce n'est pas l'alias envoye au SDK mais l'identite de ce qui a produit le
 * texte : le jour ou l'on change de modele ou de consigne, la version monte et
 * les anciennes descriptions se refont d'elles-memes, sans qu'il faille vider
 * un dossier a la main.
 */
const DESCRIBE_MODEL = 'haiku@v1'

/**
 * Taille en deca de laquelle une image ne merite pas d'etre decrite.
 *
 * Un separateur, une puce, un logo d'ecole en pied de page : les decrire
 * couterait un appel chacun pour rendre « illustration decorative ». Quinze
 * kilo-octets laissent passer tout vrai schema — le plus modeste des schemas
 * d'architecture en fait plusieurs centaines.
 */
const DECORATIVE_BYTES = 15_000

/**
 * Plafond du grand cote, en pixels.
 *
 * Les captures d'un cours font couramment 2500 pixels de large. Les envoyer
 * telles quelles ne rendrait pas une meilleure description — le modele les
 * reduit de son cote — mais ferait transiter plusieurs megaoctets par appel.
 */
const MAX_SIDE = 1280

/**
 * Images par appel.
 *
 * Quatre et non une : la consigne de format et le prompt systeme sont relus a
 * chaque appel, et vingt et une images en vingt et un appels les paieraient
 * vingt et une fois. Quatre et non dix : un lot mal formate se rejoue image par
 * image, et l'on ne veut pas repayer dix images pour une seule qui derape.
 */
const BATCH = 4

/**
 * Au-dela, on considere que l'appel ne reviendra pas.
 *
 * Trois minutes et non deux : une figure dense envoyee seule — un schema large,
 * plein de libelles — a depasse les deux minutes et s'est retrouvee sans
 * description, alors que la reponse etait manifestement en train de venir. Le
 * delai n'est pas la pour presser le modele, seulement pour qu'un appel muet ne
 * bloque pas la file indefiniment.
 */
const TIMEOUT = 180_000

function directory(): string {
  return path.join(vaultPaths().internal, 'figures')
}

/** La base du nom d'une image du dossier media — son empreinte, sans extension. */
function baseOf(name: string): string {
  return path.basename(name, path.extname(name))
}

/**
 * La file globale des appels au modele.
 *
 * Un seul CLI a la fois dans tout le processus. Sans cela, ouvrir quatre cours
 * illustres coup sur coup lancerait quatre sous-processus Claude Code en
 * parallele, chacun avec ses images en memoire — pour un travail qui n'est
 * presse en rien, puisque le cours est deja indexe quand il commence.
 */
let queue: Promise<unknown> = Promise.resolve()

function queued<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

// ---------------------------------------------------------------------------
// Le PNG reduit et la description gardee, un fichier chacun
// ---------------------------------------------------------------------------

/**
 * Reduit une image en PNG et rend son chemin, ou null si elle ne se reduit pas.
 *
 * `sips` et non `sharp`, pour la meme raison que partout ailleurs dans cette
 * application : il est livre avec macOS et ouvre des formats qu'aucune
 * bibliotheque JavaScript ne sait lire. Il ne sait pas tout ouvrir pour autant —
 * les EMF et WMF qu'un Word colle parfois le font echouer, et c'est un resultat :
 * ces images-la resteront sans description.
 */
async function reduce(name: string): Promise<string | null> {
  const source = mediaPath(name)
  if (!source) return null

  const target = path.join(directory(), `${baseOf(name)}.png`)

  try {
    await fs.access(target)
    return target
  } catch {
    // Premiere rencontre avec cette image.
  }

  try {
    await fs.mkdir(directory(), { recursive: true })

    // Le plafond porte sur le grand cote, et `sips` ne sait pas le lire tout
    // seul : il faut d'abord lui demander les dimensions. Sans ce detour,
    // `--resampleHeightWidthMax` agrandirait une petite image jusqu'au plafond.
    const { stdout } = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', source])
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0)
    const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1] ?? 0)
    const resize =
      Math.max(width, height) > MAX_SIDE ? ['--resampleHeightWidthMax', String(MAX_SIDE)] : []

    // Ecriture atomique, comme pour les images du dossier media : une fermeture
    // en pleine conversion laisserait sinon un PNG tronque, et il serait relu
    // comme valide pour toujours.
    const temporary = `${target}.tmp`
    await run('/usr/bin/sips', ['-s', 'format', 'png', ...resize, source, '--out', temporary])
    await fs.rename(temporary, target)
    return target
  } catch {
    return null
  }
}

interface Kept {
  model: string
  description: string
}

function keptPath(name: string): string {
  return path.join(directory(), `${baseOf(name)}.json`)
}

/** La description deja obtenue pour cette image, si elle vient du bon modele. */
async function readKept(name: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(keptPath(name), 'utf8')) as Partial<Kept>
    if (parsed.model !== DESCRIBE_MODEL) return null
    return typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description
      : null
  } catch {
    // Absente, illisible, tronquee : l'image sera decrite a nouveau.
    return null
  }
}

/** Garde une description. Un echec d'ecriture coute un appel de plus, jamais un resultat. */
async function keep(name: string, description: string): Promise<void> {
  try {
    const target = keptPath(name)
    const temporary = `${target}.tmp`
    const entry: Kept = { model: DESCRIBE_MODEL, description }
    await fs.writeFile(temporary, JSON.stringify(entry), 'utf8')
    await fs.rename(temporary, target)
  } catch {
    // Sans effet sur ce qui est rendu a l'appelant.
  }
}

// ---------------------------------------------------------------------------
// L'appel
// ---------------------------------------------------------------------------

/** Ce qu'on demande sous les images. Le prompt systeme dit quoi regarder. */
function instruction(count: number): string {
  return `Décris les ${count} image(s) ci-dessus, dans l'ordre où elles arrivent.

Format, sans rien avant ni après :

=== Image 1 ===
la description de la première

=== Image 2 ===
la description de la deuxième`
}

/** Ce que l'ecran Parametres montre sous le prompt du descripteur. */
export function descriptionAnnexes(): PromptAnnexe[] {
  return [
    {
      titre: 'Ajouté dans le message, sous les images',
      texte: instruction(4)
    }
  ]
}

/**
 * Envoie un lot d'images et rend la reponse brute, ou null si le moteur n'a rien
 * rendu — CLI introuvable, delai depasse, abonnement muet.
 */
async function ask(images: Array<{ name: string; file: string }>): Promise<string | null> {
  const sdk = await loadSdk()
  const executable = await resolveExecutable()
  if (!executable) return null

  const content: SDKUserMessage['message']['content'] = []
  for (const [at, image] of images.entries()) {
    content.push({ type: 'text', text: `Image ${at + 1}` })
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: (await fs.readFile(image.file)).toString('base64')
      }
    })
  }
  content.push({ type: 'text', text: instruction(images.length) })

  // Un flux qui rend un message puis se termine : le CLI traite ce tour-la et
  // n'attend pas la suite.
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: ''
    }
  })()

  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), TIMEOUT)

  const options: Options = {
    model: 'haiku',
    systemPrompt: await composePrompt('descripteur'),

    // Rien a faire d'autre que regarder et ecrire. Le descripteur n'a acces ni
    // au vault ni au web : ce qu'il decrit est dans le message.
    tools: [],
    allowedTools: [],
    disallowedTools: [
      'Bash',
      'Write',
      'Edit',
      'NotebookEdit',
      'Read',
      'Grep',
      'Glob',
      'WebSearch',
      'WebFetch',
      'Task'
    ],
    permissionMode: 'bypassPermissions',

    // Comme partout ailleurs : les reglages personnels de l'utilisateur ne
    // doivent pas s'appliquer a Noted.
    settingSources: [],
    maxTurns: 1,
    cwd: vaultPaths().root,
    env: childEnvironment(),
    pathToClaudeCodeExecutable: executable,
    abortController: abort
  }

  const query = sdk.query({ prompt, options })

  try {
    for await (const message of query) {
      if (message.type !== 'result') continue
      return message.subtype === 'success' ? message.result : null
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(deadline)
    try {
      // Sans cela le sous-processus survivrait a l'appel.
      query.close()
    } catch {
      // Deja ferme.
    }
  }
}

/** Les blocs « === Image k === » d'une reponse, dans l'ordre. */
function parseBlocks(text: string): string[] {
  return text
    .split(/=+\s*Image\s*\d+\s*=+/i)
    .slice(1)
    .map((block) => block.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Le tour complet
// ---------------------------------------------------------------------------

/**
 * Decrit les images d'un cours, dans l'ordre de `media`.
 *
 * Rend ce que chaque rang de marqueur doit dire. Un rang absent de la carte est
 * une image decorative, illisible, ou dont la description n'est pas revenue :
 * son marqueur restera nu, ce qui est une reponse acceptable.
 *
 * `report` compte les images retenues, pas les rangs : la meme capture repetee
 * en tete de chaque section ne se decrit qu'une fois, et le compteur a l'ecran
 * ne doit pas annoncer un travail qui n'aura pas lieu.
 */
export async function describeFigures(
  media: readonly string[],
  report: (done: number, total: number) => void
): Promise<Map<number, FigureDescription>> {
  const figures = new Map<number, FigureDescription>()

  // Les images qu'on va decrire, et le PNG reduit de chacune. Ce qui est trop
  // petit pour porter du sens ou trop exotique pour se convertir sort ici, avant
  // toute depense.
  const retained = new Map<string, string>()
  for (const name of new Set(media)) {
    const source = mediaPath(name)
    if (!source) continue

    const size = await fs.stat(source).then((stat) => stat.size, () => 0)
    if (size < DECORATIVE_BYTES) continue

    const reduced = await reduce(name)
    if (reduced) retained.set(name, reduced)
  }

  const total = retained.size
  if (total === 0) {
    report(0, 0)
    return figures
  }

  const said = new Map<string, string>()
  const todo: string[] = []
  for (const name of retained.keys()) {
    const known = await readKept(name)
    if (known) said.set(name, known)
    else todo.push(name)
  }

  // Une deuxieme ouverture du cours ne redecrit rien : tout est en cache, et le
  // compteur part directement au total.
  report(said.size, total)

  for (let at = 0; at < todo.length; at += BATCH) {
    const batch = todo.slice(at, at + BATCH)
    const answered = await describeBatch(batch, retained)

    if (!answered) {
      console.warn(
        `[figures] le modèle n’a pas répondu : ${todo.length - at} image(s) resteront sans description jusqu’à la prochaine ouverture`
      )
      break
    }

    for (const [name, description] of answered) {
      said.set(name, description)
      await keep(name, description)
    }

    report(said.size, total)
  }

  // Le rang du marqueur, et non l'ordre des images retenues : c'est par lui que
  // `withDescriptions` retrouve sa place dans le texte.
  media.forEach((name, at) => {
    const description = said.get(name)
    const file = retained.get(name)
    if (!description || !file) return
    figures.set(at + 1, { description, image: file })
  })

  return figures
}

/**
 * Un lot. Rend ce que chaque image a dit, ou null si le moteur lui-meme n'a pas
 * repondu — auquel cas il ne repondra pas davantage au lot suivant.
 *
 * Un lot dont le compte de blocs ne tombe pas juste se rejoue image par image :
 * le modele a fusionne deux descriptions ou en a oublie une, et rien ne dit
 * laquelle. Les rattacher au petit bonheur reviendrait a decrire un schema
 * d'architecture par ce qu'un tableau de chiffres contient.
 */
async function describeBatch(
  names: string[],
  files: ReadonlyMap<string, string>
): Promise<Map<string, string> | null> {
  const images = names.map((name) => ({ name, file: files.get(name) as string }))
  const text = await queued(() => ask(images))
  if (text === null) return null

  const blocks = parseBlocks(text)
  if (blocks.length === names.length) {
    return new Map(names.map((name, at) => [name, blocks[at] as string]))
  }

  if (names.length === 1) {
    console.warn(`[figures] réponse illisible pour ${names[0]}, image laissée sans description`)
    return new Map()
  }

  console.warn(
    `[figures] ${blocks.length} bloc(s) pour ${names.length} image(s) : le lot est rejoué une par une`
  )

  const one = new Map<string, string>()
  for (const name of names) {
    const alone = await describeBatch([name], files)
    if (!alone) return null
    for (const [key, value] of alone) one.set(key, value)
  }
  return one
}
