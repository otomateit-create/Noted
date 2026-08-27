/**
 * Verifie que l'application installee peut reellement calculer un vecteur.
 *
 * Pourquoi ce script existe. Le calcul des vecteurs tourne dans un node
 * ordinaire, pas dans Electron — c'est la seule facon d'obtenir que l'inference
 * ONNX rende la main. Or un node ordinaire ne sait pas lire une archive asar :
 * tout ce dont le worker a besoin doit avoir ete laisse en clair a cote, par
 * `build.asarUnpack`. En developpement il n'y a pas d'asar du tout, donc tout
 * resout depuis le projet et cette contrainte est invisible. Un paquet oublie
 * dans `asarUnpack` passe ainsi toutes les verifications faites sur le serveur
 * de developpement, et ne casse que l'application installee — en silence, la
 * recherche retombant sur les seuls mots-cles.
 *
 * C'est exactement ce qui est arrive avec `onnxruntime-common`. Ce script rend
 * cette panne impossible a livrer sans la voir : il parle au worker packagé
 * comme le fait l'application, et attend un vrai vecteur.
 *
 * Il ne touche a rien : ni au vault, ni aux notes, ni au cache des vecteurs. Il
 * relit le modele deja telecharge et vectorise une phrase.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const APPLICATION = process.argv[2] ?? '/Applications/Noted.app'
const WORKER = path.join(
  APPLICATION,
  'Contents/Resources/app.asar.unpacked/out/main/embed-worker.cjs'
)

/** Les memes emplacements que ceux que l'application essaie. */
const NODE_CANDIDATS = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node']

/**
 * Le premier appel charge 309 Mo depuis le disque. Large, parce qu'un echec ici
 * doit vouloir dire « le moteur est casse », jamais « la machine etait lente ».
 */
const DELAI = 5 * 60 * 1000

function echouer(message, detail) {
  console.error(`\n  ✗ Le moteur de vecteurs ne fonctionne pas dans ${APPLICATION}`)
  console.error(`    ${message}`)
  if (detail) console.error(`    ${detail}`)
  console.error(
    '\n    Presque toujours un paquet absent de "build.asarUnpack" dans package.json :'
  )
  console.error('    le worker tourne sous un node ordinaire, qui ne lit pas app.asar.\n')
  process.exit(1)
}

if (!existsSync(WORKER)) echouer('Le worker est introuvable.', WORKER)

// Garde-fou contre le seul faux positif possible. Vise sur une copie restee
// dans le projet, la resolution des modules remonterait jusqu'au node_modules
// du developpement et trouverait tout : le controle passerait au vert sans rien
// prouver. Il n'a de sens que sur une application reellement installee, isolee
// du projet.
if (WORKER.startsWith(`${path.resolve(import.meta.dirname, '..')}${path.sep}`)) {
  echouer(
    'Cette copie est dans le projet : le controle y serait toujours vert.',
    'Vise une application installee, hors du dossier de developpement.'
  )
}

const node = NODE_CANDIDATS.find((candidat) => existsSync(candidat))
if (!node) echouer('Aucun node utilisable.', `Cherche dans ${NODE_CANDIDATS.join(', ')}`)

// Le modele et sa quantisation sont transmis exactement comme l'application les
// transmet. Sans cela, le worker retomberait sur ses valeurs par defaut, et le
// controle validerait un modele que l'application n'utilise pas le jour ou les
// deux divergeraient.
const worker = spawn(node, [WORKER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NOTED_EMBED_MODEL: 'onnx-community/embeddinggemma-300m-ONNX',
    NOTED_EMBED_DTYPE: 'q8'
  }
})

// Le worker ecrit ses avertissements de chargement sur la sortie d'erreur. On
// ne les affiche pas, mais on garde les dernieres lignes : en cas d'echec, ce
// sont elles qui nomment le paquet manquant.
let bruit = ''
worker.stderr.on('data', (morceau) => {
  bruit = (bruit + morceau).slice(-1200)
})

const minuterie = setTimeout(() => {
  worker.kill()
  echouer(`Aucune reponse en ${DELAI / 1000} secondes.`, bruit.trim().split('\n').slice(-3).join(' | '))
}, DELAI)

worker.on('error', (cause) => {
  clearTimeout(minuterie)
  echouer('Le worker n’a pas pu demarrer.', cause.message)
})

worker.on('exit', (code) => {
  if (code === 0) return
  clearTimeout(minuterie)
  echouer(`Le worker s’est arrete (code ${code}).`, bruit.trim().split('\n').slice(-3).join(' | '))
})

const debut = Date.now()

readline.createInterface({ input: worker.stdout }).on('line', (ligne) => {
  let message
  try {
    message = JSON.parse(ligne)
  } catch {
    return
  }

  // Etapes et progression du telechargement : on laisse passer.
  if (message.phase || typeof message.progress === 'number' || typeof message.done === 'number') {
    return
  }

  clearTimeout(minuterie)

  if (message.error) {
    worker.kill()
    echouer('Le moteur a refuse de calculer.', message.error)
  }

  const vecteur = message.vectors?.[0]
  if (!Array.isArray(vecteur) || vecteur.length === 0) {
    worker.kill()
    echouer('Le moteur a repondu sans vecteur.', ligne.slice(0, 200))
  }

  // Un vecteur normalise a une norme de 1 : c'est ce qui distingue un vrai
  // calcul d'un tableau de zeros rendu par un moteur a moitie initialise.
  const norme = Math.sqrt(vecteur.reduce((somme, valeur) => somme + valeur * valeur, 0))
  if (!(norme > 0.9 && norme < 1.1)) {
    worker.kill()
    echouer(`Vecteur incoherent (norme ${norme.toFixed(3)}, attendue 1).`)
  }

  console.log(
    `  ✓ Moteur de vecteurs verifie — ${vecteur.length} dimensions, ` +
      `norme ${norme.toFixed(3)}, en ${((Date.now() - debut) / 1000).toFixed(1)} s`
  )
  worker.kill()
  process.exit(0)
})

worker.stdin.write(
  `${JSON.stringify({
    id: 1,
    texts: ['Le prix d’acquisition se decompose en dette et en fonds propres.'],
    kind: 'document'
  })}\n`
)
