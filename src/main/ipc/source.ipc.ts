import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, existsSync, rmSync } from 'fs'
import { join, extname } from 'path'
import type { SourceStatus, SourceFileChange, SourceFileStatus, SourceDiff, GitCommit } from '../../shared/types'

const exec = promisify(execFile)

// Détection de langage (dupliqué volontairement d'editor.ipc : petit lookup, évite un couplage inter-IPC).
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

/**
 * Exécute git dans le projet. `core.quotePath=false` → chemins non-ASCII (accents) émis bruts et non
 * octal-échappés (sinon café.txt → "caf\303\251.txt" : fichier introuvable, +/- à 0, reject no-op).
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout.toString()
}

/** Chemin de DESTINATION d'une entrée numstat de rename (`old => new` ou `pre{old => new}post`). */
function numstatDest(p: string): string {
  if (!p.includes(' => ')) return p
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
  if (brace) return (brace[1] + brace[3] + brace[4]).replace(/\/{2,}/g, '/')
  const parts = p.split(' => ')
  return parts[parts.length - 1]
}

async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    const out = await git(projectPath, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

function parseNum(s: string): number {
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : 0
}

/** Parse `git status --porcelain=v1` en changements, fusionne avec --numstat pour les compteurs +/-. */
async function gitStatus(projectPath: string): Promise<SourceFileChange[]> {
  const porcelain = await git(projectPath, ['status', '--porcelain=v1', '--untracked-files=all'])
  // numstat (HEAD → working tree, staged + unstaged) pour les +/- des fichiers suivis.
  let numstat = ''
  try {
    numstat = await git(projectPath, ['diff', '--numstat', 'HEAD'])
  } catch {
    /* dépôt sans commit (HEAD absent) → pas de numstat */
  }
  const counts = new Map<string, { add: number; del: number }>()
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const [a, d, ...rest] = line.split('\t')
    // Clé = chemin de DESTINATION (numstat émet les renames `old => new`) pour matcher le path porcelain.
    const path = numstatDest(rest.join('\t'))
    counts.set(path, { add: a === '-' ? 0 : parseNum(a), del: d === '-' ? 0 : parseNum(d) })
  }
  const unquote = (s: string): string => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s)

  const files: SourceFileChange[] = []
  for (const raw of porcelain.split('\n')) {
    if (!raw) continue
    const x = raw[0]
    const y = raw[1]
    let path = raw.slice(3)
    let oldPath: string | undefined
    let status: SourceFileStatus
    if (x === '?' && y === '?') status = '?'
    else if (x === 'A' || y === 'A') status = 'A'
    else if (x === 'D' || y === 'D') status = 'D'
    else if (x === 'R' || y === 'R') {
      status = 'R'
      const arrow = path.indexOf(' -> ')
      if (arrow >= 0) {
        oldPath = unquote(path.slice(0, arrow)) // on garde la source pour pouvoir rejeter proprement
        path = path.slice(arrow + 4)
      }
    } else status = 'M'
    path = unquote(path)

    let { add, del } = counts.get(path) ?? { add: 0, del: 0 }
    if (status === '?') {
      // Untracked : numstat ne le voit pas → compter les lignes du fichier.
      try {
        const c = readFileSync(join(projectPath, path), 'utf8')
        add = c ? c.split('\n').length : 0
      } catch {
        /* binaire/illisible */
      }
    }
    files.push({ path, oldPath, status, additions: add, deletions: del, staged: x !== ' ' && x !== '?' })
  }
  return files
}

async function gitDiff(projectPath: string, change: SourceFileChange): Promise<SourceDiff> {
  const { path: file, oldPath, status } = change
  let original = ''
  let modified = ''
  // Pour un rename, l'original vit à HEAD sous l'ANCIEN chemin.
  const headPath = status === 'R' && oldPath ? oldPath : file
  if (status !== 'A' && status !== '?') {
    try {
      original = await git(projectPath, ['show', `HEAD:${headPath}`])
    } catch {
      /* pas dans HEAD */
    }
  }
  if (status !== 'D') {
    const abs = join(projectPath, file)
    if (existsSync(abs)) {
      try {
        modified = readFileSync(abs, 'utf8')
      } catch {
        /* binaire */
      }
    }
  }
  return { path: file, original, modified, language: langFor(file), status }
}

