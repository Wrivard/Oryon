import { app, BrowserWindow, Menu, shell, session, protocol, ipcMain, crashReporter } from 'electron'
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
import { appendAppConsole } from './ipc/browser.ipc'
import { registerVoiceHotkeys, stopVoiceHotkeys, getVoiceHotkeyConflicts } from './services/voice-hotkey'
import { createVoiceWidget, destroyVoiceWidget } from './services/voice-widget'
import { initUpdater } from './services/updater'
import { reportLastDeath, startHeartbeat, markCleanShutdown } from './services/black-box'

// ── Autopsie des morts silencieuses ────────────────────────────────────────────────────────────────────
// Dumps locaux pour TOUT crash natif (main/GPU/renderer/utility) → userData/Crashpad/reports, AUCUN upload
// (diagnostic local pur, coût zéro). Croisé avec le heartbeat de black-box.ts : dump présent = crash natif
// (module identifiable) ; heartbeat coupé SANS dump NI exit-code.txt = kill EXTERNE du process (antivirus,
// injecteur de DLL — historique documenté sur cette machine, cf. sandbox-fallback plus bas).
crashReporter.start({ uploadToServer: false })

// ── Filet anti-crash du PROCESS MAIN ───────────────────────────────────────────────────────────────────
// Sans ces handlers, une exception non capturée ou un rejet de promesse non géré dans le main TUE le process
// principal → toute l'app meurt (fenêtre + tous les terminaux PTY) = « Oryon a crashé ». On LOGGE (mirroir dans
// le ring MCP via appendAppConsole → visible par l'outil read_app_log, contrairement aux console.error main qui
// ne vont qu'en stderr) et on CONTINUE. La plupart des throws isolés (handler IPC, callback async d'un service)
// ne justifient pas de tuer l'app. (Diagnostic : un crash jusque-là invisible devient une ligne de log datée.)
process.on('uncaughtException', (err) => {
  const msg = err?.stack || String(err)
  console.error('[main] uncaughtException:', msg)
  try { appendAppConsole('error', `[main] uncaughtException: ${msg}`, 'main') } catch { /* ring indispo */ }
})
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason)
  console.error('[main] unhandledRejection:', msg)
  try { appendAppConsole('error', `[main] unhandledRejection: ${msg}`, 'main') } catch { /* ring indispo */ }
})

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

// ── GPU-fallback ──────────────────────────────────────────────────────────────────────────────────────
// Chromium TUE toute l'app quand son process GPU crashe 3× (« The GPU process isn't usable. Goodbye. ») —
// une mort SANS dump WER ni événement Windows, vécue comme « Oryon crashe ». Observé 2026-06-11/12 sur
// machine no-sandbox : l'app meurt quelques secondes après le chargement/capture du <webview> du panneau
// Browser (Electron 41/Chromium 142). Même patron que le sandbox-fallback ci-dessus : un crash GPU CONFIRMÉ
// (child-process-gone, plus bas) pose un flag persistant → les lancements suivants passent en rendu
// LOGICIEL (très bien pour des terminaux/du texte ; Whisper retombe sur WASM ; le webview passe par
// SwiftShader). Supprimer le flag pour retenter l'accélération matérielle.
const GPU_OFF_FLAG = join(app.getPath('userData'), 'disable-gpu.flag')
if (existsSync(GPU_OFF_FLAG)) {
  app.disableHardwareAcceleration()
  console.error('[gpu] accélération matérielle désactivée (disable-gpu.flag présent — le supprimer pour retenter le GPU)')
}

