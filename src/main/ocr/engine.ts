/**
 * Le moteur de lecture d'images : un `llama-server` resident.
 *
 * **Un serveur qui vit, et non un processus par page.** La premiere version
 * faisait l'inverse, sur la foi de trois defauts supposes de llama.cpp. Verifies
 * un a un sur cette machine, avec ces poids et ce build, ils etaient faux ou
 * hors sujet — et le prix de l'erreur etait lourd : les 1,43 Go de poids
 * relus a chaque page asphyxiaient le Mac. Ouvrir un PDF pendant une lecture
 * demandait 10,9 s, un document Word 23,5 s, contre 2 s moteur arrete.
 *
 * Ce que mesure le serveur resident, ici meme :
 *
 *   - demarrage en 1,07 s, empreinte 1 370 Mo dont 703 Mo de pages fichier
 *     propres, donc evincables par le systeme ;
 *   - trois pages lues d'affilee, modele charge une seule fois, sans plantage :
 *     14,0 / 15,5 / 16,6 s ;
 *   - **contention nulle** : dessiner quatre pages de PDF pendant une lecture
 *     prend 3,04 / 3,01 / 2,99 s, contre 2,98 / 3,09 / 3,02 s au repos. C'etait
 *     bien la relecture des poids qui saturait la machine, pas le calcul ;
 *   - une requete coupee en plein travail laisse le serveur sain, et la lecture
 *     suivante passe normalement.
 *
 * Deux drapeaux ne sont pas negociables. **`-np 1`** : sans lui le serveur ouvre
 * quatre emplacements de contexte, l'empreinte passe a deux gigaoctets, et
 * l'allocation Metal echoue sur une machine de huit — c'est la panne que la
 * premiere version avait prise pour une incompatibilite de fond. **`-fa off`** :
 * l'attention rapide donne des sorties fausses sur ce modele. `-fit off` reste
 * par prudence, l'ajustement automatique ne comptant pas l'encodeur visuel dans
 * son calcul memoire.
 *
 * Une seule chose est perdue par rapport au processus par page, et elle est
 * rendue autrement : la ou un plantage ne pouvait emporter qu'une page, il
 * emporte maintenant le serveur. Il est donc surveille, relance, et la file
 * reprend a la page suivante.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { OcrRead } from '../../shared/types'
import { modelFiles, ensureOcrModel, serverPath } from './model'

/**
 * Les invites de tache de GLM-OCR.
 *
 * Ce ne sont pas des consignes libres : ce sont les quatre taches sur
 * lesquelles le modele a ete entraine, listees telles quelles dans son rapport
 * technique (§5.3), et les paraphraser degrade la sortie. Chacune a un format
 * de sortie qui lui est propre, et c'est tout l'interet de les distinguer :
 *
 *   - **texte** — « du texte nu correspondant au contenu visible », dit le
 *     rapport. Nu au sens strict : pas de titres, pas de tableaux, pas de
 *     structure. C'est la seule tache que Noted utilisait, et c'est pourquoi
 *     les tableaux ressortaient aplatis en lignes ;
 *   - **tableau** — retablit les lignes, les colonnes et les en-tetes. C'est
 *     ce que le modele fait de mieux : 93,96 de TEDS sur OmniDocBench v1.5,
 *     premier de tous les modeles evalues, Gemini-3 Pro compris ;
 *   - **formule** — rend du LaTeX, que le cours sait deja afficher.
 *
 * Aucune tache n'existe pour les schemas : le rapport n'en decrit que quatre,
 * la quatrieme etant l'extraction en JSON. Une frise ou une carte mentale est
 * donc gardee comme image, et seules ses etiquettes sont lues.
 */
export const TASKS = {
  text: 'Text Recognition:',
  table: 'Table Recognition:',
  formula: 'Formula Recognition:'
} as const

export type Task = keyof typeof TASKS

/**
 * Taille du contexte. Une page dense produit un millier de jetons de texte, et
 * l'image en occupe plusieurs milliers a elle seule une fois decoupee.
 */
const CONTEXT = 12_000

/**
 * Plafond de sortie pour une page.
 *
 * Il ne sert pas a economiser : il sert a couper une boucle. Un modele qui perd
 * pied sur une image illisible repete la meme ligne indefiniment.
 */
const MAX_TOKENS = 2_000

/**
 * Coeurs laisses au calcul.
 *
 * Deux, et non quatre. Mesure : 17 a 21 s par page a deux fils, contre 16,8 a
 * 20,4 s a quatre. Le goulot est l'encodeur visuel sur le processeur graphique,
 * pas le processeur central — doubler les fils ne rend presque rien et prend
 * deux coeurs a l'interface.
 */
