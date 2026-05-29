import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, extname } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { TreeNode, FileContent, FsEvent } from '../../shared/types'

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', '.next', '.turbo', '.cache',
  'build', 'coverage', '.vercel', '.oryon', '.bridgeforge', '.svelte-kit',
])

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html',
  '.md': 'markdown', '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cs': 'csharp', '.sh': 'shell', '.bash': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.xml': 'xml',
  '.sql': 'sql', '.php': 'php', '.rb': 'ruby', '.svg': 'xml', '.vue': 'html',
}

function langFor(p: string): string {
  return LANG_BY_EXT[extname(p).toLowerCase()] ?? 'plaintext'
}

function isIgnoredPath(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => IGNORE_DIRS.has(seg))
}

let watcher: FSWatcher | null = null
let watchRoot: string | null = null

export function registerEditorIpc() {
  ipcMain.handle('editor:readDir', async (_e, dir: string): Promise<TreeNode[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const nodes: TreeNode[] = entries
      .filter((ent) => !(ent.isDirectory() && IGNORE_DIRS.has(ent.name)))
      .map((ent) => ({
        name: ent.name,
        path: join(dir, ent.name),
        type: ent.isDirectory() ? ('dir' as const) : ('file' as const),
      }))
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    return nodes
  })

  ipcMain.handle('editor:readFile', async (_e, p: string): Promise<FileContent> => {
    const stat = await fs.stat(p)
    if (stat.size > 5_000_000) throw new Error('Fichier trop volumineux (> 5 Mo)')
    const buf = await fs.readFile(p)
    if (buf.includes(0)) throw new Error('Fichier binaire — édition non supportée')
    return { content: buf.toString('utf8'), language: langFor(p) }
  })

  ipcMain.handle('editor:writeFile', async (_e, p: string, content: string): Promise<void> => {
    await fs.writeFile(p, content, 'utf8')
  })

  // Liste plate des fichiers pour Quick Open (Cmd+P), dossiers lourds ignorés, plafonnée.
  ipcMain.handle('editor:listFiles', async (_e, root: string): Promise<string[]> => {
    const out: string[] = []
    const MAX = 8000
    async function walk(dir: string): Promise<void> {
      if (out.length >= MAX) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        if (out.length >= MAX) return
        if (ent.isDirectory()) {
          if (!IGNORE_DIRS.has(ent.name)) await walk(join(dir, ent.name))
        } else {
          out.push(join(dir, ent.name))
        }
      }
    }
    await walk(root)
    return out
  })

  ipcMain.on('editor:watch', (e, root: string) => {
    if (watchRoot === root && watcher) return // déjà en train de watcher ce root
    if (watcher) {
      void watcher.close()
      watcher = null
    }
    watchRoot = root
    const wc = e.sender
    watcher = chokidar.watch(root, {
      ignored: (p: string) => isIgnoredPath(p),
      ignoreInitial: true,
      persistent: true,
    })
    watcher.on('all', (type, path) => {
      if (!wc.isDestroyed()) wc.send('editor:fs-event', { type, path } as FsEvent)
    })
  })

  // unwatch ciblé par root : no-op si un watch plus récent a déjà remplacé ce root
  // (évite qu'un unwatch obsolète ferme le watcher du nouveau workspace).
  ipcMain.on('editor:unwatch', (_e, root: string) => {
    if (root && watchRoot !== root) return
    if (watcher) {
      void watcher.close()
      watcher = null
    }
    watchRoot = null
  })
}

export function closeEditorWatcher(): void {
  if (watcher) {
    void watcher.close()
    watcher = null
  }
  watchRoot = null
}
