import { app } from 'electron'
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import chokidar from 'chokidar'
import { addDataObserver } from './pty-manager'
import { getDb } from '../db'
import { stripAnsi } from './orchestrator/mailbox'
import { drainPendingMerges } from './orchestrator/merge-back'
import {
  agentMailbox,
  setTaskStatus,
  agentAssignTask,
  agentReportTask,
  agentApproveTask,
  agentBroadcastCommand,
  agentRestartAgent,
  tickWatchdog,
} from './orchestrator/router'

// Export d'état pour le serveur MCP stdio (process séparé, lit ces fichiers — pas d'accès aux
// buffers in-memory ni à la DB Electron-ABI). On écrit :
//   mcp-state/meta.json        → terminaux (index), tasks, mailbox (rafraîchi périodiquement)
//   mcp-state/term-<id>.log    → derniers ~20KB de sortie (ANSI nettoyé) par terminal

const MAX_PER_TERM = 20000

// Écriture atomique (temp + rename) : le serveur MCP (et les 8 agents) ne lisent jamais un JSON tronqué.
let mcpTmpSeq = 0
function writeFileAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}-${++mcpTmpSeq}`
  writeFileSync(tmp, content)
  renameSync(tmp, target)
}

const buffers = new Map<string, string>() // terminalId -> sortie récente nettoyée
const dirtyTerms = new Set<string>()
let dir = ''
let flushTimer: NodeJS.Timeout | null = null
let commandWatcher: chokidar.FSWatcher | null = null
const processedCommands = new Set<string>()

function stateDir(): string {
  return join(app.getPath('userData'), 'mcp-state')
}

function writeMeta(): void {
  const db = getDb()
  const terminalsRaw = db
    .prepare(
      `SELECT t.id, t.name, t.role, t.workspace_id, w.name AS workspaceName
       FROM terminals t LEFT JOIN workspaces w ON w.id = t.workspace_id
       ORDER BY t.workspace_id, t.pane_index`,
    )
    .all() as Array<{ id: string; [k: string]: unknown }>
  const tasks = db
    .prepare('SELECT id, workspace_id, title, role, status, depends_on, assigned_terminal_id FROM tasks ORDER BY created_at')
    .all() as Array<{ id: string; title?: string | null; status?: string; assigned_terminal_id?: string | null }>
  // État busy/task courant par terminal, dérivé des tasks in-progress (pour list_terminals côté MCP).
  const busyByTerm = new Map<string, string>()
  for (const t of tasks) {
    if (t.status === 'in-progress' && t.assigned_terminal_id) busyByTerm.set(t.assigned_terminal_id, t.title ?? t.id)
  }
  const terminals = terminalsRaw.map((t) => ({ ...t, busy: busyByTerm.has(t.id), task: busyByTerm.get(t.id) ?? null }))
  const mailbox = db
    .prepare('SELECT id, workspace_id, from_agent, body, created_at FROM mailbox ORDER BY created_at DESC LIMIT 200')
    .all()
  writeFileAtomic(join(dir, 'meta.json'), JSON.stringify({ terminals, tasks, mailbox, updatedAt: Date.now() }, null, 2))
}

function flushLogs(): void {
  flushTimer = null
  try {
    for (const id of dirtyTerms) writeFileAtomic(join(dir, `term-${id}.log`), buffers.get(id) ?? '')
    dirtyTerms.clear()
  } catch (e) {
    console.error('[mcp-export] écriture log échouée :', e)
  }
}

async function processCommand(path: string): Promise<void> {
  if (processedCommands.has(path)) return
  processedCommands.add(path)
  try {
    const cmd = JSON.parse(readFileSync(path, 'utf8'))
    if (cmd.type === 'mailbox') {
      agentMailbox(cmd.workspaceId, cmd.fromAgent, cmd.body)
    } else if (cmd.type === 'update-task-status') {
      setTaskStatus(cmd.taskId, cmd.status)
    } else if (cmd.type === 'assign-task') {
      await agentAssignTask(cmd.workspaceId, cmd.terminal, cmd.instructions, cmd.title ?? undefined, cmd.files ?? undefined)
    } else if (cmd.type === 'report-task') {
      await agentReportTask(cmd.workspaceId, cmd.fromAgent ?? null, cmd.status, cmd.summary ?? '', {
        filesChanged: cmd.filesChanged ?? null,
        committed: cmd.committed ?? null,
      })
    } else if (cmd.type === 'approve-task') {
      agentApproveTask(cmd.taskId)
    } else if (cmd.type === 'broadcast-command') {
      agentBroadcastCommand(cmd.workspaceId, cmd.command, cmd.terminal ?? undefined)
    } else if (cmd.type === 'restart-agent') {
      agentRestartAgent(cmd.workspaceId, cmd.terminal)
    }
    try {
      unlinkSync(path)
    } catch {
      /* ignore : déjà supprimé */
    }
  } catch (e) {
    console.error('[mcp-export] commande échouée :', path, e)
    processedCommands.delete(path)
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
  // Tick 2s : sync de l'état + rejeu des merges reportés (F7) dès que le tronc principal redevient propre.
  setInterval(() => {
    safeMeta()
    void drainPendingMerges()
    tickWatchdog() // WC : surface (sans tuer) les workers busy silencieux > 5 min
  }, 2000)

  addDataObserver((terminalId, data) => {
    buffers.set(terminalId, ((buffers.get(terminalId) ?? '') + stripAnsi(data)).slice(-MAX_PER_TERM))
    dirtyTerms.add(terminalId)
    if (!flushTimer) flushTimer = setTimeout(flushLogs, 800)
  })

  // Surveille les commandes MCP→main écrites par les agents (send_mailbox, update_task_status).
  const commandsDir = join(dir, 'commands')
  try {
    mkdirSync(commandsDir, { recursive: true })
  } catch {
    /* ignore */
  }
  commandWatcher = chokidar.watch(join(commandsDir, '*.json'), { awaitWriteFinish: true })
  commandWatcher.on('add', processCommand)
}
