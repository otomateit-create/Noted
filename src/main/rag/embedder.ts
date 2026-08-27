/**
 * Acces au modele de vecteurs, hebergé par un processus Node separe.
 *
 * Tout ici est optionnel par construction : si Node est introuvable, si le
 * telechargement du modele echoue, si le processus meurt, la recherche
 * lexicale continue de fonctionner seule. Une panne du modele degrade la
 * pertinence, elle ne casse jamais l'application.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/**
 * Delai laisse a un moteur qui vient de demarrer, tant qu'il n'a pas annonce
 * son modele pret.
 *
 * Ce delai vaut par processus, et non par lancement de l'application : c'est
 * toute la difference. Le processus est libere apres deux minutes sans
 * question, et le suivant doit relire ses 309 Mo depuis le disque — plusieurs
 * dizaines de secondes, davantage si l'extraction d'un PDF tourne en meme
 * temps. Compte a partir du premier appel de la session, ce rechargement
 * passait pour un silence anormal : le cours etait abandonne avant d'avoir
 * commence, sans rien laisser sur le disque. Au tout premier lancement d'une
 * installation, ce meme delai couvre le telechargement du modele.
 */
const COLD_TIMEOUT = 15 * 60 * 1000

/**
 * Silence tolere entre deux signes de vie du moteur.
 *
 * Ce n'est pas une duree maximale de calcul, et la distinction est tout le
 * sujet : un cours de cinq cents pages demande plusieurs minutes de calcul
 * parfaitement normal, qu'un plafond sur la duree totale interrompait en plein
 * milieu — le cours retombait alors en silence sur la seule recherche par
 * mots-cles. Le worker annonce chaque paquet termine, chaque annonce repousse
 * l'echeance : un travail qui avance n'est jamais interrompu, un moteur
 * reellement fige est libere en une minute.
 */
const SILENCE_TIMEOUT = 60 * 1000

/**
 * Delai d'inactivite au bout duquel le processus rend sa memoire.
 *
 * Le modele charge occupe plusieurs centaines de megaoctets, et rien ne
 * l'oblige a les garder entre deux questions. Sur une machine de huit
 * gigaoctets, cette reserve dormante suffit a envoyer le systeme entier dans la
 * memoire virtuelle. Le processus se relance tout seul au prochain appel : on
 * echange quelques secondes de rechargement contre une machine qui respire le
 * reste du temps.
 */
const IDLE_TIMEOUT = 2 * 60 * 1000

/**
 * Modele et quantisation. Ils sont definis ici, et transmis au worker, plutot
 * que fixes dans le worker : le cache des vecteurs sur disque doit etre invalide
 * des que l'un des deux change, et cela suppose que la valeur inscrite dans le
 * cache soit exactement celle qui a servi au calcul.
 */
const MODEL = 'onnx-community/embeddinggemma-300m-ONNX'
const DTYPE = 'q8'

/** Identite du modele, telle qu'elle est inscrite dans le cache des vecteurs. */
export const EMBEDDING_MODEL = `${MODEL}@${DTYPE}`

/**
 * Emplacements habituels de Node sur un Mac. Lancee depuis le Finder,
 * l'application n'herite pas du PATH du terminal.
 */
const NODE_CANDIDATES = [
  '/usr/local/bin/node',
  '/opt/homebrew/bin/node',
  '/usr/bin/node'
]

export type EmbeddingKind = 'query' | 'document'

interface Pending {
  resolve: (vectors: number[][]) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  /** Repousse l'echeance : le moteur vient de donner signe de vie. */
  renew: () => void
  /**
   * Note que le modele est en place pour cette requete-ci.
   *
   * L'echeance se resserre alors du delai de demarrage au delai de silence.
   * C'est bien par requete, et non par processus : une requete armee pendant
   * qu'une autre chargeait le modele se voyait sinon imposer le delai court
   * avant meme d'avoir commence.
   */
  markReady: () => void
  /**
   * Le processus a qui cette requete a ete confiee.
   *
   * Sans ce lien, une requete et un processus ne sont rattaches que par le
   * hasard du moment : l'agonie d'un moteur rejetait les requetes de son
   * successeur, et l'echeance d'une requete orpheline tuait un moteur en plein
   * travail pour quelqu'un d'autre.
   */
  owner: ChildProcessWithoutNullStreams
}

