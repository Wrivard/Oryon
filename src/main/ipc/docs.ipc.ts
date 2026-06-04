import { ipcMain, BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import * as core from '../../shared/docs-core.mjs'
import * as read from '../../mcp/docs-read.mjs'
import { importDoc, reimportDoc, type DocsImportProgress } from '../services/docs-import'

// Oryon Docs (Phase 3) — IPC fin par-dessus le cœur partagé. Lecture/écriture du store via docs-core.mjs
// (src/shared) ; liste + recherche lexicale via docs-read.mjs (src/mcp, la MÊME implémentation que les outils
// MCP des agents → recherche humaine et agent ne divergent pas) ; ingestion tierce via docs-import.ts. Le store
// est GLOBAL (~/.oryon/docs) → UN SEUL watcher chokidar (pas de re-ciblage par workspace, ≠ memory.ipc) qui
// émet 'docs:changed' pour rafraîchir le panneau en direct (écritures UI OU agents MCP). La progression d'un
// import est diffusée sur 'docs:import-progress' (payload DocsImportProgress) pour la vue progression.

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args)
}

// ---- watcher unique sur le store GLOBAL ----
let watcher: FSWatcher | null = null
let debounce: ReturnType<typeof setTimeout> | undefined
function broadcastChanged(): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => broadcast('docs:changed'), 200)
}
function startWatcher(): void {
  if (watcher) return
  const dir = core.docsDir() // crée ~/.oryon/docs si absent
  watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    depth: 1, // index.ndjson (niveau 0) + <slug>/{meta,chunks,source} (niveau 1)
  })
  watcher.on('all', () => broadcastChanged())
}

export function registerDocsIpc(): void {
  startWatcher()
  ipcMain.handle('docs:list', (_e, tag?: string) => read.listDocs({ tag }))
  ipcMain.handle('docs:read', (_e, slug: string) => core.readDocSet(slug))
  ipcMain.handle('docs:search', (_e, query: string, opts?: { docSlug?: string; tag?: string; limit?: number }) =>
    read.searchDocs({ query, ...(opts || {}) }),
  )
  ipcMain.handle('docs:import', (_e, args: { url?: string; markdown?: string; label?: string }) =>
    importDoc(args, (p: DocsImportProgress) => broadcast('docs:import-progress', p)),
  )
  ipcMain.handle('docs:reimport', (_e, slug: string) =>
    reimportDoc(slug, (p: DocsImportProgress) => broadcast('docs:import-progress', p)),
  )
  ipcMain.handle('docs:delete', (_e, slug: string) => core.deleteDocSet(slug))
}
