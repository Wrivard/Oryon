import { app, BrowserWindow, shell, globalShortcut, session, protocol } from 'electron'
import { join, extname } from 'path'
import { readFile } from 'fs/promises'
import { initDb, closeDb } from './db'
import { registerIpcHandlers } from './ipc'
import { killAllTerminals } from './services/pty-manager'
import { stopAllDevServers } from './services/dev-server'
import { closeEditorWatcher } from './ipc/editor.ipc'
import { initMcpExport } from './services/mcp-export'
import { appSetting } from './ipc/settings.ipc'
import { createVoiceWidget, destroyVoiceWidget } from './services/voice-widget'
import { initUpdater } from './services/updater'

// Nom d'app déterministe → userData = %APPDATA%/Oryon (la DB y migre depuis BridgeForge, cf. db/index.ts).
app.setName('Oryon')

// Port debug CDP — DEV UNIQUEMENT (jamais dans un build de production). Permet l'inspection/vérif headless.
if (process.env.NODE_ENV === 'development') app.commandLine.appendSwitch('remote-debugging-port', '9222')

// Schéma privilégié app:// (doit être déclaré AVANT app.ready) : sert le renderer packagé avec fetch/ONNX/
// CacheStorage fonctionnels (contrairement à file://). Voir le handler dans whenReady.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

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

  // Filet de sécurité : si le renderer tarde/échoue à peindre, on montre quand même la fenêtre après 6 s
  // (sinon un échec de chargement laisse une fenêtre invisible → « l'app ne fait rien », non diagnosticable).
  const showTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 6000)
  win.on('ready-to-show', () => {
    clearTimeout(showTimer)
    win.show()
  })
  // La fenêtre principale fermée → fermer aussi le widget flottant (sinon l'app ne quitte pas).
  win.on('closed', () => {
    clearTimeout(showTimer)
    destroyVoiceWidget()
  })

  // Visibilité des échecs packagés (app://) : un écran noir ou un renderer mort deviennent des logs clairs.
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error(`[window] did-fail-load code=${code} desc=${desc} url=${url}`),
  )
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error(`[window] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`),
  )

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    // Prod : servi via le schéma privilégié app:// (et NON file://) pour que fetch()/ONNX/CacheStorage marchent.
    win.loadURL('app://oryon/index.html')
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
  // Sert le renderer packagé via app:// (out/renderer/*). En dev on utilise ELECTRON_RENDERER_URL (intact).
  // On LIT le fichier avec fs (compatible asar) et on renvoie une Response — surtout PAS net.fetch() sur une
  // URL file:// PROFONDE dans l'asar : asar est un patch fs Node, invisible au loader file:// de Chromium,
  // donc net.fetch plantait le network service → renderer crash → fenêtre (show:false) jamais affichée.
  const rendererRoot = join(__dirname, '../renderer')
  const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  }
  protocol.handle('app', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html'
    try {
      const data = await readFile(join(rendererRoot, rel))
      const type = MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
      return new Response(new Uint8Array(data), { headers: { 'content-type': type } })
    } catch {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    }
  })
  createWindow()
  registerVoiceHotkey()
  if (appSetting('voice.showWidget') !== '0') createVoiceWidget() // widget flottant (activé par défaut)
  void initUpdater() // auto-update brandé (canaux stable/dev) — no-op hors build packagé

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
