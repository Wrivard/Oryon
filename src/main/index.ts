import { app, BrowserWindow, shell, globalShortcut, session, protocol, ipcMain } from 'electron'
import { join, extname, resolve, sep } from 'path'
import { readFile } from 'fs/promises'
import { existsSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { initDb, closeDb } from './db'
import { registerIpcHandlers } from './ipc'
import { killAllTerminals } from './services/pty-manager'
import { sweepArchiveSync } from './services/archive'
import { stopAllDevServers } from './services/dev-server'
import { closeEditorWatcher } from './ipc/editor.ipc'
import { initMcpExport } from './services/mcp-export'
import { reconcileStaleTasks } from './services/orchestrator/task-store'
import { appSetting } from './ipc/settings.ipc'
import { createVoiceWidget, destroyVoiceWidget } from './services/voice-widget'
import { initUpdater } from './services/updater'

// Nom d'app PAR CANAL → userData distinct dev vs prod. PROD = %APPDATA%/Oryon (la DB y migre depuis
// BridgeForge, cf. db/index.ts) ; DEV = %APPDATA%/Oryon Dev → oryon.db / mcp-state / flags séparés, pour que
// le build dev (electron-vite) et le build prod INSTALLÉ tournent EN MÊME TEMPS sans se battre sur la même
// SQLite. Tout le reste (db, mcp-export, settings…) dérive de getPath('userData') → un seul point à toucher.
app.setName(app.isPackaged ? 'Oryon' : 'Oryon Dev')

// Verrou d'instance unique, par identité d'app : comme le nom diffère entre dev et prod, leurs verrous sont
// distincts → dev + prod COEXISTENT. Mais deux instances du MÊME build se battraient sur la même DB userData
// → la 2e se ferme et redonne le focus à la 1re. (Aucun verrou n'existait avant : risque de corruption SQLite.)
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

// ── Sandbox-fallback (Windows) ────────────────────────────────────────────────────────────────────────
// Des overlays / antivirus tiers (Overwolf, OBS graphics-hook, Avast/Kaspersky…) injectent des DLL NON
// signées Microsoft dans TOUS les process graphiques. Le sandbox Chromium applique la mitigation
// BlockNonMicrosoftBinaries → Windows bloque ces DLL au chargement → le GPU + le renderer meurent en
// 0xC0000135 (STATUS_DLL_NOT_FOUND) AVANT que la fenêtre peigne → « l'app ne fait rien » (constaté : ça
// arrive aussi à Discord ici). Signer Oryon NE corrige PAS ça (les DLL bloquées sont celles de l'injecteur,
// jugées contre la signature Microsoft). Best practice : GARDER le sandbox par défaut (sécurité) et ne le
// désactiver QUE sur les machines où on observe ce crash. Détection à deux niveaux :
//   1. persistant — disable-sandbox.flag : on démarre directement sans sandbox (aucune relance visible).
//   2. miette de démarrage — startup-incomplete.flag écrit avant de créer la fenêtre et effacé quand elle
//      s'affiche : s'il SUBSISTE au lancement suivant, le lancement précédent a crashé avant toute fenêtre
//      → on bascule. Backstop fiable même si le fast-path (child-process-gone, plus bas) perd la course
//      contre l'auto-quit « GPU process isn't usable ».
const isWin = process.platform === 'win32'
const SANDBOX_OFF_FLAG = join(app.getPath('userData'), 'disable-sandbox.flag')
const STARTUP_CRUMB = join(app.getPath('userData'), 'startup-incomplete.flag')

// Nombre de démarrages CONSÉCUTIFS n'ayant jamais atteint la fenêtre (compteur porté par la miette).
// Le backstop n'enclenche no-sandbox qu'à partir de 2 échecs d'affilée → un force-quit isolé pendant le
// démarrage ne dégrade PAS silencieusement la sécurité. (Le fast-path, lui, enclenche dès 1 crash
// 0xC0000135 CONFIRMÉ — voir fallbackToNoSandbox.) La miette est effacée dès qu'une fenêtre s'affiche.
function readStartupFails(): number {
  try { return parseInt(readFileSync(STARTUP_CRUMB, 'utf8').trim(), 10) || 0 } catch { return 0 }
}
const priorStartupFails = isWin ? readStartupFails() : 0

if (isWin) {
  if (priorStartupFails >= 2 && !existsSync(SANDBOX_OFF_FLAG)) {
    try { writeFileSync(SANDBOX_OFF_FLAG, `auto: ${priorStartupFails} démarrages consécutifs sans fenêtre\n`) } catch { /* ignore */ }
  }
  if (existsSync(SANDBOX_OFF_FLAG)) app.commandLine.appendSwitch('no-sandbox')
}

const clearStartupCrumb = (): void => {
  try { rmSync(STARTUP_CRUMB, { force: true }) } catch { /* ignore */ }
}
// 0xC0000135 = STATUS_DLL_NOT_FOUND (hex non signé = 3221225781 ; int32 signé = -1073741515).
const isDllNotFound = (code: number): boolean => code === 0xc0000135 || code === -1073741515
let sandboxFallbackArmed = false
function fallbackToNoSandbox(reason: string): void {
  if (!isWin || sandboxFallbackArmed || existsSync(SANDBOX_OFF_FLAG)) return
  sandboxFallbackArmed = true
  try { writeFileSync(SANDBOX_OFF_FLAG, `auto: ${reason}\n`) } catch { /* ignore */ }
  console.error(`[sandbox] crash process enfant (${reason}) → relance Oryon sans sandbox`)
  app.relaunch()
  app.exit(0)
}
// Fast-path : GPU/utility tué par DLL bloquée → bascule immédiate (le renderer est couvert par
// render-process-gone dans createWindow). Sur machine saine, cet event ne se produit pas.
app.on('child-process-gone', (_e, details) => {
  if (isDllNotFound(details.exitCode)) fallbackToNoSandbox(`${details.type}:${details.reason}:${details.exitCode}`)
})

// Port debug CDP — DEV UNIQUEMENT (jamais dans un build de production). Permet l'inspection/vérif headless.
if (process.env.NODE_ENV === 'development') app.commandLine.appendSwitch('remote-debugging-port', '9222')

// Schéma privilégié app:// (doit être déclaré AVANT app.ready) : sert le renderer packagé avec fetch/ONNX/
// CacheStorage fonctionnels (contrairement à file://). Voir le handler dans whenReady.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

const isDev = process.env.NODE_ENV === 'development'

function createWindow() {
  // Miette de démarrage : posée AVANT de créer la fenêtre (donc avant que le GPU/renderer ne se lance).
  // Effacée dès qu'une fenêtre s'affiche. Si elle subsiste au prochain lancement → crash pré-fenêtre détecté.
  if (isWin) {
    // Compteur d'échecs consécutifs : si CE démarrage échoue aussi (miette non effacée), le prochain lira N+1.
    try { writeFileSync(STARTUP_CRUMB, String(priorStartupFails + 1)) } catch { /* ignore */ }
  }
  const win = new BrowserWindow({
    title: app.isPackaged ? 'Oryon' : 'Oryon Dev', // distingue visuellement les fenêtres dev et prod simultanées

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
    if (!win.isDestroyed() && !win.isVisible()) {
      console.error('[window] show forcé après 6 s — ready-to-show jamais atteint (renderer bloqué ?)')
      win.show()
      clearStartupCrumb() // une fenêtre s'affiche → le démarrage a abouti (pas un crash pré-fenêtre)
    }
  }, 6000)
  win.on('ready-to-show', () => {
    clearTimeout(showTimer)
    win.show()
    clearStartupCrumb()
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
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[window] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
    // Renderer tué par une DLL injectée bloquée par le sandbox → bascule no-sandbox (cf. en-tête du fichier).
    if (isDllNotFound(details.exitCode)) fallbackToNoSandbox(`renderer:${details.reason}:${details.exitCode}`)
  })
  // Preuve POSITIVE que le renderer + ses sous-ressources (bundle module, CSS, wasm ORT) ont chargé
  // (did-fail-load ne couvre QUE la navigation du document principal, pas les sous-ressources).
  win.webContents.on('did-finish-load', () => {
    console.log('[window] did-finish-load — renderer chargé')
    clearStartupCrumb() // renderer chargé avec succès → démarrage abouti
  })
  // Miroir des erreurs renderer dans le main : MIME module refusé, 404 de chunk hashé, exception non capturée.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) =>
    console.error(`[renderer] level=${level} ${message} (${sourceId}:${line})`),
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
  if (!gotSingleInstanceLock) return // 2e instance du même build : on a déjà demandé le quit, ne rien initialiser.
  try {
    initDb()
  } catch (err) {
    // La DB est une exigence Phase 0 ("DB créée") : échec = on quitte plutôt que tourner cassé.
    console.error('[DB] Erreur fatale à l\'initialisation :', err)
    app.quit()
    return
  }
  // Setup post-DB GARDÉ : une exception dans l'un de ces appels avorterait whenReady AVANT createWindow()
  // → aucune fenêtre, sans signal (« l'app ne fait rien »). On loggue et on continue : mieux vaut une
  // fenêtre avec un sous-système dégradé qu'une app invisible.
  try {
    // W2 : repasse les tasks 'in-progress' orphelines (laissées par une session précédente) en 'todo' AVANT
    // le 1er writeMeta, sinon des terminaux idle s'afficheraient "busy" (busy est dérivé des in-progress).
    const reconciled = reconcileStaleTasks()
    if (reconciled) console.log(`[startup] ${reconciled} task(s) in-progress orpheline(s) repassée(s) en 'todo'`)
    registerIpcHandlers()
    initMcpExport() // exporte l'état (terminaux/tasks/mailbox) pour le serveur MCP de debug
    registerMediaPermissions() // autorise le micro (getUserMedia) pour la dictée Voice — sinon « micro indisponible »
  } catch (err) {
    console.error('[startup] erreur durant le setup post-DB (la fenêtre sera quand même créée) :', err)
  }
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
    // Anti-traversée : on confine le chemin résolu sous rendererRoot. resolve() normalise les '..' en chemin
    // absolu ; on exige ensuite que le résultat soit la racine elle-même ou un descendant (préfixe + séparateur).
    const full = resolve(rendererRoot, rel)
    const rootPrefix = rendererRoot.endsWith(sep) ? rendererRoot : rendererRoot + sep
    if (full !== rendererRoot && !full.startsWith(rootPrefix)) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    }
    try {
      const data = await readFile(full)
      const type = MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
      return new Response(new Uint8Array(data), { headers: { 'content-type': type } })
    } catch (err) {
      console.error(`[app://] introuvable: ${rel} (root=${rendererRoot})`, (err as Error).message)
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    }
  })

  // ── Content-Security-Policy ─────────────────────────────────────────────────────────────────────────
  // Verrouille le renderer. PROD (app://) : politique stricte — scripts/ressources de PREMIÈRE PARTIE
  // uniquement, + les poids du modèle Whisper depuis le hub Hugging Face (cf. lib/voice.ts → @huggingface/
  // transformers, allowLocalModels=false). 'wasm-unsafe-eval' est exigé par ONNX Runtime (compilation WASM) ;
  // object-src 'none' tue les plugins. DEV (ELECTRON_RENDERER_URL) : on desserre le strict nécessaire au
  // serveur Vite — origine HTTP+WS dans connect-src (HMR) et 'unsafe-inline' dans script-src (préambule inline
  // injecté par @vitejs/plugin-react pour React Fast Refresh, sinon le renderer dev refuse de charger). La
  // surface PROD reste verrouillée (aucun script inline dans le build, hormis le polyfill modulepreload inerte).
  const devUrl = isDev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  const devOrigin = devUrl ? new URL(devUrl).origin : ''
  const scriptSrc = devOrigin ? "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'" : "script-src 'self' 'wasm-unsafe-eval'"
  const connectExtra = devOrigin ? ` ${devOrigin} ${devOrigin.replace(/^http/, 'ws')}` : ''
  const csp =
    "default-src 'self'; " +
    `${scriptSrc}; ` +
    `connect-src 'self' https://huggingface.co https://cdn-lfs.huggingface.co https://*.hf.co${connectExtra}; ` +
    "img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'"
  session.defaultSession.webRequest.onHeadersReceived((details, cb) =>
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } }),
  )

  createWindow()
  registerVoiceHotkey()
  // Ré-enregistrement à chaud des hotkeys après un changement de réglage (le renderer appelle via le preload).
  ipcMain.handle('voice:reregisterHotkeys', () => registerVoiceHotkey())
  // Conflits du DERNIER enregistrement : le renderer les récupère au montage. L'event 'voice:hotkeyConflict'
  // émis au boot part AVANT que VoiceProvider ne soit abonné (registerVoiceHotkey court juste après
  // createWindow, le renderer n'a pas chargé) → sans ce pull, une hotkey morte n'a aucun feedback.
  ipcMain.handle('voice:getHotkeyConflicts', () => lastHotkeyConflicts)
  if (appSetting('voice.showWidget') !== '0') createVoiceWidget() // widget flottant (activé par défaut)
  void initUpdater() // auto-update brandé (canaux stable/dev) — no-op hors build packagé

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Autorise les permissions média (micro) pour getUserMedia dans le renderer sandboxé. Sans ça, Chromium
 * rejette getUserMedia → « Micro indisponible ». On n'autorise QUE l'audio (jamais la caméra/géoloc/etc.) ET
 * seulement depuis l'origine de PREMIÈRE PARTIE (app://oryon en prod, le serveur Vite en dev) — une iframe
 * tierce ou une redirection ne peut pas réclamer le micro.
 */
