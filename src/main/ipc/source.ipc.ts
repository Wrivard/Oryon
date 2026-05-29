import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'fs'
import { join, extname, dirname } from 'path'
import type {
  SourceStatus,
  SourceFileChange,
  SourceFileStatus,
  SourceDiff,
  GitCommit,
  AgentBranch,
  MergeResult,
} from '../../shared/types'
import { listAgentWorktrees } from '../services/worktrees'
import { mergeAgentBranch } from '../services/orchestrator/merge-back'

const exec = promisify(execFile)

// Sécurité (audit prod) : reject/revert ne DÉTRUIT plus. Avant toute opération destructive on prend un point
// de récupération (git stash create = commit du WT sans toucher l'arbre) loggé dans .oryon/trash/recovery.log ;
// les fichiers non suivis sont DÉPLACÉS dans .oryon/trash/ au lieu d'être supprimés.
let trashSeq = 0
function moveToTrash(projectPath: string, file: string): void {
  try {
    const dest = join(projectPath, '.oryon', 'trash', `${Date.now()}-${++trashSeq}`, file)
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(join(projectPath, file), dest)
  } catch (e) {
    console.error('[source] corbeille échouée, fichier CONSERVÉ :', file, (e as Error).message)
  }
}
async function snapshotRecovery(projectPath: string, label: string): Promise<void> {
  try {
    const sha = (await git(projectPath, ['stash', 'create'])).trim()
    if (!sha) return
    const log = join(projectPath, '.oryon', 'trash', 'recovery.log')
    mkdirSync(dirname(log), { recursive: true })
    appendFileSync(log, `${new Date().toISOString()}  ${label}  ->  git stash apply ${sha}\n`)
  } catch {
    /* pas de repo / rien à snapshotter */
  }
}

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
/** git qui avale l'erreur (null si code ≠ 0) — pour les sondes (merge-base, show d'un fichier absent). */
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
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
      moveToTrash(projectPath, file)
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
      moveToTrash(projectPath, file)
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
    await snapshotRecovery(projectPath, `reject ${file}`)
    await rejectFile(projectPath, file)
  })

  ipcMain.handle('source:acceptAll', async (_e, projectPath: string): Promise<void> => {
    // Stage UNIQUEMENT les fichiers listés par git status, par pathspec explicite (jamais `git add -A` :
    // dans le tronc partagé d'un run, -A ramasserait le travail en vol d'autres agents + la corbeille .oryon).
    const files = await gitStatus(projectPath)
    const specs: string[] = []
    for (const f of files) {
      if (f.path.startsWith('.oryon/')) continue
      specs.push(f.path)
      if (f.status === 'R' && f.oldPath) specs.push(f.oldPath) // rename : stager la source ET la destination
    }
    for (let i = 0; i < specs.length; i += 200) {
      await git(projectPath, ['add', '--', ...specs.slice(i, i + 200)])
    }
  })

  ipcMain.handle('source:rejectAll', async (_e, projectPath: string): Promise<void> => {
    await snapshotRecovery(projectPath, 'rejectAll')
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
    await snapshotRecovery(projectPath, `revert ${file} -> ${ref}`)
    await git(projectPath, ['checkout', ref, '--', file])
  })

  // Worktrees/branches d'agents (run multi-agent) : les éditions des agents vivent sur leur branche,
  // pas dans l'arbre de travail de MAIN → source:status ne les montrerait pas. Ces trois handlers
  // exposent la revue/intégration par branche.
  ipcMain.handle('source:branches', async (_e, projectPath: string): Promise<AgentBranch[]> => {
    return listAgentWorktrees(projectPath)
  })

  ipcMain.handle('source:branchDiff', async (_e, projectPath: string, branch: string): Promise<SourceDiff[]> => {
    // Diff de plage merge-base(HEAD,branch)…branch : exactement ce que le merge-back intégrerait.
    const base = ((await tryGit(projectPath, ['merge-base', 'HEAD', branch])) ?? 'HEAD').trim() || 'HEAD'
    const nameStatus = (await tryGit(projectPath, ['diff', '--name-status', `${base}...${branch}`])) ?? ''
    const out: SourceDiff[] = []
    for (const line of nameStatus.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      const code = parts[0][0]
      const isRename = code === 'R'
      const file = isRename ? parts[2] : parts[1]
      const oldPath = isRename ? parts[1] : undefined
      if (!file) continue
      const status: SourceFileStatus = code === 'A' ? 'A' : code === 'D' ? 'D' : isRename ? 'R' : 'M'
      const headPath = isRename && oldPath ? oldPath : file
      let original = ''
      let modified = ''
      if (code !== 'A') original = (await tryGit(projectPath, ['show', `${base}:${headPath}`])) ?? ''
      if (code !== 'D') modified = (await tryGit(projectPath, ['show', `${branch}:${file}`])) ?? ''
      out.push({ path: file, original, modified, language: langFor(file), status })
    }
    return out
  })

  ipcMain.handle('source:mergeAgent', async (_e, projectPath: string, branch: string): Promise<MergeResult> => {
    // Passe par la MÊME chaîne sérialisée/conflict-safe que le merge-back automatique (jamais add -A).
    return mergeAgentBranch(projectPath, branch)
  })
}
