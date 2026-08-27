/**
 * Taille et position de la fenetre, d'une session a l'autre.
 *
 * Cela ne regarde pas le vault — ce n'est pas une donnee de travail, et un
 * dossier synchronise avec un autre Mac n'a aucune raison d'y imposer la
 * geometrie de celui-ci. Le fichier vit donc dans le dossier de reglages que
 * macOS reserve a l'application.
 */

import { app, screen } from 'electron'
import type { BrowserWindow, Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

interface Geometrie extends Rectangle {
  /** Restaurer une fenetre plein ecran doit la rouvrir plein ecran. */
  plein: boolean
}

const DEFAUT = { width: 1560, height: 1000 }

/** Le temps de laisser un glissement de fenetre se terminer avant d'ecrire. */
const REPOS = 400

function fichier(): string {
  return path.join(app.getPath('userData'), 'fenetre.json')
}

/**
 * Une fenetre restauree doit rester attrapable a la souris. Si elle avait ete
 * laissee sur un ecran externe aujourd'hui debranche, ses coordonnees pointent
 * dans le vide : on ne garde alors que ses dimensions et macOS la recentre.
 */
function visible(geometrie: Geometrie): boolean {
  return screen.getAllDisplays().some((ecran) => {
    const zone = ecran.workArea
    // Il suffit que la barre de titre soit atteignable.
    return (
      geometrie.x + geometrie.width > zone.x + 80 &&
      geometrie.x < zone.x + zone.width - 80 &&
      geometrie.y >= zone.y - 8 &&
      geometrie.y < zone.y + zone.height - 40
    )
  })
}

export function geometrieRetenue(): Partial<Geometrie> {
  try {
    const lu = JSON.parse(readFileSync(fichier(), 'utf8')) as Partial<Geometrie>

    const complet =
      typeof lu.x === 'number' &&
      typeof lu.y === 'number' &&
      typeof lu.width === 'number' &&
      typeof lu.height === 'number'

    if (!complet) return DEFAUT

    const geometrie = lu as Geometrie
    if (!visible(geometrie)) {
      return { width: geometrie.width, height: geometrie.height, plein: false }
    }
    return geometrie
  } catch {
    // Premier lancement, ou fichier illisible : les valeurs d'origine font
    // parfaitement l'affaire.
    return DEFAUT
  }
}

/** Met la fenetre sous surveillance : tout deplacement finit par etre retenu. */
export function suivreGeometrie(window: BrowserWindow): void {
  let minuteur: NodeJS.Timeout | null = null

  const retenir = (): void => {
    if (window.isDestroyed()) return
    // Une fenetre plein ecran ou en Dock renvoie des dimensions qui ne sont pas
    // celles qu'on veut retrouver ; on conserve les dernieres dimensions
    // normales, deja ecrites.
    if (window.isMinimized()) return

    const plein = window.isFullScreen()
    if (plein) {
      const connu = geometrieRetenue()
      if (typeof connu.x !== 'number') return
      ecrire({ ...(connu as Geometrie), plein: true })
      return
    }

    ecrire({ ...window.getNormalBounds(), plein: false })
  }

  const differer = (): void => {
    if (minuteur) clearTimeout(minuteur)
    minuteur = setTimeout(retenir, REPOS)
  }

  window.on('resize', differer)
  window.on('move', differer)
  window.on('enter-full-screen', differer)
  window.on('leave-full-screen', differer)

  window.on('close', () => {
    if (minuteur) clearTimeout(minuteur)
    retenir()
  })
}

function ecrire(geometrie: Geometrie): void {
  try {
    writeFileSync(fichier(), JSON.stringify(geometrie), 'utf8')
  } catch {
    // Ne pas savoir ou etait la fenetre n'empeche pas de travailler.
  }
}
