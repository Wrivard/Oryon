import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { addDataObserver } from './pty-manager'
import { getDb } from '../db'
import { stripAnsi } from './orchestrator/mailbox'

// Export d'état pour le serveur MCP stdio (process séparé, lit ces fichiers — pas d'accès aux
// buffers in-memory ni à la DB Electron-ABI). On écrit :
//   mcp-state/meta.json        → terminaux (index), tasks, mailbox (rafraîchi périodiquement)
//   mcp-state/term-<id>.log    → derniers ~20KB de sortie (ANSI nettoyé) par terminal

const MAX_PER_TERM = 20000

const buffers = new Map<string, string>() // terminalId -> sortie récente nettoyée
const dirtyTerms = new Set<string>()
let dir = ''
let flushTimer: NodeJS.Timeout | null = null

function stateDir(): string {
  return join(app.getPath('userData'), 'mcp-state')
}

function writeMeta(): void {
  const db = getDb()
  const terminals = db
    .prepare(
      `SELECT t.id, t.name, t.role, t.workspace_id AS workspaceId, w.name AS workspaceName
       FROM terminals t LEFT JOIN workspaces w ON w.id = t.workspace_id
       ORDER BY t.workspace_id, t.pane_index`,
    )
    .all()
  const tasks = db
    .prepare('SELECT id, workspace_id, title, role, status, depends_on, assigned_terminal_id FROM tasks ORDER BY created_at')
    .all()
  const mailbox = db
    .prepare('SELECT id, workspace_id, from_agent, body, created_at FROM mailbox ORDER BY created_at DESC LIMIT 200')
    .all()
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ terminals, tasks, mailbox, updatedAt: Date.now() }, null, 2),
  )
}

function flushLogs(): void {
  flushTimer = null
  try {
    for (const id of dirtyTerms) writeFileSync(join(dir, `term-${id}.log`), buffers.get(id) ?? '')
    dirtyTerms.clear()
  } catch (e) {
    console.error('[mcp-export] écriture log échouée :', e)
  }
}

export function initMcpExport(): void {
  dir = stateDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  // meta rafraîchie périodiquement (terminaux/tasks/mailbox) ; logs terminaux en debounce sur le flux.
  const safeMeta = () => {
    try {
      writeMeta()
    } catch (e) {
      console.error('[mcp-export] écriture meta échouée :', e)
    }
  }
  safeMeta()
  setInterval(safeMeta, 2000)

  addDataObserver((terminalId, data) => {
    buffers.set(terminalId, ((buffers.get(terminalId) ?? '') + stripAnsi(data)).slice(-MAX_PER_TERM))
    dirtyTerms.add(terminalId)
    if (!flushTimer) flushTimer = setTimeout(flushLogs, 800)
  })
}
