import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db'
import { startDevServer, stopDevServer, getDevPort } from '../services/dev-server'
import { setVercelToken, hasVercelToken, listVercelProjects } from '../services/vercel-rest'
import type { Workspace, DevServerResult, BrowserRecent, BrowserFavorite } from '../../shared/types'

// Dossier d'état MCP (miroir de mcp-export.stateDir — recopié ici pour éviter un cycle d'import
// mcp-export ↔ browser.ipc, puisque mcp-export importe déjà navigateBrowser d'ici).
function mcpStateDir(): string {
  return join(app.getPath('userData'), 'mcp-state')
}
function writeFileAtomic(p: string, content: string | Buffer): void {
  try {
    const tmp = `${p}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, p)
  } catch {
    /* best-effort : ne jamais casser sur une écriture */
  }
}

// Console de la webview → ring par workspace, flush (debounce 500 ms) vers mcp-state/browser-console-<ws>.log,
// lu par l'outil MCP browser_console. Cap ~20 KB comme les term-logs.
const CONSOLE_CAP = 20000
const consoleBuf = new Map<string, string>()
const dirtyConsole = new Set<string>()
let consoleFlushTimer: ReturnType<typeof setTimeout> | null = null
function flushConsole(): void {
  consoleFlushTimer = null
  const dir = mcpStateDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  for (const ws of dirtyConsole) writeFileAtomic(join(dir, `browser-console-${ws}.log`), consoleBuf.get(ws) ?? '')
  dirtyConsole.clear()
}

// Console de la FENÊTRE PRINCIPALE (renderer hôte) → ring + flush (debounce 500 ms) vers mcp-state/app-console.log,
// lu par l'outil MCP read_app_log (debug runtime de l'app elle-même, ex. les sondes [voice] de la dictée).
let appBuf = ''
let appDirty = false
let appFlushTimer: ReturnType<typeof setTimeout> | null = null
// Boîte noire : au PREMIER flush de la session, l'app-console.log de l'instance PRÉCÉDENTE est tournée en
// app-console.prev.log au lieu d'être écrasée. C'est le seul témoin qui survit à une mort brutale de l'app
// (ex. kill Chromium « GPU process isn't usable » : aucun dump, aucun événement WER — vécu 2026-06-12, le
// log de l'instance morte avait été détruit par le redémarrage et le diagnostic a dû se faire sans lui).
let appPrevRotated = false
function flushAppConsole(): void {
  appFlushTimer = null
  if (!appDirty) return
  const dir = mcpStateDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  if (!appPrevRotated) {
    appPrevRotated = true
    try { renameSync(join(dir, 'app-console.log'), join(dir, 'app-console.prev.log')) } catch { /* 1er boot : rien à tourner */ }
  }
  writeFileAtomic(join(dir, 'app-console.log'), appBuf)
  appDirty = false
}
/** Append une ligne de la console de la fenêtre principale au ring (lu via l'outil MCP read_app_log). */
export function appendAppConsole(level: number | string, message: string, source?: string, line?: number): void {
  const loc = source ? ` (${source}:${line ?? '?'})` : ''
  const t = new Date().toISOString().slice(11, 23)
  appBuf = (appBuf + `${t} [${level}] ${message}${loc}\n`).slice(-CONSOLE_CAP)
  appDirty = true
  // Niveau ERREUR (3 = console-message renderer, 'error' = appels main) : flush IMMÉDIAT. Le debounce de
  // 500 ms a une fenêtre aveugle fatale pour une boîte noire : quand l'app meurt juste après l'événement,
  // la ligne décisive n'atteignait jamais le disque (vécu pendant l'autopsie des morts du 2026-06-12).
  if (level === 'error' || level === 3) {
    if (appFlushTimer) {
      clearTimeout(appFlushTimer)
      appFlushTimer = null
    }
    flushAppConsole()
    return
  }
  if (!appFlushTimer) appFlushTimer = setTimeout(flushAppConsole, 500)
}

// Préférences Browser persistées sur la ligne `workspaces` (Migration 012). recents/favorites = colonnes JSON
// (null tant que jamais écrites → []). Cap des récents : on garde les 15 plus récentes, dédupliquées par URL.
const RECENTS_CAP = 15
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function registerBrowserIpc() {
  ipcMain.handle('browser:startDevServer', (e, workspaceId: string): Promise<DevServerResult> => {
    const wc = e.sender
    const ws = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
      | Workspace
      | undefined
    if (!ws) throw new Error(`Workspace ${workspaceId} introuvable`)
    const command = ws.dev_command ?? 'npm run dev'

    return new Promise<DevServerResult>((resolve) => {
      let settled = false
      const finish = (port: number | null) => {
        if (settled) return
        settled = true
        resolve({ port, running: true })
      }
      startDevServer({
        workspaceId,
        cwd: ws.project_path,
        command,
        onLog: (line) => {
          if (!wc.isDestroyed()) wc.send('browser:dev-log', line)
        },
        onPort: (port) => finish(port),
      })
      // Filet : certains serveurs n'impriment pas de port lisible → on rend la main après 20s.
      setTimeout(() => finish(getDevPort(workspaceId)), 20000)
    })
  })

  ipcMain.handle('browser:stopDevServer', (_e, workspaceId: string): void => {
    stopDevServer(workspaceId)
  })

  // Console de la webview (renderer → main) : append au ring du workspace + flush debounce (outil browser_console).
  ipcMain.on(
    'browser:console',
    (_e, d: { workspaceId: string; level?: string; message?: string; line?: number; source?: string }) => {
      if (!d?.workspaceId) return
      const loc = d.source ? ` (${d.source}:${d.line ?? '?'})` : ''
      const entry = `[${d.level ?? 'log'}] ${d.message ?? ''}${loc}\n`
      consoleBuf.set(d.workspaceId, ((consoleBuf.get(d.workspaceId) ?? '') + entry).slice(-CONSOLE_CAP))
      dirtyConsole.add(d.workspaceId)
      if (!consoleFlushTimer) consoleFlushTimer = setTimeout(flushConsole, 500)
    },
  )

  // Résultat de capture webview (renderer → main) → écrit mcp-state/screenshots/<reqId>.png (poll par l'outil).
  ipcMain.on('browser:capture-result', (_e, d: { reqId: string; png?: Uint8Array; error?: string }) => {
    if (!d?.reqId) return
    // Trace boîte noire : les morts silencieuses observées tombent dans les secondes qui suivent une capture
    // webview — dater précisément chaque capture rend le post-mortem autonome (sans relire les transcripts).
    appendAppConsole('log', `[browser] capture ${d.reqId} : ${d.png?.length ? `${d.png.length} octets` : `ERREUR ${d.error ?? 'vide'}`}`, 'main')
    const dir = join(mcpStateDir(), 'screenshots')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* ignore */
    }
    if (d.error || !d.png || !d.png.length) {
      writeFileAtomic(join(dir, `${d.reqId}.err`), d.error || 'capture vide (aucun site ouvert ?)')
      return
    }
    writeFileAtomic(join(dir, `${d.reqId}.png`), Buffer.from(d.png))
  })

  // ── Optim Browser : préférences (récents/favoris/dernière URL) persistées par workspace (Migration 012) ──
  ipcMain.handle('browser:getPrefs', (_e, workspaceId: string) => {
    const row = getDb()
      .prepare('SELECT browser_recents, browser_favorites, last_browser_url FROM workspaces WHERE id = ?')
      .get(workspaceId) as Pick<Workspace, 'browser_recents' | 'browser_favorites' | 'last_browser_url'> | undefined
    return {
      recents: parseJson<BrowserRecent[]>(row?.browser_recents, []),
      favorites: parseJson<BrowserFavorite[]>(row?.browser_favorites, []),
      lastUrl: row?.last_browser_url ?? null,
    }
  })

  ipcMain.handle('browser:addRecent', (_e, workspaceId: string, url: string, title?: string): void => {
    if (!url) return
    const row = getDb().prepare('SELECT browser_recents FROM workspaces WHERE id = ?').get(workspaceId) as
      | Pick<Workspace, 'browser_recents'>
      | undefined
    if (!row) return // workspace inconnu : rien à écrire
    const recents = parseJson<BrowserRecent[]>(row.browser_recents, [])
    // Prepend + dédup par URL (l'entrée existante remonte en tête) + cap aux RECENTS_CAP plus récentes.
    const next = [{ url, title, ts: Date.now() }, ...recents.filter((r) => r.url !== url)].slice(0, RECENTS_CAP)
    getDb().prepare('UPDATE workspaces SET browser_recents = ? WHERE id = ?').run(JSON.stringify(next), workspaceId)
  })

  ipcMain.handle(
    'browser:toggleFavorite',
    (_e, workspaceId: string, url: string, label?: string): { favorited: boolean } => {
      if (!url) return { favorited: false }
      const row = getDb().prepare('SELECT browser_favorites FROM workspaces WHERE id = ?').get(workspaceId) as
        | Pick<Workspace, 'browser_favorites'>
        | undefined
      if (!row) return { favorited: false }
      const favorites = parseJson<BrowserFavorite[]>(row.browser_favorites, [])
      const exists = favorites.some((f) => f.url === url)
      const next = exists ? favorites.filter((f) => f.url !== url) : [...favorites, { url, label }]
      getDb().prepare('UPDATE workspaces SET browser_favorites = ? WHERE id = ?').run(JSON.stringify(next), workspaceId)
      return { favorited: !exists }
    },
  )

  ipcMain.handle('browser:setLastUrl', (_e, workspaceId: string, url: string): void => {
    getDb().prepare('UPDATE workspaces SET last_browser_url = ? WHERE id = ?').run(url || null, workspaceId)
  })

  // ── Vercel REST : token chiffré au repos, jamais renvoyé au renderer (cf. services/vercel-rest.ts) ──
  ipcMain.handle('browser:setVercelToken', (_e, token: string) => setVercelToken(token))
  ipcMain.handle('browser:vercelStatus', () => ({ hasToken: hasVercelToken() }))
  ipcMain.handle('browser:vercelProjects', () => listVercelProjects())

  // Ouvre une URL dans le navigateur système (lien externe depuis le panneau Browser).
  ipcMain.handle('browser:openExternal', async (_e, url: string): Promise<void> => {
    if (url) await shell.openExternal(url)
  })

  // Vide le ring de console de la webview du workspace (+ flush du buffer vidé vers le log lu par browser_console).
  ipcMain.handle('browser:clearConsole', (_e, workspaceId: string): void => {
    if (!workspaceId) return
    consoleBuf.set(workspaceId, '')
    dirtyConsole.add(workspaceId)
    if (!consoleFlushTimer) consoleFlushTimer = setTimeout(flushConsole, 500)
  })
}

/** Pousse une demande de navigation du panneau Browser au renderer (depuis la commande MCP open_browser). */
export function navigateBrowser(workspaceId: string, url: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('browser:navigate', { workspaceId, url })
  }
}

/** Demande au renderer de capturer la webview du workspace (commande MCP browser_screenshot). */
export function requestBrowserScreenshot(workspaceId: string, reqId: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('browser:capture', { workspaceId, reqId })
  }
}
