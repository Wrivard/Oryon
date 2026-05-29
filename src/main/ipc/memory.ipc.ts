import { ipcMain, BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import * as core from '../../shared/memory-core.mjs'
import type { MemoryNote, MemoryGraph } from '../../shared/types'

// Oryon Memory (Phase 5) — IPC fin par-dessus le cœur partagé (memory-core.mjs). La MÊME implémentation sert
// le serveur MCP des agents → le graphe/backlinks humain et agent ne peuvent pas diverger. Un watcher chokidar
// émet 'memory:changed' pour que l'UI reflète les écritures des agents en direct.

async function noteFor(projectPath: string, name: string): Promise<MemoryNote> {
  const r = await core.readMemory(projectPath, name)
  return { name: r.name, title: r.title, excerpt: r.content.slice(0, 160), links: r.links, updated: r.updated }
}

// ---- watcher (un seul, re-ciblé par le panneau Memory selon le projet actif) ----
let watcher: FSWatcher | null = null
let watchRoot: string | null = null
let debounce: ReturnType<typeof setTimeout> | undefined

function broadcastChanged(): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('memory:changed')
  }, 200)
}

function watchMemory(projectPath: string): void {
  const dir = core.memDir(projectPath)
  if (watchRoot === dir && watcher) return
  unwatchMemory()
  watchRoot = dir
  watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    depth: 0,
  })
  watcher.on('all', () => broadcastChanged())
}
function unwatchMemory(): void {
  void watcher?.close()
  watcher = null
  watchRoot = null
}

export function registerMemoryIpc(): void {
  ipcMain.handle('memory:list', (_e, projectPath: string): Promise<MemoryNote[]> => core.listMemories(projectPath))
  // Renvoie le contenu ; ENOENT → '' (note neuve), toute autre erreur (verrou/EACCES) REJETTE
  // → le renderer ne doit pas écraser une note qu'il n'a pas pu lire.
  ipcMain.handle('memory:read', async (_e, projectPath: string, name: string): Promise<string> => {
    const r = await core.readMemory(projectPath, name)
    return r.content
  })
  ipcMain.handle('memory:write', async (_e, projectPath: string, name: string, content: string): Promise<MemoryNote> => {
    await core.writeMemory(projectPath, name, content)
    return noteFor(projectPath, name)
  })
  ipcMain.handle('memory:append', (_e, projectPath: string, name: string, content: string, author?: string, role?: string) =>
    core.appendMemory(projectPath, name, content, { author, role }),
  )
  ipcMain.handle('memory:delete', (_e, projectPath: string, name: string) => core.deleteMemory(projectPath, name))
  ipcMain.handle('memory:graph', (_e, projectPath: string): Promise<MemoryGraph> => core.buildGraph(projectPath))
  ipcMain.handle('memory:search', (_e, projectPath: string, query: string, limit?: number) =>
    core.searchMemories(projectPath, query, limit),
  )
  ipcMain.handle('memory:rename', (_e, projectPath: string, oldName: string, newName: string) =>
    core.renameMemory(projectPath, oldName, newName),
  )
  ipcMain.on('memory:watch', (_e, projectPath: string) => watchMemory(projectPath))
  ipcMain.on('memory:unwatch', () => unwatchMemory())
}