const THREADS = 2

/**
 * Delai laisse au serveur pour repondre qu'il est pret.
 *
 * Il demarre en une seconde, mais la premiere fois les poids viennent du disque
 * et non du cache du systeme. Deux minutes couvrent largement ce cas sans
 * jamais faire attendre pour rien : on interroge `/health`, on ne compte pas.
 */
const BOOT_TIMEOUT = 2 * 60 * 1000

/**
 * Temps maximal pour une page, une fois le modele charge.
 *
 * Mesure sur cette machine : 14 a 21 s pour une page dense. Cinq minutes
 * laissent une marge tres large sans qu'une page pathologique puisse bloquer la
 * conversion des cinquante-neuf suivantes.
 */
const PAGE_TIMEOUT = 5 * 60 * 1000

/**
 * Silence apres lequel le serveur rend sa memoire.
 *
 * Une minute, et c'est deliberement court. Pendant une conversion les pages
 * s'enchainent en quelques secondes : la minuterie ne se declenche donc jamais
 * au milieu du travail. Des qu'il s'arrete, les 1 370 Mo reviennent au systeme
 * en moins d'une minute — ce qui compte sur une machine qui en a huit. Le prix
 * est de 1,1 s si une lecture repart juste apres, et c'est peu cher paye.
 */
const IDLE_TIMEOUT = 60 * 1000

let child: ChildProcess | null = null
let port = 0
/** Le demarrage en cours, pour que deux pages ne lancent pas deux serveurs. */
let booting: Promise<boolean> | null = null
let idleTimer: NodeJS.Timeout | null = null

/**
 * File d'attente des pages.
 *
 * Une page a la fois, jamais deux. `-np 1` l'impose d'ailleurs cote serveur, et
 * c'est ce qui evite l'assertion sur le cache de prompt en acces concurrent. La
 * file ne transporte que l'ordre de passage, jamais un resultat : une page qui
 * echoue ne rompt pas la chaine pour celles qui suivent.
 */
let queue: Promise<unknown> = Promise.resolve()

let inFlight = 0

/** Ceux qui attendent que la lecture d'images laisse la place. */
let idleWaiters: (() => void)[] = []

/**
 * De quoi couper la requete en cours sans toucher au serveur.
 */
let reading: AbortController | null = null

export function ocrBusy(): boolean {
  return inFlight > 0
}

/**
 * Attend que la lecture d'images laisse la place.
 *
 * C'est l'exclusion mutuelle qui compte, et elle ne bouge pas : le calcul des
 * vecteurs l'appelle avant chaque tranche, ce qui empeche une indexation en
 * masse de tourner pendant une lecture. Le modele de vecteurs, lui, n'est plus
 * decharge ici — il a sa propre minuterie d'inactivite, qui sait ne pas couper
 * une indexation en cours, et la doubler d'un dechargement par page n'avait de
 * sens qu'avec un moteur qui naissait et mourait a chaque image.
 */
export function whenOcrIdle(): Promise<void> {
  if (inFlight === 0) return Promise.resolve()
  return new Promise((resolve) => idleWaiters.push(resolve))
}

function releaseIdleWaiters(): void {
  if (inFlight > 0) return
  const waiting = idleWaiters
  idleWaiters = []
  for (const resolve of waiting) resolve()
}

/**
 * Temps de calme exige apres un geste de l'utilisateur.
 *
 * Quatre secondes : de quoi laisser un document s'ouvrir, se dessiner et se
 * poser, avant que le travail de fond ne reprenne la machine.
 */
const QUIET = 4_000

/** Instant avant lequel aucune nouvelle lecture ne doit demarrer. */
let quietUntil = 0

/** Vrai quand la lecture en cours a ete coupee par un geste, non par une panne. */
let interrupted = false

/**
 * L'utilisateur vient de demander quelque chose : la lecture d'images s'efface.
 *
 * La requete en cours est abandonnee, **le serveur reste debout**. Avec le
 * processus par page, il fallait le tuer — c'etait le seul moyen de rendre la
 * machine. La contention mesuree etant desormais nulle, il n'y a plus rien a
 * reprendre de force : on cesse simplement d'attendre une reponse dont plus
 * personne ne veut, et la page sera relue une fois le calme revenu.
 */