function registerMediaPermissions(): void {
  const ALLOWED = new Set(['media', 'audioCapture'])
  // URL.origin renvoie "null" pour le schéma custom app:// (non standard côté Node, même déclaré privilégié
  // pour Chromium) → on reconstruit l'origine en protocole+hôte pour une comparaison fiable dev ET prod.
  const originOf = (s: string): string => { const u = new URL(s); return `${u.protocol}//${u.host}` }
  const allowedOrigin = isDev && process.env['ELECTRON_RENDERER_URL'] ? originOf(process.env['ELECTRON_RENDERER_URL']) : 'app://oryon'
  const isFirstParty = (urlOrOrigin?: string | null): boolean => {
    if (!urlOrOrigin) return false
    try { return originOf(urlOrOrigin) === allowedOrigin } catch { return false }
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) =>
    cb(ALLOWED.has(permission) && isFirstParty(details.requestingUrl)),
  )
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    ALLOWED.has(permission) && isFirstParty(requestingOrigin),
  )
}

// État module : accélérateurs réellement enregistrés (pour ré-enregistrement à chaud) et horodatage de
// coalescence — module-scoped pour survivre à un ré-enregistrement (sinon le debounce se réarmerait à zéro).
let registeredAccels: string[] = []
let lastHotkeyConflicts: { accel: string; mode: string }[] = []
let lastToggle = 0

