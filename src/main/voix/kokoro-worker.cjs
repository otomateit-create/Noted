/**
 * La voix de l'assistant : Kokoro, un modele de synthese de 82 millions de
 * parametres, dans un processus Node separe.
 *
 * Pourquoi un processus a part, et un vrai Node plutot qu'Electron : c'est la
 * meme raison que pour le moteur de vecteurs (voir rag/embed-worker.cjs) —
 * l'inference ONNX ne rend jamais la main sous Electron. Le processus a par
 * ailleurs le merite de pouvoir etre tue : ses quelque cinq cents megaoctets
 * repartent d'un coup des que la voix se tait pour de bon.
 *
 * Ce qu'il fait, texte par texte :
 *
 *   1. il decoupe la phrase en passages francais et anglais ;
 *   2. il demande a espeak-ng les phonemes de chacun, dans sa langue ;
 *   3. il donne la suite de phonemes au modele, avec le timbre choisi ;
 *   4. il en recoit une onde et, surtout, la duree de chaque phoneme ;
 *   5. il en deduit l'instant de chaque mot du texte, et ecrit un fichier.
 *
 * Le point 4 est la raison du modele « timestamped » plutot que l'ordinaire :
 * sans ces durees, on saurait faire parler l'assistant mais plus savoir quel
 * mot il prononce — et la coupure ne saurait plus ce qui a ete entendu.
 *
 * Protocole : une requete JSON par ligne sur l'entree, une reponse par ligne
 * sur la sortie.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

const MODELE = process.env.NOTED_KOKORO_MODELE || 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped'
const DTYPE = process.env.NOTED_KOKORO_DTYPE || 'q8'
/** Ou vivent les poids et les timbres, a cote du modele de vecteurs. */
const MODELES = path.join(os.homedir(), 'Documents', 'Noted', '.noted', 'modeles')
/** Les timbres se telechargent un par un, depuis le depot d'origine. */
const DEPOT_TIMBRES = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices'

/** Le modele rend ses durees en pas de 600 echantillons a 24 kHz, soit 25 ms. */
const PAS_MS = (600 / 24000) * 1000
const TAUX = 24000

/**
 * Les mots anglais qu'espeak, laisse a lui-meme, lit en francais.
 *
 * Il bascule tout seul sur l'anglais pour « goodwill », « cash flow » ou
 * « deal » — mais pas pour « income », qu'il rend « ɛ̃kɔm », ni pour
 * « buyout » ou « put ». La liste ne dit pas comment prononcer : elle dit
 * seulement « ces mots-la sont anglais », et espeak fait le reste. Elle vient
 * des termes releves dans les cours, les notes et les flashcards du vault.
 */
const ANGLAIS = [
  'free cash flow', 'cash flow', 'net income', 'income', 'earnings', 'goodwill', 'turnover',
  'working capital', 'break-even', 'forecast', 'capex', 'opex',
  'private equity', 'sweet equity', 'equity', 'leveraged buyout', 'leveraged', 'buyout', 'debt',
  'leverage', 'high yield', 'yield', 'spread', 'junk bond', 'investment grade', 'distressed',
  'turnaround', 'earn-out', 'clawback', 'ratchet', 'escrow', 'hurdle', 'bridge',
  'investment banking', 'asset management', 'asset', 'hedge fund', 'due diligence', 'deal',
  'pitch deck', 'pitch', 'track record', 'dry powder', 'carve-out', 'spin-off', 'bolt-on',
  'add-on', 'closing', 'sourcing', 'screening', 'term sheet', 'roadshow', 'bookbuilding',
  'underwriting', 'lock-up', 'carried interest', 'waterfall', 'burn rate', 'runway',
  'benchmark', 'trading', 'prime broker', 'broker', 'dealer', 'market maker', 'market share',
  'market', 'shareholder', 'stakeholder', 'hedging', 'swap', 'forward', 'futures', 'strike',
  'underlying', 'drawdown', 'tracking error', 'blue chip', 'small cap', 'mid cap', 'large cap',
  'long short', 'clearing', 'settlement', 'custody', 'growth', 'business plan', 'business',
  'dashboard', 'reporting', 'call', 'put',
  'blockchain', 'smart contract', 'proof of work', 'proof of stake', 'token', 'wallet',
  'staking', 'mining',
  'machine learning', 'deep learning', 'embeddings', 'embedding', 'fine-tuning', 'overfitting',
  'training', 'dataset', 'backpropagation'
]

