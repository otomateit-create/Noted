/**
 * La session vocale d'un cours : une seule a la fois dans l'application.
 *
 * Elle tient les trois fils du mode voix et les fait se repondre :
 *
 * - l'oreille (helper.swift) : le micro reste ouvert, l'analyseur rend ce qu'il
 *   comprend au fil de l'eau ; c'est ici qu'on decide qu'une question est
 *   finie (un silence apres des mots) ou que l'utilisateur coupe l'assistant
 *   (des mots pendant que la voix parle) ;
 * - la conversation (claude/session.ts, en flux) : la meme que l'ecrit, reprise
 *   la ou elle en etait, et rendue a l'ecrit telle qu'on la laisse ;
 * - la bouche : le texte du modele, decoupe en phrases a mesure qu'il arrive,
 *   part a la voix phrase par phrase ; chaque mot prononce est rapporte, pour
 *   savoir, a la coupure, ce qui a ete reellement entendu.
 *
 * Le point delicat est la coupure. Le modele ecrit bien plus vite que la voix
 * ne lit : coupe apres vingt secondes, il a souvent tout redige. Le transcript
 * garde tout ce texte (c'est `interrupt()` qui le garantit) ; ce qui a ete
 * entendu, lui, n'est connu que d'ici. On le joint donc au message suivant
 * (voir blocs.ts), pour que le modele raisonne sur ce qui a ete dit et non sur
 * ce qu'il a produit.
 */

import { systemPreferences } from 'electron'
import type {
  ChatStreamEvent,
  Course,
  VoixDisponible,
  VoixEntree,
  VoixEtat,
  VoixOuverture,
  VoixParole,
  VoixPhase,
  VoixTour
} from '../../shared/types'
import { describeError, ouvrirSessionFlux } from '../claude/session'
import type { SessionFlux } from '../claude/session'
import { composePrompt } from '../prompts/store'
import { findCourse } from '../vault'
import { blocCoupure, blocTourParle } from './blocs'
import type { Coupure } from './blocs'
import { HelperVoix } from './helper'
import { VOIX, VOIX_PAR_DEFAUT, endormir, reveiller, synthetiser } from './kokoro'
import type { EvenementVoix } from './helper'
import { Decoupeur, compterMots, pourLaVoix } from './parole'
import type { Phrase } from './parole'

/**
 * Le silence apres lequel une question est tenue pour finie. Trop court, il
 * coupe une phrase qu'on cherche ; trop long, la reponse traine. Une seconde
 * et des poussieres est le temps d'une respiration entre deux phrases dites
 * pour de bon.
 */
const SILENCE_MS = 1100
/** Apres avoir demande a l'analyseur de trancher, le temps qu'on lui laisse. */
const ATTENTE_FINAL_MS = 800
/**
 * Les mots qui, seuls, suffisent a couper : ce qu'on dit quand on interrompt
 * quelqu'un. Un seul mot ordinaire ne coupe pas — c'est la marge contre les
 * residus d'echo — mais « attends » ou « stop » n'attendent pas un second mot.
 */
const MOTS_D_INTERRUPTION = new Set([
  'attends', 'attend', 'attendez', 'stop', 'pause', 'arrête', 'arrete', 'arrêtez', 'arretez',
  'non', 'pardon', 'excuse', 'excusez', 'question', 'reviens', 'revenez', 'répète', 'repete',
  'répétez', 'repetez', 'reprends', 'reprenez', 'doucement', 'hop', 'ok', 'okay', 'oui', 'euh'
])

/**
 * Apres l'envoi d'une question, le temps pendant lequel un resultat qui la
 * repete est tenu pour un retard de l'analyseur et non pour de nouveaux mots.
 * Sans cela, la question rejouee en « final » tardif passerait pour quelqu'un
 * qui parle, et couperait l'assistant a tort.
 */
const ECHO_QUESTION_MS = 4000
/** Le temps laisse au micro et a la voix pour s'ouvrir. */
const OUVERTURE_MS = 12_000

/** Ou vont les evenements de la session : vers le renderer, par l'IPC. */
export interface Emetteurs {
  etat(etat: VoixEtat): void
  tour(tour: VoixTour): void
  parole(parole: VoixParole): void
  flux(event: ChatStreamEvent): void
}

