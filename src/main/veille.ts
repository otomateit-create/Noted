/**
 * Surveillance du dossier des cours.
 *
 * Le vault est un dossier ordinaire, et c'est tout l'interet : on y depose un
 * PDF depuis le Finder, on y jette une matiere a la corbeille d'un glissement.
 * L'application ne peut pas etre la derniere informee de ce qui se passe dans
 * son propre dossier — un ecran d'accueil qui affiche encore une matiere
 * effacee cinq minutes plus tot cesse d'etre digne de confiance.
 *
 * On surveille Cours/ et rien d'autre. Notes/ ne decide de rien a l'ecran, et
 * .noted/ se remplit de vecteurs pendant l'indexation : le surveiller
 * declencherait une averse d'evenements pour du cache.
 */

import { watch, type FSWatcher } from 'node:fs'
import type { BrowserWindow } from 'electron'
import { CHANNELS } from '../shared/channels'
import { vaultPaths } from './vault'

/**
 * FSEvents ne rend pas un evenement par geste mais un par fichier touche :
 * copier un dossier de douze PDF en produit des dizaines. On attend que le
 * calme revienne avant de prevenir le renderer, une seule fois.
 */
const REPOS = 300

/** Si le dossier Cours/ disparait lui-meme, le temps de le laisser revenir. */
const RECONNEXION = 1500

export function veillerSurLesCours(window: BrowserWindow): void {
  let veilleur: FSWatcher | null = null
  let annonce: NodeJS.Timeout | null = null
  let reprise: NodeJS.Timeout | null = null
  /** Vrai quand Cours/ est introuvable : evite de le repeter a chaque essai. */
  let perdu = false

  const prevenir = (): void => {
    annonce = null
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.vaultChanged)
  }

  const differer = (): void => {
    if (annonce) clearTimeout(annonce)
    annonce = setTimeout(prevenir, REPOS)
  }

  const ouvrir = (): void => {
    reprise = null
    try {
      // recursive : sur macOS, FSEvents remonte aussi les sous-dossiers, ce qui
      // couvre les matieres rangees par seance ou par theme.
      veilleur = watch(vaultPaths().courses, { recursive: true }, differer)
      veilleur.on('error', reouvrir)

      if (perdu) {
        perdu = false
        // Le dossier est revenu : son contenu a toutes les chances d'avoir
        // change pendant qu'on ne regardait pas.
        differer()
      }
    } catch {
      reouvrir()
    }
  }

  /**
   * Supprimer Cours/ lui-meme coupe la surveillance. C'est un geste possible
   * depuis le Finder : on reessaie en sourdine plutot que de rester aveugle
   * jusqu'au prochain lancement.
   */
  const reouvrir = (): void => {
    veilleur?.close()
    veilleur = null

    if (!perdu) {
      perdu = true
      // La disparition du dossier est elle-meme un changement : on le dit une
      // fois, puis on se tait tant qu'il n'est pas revenu.
      differer()
    }

    if (!reprise) reprise = setTimeout(ouvrir, RECONNEXION)
  }

  ouvrir()

  window.on('closed', () => {
    if (annonce) clearTimeout(annonce)
    if (reprise) clearTimeout(reprise)
    veilleur?.close()
    veilleur = null
  })
}