/** Ce que rend une vectorisation : des vecteurs, ou la raison de leur absence. */
export interface Embedding {
  /** null quand le calcul n'a pas abouti. */
  vectors: number[][] | null
  /** Renseigne exactement quand `vectors` est null. */
  reason: string | null
}

let child: ChildProcessWithoutNullStreams | null = null
let nextId = 1
/** Vrai des que le processus en cours a annonce son modele charge. */
let warm = false
let idleTimer: NodeJS.Timeout | null = null
const pending = new Map<number, Pending>()

/** Repousse l'echeance a chaque signe de vie. */
function keepAlive(): void {
  if (idleTimer) clearTimeout(idleTimer)

  idleTimer = setTimeout(() => {
    idleTimer = null
    // Une indexation en cours ne doit jamais etre coupee par la minuterie : on
    // laisse passer le tour et on redemande le silence.
    if (pending.size > 0) {
      keepAlive()
      return
    }
    disposeEmbedder()
  }, IDLE_TIMEOUT)
}

/** Progression du telechargement initial, pour l'afficher dans l'interface. */
let downloadProgress: number | null = null

export function modelProgress(): number | null {
  return downloadProgress
}

function resolveNode(): string | null {
  for (const candidate of NODE_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function workerPath(): string {
  // Le fichier est copie a cote du bundle du processus principal.
  const local = path.join(__dirname, 'embed-worker.cjs')

  // Une fois l'application packagee, ce bundle vit dans une archive asar que
  // seul Electron sait ouvrir. Le calcul des vecteurs tourne sous un node
  // ordinaire : il lui faut le chemin de la copie laissee en clair a cote.
  return local.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  )
}

/**
 * Pourquoi le dernier `start` a renonce. Une variable de module suffit et ne
 * peut pas se melanger entre appels : elle est ecrite et relue dans le meme
 * enchainement synchrone, sans la moindre attente entre les deux.
 */
let startFailure: string | null = null

function start(): ChildProcessWithoutNullStreams | null {
  startFailure = null

  // Un processus mort dont l'evenement de sortie n'est pas encore arrive reste
  // reference ici. Lui ecrire ne menerait nulle part, et l'appel n'echouerait
  // qu'au bout du delai — quinze minutes d'immobilite pour un interlocuteur
  // deja disparu.
  if (child && (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed)) {
    child = null
  }
  if (child) return child

  const node = resolveNode()
  if (!node) {
    startFailure = `Node introuvable (cherche dans ${NODE_CANDIDATES.join(', ')}).`
    return null
  }
  if (!existsSync(workerPath())) {
    startFailure = `Moteur introuvable : ${workerPath()}`
    return null
  }

  const spawned = spawn(node, [workerPath()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NOTED_EMBED_MODEL: MODEL, NOTED_EMBED_DTYPE: DTYPE }
  })

  // Un processus neuf n'a pas encore de modele en memoire.
  warm = false

  // Le tube d'erreur fait soixante-quatre kilo-octets. Personne ne le lit ici,
  // et le moteur y ecrit ses avertissements de chargement : sans cette purge,
  // le worker se bloquerait definitivement en ecriture le jour ou il depasse
  // cette taille, et la recherche retomberait en silence sur le lexical seul.
  spawned.stderr.resume()

  const lines = readline.createInterface({ input: spawned.stdout })

  lines.on('line', (line) => {
    // Un processus deja remplace continue de parler le temps de mourir. Ce
    // qu'il raconte ne concerne plus personne : sans ce filtre, ses annonces
    // repoussaient les echeances des requetes du processus suivant, et un
    // fantome maintenait en vie l'attente d'un moteur reellement fige.
    if (child !== spawned) return

    let message: {
      id?: number
      vectors?: number[][]
      error?: string
      progress?: number
      done?: number
      phase?: string
    }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (typeof message.progress === 'number') {
      downloadProgress = message.progress
      if (message.progress >= 100) downloadProgress = null
      // Le telechargement ne porte pas d'identifiant d'appel, mais c'est bien
      // un signe de vie : le moteur est occupe pour tout le monde a la fois.
      for (const waiting of pending.values()) waiting.renew()
      keepAlive()
      return
    }

    const waiting = message.id !== undefined ? pending.get(message.id) : undefined
    if (!waiting || message.id === undefined) return

    // Etape franchie, mais l'appel continue : on repousse l'echeance sans rien
    // resoudre. Ces tests doivent preceder celui de la reponse finale, sinon un
    // simple battement serait pris pour un resultat vide.
    if (message.phase) {
      // Le modele est en place : ce qui suit doit avancer paquet par paquet,
      // et la surveillance se resserre sur le silence entre deux paquets.
      if (message.phase === 'calcul') {
        warm = true
        waiting.markReady()
      }
      waiting.renew()
      keepAlive()
      return
    }

    if (typeof message.done === 'number') {
      waiting.renew()
      keepAlive()
      return
    }

    clearTimeout(waiting.timer)
    pending.delete(message.id)

    if (message.error) waiting.reject(new Error(message.error))
    else waiting.resolve(message.vectors ?? [])
  })

  const die = (reason: string): void => {
    // Un processus qui meurt libere ce qui lui avait ete confie, et cela seul.
    //
    // Les deux moities de cette phrase comptent autant l'une que l'autre. Sans
    // le filtre, l'agonie d'un processus deja remplace — la sortie arrive
    // toujours un tour de boucle apres la mise a mort — rejetait les requetes
    // du suivant et le rendait injoignable. Mais renoncer a tout des que le
    // mourant n'est plus le processus courant abandonnerait ses propres
    // requetes a leur echeance : jusqu'a quinze minutes d'attente pour un
    // interlocuteur deja enterre.
    for (const [id, waiting] of pending) {
      if (waiting.owner !== spawned) continue
      clearTimeout(waiting.timer)
      pending.delete(id)
      waiting.reject(new Error(reason))
    }

    lines.close()
    spawned.kill()
    if (child === spawned) child = null
  }

  spawned.on('exit', () => die('Le calcul des vecteurs s’est arrêté.'))
  spawned.on('error', () => die('Le calcul des vecteurs n’a pas pu démarrer.'))

  // Une ecriture dans un tube rompu emet une erreur sur ce flux. Sans
  // recepteur, Node en fait une exception non interceptee — et c'est
  // l'application entiere qui tombe, pour un calcul d'arriere-plan dont
  // l'echec ne devrait couter que la recherche par le sens.
  spawned.stdin.on('error', () => die('Le calcul des vecteurs est injoignable.'))

  child = spawned
  return child
}