/** Une phrase donnee a la voix, et ce qu'elle est devenue. */
interface PhraseDite {
  id: string
  /** Ce qui est prononce — le texte mis au propre pour la voix. */
  texte: string
  /** Ses bornes dans le texte brut de la reponse. */
  debut: number
  fin: number
  etat: 'en-file' | 'en-cours' | 'dite' | 'coupee' | 'abandonnee'
}

/** Un tour parle : la reponse en train de s'ecrire et de se dire. */
interface TourParle {
  messageId: string
  decoupeur: Decoupeur
  phrases: Map<string, PhraseDite>
  ordre: string[]
  /** La phrase que la voix lit, et jusqu'ou elle en est (fin du dernier mot commence). */
  enCours: string | null
  jusqua: number
  compteur: number
  /** Le modele a fini d'ecrire. */
  genere: boolean
  /** Tout a ete dit, ou coupe. */
  fini: boolean
  coupe: boolean
  /**
   * Les phrases partent a la synthese l'une apres l'autre : le moteur n'en
   * calcule qu'une a la fois, et l'ordre de la reponse doit etre celui de la
   * lecture.
   */
  file: Promise<void>
}

let courante: SessionVocale | null = null

/** Ouvre le mode voix sur un cours. Une session deja ouverte est fermee d'abord. */
export async function entrerEnVoix(input: VoixEntree, emetteurs: Emetteurs): Promise<VoixOuverture> {
  if (courante) await courante.fermer()
  const course = await findCourse(input.courseId)
  const session = new SessionVocale(course, input, emetteurs)
  courante = session
  const ouverture = await session.ouvrir()
  if (!ouverture.ok && courante === session) courante = null
  return ouverture
}

/** Ferme le mode voix ; la conversation ecrite reprend la meme session. */
export async function sortirDeVoix(): Promise<void> {
  const session = courante
  courante = null
  if (session) await session.fermer()
}

export function sessionVocale(): SessionVocale | null {
  return courante
}

/**
 * L'acces au micro, demande a macOS au premier usage. La description qui
 * s'affiche est celle du package.json (NSMicrophoneUsageDescription).
 */
async function autoriserMicro(): Promise<string | null> {
  const statut = systemPreferences.getMediaAccessStatus('microphone')
  if (statut === 'granted') return null
  if (statut === 'not-determined') {
    const accorde = await systemPreferences.askForMediaAccess('microphone')
    if (accorde) return null
  }
  return "Noted n'a pas accès au micro. Autorise-le dans Réglages Système › Confidentialité et sécurité › Microphone, puis réessaie."
}

export class SessionVocale {
  private phase: VoixPhase = 'ouverture'
  private helper: HelperVoix | null = null
  private flux: SessionFlux | null = null
  private voix: VoixDisponible[] = VOIX
  private voixChoisie = VOIX_PAR_DEFAUT
  private vitesse = 1
  private detail: string | undefined
  private erreur: string | undefined
  private fermee = false
  private attenteMicro: ((raison: string | null) => void) | null = null

  // L'ecoute : ce que l'analyseur a tranche, et ce qu'il hesite encore a dire.
  private segments: string[] = []
  private volatil = ''
  private silence: NodeJS.Timeout | null = null
  private generation = 0
  private finalAttendu: (() => void) | null = null

  /** La derniere question partie, pour reconnaitre son echo tardif. */
  private questionEnvoyee: { texte: string; quand: number } | null = null

  // La parole.
  private tour: TourParle | null = null
  private coupure: Coupure | null = null
  private coupureEnCours: Promise<void> | null = null

  constructor(
    private readonly course: Course,
    private readonly entree: VoixEntree,
    private readonly emetteurs: Emetteurs
  ) {}