// Du plus long au plus court : « free cash flow » doit l'emporter sur « cash flow ».
const MOTIF_ANGLAIS = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${ANGLAIS.slice()
    .sort((a, b) => b.length - a.length)
    .map((terme) => terme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?![\\p{L}\\p{N}])`,
  'giu'
)

function repondre(objet) {
  process.stdout.write(`${JSON.stringify(objet)}\n`)
}

// ---------------------------------------------------------------------------
// Les phonemes
// ---------------------------------------------------------------------------

let ESpeakNg = null

/**
 * Les phonemes d'un passage, dans la langue demandee.
 *
 * Le texte passe par un fichier du systeme de fichiers virtuel et non par la
 * ligne de commande : les arguments d'espeak compile en wasm ne survivent pas
 * a l'UTF-8, et « é » y devenait « copyright ». L'option `-b=1` du mode
 * d'emploi du paquet a le meme effet et doit rester absente.
 */
async function phonemiser(texte, langue) {
  if (!ESpeakNg) ESpeakNg = (await import('espeak-ng')).default
  const espeak = await ESpeakNg({
    arguments: ['--phonout', 'sortie', '-q', '--ipa=3', '-v', langue, '-f', 'entree'],
    preRun: [(module) => module.FS.writeFile('entree', new TextEncoder().encode(texte))]
  })
  return espeak.FS.readFile('sortie', { encoding: 'utf8' })
    // espeak signale ses propres bascules de langue par « (en) … (fr) »,
    // liants invisibles compris. Elles ne se prononcent pas.
    .replace(/‍/g, '')
    .replace(/\((?:en|fr)\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Le texte coupe en passages, chacun avec sa langue. */
function passages(texte) {
  const morceaux = []
  let curseur = 0
  for (const trouvaille of texte.matchAll(MOTIF_ANGLAIS)) {
    if (trouvaille.index > curseur) {
      morceaux.push({ langue: 'fr-fr', texte: texte.slice(curseur, trouvaille.index), debut: curseur })
    }
    morceaux.push({ langue: 'en-us', texte: trouvaille[0], debut: trouvaille.index })
    curseur = trouvaille.index + trouvaille[0].length
  }
  if (curseur < texte.length) morceaux.push({ langue: 'fr-fr', texte: texte.slice(curseur), debut: curseur })
  return morceaux.filter((morceau) => morceau.texte.trim())
}

/**
 * Les phonemes de toute la phrase, et le lien entre les mots du texte et les
 * groupes de phonemes — c'est ce lien qui permettra, une fois les durees
 * connues, de dire quel mot se prononce a quel instant.
 */
async function preparer(texte) {
  const groupes = []
  const mots = []
  for (const passage of passages(texte)) {
    const phonemes = await phonemiser(passage.texte, passage.langue)
    if (!phonemes) continue
    const groupesPassage = phonemes.split(' ').filter(Boolean)
    const motsPassage = []
    for (const trouvaille of passage.texte.matchAll(/\S+/g)) {
      motsPassage.push({ position: passage.debut + trouvaille.index, longueur: trouvaille[0].length })
    }
    const base = groupes.length
    groupes.push(...groupesPassage)
    // Espeak rend un groupe par mot ecrit. Quand les comptes different — une
    // ponctuation isolee, une abreviation eclatee —, on repartit les mots sur
    // les groupes au prorata plutot que de renoncer au reperage.
    for (let i = 0; i < motsPassage.length; i += 1) {
      const part = groupesPassage.length === motsPassage.length
        ? i
        : Math.floor((i * groupesPassage.length) / Math.max(motsPassage.length, 1))
      mots.push({ ...motsPassage[i], groupe: base + Math.min(part, groupesPassage.length - 1) })
    }
  }
  return { phonemes: groupes.join(' '), groupes, mots }
}

// ---------------------------------------------------------------------------
// Le modele
// ---------------------------------------------------------------------------

let modele = null
let tokeniseur = null
const timbres = new Map()

async function charger() {
  if (modele && tokeniseur) return
  const { env, AutoTokenizer, StyleTextToSpeech2Model } = await import('@huggingface/transformers')
  env.cacheDir = MODELES
  const [t, m] = await Promise.all([
    AutoTokenizer.from_pretrained(MODELE),
    StyleTextToSpeech2Model.from_pretrained(MODELE, { dtype: DTYPE, device: 'cpu' })
  ])
  tokeniseur = t
  modele = m
}

/** Le vecteur de timbre d'une voix : 510 longueurs de phrase, 256 nombres chacune. */
async function timbre(nom) {
  if (timbres.has(nom)) return timbres.get(nom)
  const fichier = path.join(MODELES, 'kokoro-voix', `${nom}.bin`)
  if (!fs.existsSync(fichier)) {
    fs.mkdirSync(path.dirname(fichier), { recursive: true })
    const reponse = await fetch(`${DEPOT_TIMBRES}/${nom}.bin`)
    if (!reponse.ok) throw new Error(`timbre « ${nom} » introuvable (${reponse.status})`)
    fs.writeFileSync(fichier, Buffer.from(await reponse.arrayBuffer()))
  }
  const brut = fs.readFileSync(fichier)
  const vecteurs = new Float32Array(brut.buffer, brut.byteOffset, brut.byteLength / 4)
  timbres.set(nom, vecteurs)
  return vecteurs
}

function ecrireWav(chemin, onde) {
  const n = onde.length
  const tampon = Buffer.alloc(44 + n * 2)
  tampon.write('RIFF', 0)
  tampon.writeUInt32LE(36 + n * 2, 4)
  tampon.write('WAVE', 8)
  tampon.write('fmt ', 12)
  tampon.writeUInt32LE(16, 16)
  tampon.writeUInt16LE(1, 20)
  tampon.writeUInt16LE(1, 22)
  tampon.writeUInt32LE(TAUX, 24)
  tampon.writeUInt32LE(TAUX * 2, 28)
  tampon.writeUInt16LE(2, 32)
  tampon.writeUInt16LE(16, 34)
  tampon.write('data', 36)
  tampon.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i += 1) {
    const valeur = Math.max(-1, Math.min(1, onde[i]))
    tampon.writeInt16LE(Math.round(valeur * 32767), 44 + i * 2)
  }
  fs.writeFileSync(chemin, tampon)
}

/**
 * Combien d'echantillons de silence ouvrent l'onde. On laisse vingt
 * millisecondes de marge : couper au ras de la premiere vibration mange
 * l'attaque de la consonne.
 */
function silenceInitial(onde) {
  const marge = Math.round(TAUX * 0.02)
  for (let i = 0; i < onde.length; i += 1) {
    if (Math.abs(onde[i]) > 0.005) return Math.max(0, i - marge)
  }
  return 0
}

async function dire({ id, texte, voix, vitesse, dossier }) {
  await charger()
  const { Tensor } = await import('@huggingface/transformers')
  const { phonemes, groupes, mots } = await preparer(texte)
  if (!phonemes) return { id, vide: true }

  const { input_ids } = tokeniseur(phonemes, { truncation: true })
  const jetons = input_ids.dims.at(-1)
  const vecteurs = await timbre(voix)
  const depart = 256 * Math.min(Math.max(jetons - 2, 0), 509)

  const sortie = await modele({
    input_ids,
    style: new Tensor('float32', vecteurs.slice(depart, depart + 256), [1, 256]),
    speed: new Tensor('float32', [vitesse], [1])
  })
  const onde = sortie.waveform.data
  const durees = Array.from(sortie.durations.data)

  // Les jetons sont les caracteres de la chaine de phonemes, encadres de deux
  // bornes. On rend a chaque groupe la somme des siens, espace compris.
  const parCaractere = durees.slice(1, 1 + phonemes.length)
  const debuts = []
  let curseur = 0
  let temps = durees[0] ?? 0
  for (const groupe of groupes) {
    debuts.push(temps * PAS_MS)
    for (let i = 0; i < groupe.length + 1 && curseur < parCaractere.length; i += 1, curseur += 1) {
      temps += parCaractere[curseur]
    }
  }

  // Le modele pose un demi-silence avant d'attaquer. Garde, il s'ajouterait au
  // temps de calcul a chaque phrase ; on le coupe, et l'on decale d'autant les
  // instants des mots pour qu'ils continuent de tomber juste.
  const retrait = silenceInitial(onde)
  const util = retrait > 0 ? onde.subarray(retrait) : onde
  const decalage = (retrait / TAUX) * 1000

  const chemin = path.join(dossier, `${id}.wav`)
  ecrireWav(chemin, util)

  return {
    id,
    chemin,
    duree: Math.round((util.length / TAUX) * 1000),
    jalons: mots.map((mot) => ({
      position: mot.position,
      longueur: mot.longueur,
      quand: Math.max(0, Math.round((debuts[mot.groupe] ?? 0) - decalage))
    }))
  }
}

// ---------------------------------------------------------------------------
// Les demandes
// ---------------------------------------------------------------------------

const lignes = readline.createInterface({ input: process.stdin })
let file = Promise.resolve()

lignes.on('line', (ligne) => {
  let demande
  try {
    demande = JSON.parse(ligne)
  } catch {
    return
  }
  if (demande.cmd === 'quitter') process.exit(0)
  // Une synthese a la fois : le modele n'est pas reentrant, et deux appels
  // simultanes doubleraient la memoire pour rien.
  file = file
    .then(async () => {
      if (demande.cmd === 'chauffer') {
        await charger()
        await timbre(demande.voix)
        repondre({ id: 'chauffe', pret: true })
        return
      }
      repondre(await dire(demande))
    })
    .catch((erreur) => repondre({ id: demande.id ?? 'chauffe', erreur: String(erreur?.message ?? erreur) }))
})

lignes.on('close', () => process.exit(0))