export function yieldOcrToUser(): void {
  quietUntil = Date.now() + QUIET

  if (reading) {
    interrupted = true
    reading.abort()
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Attend que la machine soit rendue au travail de fond. */
async function untilQuiet(): Promise<void> {
  while (Date.now() < quietUntil) {
    await pause(quietUntil - Date.now())
  }
}

/** Un port libre, choisi par le systeme puis rendu aussitot. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    // 127.0.0.1 et non 0.0.0.0 : ce moteur n'a aucune raison d'etre joignable
    // depuis le reseau local.
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (chosen ? resolve(chosen) : reject(new Error('Aucun port libre.'))))
    })
  })
}

/** Repousse l'extinction a chaque signe d'activite. */
function keepAlive(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (inFlight > 0) {
      keepAlive()
      return
    }
    disposeOcr()
  }, IDLE_TIMEOUT)
}

/** Le serveur est-il debout et joignable ? */
function alive(): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null && port > 0
}

/**
 * Allume le serveur si besoin. Rend faux quand il n'y a rien a allumer — modele
 * absent, binaire introuvable — auquel cas l'appelant continue sans OCR.
 */
function boot(): Promise<boolean> {
  if (alive()) return Promise.resolve(true)
  if (!booting) {
    booting = start().finally(() => {
      booting = null
    })
  }
  return booting
}