  async ouvrir(): Promise<VoixOuverture> {
    const refus = await autoriserMicro()
    if (refus) return { ok: false, raison: refus }

    // Un reglage garde d'une version precedente peut nommer une voix du
    // systeme, qui n'existe plus ici : on ne retient que ce qu'on sait dire.
    if (VOIX.some((voix) => voix.id === this.entree.reglages?.voix)) {
      this.voixChoisie = this.entree.reglages?.voix as string
    }
    if (this.entree.reglages?.vitesse) this.vitesse = this.entree.reglages.vitesse

    // Le helper, la conversation et le modele de voix s'ouvrent ensemble : le
    // micro prend une seconde, la conversation deux, et le modele se charge
    // pendant ce temps pour que la premiere phrase parte sans attendre.
    const helperPret = this.lancerHelper()
    void reveiller(this.voixChoisie).catch((erreur) => {
      if (this.fermee) return
      this.erreur = describeError(erreur)
      this.emettreEtat()
    })

    let flux: SessionFlux
    try {
      flux = await ouvrirSessionFlux(
        this.course,
        { model: this.entree.model, effort: this.entree.effort },
        () => {
          void this.fermer('La conversation a été fermée.')
        }
      )
    } catch (error) {
      this.helper?.arreter()
      this.helper = null
      return { ok: false, raison: describeError(error) }
    }
    this.flux = flux

    const raison = await helperPret
    if (raison !== null) {
      await this.fermer()
      return { ok: false, raison }
    }
    if (this.fermee) return { ok: false, raison: this.erreur ?? 'Le mode voix s’est fermé.' }

    this.phase = 'repos'
    this.emettreEtat()
    return { ok: true }
  }

  /** Lance le helper et attend que le micro soit ouvert. Rend la raison d'un echec, sinon null. */
  private lancerHelper(): Promise<string | null> {
    return new Promise((resolve) => {
      let regle = false
      const conclure = (raison: string | null): void => {
        if (regle) return
        regle = true
        clearTimeout(minuteur)
        this.attenteMicro = null
        resolve(raison)
      }
      const minuteur = setTimeout(() => conclure("Le micro n'a pas répondu à temps."), OUVERTURE_MS)
      this.attenteMicro = conclure

      const helper = new HelperVoix(
        (evenement) => this.surHelper(evenement),
        (raison) => {
          conclure(raison)
          void this.fermer(raison)
        }
      )
      this.helper = helper
      helper.lancer()
    })
  }

  choisirVoix(id: string): void {
    this.voixChoisie = id
    this.emettreEtat()
    // Le timbre se telecharge au premier usage : autant le faire maintenant,
    // pendant qu'on lit, plutot qu'au milieu d'une reponse.
    void reveiller(id).catch(() => {
      // Le prochain tour de parole le redira, avec son message.
    })
  }

  regler(vitesse: number): void {
    this.vitesse = vitesse
  }

  /** Un fichier audio verse dans le micro — pour les tests, faute de voix humaine. */
  injecter(chemin: string): void {
    this.helper?.envoyer({ cmd: 'injecter', chemin })
  }

  async fermer(raison?: string): Promise<void> {
    if (this.fermee) return
    this.fermee = true
    if (this.silence) clearTimeout(this.silence)
    this.attenteMicro?.(raison ?? 'Le mode voix s’est fermé.')

    const helper = this.helper
    const flux = this.flux
    this.helper = null
    this.flux = null

    helper?.envoyer({ cmd: 'stop' })
    // Un tour en cours est coupe proprement : son texte partiel reste dans la
    // conversation, et l'ecrit le retrouvera.
    if (flux) {
      try {
        if (flux.occupe) await flux.couper()
      } catch {
        // Le flux etait deja ferme.
      }
      flux.fermer()
    }
    helper?.envoyer({ cmd: 'taire' })
    helper?.arreter()
    // Le modele rend ses cinq cents megaoctets tout de suite : on sort du mode
    // voix, il n'a plus rien a dire.
    endormir()

    this.phase = 'ferme'
    this.erreur = raison
    this.emetteurs.etat({ phase: 'ferme', erreur: raison })
    if (courante === this) courante = null
  }

  // -------------------------------------------------------------------------
  // Ce que dit le helper
  // -------------------------------------------------------------------------

  private surHelper(evenement: EvenementVoix): void {
    if (this.fermee) return
    switch (evenement.ev) {
      case 'pret':
        if (!evenement.transcription) {
          this.attenteMicro?.('La transcription hors ligne demande macOS 26.')
          return
        }
        this.helper?.envoyer({ cmd: 'ecouter' })
        return
      case 'micro':
        if (evenement.ouvert) this.attenteMicro?.(null)
        return
      case 'telechargement':
        this.detail = evenement.etat === 'debut' ? 'Téléchargement du modèle de transcription…' : undefined
        this.emettreEtat()
        return
      case 'resultat':
        this.surResultat(evenement.texte, evenement.final)
        return
      case 'debut':
        this.surDebut(evenement.id)
        return
      case 'mot':
        this.surMot(evenement.id, evenement.debut + evenement.longueur)
        return
      case 'fin':
        this.surFin(evenement.id)
        return
      case 'erreur':
        if (this.attenteMicro) {
          this.attenteMicro(evenement.message)
          return
        }
        this.erreur = evenement.message
        this.emettreEtat()
        return
      default:
        return
    }
  }

