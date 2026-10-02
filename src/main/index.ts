import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { geometrieRetenue, suivreGeometrie } from './fenetre'
import { FEUX_REPOS, registerIpc } from './ipc'
import { declareMediaScheme, serveMedia } from './media'
import { buildMenu } from './menu'
import { demarrerMiseAJourClaude } from './claude/mise-a-jour'
import { disposeAllSessions } from './claude/session'
import { sortirDeVoix } from './voix/session'
import { scanForGeneration } from './flashcards/generation'
import { seedPrompts } from './prompts/store'
import { disposeEmbedder, embedderBusy } from './rag/embedder'
import { veillerSurLesCours } from './veille'
import { ensureVault } from './vault'

let mainWindow: BrowserWindow | null = null

// Doit precede `app.whenReady` : un schema declare trop tard n'est pas
// enregistre, et toutes les images des cours Word resteraient vides — sans la
// moindre erreur pour le dire.
declareMediaScheme()

function createWindow(): BrowserWindow {
  const geometrie = geometrieRetenue()

  const window = new BrowserWindow({
    ...geometrie,
    // En dessous de cette largeur les trois panneaux deviennent illisibles ;
    // autant empecher la fenetre d'y descendre.
    minWidth: 1080,
    minHeight: 680,
    show: false,
    // Barre de titre discrete facon application native macOS. La position des
    // feux vit dans ipc.ts, qui la rejoue a chaque changement de barre : la
    // poser ici aussi, en dur, c'est exactement ce qui les avait laisses
    // desaxes de 6px des la premiere navigation.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: FEUX_REPOS,
    // Doit rester accorde a --paper dans tokens.css : c'est cette couleur qui
    // remplit la fenetre avant que le rendu arrive.
    backgroundColor: '#f6f2ea',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Le renderer ne doit jamais toucher a Node : tout passe par le preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (geometrie.plein) window.setFullScreen(true)
  suivreGeometrie(window)
  veillerSurLesCours(window)

  // Afficher seulement quand le rendu est pret evite le flash blanc au lancement.
  window.once('ready-to-show', () => window.show())

  // Les liens externes s'ouvrent dans le navigateur, jamais dans l'application.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Le gardien ci-dessus ne voit que les nouvelles fenetres. Un lien ordinaire
  // d'un document — un cours HTML en est plein — ferait, lui, naviguer la
  // fenetre elle-meme : l'application entiere remplacee par la page visee,
  // sans bouton retour. Seul le rechargement de la page de l'application
  // (serveur de developpement) reste permis.
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (current && new URL(url).origin === new URL(current).origin) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

void app.whenReady().then(async () => {
  app.setName('Noted')

  await ensureVault()
  await seedPrompts()
  serveMedia()
  registerIpc(() => mainWindow)
  buildMenu()

  mainWindow = createWindow()

  // Des surlignages ont pu etre poses juste avant une fermeture, ou une
  // generation echouer hors ligne : on rattrape en tache de fond, apres avoir
  // laisse l'application s'installer.
  void scanForGeneration()

  // Garde le CLI Claude Code a jour, pour que les nouveaux modeles apparaissent.
  demarrerMiseAJourClaude()

  app.on('activate', () => {
    // Sur macOS, cliquer l'icone du Dock rouvre une fenetre si tout est ferme.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // Convention macOS : l'application reste active sans fenetre. Le modele
  // charge pese trop lourd pour qu'on le laisse dormir dans la memoire d'une
  // machine dont on ne se sert plus, et il se rechargera a la reouverture.
  //
  // Mais fermer la fenetre au bouton rouge n'annule pas ce qui est en cours :
  // un cours a moitie vectorise perdait ainsi sa tranche entamee a chaque fois.
  // Le calcul va au bout, et la minuterie d'inactivite rendra la memoire une
  // fois qu'il n'y aura plus rien a attendre.
  if (!embedderBusy()) disposeEmbedder()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * Dernier filet du processus principal.
 *
 * Une promesse rejetee que personne n'attend ne laisse aucune trace : ni
 * message, ni journal, ni indice a l'ecran. Sur un travail de fond comme la
 * vectorisation, lance et oublie, c'est exactement la panne qu'on ne trouve
 * pas. La consigner ne repare rien, mais elle cesse d'etre invisible.
 */
process.on('unhandledRejection', (cause) => {
  console.error('[Noted] promesse rejetee sans destinataire :', cause)
})

app.on('before-quit', () => {
  // Chaque session Claude tient un sous-processus ouvert, et le calcul des
  // vecteurs un autre : il faut les fermer explicitement, sinon ils survivent
  // a l'application. Le helper vocal aussi, et lui tient le micro.
  void sortirDeVoix()
  disposeAllSessions()
  disposeEmbedder()
})
