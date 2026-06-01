// Archivage durable des transcripts de conversation (workers + orchestrateur) pour analyse/optimisation
// ultérieure (tuning des prompts/contrats, détection de frictions récurrentes). Les transcripts vivent dans
// ~/.claude/projects/<ENC>/*.jsonl (record structuré COMPLET) et Claude les PURGE (~30 j par défaut) → on les
// copie GZIPPÉS sous <projet>/.oryon/archive/<agent>/<session>.jsonl.gz, avec une meta .json par session, plus
// un index.ndjson consolidé par projet. Le dossier .oryon/archive/ EST l'index et l'export (auto-suffisant,
// gitignored). Lecture FS + SQLite seulement → coût $0, JAMAIS d'appel claude.

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs'
import { gzipSync, createGzip } from 'zlib'
import { join } from 'path'
import { getDb } from '../db'
import { claudeProjectDir } from './claude-session'

interface AgentRef {
  termId: string
  agent: string
  role: string
  workspaceId: string
  cwd: string // worktree (worker) ou arbre principal (orchestrateur) — là où claude tourne
  project: string // arbre principal du projet → racine de .oryon/archive
}
interface TaskTag {
  id: string
  title: string | null
  status: string
}
interface GzJob {
  src: string
  dest: string
}

function archiveRoot(project: string): string {
  return join(project, '.oryon', 'archive')
}

/** Tous les terminaux (workers + orchestrateurs) de tous les workspaces, avec leur cwd réel + projet. */
function allAgents(): AgentRef[] {
  try {
    return (
      getDb()
        .prepare(
          `SELECT t.id AS termId, t.name AS agent, t.role AS role, t.workspace_id AS workspaceId,
                  COALESCE(t.worktree_path, t.cwd) AS cwd, w.project_path AS project
             FROM terminals t JOIN workspaces w ON w.id = t.workspace_id`,
        )
        .all() as AgentRef[]
    ).filter((r) => r.cwd && r.project)
  } catch {
    return []
  }
}

/** Tâches assignées à ce terminal (tag grossier pour filtrer l'archive : « sessions de Nell », statut final). */
function tasksFor(termId: string): TaskTag[] {
  try {
    return getDb()
      .prepare('SELECT id, title, status FROM tasks WHERE assigned_terminal_id = ? ORDER BY created_at')
      .all(termId) as TaskTag[]
  } catch {
    return []
  }
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}
function writeFileAtomic(p: string, content: string): void {
  try {
    const tmp = `${p}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, p)
  } catch {
    /* best-effort : ne jamais casser un sweep sur une écriture */
  }
}

/**
 * Planifie l'archivage d'UN agent — PUREMENT SYNCHRONE : lit le dossier de transcripts, dédoublonne (une
 * session déjà archivée à la même taille+mtime n'est pas re-gzippée), (ré)écrit chaque meta .json (tags +
 * horodatage frais), et renvoie la liste des copies gzip à exécuter (le caller choisit sync ou streaming).
 */
function planAgent(ref: AgentRef): GzJob[] {
  const src = claudeProjectDir(ref.cwd)
  let files: string[]
  try {
    files = readdirSync(src).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return [] // pas de transcripts pour ce cwd
  }
  if (!files.length) return []
  const slug = (ref.role === 'orchestrator' ? 'orchestrator' : ref.agent || ref.termId).toLowerCase()
  const outDir = join(archiveRoot(ref.project), slug)
  try {
    mkdirSync(outDir, { recursive: true })
  } catch {
    return []
  }
  const tasks = tasksFor(ref.termId)
  const jobs: GzJob[] = []
  for (const f of files) {
    const sp = join(src, f)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(sp)
    } catch {
      continue
    }
    const sessionId = f.replace(/\.jsonl$/, '')
    const gzPath = join(outDir, `${sessionId}.jsonl.gz`)
    const metaPath = join(outDir, `${sessionId}.meta.json`)
    const prev = readJson<{ sourceBytes: number; sourceMtimeMs: number }>(metaPath)
    const needsGzip =
      !prev || prev.sourceBytes !== st.size || prev.sourceMtimeMs !== st.mtimeMs || !existsSync(gzPath)
    // meta réécrite à CHAQUE passage (MAJ tags/horodatage) ; le gzip ne tourne que si le source a changé.
    writeFileAtomic(
      metaPath,
      JSON.stringify(
        {
          sessionId,
          agent: ref.agent,
          role: ref.role,
          workspaceId: ref.workspaceId,
          project: ref.project,
          bytes: st.size,
          sourceMtimeMs: st.mtimeMs,
          archivedAt: Date.now(),
          gz: `${slug}/${sessionId}.jsonl.gz`,
          tasks,
        },
        null,
        2,
      ),
    )
    if (needsGzip) jobs.push({ src: sp, dest: gzPath })
  }
  return jobs
}

function gzipSyncFile(src: string, dest: string): void {
  try {
    const tmp = `${dest}.tmp`
    writeFileSync(tmp, gzipSync(readFileSync(src)))
    renameSync(tmp, dest)
  } catch {
    /* best-effort */
  }
}
function gzipStreamFile(src: string, dest: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tmp = `${dest}.tmp`
      const ws = createWriteStream(tmp)
      const finish = (ok: boolean): void => {
        if (ok) {
          try {
            renameSync(tmp, dest)
          } catch {
            /* ignore */
          }
        }
        resolve()
      }
      const rs = createReadStream(src)
      const gz = createGzip()
      rs.on('error', () => finish(false))
      gz.on('error', () => finish(false))
      ws.on('error', () => finish(false))
      ws.on('finish', () => finish(true))
      rs.pipe(gz).pipe(ws)
    } catch {
      resolve()
    }
  })
}

/** Reconstruit un index.ndjson consolidé par projet (1 ligne = 1 session, agrégé depuis les meta .json). */
function rebuildIndexes(projects: string[]): void {
  for (const project of [...new Set(projects)]) {
    try {
      const root = archiveRoot(project)
      if (!existsSync(root)) continue
      const lines: string[] = []
      for (const slug of readdirSync(root)) {
        const ad = join(root, slug)
        try {
          if (!statSync(ad).isDirectory()) continue
        } catch {
          continue
        }
        for (const f of readdirSync(ad)) {
          if (!f.endsWith('.meta.json')) continue
          const m = readJson(join(ad, f))
          if (m) lines.push(JSON.stringify(m))
        }
      }
      writeFileAtomic(join(root, 'index.ndjson'), lines.length ? `${lines.join('\n')}\n` : '')
    } catch {
      /* best-effort */
    }
  }
}

/** Sweep ASYNC (gzip en streaming → pas de jank du process main). Utilisé périodiquement + au report. */
export async function sweepArchive(): Promise<void> {
  const agents = allAgents()
  for (const ref of agents) {
    for (const job of planAgent(ref)) await gzipStreamFile(job.src, job.dest)
  }
  rebuildIndexes(agents.map((a) => a.project))
}

/** Sweep SYNC (bloquant) — pour will-quit : garantit l'écriture du delta AVANT killAllTerminals + closeDb. */
export function sweepArchiveSync(): void {
  const agents = allAgents()
  for (const ref of agents) {
    for (const job of planAgent(ref)) gzipSyncFile(job.src, job.dest)
  }
  rebuildIndexes(agents.map((a) => a.project))
}