  private emettreEtat(): void {
    if (this.fermee) return
    this.emetteurs.etat({
      phase: this.phase,
      transcription: this.texteEntendu() || undefined,
      detail: this.detail,
      erreur: this.erreur,
      voix: this.voix,
      voixChoisie: this.voixChoisie
    })
  }

  // -------------------------------------------------------------------------
  // L'ecoute
  // -------------------------------------------------------------------------

  private texteEntendu(): string {
    return [...this.segments, this.volatil.trim()].filter(Boolean).join(' ')
  }

  private surResultat(texte: string, final: boolean): void {
    // L'analyseur rejoue parfois, apres coup, la question qui vient de partir
    // — sa finalisation arrivait en retard. Ce n'est pas quelqu'un qui parle.
    const envoyee = this.questionEnvoyee
    if (
      envoyee &&
      Date.now() - envoyee.quand < ECHO_QUESTION_MS &&
      texte.trim() &&
      envoyee.texte.includes(texte.trim())
    ) {
      this.volatil = ''
      return
    }

    if (final) {
      this.volatil = ''
      if (texte.trim()) this.segments.push(texte.trim())
      // Un final que nous avions demande (fin de question) : il n'ouvre pas
      // une nouvelle ecoute, il conclut la precedente.
      const attendu = this.finalAttendu
      if (attendu) {
        this.finalAttendu = null
        attendu()
        return
      }
    } else {
      this.volatil = texte
    }

    const entendu = this.texteEntendu()
    const mots = compterMots(entendu)
    // Quelqu'un parle vraiment : deux mots ; ou un seul, si c'est un mot
    // d'interruption, ou si l'analyseur l'a tranche et qu'il a de la
    // substance. « C' » — le residu d'echo mesure — ne passe pas ; « Attends »
    // ou « Stop » passent sans attendre la suite.
    const premier = entendu.toLowerCase().match(/[\p{L}]+/u)?.[0] ?? ''
    const parleVraiment =
      mots >= 2 ||
      (mots === 1 && MOTS_D_INTERRUPTION.has(premier)) ||
      (final && mots >= 1 && /\p{L}{3,}/u.test(entendu))

    switch (this.phase) {
      case 'parole':
      case 'reflexion':
        if (parleVraiment) {
          this.phase = 'ecoute'
          this.armerSilence()
          this.coupureEnCours = this.couper()
          this.emettreEtat()
        } else if (final) {
          // Un souffle, un residu : rien qui merite d'etre garde.
          this.segments = []
        }
        return
      case 'repos':
        if (mots >= 1) {
          this.phase = 'ecoute'
          this.armerSilence()
          this.emettreEtat()
        } else if (final) {
          this.segments = []
        }
        return
      case 'ecoute':
        this.armerSilence()
        this.emettreEtat()
        return
      default:
        return
    }
  }

  private armerSilence(): void {
    if (this.silence) clearTimeout(this.silence)
    const generation = ++this.generation
    this.silence = setTimeout(() => void this.finDeQuestion(generation), SILENCE_MS)
  }

  /** Le silence est venu : la question est finie, sauf s'il a repris entre-temps. */
  private async finDeQuestion(generation: number): Promise<void> {
    if (this.fermee || this.phase !== 'ecoute' || generation !== this.generation) return

    // Le dernier mot est peut-etre encore volatil : on demande a l'analyseur
    // de trancher, sans l'attendre plus d'une demi-seconde.
    if (this.volatil) {
      await new Promise<void>((resolve) => {
        const minuteur = setTimeout(() => {
          this.finalAttendu = null
          resolve()
        }, ATTENTE_FINAL_MS)
        this.finalAttendu = () => {
          clearTimeout(minuteur)
          resolve()
        }
        this.helper?.envoyer({ cmd: 'finaliser' })
      })
    }
    if (this.fermee || this.phase !== 'ecoute' || generation !== this.generation) return

    const question = this.texteEntendu()
    this.segments = []
    this.volatil = ''
    this.questionEnvoyee = { texte: question, quand: Date.now() }

    // Pas un mot qui tienne debout : ce n'etait pas une question.
    if (!/\p{L}{2,}/u.test(question)) {
      this.phase = 'repos'
      this.emettreEtat()
      return
    }

    await this.envoyer(question)
  }

