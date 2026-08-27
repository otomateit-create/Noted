/**
 * Menu macOS.
 *
 * Reduit au strict necessaire : sans barre de menus, Couper / Copier / Coller
 * n'existent pas dans une application Electron empaquetee, et Quitter /
 * Masquer sont des conventions que tout Mac attend d'une application. Aucune
 * commande propre a Noted n'y figure — biblioteque, enregistrer, assistant,
 * recherche, raccourcis vivent tous dans la barre de titre de l'application,
 * pas dans celle du systeme (voir TitleBar.tsx).
 */

import { app, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

export function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'À propos de Noted' },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer Noted' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { role: 'unhide', label: 'Tout afficher' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter Noted' }
      ]
    },
    {
      label: 'Fichier',
      submenu: [{ role: 'close', label: 'Fermer la fenêtre' }]
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'pasteAndMatchStyle', label: 'Coller en conservant le style' },
        { role: 'selectAll', label: 'Tout sélectionner' }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'resetZoom', label: 'Taille réelle' },
        { role: 'zoomIn', label: 'Agrandir' },
        { role: 'zoomOut', label: 'Réduire' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' }
      ]
    },
    {
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Placer dans le Dock' },
        { role: 'zoom', label: 'Ajuster' },
        { type: 'separator' },
        { role: 'front', label: 'Tout ramener au premier plan' }
      ]
    }
  ]

  // Recharger la page et la console ne sont utiles qu'en developpement. Dans
  // l'application installee, ⌘R jetterait une note non encore ecrite : autant
  // que l'entree n'existe pas.
  if (process.env['ELECTRON_RENDERER_URL']) {
    template.push({
      label: 'Développement',
      submenu: [
        { role: 'reload', label: 'Recharger' },
        { role: 'forceReload', label: 'Recharger sans le cache' },
        { role: 'toggleDevTools', label: 'Console' }
      ]
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
