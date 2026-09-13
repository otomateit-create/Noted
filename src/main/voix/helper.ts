/**
 * Le pilote du helper vocal (helper.swift) : un sous-processus natif, une
 * commande par ligne sur son entree, un evenement par ligne sur sa sortie.
 *
 * Ce module ne sait rien du mode voix lui-meme — il lance, ecrit, lit, et
 * previent quand le processus s'en va. C'est voix/session.ts qui decide.
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync } from 'node:fs'
import path from 'node:path'
import type { Jalon } from './kokoro'

/** Ce que le processus principal peut lui demander. */
export type CommandeVoix =
  /** Un fichier a jouer, avec l'instant de chacun de ses mots. */
  | { cmd: 'jouer'; id: string; chemin: string; jalons: Jalon[] }
  | { cmd: 'stop' }
  | { cmd: 'ecouter' }
  | { cmd: 'taire' }
  | { cmd: 'finaliser' }
  | { cmd: 'injecter'; chemin: string }
  | { cmd: 'quitter' }

/** Ce qu'il raconte. */
export type EvenementVoix =
  | { ev: 'pret'; transcription: boolean }
  | { ev: 'micro'; ouvert: boolean }
  | { ev: 'telechargement'; etat: 'debut' | 'fin' }
  | { ev: 'resultat'; texte: string; final: boolean }
  | { ev: 'debut'; id: string }
  | { ev: 'mot'; id: string; debut: number; longueur: number }
  | { ev: 'fin'; id: string }
  | { ev: 'arret'; id?: string; mot?: number }
  | { ev: 'injecte'; chemin: string }
  | { ev: 'erreur'; message: string }

function cheminHelper(): string {
  // Compile a cote du bundle du processus principal (voir scripts/construire-voix.mjs).
  // Une fois l'application packagee, le bundle vit dans une archive asar que seul
  // Electron sait ouvrir : le binaire, lui, est laisse en clair a cote.
  return path
    .join(__dirname, 'voix-helper')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

export class HelperVoix {
  private processus: ChildProcessWithoutNullStreams | null = null
  private tampon = ''
  private parti = false

  constructor(
    private readonly surEvenement: (evenement: EvenementVoix) => void,
    private readonly surSortie: (raison: string) => void
  ) {}

  lancer(): void {
    const chemin = cheminHelper()
    // L'empaquetage ne garantit pas le bit d'execution du binaire : on le
    // repose, ce qui ne coute rien quand il y est deja.
    try {
      chmodSync(chemin, 0o755)
    } catch {
      // Fichier absent : le lancement le dira.
    }
    const processus = spawn(chemin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.processus = processus

    processus.stdout.setEncoding('utf8')
    processus.stdout.on('data', (morceau: string) => {
      this.tampon += morceau
      let fin: number
      while ((fin = this.tampon.indexOf('\n')) >= 0) {
        const ligne = this.tampon.slice(0, fin)
        this.tampon = this.tampon.slice(fin + 1)
        if (!ligne.trim()) continue
        try {
          this.surEvenement(JSON.parse(ligne) as EvenementVoix)
        } catch {
          console.warn('[voix] ligne illisible du helper :', ligne)
        }
      }
    })

    processus.stderr.setEncoding('utf8')
    processus.stderr.on('data', (texte: string) => {
      // Les avertissements du systeme audio sont bavards et sans consequence ;
      // on les garde dans le journal, jamais a l'ecran.
      console.warn('[voix-helper]', texte.trim())
    })

    processus.on('error', (cause) => {
      if (this.parti) return
      this.parti = true
      this.surSortie(`Le helper vocal n'a pas pu démarrer : ${cause.message}`)
    })

    processus.on('exit', (code, signal) => {
      if (this.parti) return
      this.parti = true
      this.surSortie(
        code === 0 ? "Le helper vocal s'est arrêté." : `Le helper vocal s'est arrêté (${signal ?? code}).`
      )
    })
  }

  envoyer(commande: CommandeVoix): void {
    const processus = this.processus
    if (!processus || this.parti || !processus.stdin.writable) return
    processus.stdin.write(`${JSON.stringify(commande)}\n`)
  }

  /** Ferme proprement, puis de force si le processus traine. */
  arreter(): void {
    const processus = this.processus
    if (!processus) return
    this.parti = true
    try {
      processus.stdin.write(`${JSON.stringify({ cmd: 'quitter' })}\n`)
      processus.stdin.end()
    } catch {
      // Deja ferme.
    }
    const minuteur = setTimeout(() => {
      if (processus.exitCode === null) processus.kill('SIGKILL')
    }, 800)
    minuteur.unref()
    this.processus = null
  }
}