  // -------------------------------------------------------------------------
  // Le tour parle
  // -------------------------------------------------------------------------

  private async envoyer(question: string): Promise<void> {
    const flux = this.flux
    if (!flux || this.fermee) return

    // La coupure precedente doit avoir abouti — le tour coupe, fini — avant
    // que le suivant parte.
    if (this.coupureEnCours) {
      await this.coupureEnCours
      this.coupureEnCours = null
    }
    if (this.fermee) return

    const messageId = `v-${Date.now()}`
    const tour: TourParle = {
      messageId,
      decoupeur: new Decoupeur(),
      phrases: new Map(),
      ordre: [],
      enCours: null,
      jusqua: 0,
      compteur: 0,
      genere: false,
      fini: false,
      coupe: false,
      file: Promise.resolve()
    }
    this.tour = tour
    this.phase = 'reflexion'
    this.detail = undefined
    this.erreur = undefined
    this.emetteurs.tour({ courseId: this.course.id, messageId, texte: question })
    this.emettreEtat()

    const prompt = await this.avecBlocs(question)
    await flux.poser(prompt, messageId, (event) => this.surFlux(tour, event))
  }

  /** Les mots de l'utilisateur, puis ce que l'application y joint. */
  private async avecBlocs(question: string): Promise<string> {
    const blocs: string[] = []
    try {
      blocs.push(blocTourParle(await composePrompt('voix')))
    } catch {
      // Style illisible : le message part sans, la voix lira ce qu'elle peut.
    }
    if (this.coupure) {
      blocs.push(blocCoupure(this.coupure))
      this.coupure = null
    }
    return `${question}\n\n${blocs.join('\n\n')}`
  }

  private surFlux(tour: TourParle, event: ChatStreamEvent): void {
    // Le fil ecrit recoit tout, coupe ou non : c'est la meme conversation.
    this.emetteurs.flux(event)
    if (tour !== this.tour || tour.coupe || this.fermee) return

    switch (event.kind) {
      case 'text':
        for (const phrase of tour.decoupeur.pousser(event.delta)) this.dire(tour, phrase)
        return
      case 'tool':
        this.detail = event.call.summary
        this.emettreEtat()
        return
      case 'tool-result':
        this.detail = undefined
        this.emettreEtat()
        return
      case 'done': {
        const reste = tour.decoupeur.vider()
        if (reste) this.dire(tour, reste)
        tour.genere = true
        this.detail = undefined
        this.verifierFin(tour)
        return
      }
      case 'error':
        tour.genere = true
        this.erreur = event.message
        this.verifierFin(tour)
        return
      default:
        return
    }
  }

  /**
   * Une phrase prete a etre dite. Elle part d'abord au modele, qui en rend un
   * fichier et l'instant de chacun de ses mots ; le helper ne fait que le
   * jouer. La file preserve l'ordre : une phrase courte calculee plus vite que
   * la precedente ne la double pas.
   */
  private dire(tour: TourParle, phrase: Phrase): void {
    const texte = pourLaVoix(phrase.texte)
    if (!/[\p{L}\p{N}]/u.test(texte)) return
    const id = `${tour.messageId}:${tour.compteur++}`
    tour.phrases.set(id, { id, texte, debut: phrase.debut, fin: phrase.fin, etat: 'en-file' })
    tour.ordre.push(id)
    tour.file = tour.file.then(async () => {
      if (tour !== this.tour || tour.coupe || this.fermee) {
        this.abandonner(tour, id)
        return
      }
      try {
        const parole = await synthetiser(texte, this.voixChoisie, this.vitesse)
        if (!parole || tour.coupe || this.fermee) {
          this.abandonner(tour, id)
          return
        }
        this.helper?.envoyer({ cmd: 'jouer', id, chemin: parole.chemin, jalons: parole.jalons })
      } catch (erreur) {
        this.erreur = describeError(erreur)
        this.abandonner(tour, id)
        this.emettreEtat()
      }
    })
  }

  /**
   * Une phrase qui ne sera pas dite — coupee avant son tour, ou perdue par le
   * moteur — ne doit pas retenir la fin du tour : sans cela, la session
   * resterait a jamais en train de parler.
   */
  private abandonner(tour: TourParle, id: string): void {
    const phrase = tour.phrases.get(id)
    if (phrase && phrase.etat === 'en-file') phrase.etat = 'abandonnee'
    this.verifierFin(tour)
  }