/**
 * File d'attente des vectorisations de documents.
 *
 * Un seul paquet est confie au moteur a la fois. Deux cours lances ensemble
 * s'entrelacaient sinon dans le meme processus, doublaient la memoire de travail
 * et, surtout, l'echeance depassee de l'un faisait tuer le moteur qui calculait
 * pour l'autre.
 *
 * La file ordonne des paquets, et non des cours — la nuance a son interet. Un
 * cours ne depose sa tranche suivante qu'une fois la precedente rendue : deux
 * cours ouverts ensemble alternent donc naturellement, tranche apres tranche,
 * au lieu que le second attende la fin complete du premier.
 *
 * Elle ne transporte que l'ordre de passage, jamais un resultat : un tour qui
 * echoue ne doit pas rompre la chaine pour ceux qui suivent.
 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Vectorise des textes. Renvoie `vectors: null` si le modele n'est pas
 * disponible — a l'appelant de se rabattre sur la recherche lexicale.
 */
export async function embed(
  texts: string[],
  kind: EmbeddingKind,
  /**
   * D'ou vient chaque passage, dans le meme ordre que `texts`.
   *
   * EmbeddingGemma reserve un emplacement a cette information. Sans elle, un
   * passage est vectorise sans qu'on sache jamais de quel cours ni de quelle
   * section il vient — et « la cascade » se trouve dans dix cours.
   */
  titles?: (string | null)[]
): Promise<Embedding> {
  if (texts.length === 0) return { vectors: [], reason: null }

  // Une question posee a l'assistant ne fait jamais la queue : un seul texte
  // court, et quelqu'un attend devant son ecran. La faire patienter derriere
  // l'indexation d'un livre de cinq cents pages n'aurait aucun sens.
  if (kind === 'query') return dispatch(texts, kind, titles)

  const turn = queue.then(() => dispatch(texts, kind, titles))
  queue = turn.catch(() => undefined)
  return turn
}

