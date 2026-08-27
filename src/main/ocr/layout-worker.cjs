/**
 * Detection de la mise en page d'une image, dans un processus Node separe.
 *
 * Meme raison que pour les vecteurs, et elle est ecrite noir sur blanc dans
 * `rag/embed-worker.cjs` : le moteur ONNX charge son modele sans probleme sous
 * Electron, mais son inference ne rend jamais la main — ni dans le processus
 * principal, ni dans un utilityProcess. Sous Node ordinaire, elle s'execute
 * normalement. On delegue donc, ce qui a par ailleurs le merite de sortir un
 * calcul du processus qui sert l'interface.
 *
 * Protocole : une requete JSON par ligne sur l'entree standard, une reponse
 * JSON par ligne sur la sortie standard. Les images circulent en base64 — elles
 * font quelques centaines de kilo-octets, et un tube de texte est ce qui coute
 * le moins de ceremonie entre deux processus.
 */

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')

/** Cote de l'image carree attendue par le modele : il est entraine a 1024. */
const SIDE = 1024

/**
 * Gris de remplissage des bandes de letterbox.
 *
 * 114, et non 0 : c'est la valeur avec laquelle la famille YOLO est entrainee.
 * Du noir franc creerait un contraste que le detecteur n'a jamais vu, et il y
 * lirait volontiers un bord de tableau.
 */
const PAD = 114

/**
 * Confiance minimale d'une region.
 *
 * 0,25 est le seuil du code d'inference publie avec le modele. On ne le
 * resserre pas : une region manquee est du texte perdu pour le cours, alors
 * qu'une region en trop ne coute qu'une lecture de quelques secondes.
 */
const SCORE = 0.25

let session = null
let labels = null

async function load(modelPath) {
  if (session) return session

  const ort = require('onnxruntime-node')

  session = await ort.InferenceSession.create(modelPath, {
    // Un seul fil : ce detecteur passe en quelques centaines de millisecondes,
    // et il tourne pendant que l'utilisateur travaille. Lui donner tous les
    // coeurs ne ferait gagner que des miettes, au prix de l'interface.
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all'
  })

  labels = readLabels(modelPath)

  return session
}

/**
 * La table des classes, telle qu'elle est ecrite dans le fichier du modele.
 *
 * `onnxruntime-node` n'expose pas les metadonnees — verifie : la session ne
 * porte qu'un `handler`. Mais la chaine y est, en clair, dans les cent
 * soixante-quatorze derniers octets, en syntaxe Python :
 * « {0: 'title', 1: 'plain text', ...} ». On lit donc la queue du fichier.
 *
 * La lire plutot que la recopier n'est pas un raffinement : une reexportation
 * du modele qui changerait l'ordre des classes rendrait une table figee
 * silencieusement fausse, et tous les tableaux du cours partiraient dans la
 * tache « texte » sans que rien ne le signale. La table de secours ci-dessous
 * ne sert que si la chaine devenait introuvable.
 */
const FALLBACK_LABELS = {
  0: 'title',
  1: 'plain text',
  2: 'abandon',
  3: 'figure',
  4: 'figure_caption',
  5: 'table',
  6: 'table_caption',
  7: 'table_footnote',
  8: 'isolate_formula',
  9: 'formula_caption'
}

function readLabels(modelPath) {
  try {
    const size = fs.statSync(modelPath).size
    const span = Math.min(size, 256 * 1024)
    const buffer = Buffer.alloc(span)

    const handle = fs.openSync(modelPath, 'r')
    try {
      fs.readSync(handle, buffer, 0, span, size - span)
    } finally {
      fs.closeSync(handle)
    }

    const found = {}
    // Volontairement etroit : on n'accepte que des paires « nombre: 'texte' »,
    // ce qui exclut d'evaluer quoi que ce soit venant du fichier.
    for (const match of buffer.toString('latin1').matchAll(/(\d+)\s*:\s*'([^']{1,40})'/g)) {
      found[Number(match[1])] = match[2]
    }

    return Object.keys(found).length >= 2 ? found : FALLBACK_LABELS
  } catch {
    return FALLBACK_LABELS
  }
}

/**
 * Prepare l'image : mise a l'echelle a proportions gardees, bandes grises,
 * canaux dans l'ordre BGR, valeurs ramenees entre 0 et 1.
 *
 * L'ordre BGR n'est pas une coquetterie : le code d'inference publie avec le
 * modele convertit explicitement en BGR avant de normaliser, et intervertir
 * deux canaux suffit a deplacer les boites.
 */