async function start(): Promise<boolean> {
  if (!(await ensureOcrModel())) return false

  const files = modelFiles()
  const chosen = await freePort()

  // `nice` plutot que le binaire directement : le systeme donne la main a
  // l'interface des qu'elle en a besoin. Cela ne suffisait pas a lui seul quand
  // les poids etaient relus a chaque page, mais cela ne coute rien et reste
  // juste — un travail de fond n'a pas a passer devant.
  const spawned = spawn(
    '/usr/bin/nice',
    [
      '-n', '10',
      serverPath(),
      '-m', files.decoder,
      '--mmproj', files.vision,
      '-c', String(CONTEXT),
      // Un seul emplacement de contexte. Sans lui, quatre sont ouverts,
      // l'empreinte passe de 1 370 a 2 000 Mo, et l'allocation Metal echoue.
      '-np', '1',
      '-t', String(THREADS),
      // Defaut connu de ce modele : l'attention rapide donne des sorties fausses.
      '-fa', 'off',
      // L'ajustement automatique ne compte pas l'encodeur visuel dans son calcul
      // memoire — defaut connu et non corrige en amont.
      '-fit', 'off',
      // Un tour a vide avant la premiere image ne sert a rien ici, et c'est lui
      // qui faisait tomber le serveur lors des premiers essais.
      '--no-warmup',
      // Chaque page est lue pour elle seule : rien a faire glisser d'un contexte
      // au suivant.
      '--no-context-shift',
      '--port', String(chosen),
      '--host', '127.0.0.1'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  // Les deux tubes font soixante-quatre kilo-octets et le serveur y ecrit
  // abondamment. Sans cette purge, il se bloquerait en ecriture une fois pleins,
  // et la lecture s'arreterait sans un mot.
  spawned.stdout?.resume()
  spawned.stderr?.resume()

  const forget = (): void => {
    if (child === spawned) {
      child = null
      port = 0
    }
  }
  spawned.on('exit', forget)
  spawned.on('error', forget)

  child = spawned
  port = chosen

  // On attend qu'il reponde, plutot que de supposer un delai : les poids
  // viennent du disque au premier lancement, du cache du systeme ensuite.
  const until = Date.now() + BOOT_TIMEOUT
  while (Date.now() < until) {
    if (child !== spawned || spawned.exitCode !== null) return false

    try {
      const response = await fetch(`http://127.0.0.1:${chosen}/health`)
      const health = response.ok ? ((await response.json()) as { status?: string }) : null
      if (health?.status === 'ok') {
        keepAlive()
        return true
      }
    } catch {
      // Pas encore leve : c'est l'etat normal de la premiere seconde.
    }
    await pause(250)
  }

  disposeOcr()
  return false
}

/**
 * Lit une image et rend son Markdown.
 *
 * Ne leve jamais. Et il faut lire attentivement ce que valent ses deux formes de
 * reponse negative, car elles ne se valent pas :
 *
 *   - **`null`** : le moteur n'a pas pu travailler — modele absent, serveur
 *     mort, echeance depassee. Rien n'a ete appris de cette image, et il faudra
 *     reessayer un jour ;
 *   - **`{ markdown: '' }`** : le moteur a bien lu, et il n'y avait rien a
 *     lire. Un schema sans legende, une photo decorative. C'est un resultat, pas
 *     un echec, et il doit etre garde — sans quoi les memes images sans texte
 *     sont relues a chaque ouverture du cours.
 */
export function readImage(png: Buffer, task: Task = 'text'): Promise<OcrRead | null> {
  const turn = queue.then(() => run(png, task))
  queue = turn.catch(() => undefined)
  return turn
}

async function run(png: Buffer, task: Task): Promise<OcrRead | null> {
  inFlight += 1

  try {
    // Une lecture interrompue par un geste de l'utilisateur n'est pas un echec :
    // elle est simplement remise a plus tard. On repasse donc, une fois le calme
    // revenu. Trois tentatives suffisent — au-dela, c'est que la machine n'est
    // jamais tranquille, et la page attendra la prochaine ouverture du cours.
    let markdown: string | null = null

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await untilQuiet()
      if (!(await boot())) return null

      keepAlive()
      interrupted = false
      markdown = await ask(png, TASKS[task])

      if (markdown !== null || !interrupted) break
    }

    if (markdown === null) return null

    // Une lecture qui s'effondre en boucle vaut une lecture vide, et non un
    // echec : le moteur a bien tourne, c'est l'image qui ne se laisse pas lire.
    const text = unfence(markdown)
    return { markdown: degenerate(text) ? '' : text }
  } catch {
    return null
  } finally {
    inFlight -= 1
    releaseIdleWaiters()
    keepAlive()
  }
}

/** Une requete au serveur. Rend null des que quoi que ce soit tourne mal. */
async function ask(png: Buffer, prompt: string): Promise<string | null> {
  const guard = new AbortController()
  reading = guard

  const deadline = setTimeout(() => guard.abort(), PAGE_TIMEOUT)

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      signal: guard.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${png.toString('base64')}` }
              },
              { type: 'text', text: prompt }
            ]
          }
        ],
        // Une lecture n'est pas une redaction. On veut le mot le plus probable,
        // pas une variation : la meme page doit ressortir deux fois de suite,
        // et le cache sur disque suppose ce determinisme.
        temperature: 0.1,
        top_k: 1,
        max_tokens: MAX_TOKENS
      })
    })

    if (!response.ok) return null

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    return payload.choices?.[0]?.message?.content ?? null
  } catch {
    // Requete abandonnee, serveur tombe, reponse illisible. Dans le dernier cas
    // le serveur est peut-etre mort : le prochain tour le constatera et le
    // relancera, la page en cours etant perdue et les suivantes servies.
    return null
  } finally {
    clearTimeout(deadline)
    if (reading === guard) reading = null
  }
}

/**
 * Retire l'enveloppe de bloc de code que le modele pose parfois autour de sa
 * reponse.
 *
 * GLM-OCR rend tantot du Markdown nu, tantot le meme Markdown enferme dans un
 * ```markdown … ```. Garde telle quelle, cette enveloppe traverse l'index et
 * l'assistant, ou elle se lit comme du code — et, sur une image dont il n'a
 * rien tire, le modele rend l'enveloppe **vide**. Constate en verifiant : une
 * capture d'ecran avait produit « ```markdown\n\n``` », six caracteres qui
 * n'apprennent rien, mis en cache et donc reservis pour toujours.
 *
 * Rendre la chaine vide dans ce cas, c'est declarer l'image lue et muette — ce
 * qui se garde, et evite de la relire indefiniment.
 */
function unfence(text: string): string {
  const trimmed = text.trim()

  const fenced = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/)
  if (fenced) return fenced[1].trim()

  // Une enveloppe ouverte mais jamais refermee — le plafond de jetons a ete
  // atteint en plein bloc.
  const opened = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*)$/)
  if (opened) return opened[1].trim()

  return trimmed
}

/**
 * La lecture s'est-elle visiblement effondree ?
 *
 * Un modele qui perd pied sur une image illisible ne rend pas un texte
 * mediocre : il boucle, et recopie la meme ligne jusqu'au plafond de jetons.
 * Ecrire cela dans le cours serait pire que de ne rien ecrire — la boucle
 * partirait dans l'index, l'IA la citerait, et elle occuperait la page a la
 * place du texte manquant.
 *
 * On ne detecte ici que l'effondrement visible. Une page lue avec assurance et
 * fausse — « achete » rendu « achété » — passe et doit passer : la corriger
 * demanderait de savoir ce qui etait ecrit, et c'est precisement la question
 * qu'on posait au modele.
 */
function degenerate(text: string): boolean {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length < 6) return false

  // Deux tiers de lignes repetees : aucun cours ne ressemble a cela, et une
  // boucle y arrive toujours.
  return new Set(lines).size / lines.length < 0.34
}

/**
 * Eteint le serveur et rend sa memoire. Appele a la fermeture de l'application
 * et apres une minute de silence. Sans effet s'il n'a jamais demarre.
 */
export function disposeOcr(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  const dying = child
  child = null
  port = 0
  dying?.kill()
}