/** Confie reellement un texte au moteur, et attend sa reponse. */
function dispatch(
  texts: string[],
  kind: EmbeddingKind,
  titles?: (string | null)[]
): Promise<Embedding> {
  // Nommer cette variable `process` masquerait le `process` de Node dans toute
  // la fonction, et le jour ou l'on y lirait `process.env` on obtiendrait un
  // enfant, sans la moindre erreur.
  const worker = start()
  if (!worker) return Promise.resolve({ vectors: null, reason: startFailure })

  const id = nextId++
  keepAlive()

  return new Promise<Embedding>((resolve) => {
    const done = (vectors: number[][] | null, reason: string | null): void =>
      resolve({ vectors, reason })

    // Le modele est-il en place pour cette requete ? La reponse conditionne
    // l'echeance, et elle appartient a la requete : un processus neuf peut
    // avoir charge son modele pour une premiere requete pendant qu'une seconde
    // attendait encore son tour.
    let ready = warm
    const budget = (): number => (ready ? SILENCE_TIMEOUT : COLD_TIMEOUT)

    const expire = (): void => {
      pending.delete(id)
      // Un moteur qui ne dit plus rien ne se debloquera pas de lui-meme, et le
      // laisser tourner reviendrait a lui abandonner sa memoire et ses quatre
      // coeurs pour un travail que plus personne n'attend.
      //
      // Deux conditions, et chacune protege quelqu'un. Le processus doit etre
      // celui a qui la requete avait ete confiee, sinon une echeance depassee
      // irait tuer son successeur. Et il ne doit plus rien avoir sur les bras :
      // une question posee a l'assistant contourne la file et court donc en
      // meme temps qu'une tranche de cours — abandonner l'une ne doit pas
      // emporter l'autre. Si le moteur est reellement fige, chaque requete
      // arrivera a son terme et c'est la derniere qui le liberera.
      if (child === worker && pending.size === 0) disposeEmbedder()
      done(
        null,
        ready
          ? 'Le moteur s’est arrêté de répondre en plein calcul.'
          : 'Le moteur n’a jamais fini de charger son modèle.'
      )
    }

    const entry: Pending = {
      owner: worker,
      timer: setTimeout(expire, budget()),
      markReady: () => {
        ready = true
      },
      renew: () => {
        clearTimeout(entry.timer)
        entry.timer = setTimeout(expire, budget())
      },
      resolve: (vectors) => {
        // Une reponse complete prouve le modele charge, meme si l'annonce
        // d'etape n'est jamais arrivee.
        warm = true
        keepAlive()
        done(vectors, null)
      },
      // Un echec de vectorisation n'est pas une erreur fatale : on rend la main
      // sans vecteurs et la recherche lexicale prend le relais. La raison, elle,
      // repart avec l'appel — c'est le seul endroit ou le moteur explique son
      // refus, et le seul moyen que deux cours ne se volent pas leur message.
      reject: (error) => done(null, error.message)
    }

    pending.set(id, entry)
    worker.stdin.write(`${JSON.stringify({ id, texts, kind, titles })}\n`)
  })
}

/**
 * Ferme le processus et rend sa memoire. Appele a la fermeture de la fenetre,
 * a celle de l'application, et apres un long silence. Sans effet si le
 * processus n'a jamais demarre.
 */
/**
 * Lance le chargement du modele sans rien attendre — quand on devine qu'une
 * question arrive : la barre de l'assistant prend le focus. Le premier message
 * d'une conversation trouve alors un moteur deja chaud pour choisir ce que la
 * memoire lui rappelle, et la premiere recherche du modele n'attend pas non
 * plus. Sans effet si le moteur tourne deja.
 */
export function warmEmbedder(): void {
  if (warm && child) return
  void embed(['Noted'], 'query').catch(() => undefined)
}

/** Vrai tant qu'un calcul est confie au moteur et attend sa reponse. */
export function embedderBusy(): boolean {
  return pending.size > 0
}

export function disposeEmbedder(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  const dying = child
  child = null
  // `kill` ne fait qu'envoyer un signal : la sortie effective, et donc `die`,
  // n'arrivent qu'au tour de boucle suivant. Rien ici n'attend ce tour — mais
  // `die` s'en chargera, et ne liberera que les requetes de ce processus.
  dying?.kill()
}
