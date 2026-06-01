import { BrowserWindow, ipcMain } from 'electron'
import { getDb } from '../db'
import { startDevServer, stopDevServer, getDevPort } from '../services/dev-server'
import type { Workspace, DevServerResult } from '../../shared/types'

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
}

/** Pousse une demande de navigation du panneau Browser au renderer (depuis la commande MCP open_browser). */
export function navigateBrowser(workspaceId: string, url: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('browser:navigate', { workspaceId, url })
  }
}