  private surDebut(id: string): void {
    const tour = this.tour
    const phrase = tour?.phrases.get(id)
    if (!tour || !phrase || tour.coupe) return
    phrase.etat = 'en-cours'
    tour.enCours = id
    tour.jusqua = 0
    if (this.phase === 'reflexion') {
      this.phase = 'parole'
      this.detail = undefined
      this.emettreEtat()
    }
    this.emetteurs.parole({ messageId: tour.messageId, phrase: phrase.texte, jusqua: 0 })
  }

  private surMot(id: string, jusqua: number): void {
    const tour = this.tour
    if (!tour || tour.enCours !== id || tour.coupe) return
    tour.jusqua = jusqua
    const phrase = tour.phrases.get(id)
    if (phrase) this.emetteurs.parole({ messageId: tour.messageId, phrase: phrase.texte, jusqua })
  }

  private surFin(id: string): void {
    const tour = this.tour
    const phrase = tour?.phrases.get(id)
    if (!tour || !phrase || tour.coupe) return
    phrase.etat = 'dite'
    if (tour.enCours === id) {
      tour.enCours = null
      tour.jusqua = 0
    }
    this.verifierFin(tour)
  }

  /** Tout est ecrit et tout est dit : la voix se tait, on ecoute. */
  private verifierFin(tour: TourParle): void {
    if (tour.fini || !tour.genere || tour.enCours !== null) return
    for (const phrase of tour.phrases.values()) if (phrase.etat === 'en-file') return
    tour.fini = true
    if (this.phase === 'reflexion' || this.phase === 'parole') {
      this.phase = 'repos'
      this.emettreEtat()
    }
    this.emetteurs.parole({ messageId: tour.messageId, phrase: '', jusqua: 0 })
  }

  /**
   * L'utilisateur coupe. La voix se tait sur-le-champ ; le tour, s'il ecrit
   * encore, est interrompu ; et l'on note ce qui a ete entendu, pour le dire
   * au modele avec la prochaine question.
   */
  private async couper(): Promise<void> {
    const tour = this.tour
    const flux = this.flux
    this.helper?.envoyer({ cmd: 'stop' })

    if (!tour || tour.coupe) {
      if (flux?.occupe) await flux.couper()
      return
    }
    tour.coupe = true

    const phrases = tour.ordre.map((id) => tour.phrases.get(id) as PhraseDite)
    const dites = phrases.filter((phrase) => phrase.etat === 'dite')
    const coupee = tour.enCours ? (tour.phrases.get(tour.enCours) ?? null) : null
    for (const phrase of phrases) if (phrase.etat === 'en-file') phrase.etat = 'abandonnee'
    if (coupee) coupee.etat = 'coupee'

    // Le mot commence au moment de la coupure compte comme entendu : on a
    // eu le temps d'en entendre l'attaque.
    const partiel = coupee ? coupee.texte.slice(0, tour.jusqua).trim() : ''
    const entendu = [...dites.map((phrase) => phrase.texte), partiel].filter(Boolean).join(' ')
    const motCoupe = partiel ? partiel.split(/\s+/).pop() : undefined
    const at = coupee ? positionBrute(tour, coupee, partiel) : (dites.at(-1)?.fin ?? 0)

    this.coupure = { entendu, motCoupe, avantParole: !entendu }
    tour.enCours = null
    tour.fini = true
    this.emetteurs.flux({ kind: 'coupure', messageId: tour.messageId, at })
    this.emetteurs.parole({ messageId: tour.messageId, phrase: '', jusqua: 0 })

    if (flux?.occupe) await flux.couper()
  }
}

/**
 * Ou tombe la coupure dans le texte brut de la reponse. La voix lit un texte
 * mis au propre, dont les positions ne sont pas celles du brut : on retrouve
 * le dernier mot entendu dans la phrase brute, et a defaut on s'arrete au
 * debut de la phrase coupee.
 */
function positionBrute(tour: TourParle, coupee: PhraseDite, partiel: string): number {
  const mot = partiel.split(/\s+/).pop()
  if (!mot) return coupee.debut
  const brut = tour.decoupeur.texte
  const position = brut.indexOf(mot, coupee.debut)
  return position >= 0 && position < coupee.fin ? position + mot.length : coupee.debut
}
