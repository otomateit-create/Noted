/**
 * Calcul des vecteurs de sens, dans un processus Node separe.
 *
 * Pourquoi un processus separe plutot que le processus principal d'Electron :
 * le moteur ONNX charge son modele sans probleme sous Electron, mais son
 * inference ne rend jamais la main — ni dans le processus principal, ni dans un
 * utilityProcess. Sous Node ordinaire, elle s'execute normalement. On delegue
 * donc a un vrai Node, ce qui a par ailleurs le merite de sortir un calcul
 * lourd du processus qui sert l'interface.
 *
 * Protocole : une requete JSON par ligne sur l'entree standard, une reponse
 * JSON par ligne sur la sortie standard.
 */

const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

/**
 * Le modele est choisi par embedder.ts et transmis par l'environnement : c'est
 * la meme valeur qui identifie le modele dans le cache des vecteurs sur disque.
 * La modifier ici seulement ferait relire les vecteurs de l'ancien modele comme
 * s'ils venaient du nouveau. Les valeurs ci-dessous ne servent qu'a lancer le
 * worker a la main, pour le mettre au point.
 *
 * Poids quantifies en 8 bits : 309 Mo au lieu de 1,2 Go, sans perte notable. On
 * evite les variantes en float16, que ce modele ne prend pas en charge.
 */
const MODEL = process.env.NOTED_EMBED_MODEL || 'onnx-community/embeddinggemma-300m-ONNX'
const DTYPE = process.env.NOTED_EMBED_DTYPE || 'q8'

/**
 * Nombre de textes vectorises en un seul passage.
 *
 * Un cours de cinquante pages donne pres de cent morceaux. Les envoyer d'un
 * bloc reclamait quatre gigaoctets a la machine : le moteur doit tenir en
 * memoire l'attention de toutes les sequences a la fois, et il ne rend jamais
 * ce qu'il a pris. Par paquets, le resultat est identique — chaque morceau est
 * vectorise independamment des autres, la moyenne se fait sequence par
 * sequence — pour quelques centaines de megaoctets.
 */
const BATCH = 8

/**
 * EmbeddingGemma attend que l'on annonce la nature du texte. Sans ces prefixes,
 * la qualite de la recherche chute nettement : le modele a ete entraine a
 * placer une question et le passage qui y repond au meme endroit de l'espace,
 * a condition qu'on lui dise lequel est lequel.
 *
 * L'emplacement `title:` est prevu pour dire d'ou vient le passage. On y met le
 * fil « matiere › cours › section › page ». Recopier ce meme fil en tete du
 * texte, lui, degrade la recherche : presque identique d'un passage a l'autre,
 * il tire tous les vecteurs vers un centre commun. Le modele, lui, a appris a
 * traiter ce champ comme une etiquette.
 */
function decorate(text, kind, title) {
  return kind === 'query'
    ? `task: search result | query: ${text}`
    : `title: ${title || 'none'} | text: ${text}`
}

let chargement = null

/**
 * Charge le modele, une seule fois.
 *
 * C'est la promesse qui est memorisee, et non son resultat : readline n'attend
 * pas la fin du gestionnaire de ligne, donc deux requetes qui se croisent —
 * l'indexation d'un cours et une question posee a l'assistant — entraient
 * toutes deux dans le chargement avant que la premiere ait pu s'inscrire. Le
 * modele etait alors monte deux fois, soit six cents megaoctets de plus sur une
 * machine qui en a huit.
 */
function load() {
  if (!chargement) {
    chargement = charger().catch((cause) => {
      // Un echec ne se memorise pas. Retenir la promesse evite de monter deux
      // fois le meme modele ; retenir un refus condamnerait le processus pour
      // un incident passager, et toutes les requetes suivantes echoueraient
      // sans meme reessayer.
      chargement = null
      throw cause
    })
  }
  return chargement
}

async function charger() {
  const { env, pipeline } = require('@huggingface/transformers')
  // Le modele vit dans le vault, avec le reste des donnees de l'utilisateur.
  env.cacheDir = path.join(os.homedir(), 'Documents', 'Noted', '.noted', 'modeles')

  return pipeline('feature-extraction', MODEL, {
    dtype: DTYPE,
    session_options: {
      // Sans cet arret, le moteur garde pour lui la memoire allouee au plus
      // gros calcul qu'il ait eu a faire, et l'empreinte du processus ne
      // redescend plus jamais, meme des heures apres la derniere question.
      enableCpuMemArena: false,
      // Quatre coeurs sur huit. L'indexation reste rapide, et la machine reste
      // utilisable pendant qu'elle tourne — c'est un calcul de fond, il n'a pas
      // a prendre toute la place.
      intraOpNumThreads: 4,
      interOpNumThreads: 1
    },
    progress_callback: (report) => {
      if (report.status === 'progress' && typeof report.progress === 'number') {
        send({ progress: Math.round(report.progress) })
      }
    }
  })
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return

  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  try {
    // Accuse reception avant toute chose. Charger le modele prend plusieurs
    // dizaines de secondes pendant lesquelles rien ne peut etre dit : sans ce
    // premier mot, le processus principal ne distingue pas un moteur qui
    // demarre d'un moteur qui ne repondra jamais.
    send({ id: request.id, phase: 'chargement' })
    const model = await load()
    send({ id: request.id, phase: 'calcul' })

    const vectors = []
    for (let start = 0; start < request.texts.length; start += BATCH) {
      const decorated = request.texts
        .slice(start, start + BATCH)
        .map((text, index) => decorate(text, request.kind, request.titles?.[start + index]))
      const output = await model(decorated, { pooling: 'mean', normalize: true })
      vectors.push(...output.tolist())

      // Signe de vie. C'est lui qui distingue un calcul long d'un moteur
      // bloque : sans ce battement, le processus principal ne peut que compter
      // le temps et finit par abandonner un travail qui avancait normalement.
      if (vectors.length < request.texts.length) {
        send({ id: request.id, done: vectors.length })
      }
    }

    send({ id: request.id, vectors })
  } catch (error) {
    send({ id: request.id, error: error?.message ?? String(error) })
  }
})
