import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, extname, dirname, basename } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { TreeNode, FileContent, FsEvent, WriteFileResult } from '../../shared/types'

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
    // mtime/taille → base d'une écriture optimiste (l'agent/merge-back peut réécrire entre open et save).
    return { content: buf.toString('utf8'), language: langFor(p), mtimeMs: stat.mtimeMs, size: stat.size }
  })

  ipcMain.handle(
    'editor:writeFile',
    async (_e, p: string, content: string, expect?: { mtimeMs: number; size: number }): Promise<WriteFileResult> => {
      // Garde de concurrence optimiste : si le fichier a divergé depuis l'ouverture (un agent ou un
      // merge-back l'a réécrit), on NE clobbe PAS — on renvoie l'état courant pour que l'UI décide.
      if (expect) {
        try {
          const cur = await fs.stat(p)
          if (cur.mtimeMs !== expect.mtimeMs || cur.size !== expect.size) {
            return { ok: false, reason: 'diverged', mtimeMs: cur.mtimeMs, size: cur.size }
          }
        } catch {
          /* fichier disparu → on le (re)crée, pas de divergence à signaler */
        }
      }
      // Écriture atomique (temp + rename même dossier) : pas de troncature visible par une lecture
      // concurrente d'agent, et le remplacement par rename évite la course avec chokidar.
      const tmp = join(dirname(p), `.${basename(p)}.oryon-${process.pid}.tmp`)
      await fs.writeFile(tmp, content, 'utf8')
      await fs.rename(tmp, p)
      const after = await fs.stat(p)
      return { ok: true, mtimeMs: after.mtimeMs, size: after.size }
    },
  )

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
