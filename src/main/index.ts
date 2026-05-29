import { app, BrowserWindow, shell, globalShortcut, session } from 'electron'
import { join } from 'path'
import { initDb, closeDb } from './db'
import { registerIpcHandlers } from './ipc'
import { killAllTerminals } from './services/pty-manager'
import { stopAllDevServers } from './services/dev-server'
import { closeEditorWatcher } from './ipc/editor.ipc'
import { initMcpExport } from './services/mcp-export'
import { appSetting } from './ipc/settings.ipc'
import { createVoiceWidget, destroyVoiceWidget } from './services/voice-widget'

// Nom d'app déterministe → userData = %APPDATA%/Oryon (la DB y migre depuis BridgeForge, cf. db/index.ts).
app.setName('Oryon')

// Port debug CDP — DEV UNIQUEMENT (jamais dans un build de production). Permet l'inspection/vérif headless.
if (process.env.NODE_ENV === 'development') app.commandLine.appendSwitch('remote-debugging-port', '9222')

const isDev = process.env.NODE_ENV === 'development'

function createWindow() {
  const win = new BrowserWindow({
    title: 'Oryon',
    icon: join(app.getAppPath(), 'app-logo.png'),
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox actif : le preload n'utilise que contextBridge/ipcRenderer (aucun module Node),
      // et tout le travail natif (SQLite, node-pty…) vit dans le main process.
      sandbox: true,
      // <webview> pour la preview localhost du panneau Browser (Phase 2).
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => win.show())
  // La fenêtre principale fermée → fermer aussi le widget flottant (sinon l'app ne quitte pas).
  win.on('closed', () => destroyVoiceWidget())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  try {
    initDb()
  } catch (err) {
    // La DB est une exigence Phase 0 ("DB créée") : échec = on quitte plutôt que tourner cassé.
    console.error('[DB] Erreur fatale à l\'initialisation :', err)
    app.quit()
    return
  }
  registerIpcHandlers()
  initMcpExport() // exporte l'état (terminaux/tasks/mailbox) pour le serveur MCP de debug
  registerMediaPermissions() // autorise le micro (getUserMedia) pour la dictée Voice — sinon « micro indisponible »
  createWindow()
  registerVoiceHotkey()
  if (appSetting('voice.showWidget') !== '0') createVoiceWidget() // widget flottant (activé par défaut)
  void initAutoUpdate() // auto-update (electron-updater) — uniquement en build packagé

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Autorise les permissions média (micro) pour getUserMedia dans le renderer sandboxé. Sans ça, Chromium
 * rejette getUserMedia → « Micro indisponible ». On n'autorise QUE l'audio (jamais la caméra/géoloc/etc.).
 */
function registerMediaPermissions(): void {
  const ALLOWED = new Set(['media', 'audioCapture'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission))
}

/** Hotkeys globales de dictée (toggle) et de command mode → notifient le renderer. Défauts configurables. */
function registerVoiceHotkey(): void {
  const broadcast = (channel: string): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel)
  }
  const toggleAccel = appSetting('voice.hotkey.toggle') || appSetting('voice.hotkey') || 'CommandOrControl+Shift+Space'
  const commandAccel = appSetting('voice.hotkey.command') || 'CommandOrControl+Shift+.'
  // Coalescence leading-edge : deux voice:toggle rapprochés (hotkey + widget, ou rebond) ne doivent pas
  // démarrer-puis-arrêter aussitôt une capture.
  let lastToggle = 0
  const sendToggle = (): void => {
    const now = Date.now()
    if (now - lastToggle < 250) return
    lastToggle = now
    broadcast('voice:toggle')
  }
  try {
    globalShortcut.register(toggleAccel, sendToggle)
  } catch (e) {
    console.error('[voice] enregistrement hotkey dictée échoué :', (e as Error).message)
  }
  try {
    if (commandAccel && commandAccel !== toggleAccel) globalShortcut.register(commandAccel, () => broadcast('voice:command-key'))
  } catch (e) {
    console.error('[voice] enregistrement hotkey command mode échoué :', (e as Error).message)
  }
}

/**
 * Auto-update via electron-updater (GitHub Releases, cf. electron-builder.yml). Actif UNIQUEMENT en build
 * packagé : en dev, app.isPackaged est false → on ne fait rien (pas d'app-update.yml de toute façon).
 * Import dynamique pour ne pas charger le module hors prod.
 */
async function initAutoUpdate(): Promise<void> {
  if (!app.isPackaged) return
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = true
    await autoUpdater.checkForUpdatesAndNotify()
  } catch (e) {
    console.error('[update] échec de la vérification des mises à jour :', (e as Error).message)
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  destroyVoiceWidget()
  killAllTerminals()
  stopAllDevServers()
  closeEditorWatcher()
  closeDb()
})