async function prepare(png) {
  const sharp = require('sharp')

  const image = sharp(png, { failOn: 'none' })
  const meta = await image.metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (width <= 0 || height <= 0) throw new Error('Image sans dimensions.')

  const scale = Math.min(SIDE / width, SIDE / height)
  const drawnWidth = Math.max(1, Math.round(width * scale))
  const drawnHeight = Math.max(1, Math.round(height * scale))

  // Les bandes sont posees en haut-gauche : le decalage est donc nul, et
  // defaire la transformation ne demande qu'une division. `position: left top`
  // evite d'avoir a tenir compte d'un centrage au retour.
  const { data } = await image
    .resize(drawnWidth, drawnHeight, { fit: 'fill' })
    .extend({
      top: 0,
      left: 0,
      bottom: SIDE - drawnHeight,
      right: SIDE - drawnWidth,
      background: { r: PAD, g: PAD, b: PAD }
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = SIDE * SIDE
  const tensor = new Float32Array(3 * pixels)

  for (let i = 0; i < pixels; i += 1) {
    const r = data[i * 3] / 255
    const g = data[i * 3 + 1] / 255
    const b = data[i * 3 + 2] / 255

    // Plan par plan (CHW), et BGR : bleu d'abord, rouge en dernier.
    tensor[i] = b
    tensor[pixels + i] = g
    tensor[2 * pixels + i] = r
  }

  return { tensor, scale, width, height }
}

/**
 * Lit le tenseur de sortie et rend les regions, dans les coordonnees de l'image
 * d'origine.
 *
 * La sortie est un tableau de detections de six valeurs : quatre pour la boite
 * en xyxy, la confiance, puis l'indice de classe. Le modele est de la famille
 * YOLOv10, qui rend des detections deja depouillees — il n'y a pas de
 * suppression des doublons a refaire ici.
 */
function decode(output, scale, width, height) {
  const data = output.data
  const dims = output.dims
  const count = dims.length === 3 ? dims[1] : 0
  const stride = dims.length === 3 ? dims[2] : 0
  if (count === 0 || stride < 6) return []

  const regions = []

  for (let i = 0; i < count; i += 1) {
    const at = i * stride
    const score = data[at + 4]
    if (!(score > SCORE)) continue

    // Retour aux pixels d'origine : les bandes etant en bas et a droite, il n'y
    // a rien a soustraire avant de diviser.
    const x1 = data[at] / scale
    const y1 = data[at + 1] / scale
    const x2 = data[at + 2] / scale
    const y2 = data[at + 3] / scale

    const left = Math.max(0, Math.min(width, Math.min(x1, x2)))
    const top = Math.max(0, Math.min(height, Math.min(y1, y2)))
    const right = Math.max(0, Math.min(width, Math.max(x1, x2)))
    const bottom = Math.max(0, Math.min(height, Math.max(y1, y2)))

    if (right - left < 2 || bottom - top < 2) continue

    const id = Math.round(data[at + stride - 1])

    regions.push({
      label: labels?.[id] ?? String(id),
      score,
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(right - left),
      height: Math.round(bottom - top)
    })
  }

  return regions
}

async function detect(modelPath, pngBase64) {
  const ort = require('onnxruntime-node')
  const active = await load(modelPath)

  const png = Buffer.from(pngBase64, 'base64')
  const { tensor, scale, width, height } = await prepare(png)

  const input = new ort.Tensor('float32', tensor, [1, 3, SIDE, SIDE])
  const name = active.inputNames[0]
  const outputs = await active.run({ [name]: input })
  const first = outputs[active.outputNames[0]]

  return { width, height, regions: decode(first, scale, width, height) }
}

// ---------------------------------------------------------------------------

const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  const id = request?.id
  if (typeof id !== 'number') return

  if (request.kind === 'ping') {
    say({ id, ok: true })
    return
  }

  const modelPath = String(request.model ?? '')
  if (!modelPath || !path.isAbsolute(modelPath)) {
    say({ id, error: 'Chemin de modele invalide.' })
    return
  }

  detect(modelPath, String(request.png ?? ''))
    .then((result) => say({ id, ...result }))
    .catch((cause) => say({ id, error: cause instanceof Error ? cause.message : String(cause) }))
})