/**
 * Hotkeys globales de dictée (toggle) et de command mode → notifient le renderer. Défauts configurables.
 * RE-RUNNABLE : libère d'abord les accélérateurs précédemment posés par CETTE fonction, puis ré-enregistre à
 * partir des réglages COURANTS — appelable à chaud (cf. ipcMain 'voice:reregisterHotkeys') sans redémarrage.
 * globalShortcut.register renvoie false (SANS throw) si l'accélérateur est déjà pris : on le détecte et on
 * notifie le renderer (voice:hotkeyConflict) au lieu d'avaler l'échec en silence. Le try/catch couvre, lui,
 * le cas de l'accélérateur MALFORMÉ (qui, lui, throw).
 */
export function registerVoiceHotkey(): void {
  // Libère uniquement ce que CETTE fonction avait posé (surtout pas unregisterAll, qui tuerait d'autres hotkeys).
  for (const accel of registeredAccels) {
    try { globalShortcut.unregister(accel) } catch { /* ignore */ }
  }
  registeredAccels = []
  lastHotkeyConflicts = []

  const broadcast = (channel: string): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel)
  }
  const toggleAccel = appSetting('voice.hotkey.toggle') || appSetting('voice.hotkey') || 'CommandOrControl+Shift+Space'
  const commandAccel = appSetting('voice.hotkey.command') || 'CommandOrControl+Shift+.'
  // Coalescence leading-edge : deux voice:toggle rapprochés (hotkey + widget, ou rebond) ne doivent pas
  // démarrer-puis-arrêter aussitôt une capture.
  const sendToggle = (): void => {
    const now = Date.now()
    if (now - lastToggle < 250) return
    lastToggle = now
    broadcast('voice:toggle')
  }
  try {
    const okToggle = globalShortcut.register(toggleAccel, sendToggle)
    if (!okToggle || !globalShortcut.isRegistered(toggleAccel)) {
      console.warn('Voice hotkey conflict:', toggleAccel)
      lastHotkeyConflicts.push({ accel: toggleAccel, mode: 'toggle' })
      BrowserWindow.getAllWindows()[0]?.webContents.send('voice:hotkeyConflict', { accel: toggleAccel, mode: 'toggle' })
    } else {
      registeredAccels.push(toggleAccel)
    }
  } catch (e) {
    console.error('[voice] enregistrement hotkey dictée échoué :', (e as Error).message)
  }
  try {
    if (commandAccel && commandAccel !== toggleAccel) {
      const okCommand = globalShortcut.register(commandAccel, () => broadcast('voice:command-key'))
      if (!okCommand || !globalShortcut.isRegistered(commandAccel)) {
        console.warn('Voice hotkey conflict:', commandAccel)
        lastHotkeyConflicts.push({ accel: commandAccel, mode: 'command' })
        BrowserWindow.getAllWindows()[0]?.webContents.send('voice:hotkeyConflict', { accel: commandAccel, mode: 'command' })
      } else {
        registeredAccels.push(commandAccel)
      }
    }
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
  sweepArchiveSync() // capture finale des transcripts (delta depuis le dernier sweep) AVANT de tuer les agents + fermer la DB
  killAllTerminals()
  stopAllDevServers()
  closeEditorWatcher()
  closeDb()
})
