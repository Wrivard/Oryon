import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db'
import { startDevServer, stopDevServer, getDevPort } from '../services/dev-server'
import type { Workspace, DevServerResult } from '../../shared/types'

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