/** Change complet d'un fichier (status + oldPath éventuel) pour router accept/reject/diff. */
async function changeOf(projectPath: string, file: string): Promise<SourceFileChange | null> {
  const files = await gitStatus(projectPath)
  return files.find((f) => f.path === file) ?? null
}

async function rejectFile(projectPath: string, file: string): Promise<void> {
  const ch = await changeOf(projectPath, file)
  const st = ch?.status
  if (st === '?' || st === 'A') {
    // Nouveau fichier : désindexer (si stagé) puis supprimer du disque.
    if (st === 'A') {
      try {
        await git(projectPath, ['reset', '--', file])
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(join(projectPath, file), { force: true })
    } catch {
      /* ignore */
    }
  } else if (st === 'R' && ch?.oldPath) {
    // Rename : restaurer la SOURCE à HEAD, puis désindexer + supprimer la destination.
    await git(projectPath, ['checkout', 'HEAD', '--', ch.oldPath])
    try {
      await git(projectPath, ['reset', '--', file])
    } catch {
      /* ignore */
    }
    try {
      rmSync(join(projectPath, file), { force: true })
    } catch {
      /* ignore */
    }
  } else {
    // Modifié/supprimé : restaurer à HEAD (index + working tree).
    await git(projectPath, ['checkout', 'HEAD', '--', file])
  }
}

export function registerSourceIpc(): void {
  ipcMain.handle('source:status', async (_e, projectPath: string): Promise<SourceStatus> => {
    if (!(await isGitRepo(projectPath))) return { isGit: false, files: [] }
    try {
      return { isGit: true, files: await gitStatus(projectPath) }
    } catch {
      return { isGit: true, files: [] }
    }
  })

  ipcMain.handle('source:diff', async (_e, projectPath: string, file: string): Promise<SourceDiff> => {
    const ch = (await changeOf(projectPath, file)) ?? {
      path: file,
      status: 'M' as const,
      additions: 0,
      deletions: 0,
      staged: false,
    }
    return gitDiff(projectPath, ch)
  })

  ipcMain.handle('source:accept', async (_e, projectPath: string, file: string): Promise<void> => {
    await git(projectPath, ['add', '--', file]) // accepter = stager (le changement est conservé)
  })

  ipcMain.handle('source:reject', async (_e, projectPath: string, file: string): Promise<void> => {
    await rejectFile(projectPath, file)
  })

  ipcMain.handle('source:acceptAll', async (_e, projectPath: string): Promise<void> => {
    await git(projectPath, ['add', '-A'])
  })

  ipcMain.handle('source:rejectAll', async (_e, projectPath: string): Promise<void> => {
    // Rejeter chaque fichier individuellement (plus sûr que `git clean -fd`).
    for (const f of await gitStatus(projectPath)) {
      try {
        await rejectFile(projectPath, f.path)
      } catch {
        /* continue */
      }
    }
  })

  ipcMain.handle('source:log', async (_e, projectPath: string, file?: string): Promise<GitCommit[]> => {
    if (!(await isGitRepo(projectPath))) return []
    const args = ['log', '-n', '40', '--date=short', '--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s']
    if (file) args.push('--', file)
    try {
      const out = await git(projectPath, args)
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, shortHash, author, date, subject] = line.split('\x1f')
          return { hash, shortHash, author, date, subject }
        })
    } catch {
      return []
    }
  })

  ipcMain.handle(
    'source:fileAtRef',
    async (_e, projectPath: string, file: string, ref: string): Promise<{ content: string; language: string }> => {
      let content = ''
      try {
        content = await git(projectPath, ['show', `${ref}:${file}`])
      } catch {
        /* fichier absent à cette révision */
      }
      return { content, language: langFor(file) }
    },
  )

  ipcMain.handle('source:revertFile', async (_e, projectPath: string, file: string, ref: string): Promise<void> => {
    await git(projectPath, ['checkout', ref, '--', file])
  })
}