const clearStartupCrumb = (): void => {
  try { rmSync(STARTUP_CRUMB, { force: true }) } catch { /* ignore */ }
}
// 0xC0000135 = STATUS_DLL_NOT_FOUND (hex non signé = 3221225781 ; int32 signé = -1073741515).
const isDllNotFound = (code: number): boolean => code === 0xc0000135 || code === -1073741515
let sandboxFallbackArmed = false
// Anti-boucle de reload renderer : au plus 1 reload de récupération /15 s (un crash renderer déterministe ne
// doit pas tourner en boucle de reload serrée).
let lastRendererReload = 0
function fallbackToNoSandbox(reason: string): void {
  if (!isWin || sandboxFallbackArmed || existsSync(SANDBOX_OFF_FLAG)) return
  sandboxFallbackArmed = true
  try { writeFileSync(SANDBOX_OFF_FLAG, `auto: ${reason}\n`) } catch { /* ignore */ }
  console.error(`[sandbox] crash process enfant (${reason}) → relance Oryon sans sandbox`)
  app.relaunch()
  app.exit(0)
}
// Morts de process enfants (GPU/utility/network…) : TOUJOURS journalisées dans le ring (read_app_log +
// boîte noire app-console.prev.log) — avant ce log, un crash GPU était strictement invisible en prod.
// Fast-path DLL bloquée → bascule no-sandbox immédiate (le renderer est couvert par render-process-gone
// dans createWindow). Crash GPU : dès le 1er crash CONFIRMÉ on pose le flag (cf. GPU_OFF_FLAG plus haut —
// protège tous les lancements SUIVANTS) ; au 2e de la MÊME session on relance nous-mêmes, AVANT le 3e où
// Chromium tuerait l'app sans préavis. Si on perd la course (« Goodbye » au 3e), le flag déjà posé fait
// converger : le prochain lancement démarre en rendu logiciel.
let gpuCrashCount = 0
app.on('child-process-gone', (_e, details) => {
  const gone = `[child] process ${details.type} mort : reason=${details.reason} exitCode=${details.exitCode}${details.serviceName ? ` service=${details.serviceName}` : ''}`
  console.error(gone)
  try { appendAppConsole('error', gone, 'main') } catch { /* ring indispo */ }
  if (isDllNotFound(details.exitCode)) {
    fallbackToNoSandbox(`${details.type}:${details.reason}:${details.exitCode}`)
    return
  }
  if (details.type === 'GPU' && ['crashed', 'abnormal-exit', 'oom', 'launch-failed'].includes(details.reason)) {
    gpuCrashCount++
    if (!existsSync(GPU_OFF_FLAG)) {
      try {
        writeFileSync(GPU_OFF_FLAG, `auto: process GPU ${details.reason} (exitCode=${details.exitCode}) le ${new Date().toISOString()} — supprimer ce fichier pour retenter l'accélération matérielle\n`)
      } catch { /* ignore */ }
    }
    if (gpuCrashCount >= 2) {
      console.error('[gpu] 2e crash GPU de la session → relance en rendu logiciel (flag posé)')
      app.relaunch()
      app.exit(0)
    }
  }
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
  // Pas de menu natif (File/Edit/View/Window/Help) : Oryon a sa propre barre. setApplicationMenu(null) le
  // retire GLOBALEMENT (toutes fenêtres), contrairement à autoHideMenuBar qui le ré-affiche au Alt.
  Menu.setApplicationMenu(null)
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
    const gone = `[window] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`
    console.error(gone)
    try { appendAppConsole('error', gone, 'main') } catch { /* ring indispo */ }
    // Renderer tué par une DLL injectée bloquée par le sandbox → bascule no-sandbox (cf. en-tête du fichier).
    if (isDllNotFound(details.exitCode)) {
      fallbackToNoSandbox(`renderer:${details.reason}:${details.exitCode}`)
      return
    }
    // Sinon (crashed/oom/abnormal) : le process renderer est mort → fenêtre figée/blanche. On RECHARGE (nouveau
    // process renderer) plutôt que de laisser l'app inutilisable. Débounce 15 s pour éviter une boucle si le
    // crash se reproduit aussitôt. 'clean-exit' = fermeture normale → on ne recharge pas.
    const now = Date.now()
    if (details.reason !== 'clean-exit' && !win.isDestroyed() && now - lastRendererReload > 15000) {
      lastRendererReload = now
      console.error('[window] render-process-gone → reload de récupération')
      win.webContents.reload()
    }
  })
  // Preuve POSITIVE que le renderer + ses sous-ressources (bundle module, CSS, wasm ORT) ont chargé
  // (did-fail-load ne couvre QUE la navigation du document principal, pas les sous-ressources).
  win.webContents.on('did-finish-load', () => {
    console.log('[window] did-finish-load — renderer chargé')
    clearStartupCrumb() // renderer chargé avec succès → démarrage abouti
  })
  // Miroir des erreurs renderer dans le main : MIME module refusé, 404 de chunk hashé, exception non capturée.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.error(`[renderer] level=${level} ${message} (${sourceId}:${line})`)
    appendAppConsole(level, message, sourceId, line) // ring → mcp-state/app-console.log (outil MCP read_app_log)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Durcissement du <webview> du panneau Browser (plan 017) : il charge des URL INTERNET arbitraires —
  // on borne sa navigation aux schémas web (http/https/about/devtools) et on neutralise window.open
  // (toute « nouvelle fenêtre » part dans le navigateur SYSTÈME, jamais dans une fenêtre Electron
  // privilégiée). Posé au did-attach (couvre chaque webview créé par le renderer, partition incluse).
  win.webContents.on('did-attach-webview', (_e, contents) => {
    // Mort du renderer du webview journalisée dans le ring : c'est le contenu le plus instable de l'app
    // (URL internet/dev-server arbitraires) et le déclencheur observé des crashs GPU (cf. GPU_OFF_FLAG).
    contents.on('render-process-gone', (_ev, d) => {
      const gone = `[webview] render-process-gone reason=${d.reason} exitCode=${d.exitCode}`
      console.error(gone)
      try { appendAppConsole('error', gone, 'main') } catch { /* ring indispo */ }
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (ev, url) => {
      if (!/^(https?:|about:|devtools:)/i.test(url)) {
        console.error('[webview] navigation bloquée (schéma non web) :', url)
        ev.preventDefault()
      }
    })
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
  // Autopsie AVANT le premier battement (sinon le heartbeat frais écraserait la preuve de la mort précédente).
  reportLastDeath()
  startHeartbeat()
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
  registerVoiceHotkeys()
  // Ré-enregistrement à chaud des hotkeys après un changement de réglage/mode (le renderer appelle via le preload).
  ipcMain.handle('voice:reregisterHotkeys', () => registerVoiceHotkeys())
  // Conflits du DERNIER enregistrement : le renderer les récupère au montage. L'event 'voice:hotkeyConflict'
  // émis au boot part AVANT que VoiceProvider ne soit abonné (registerVoiceHotkeys court juste après
  // createWindow, le renderer n'a pas chargé) → sans ce pull, une hotkey morte n'a aucun feedback.
  ipcMain.handle('voice:getHotkeyConflicts', () => getVoiceHotkeyConflicts())
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  markCleanShutdown() // EN PREMIER : un crash plus loin dans ce handler ne doit pas compter comme mort brutale
  stopVoiceHotkeys()
  destroyVoiceWidget()
  sweepArchiveSync() // capture finale des transcripts (delta depuis le dernier sweep) AVANT de tuer les agents + fermer la DB
  killAllTerminals()
  stopAllDevServers()
  closeEditorWatcher()
  closeDb()
})
