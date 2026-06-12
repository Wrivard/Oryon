import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import chokidar from 'chokidar'
import { addDataObserver } from './pty-manager'
import { getDb } from '../db'
import { stripAnsi } from './orchestrator/mailbox'
import { drainPendingMerges } from './orchestrator/merge-back'
import { sweepArchive } from './archive'
import { navigateBrowser, requestBrowserScreenshot, appendAppConsole } from '../ipc/browser.ipc'
import { recordSystemFeedback, resolveSystemFeedback } from '../ipc/system-feedback.ipc'
import { importDoc } from './docs-import'
import * as docsImportCmd from './docs-import-command.mjs'
import { COMMAND_TYPES } from '../../shared/command-types.mjs'
import {
  agentMailbox,
  setTaskStatus,
  agentAssignTask,
  agentReportTask,
  agentApproveTask,
  agentBroadcastCommand,
  agentRestartAgent,
  agentAddConnector,
  agentFlushArchive,
  agentResetOrchestrator,
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

// Sweep des issues d'import (docs-import/<reqId>.{json,err}) : l'outil MCP `import_doc` les relit en polling
// COURT puis le main les unlink après lecture. Une issue survivant > 1 h = orpheline (poll abandonné / crash) →
// on la balaie. Throttle 10 min : inutile de stat le dossier à chaque tick 2 s.
const DOCS_IMPORT_TTL_MS = 60 * 60_000
let lastDocsImportSweep = 0
function maybeSweepDocsImport(): void {
  if (Date.now() - lastDocsImportSweep < 600_000) return
  lastDocsImportSweep = Date.now()
  const importDir = join(dir, docsImportCmd.DOCS_IMPORT_SUBDIR)
  let files: string[]
  try {
    files = readdirSync(importDir)
  } catch {
    return // dossier absent (aucun import déclenché) : rien à balayer
  }
  const now = Date.now()
  for (const f of files) {
    if (!/\.(json|err)$/.test(f)) continue
    const p = join(importDir, f)
    try {
      if (now - statSync(p).mtimeMs > DOCS_IMPORT_TTL_MS) unlinkSync(p)
    } catch {
      /* déjà supprimé / illisible : ignore */
    }
  }
}

// Sweep des captures du panneau Browser (screenshots/<reqId>.{png,err}) : l'outil MCP `browser_screenshot` les
// relit en polling COURT (~12 s) puis ne les supprime jamais → un fichier survivant > 1 h est orphelin (capture
// jamais relue / crash). Même convention que maybeSweepDocsImport (throttle 10 min : inutile de stat à chaque tick).
const SCREENSHOT_TTL_MS = 60 * 60_000
let lastScreenshotSweep = 0
function maybeSweepScreenshots(): void {
  if (Date.now() - lastScreenshotSweep < 600_000) return
  lastScreenshotSweep = Date.now()
  const shotDir = join(dir, 'screenshots')
  let files: string[]
  try {
    files = readdirSync(shotDir)
  } catch {
    return // dossier absent (aucune capture déclenchée) : rien à balayer
  }
  const now = Date.now()
  for (const f of files) {
    if (!/\.(png|err)$/.test(f)) continue
    const p = join(shotDir, f)
    try {
      if (now - statSync(p).mtimeMs > SCREENSHOT_TTL_MS) unlinkSync(p)
    } catch {
      /* déjà supprimé / illisible : ignore */
    }
  }
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
    if (!COMMAND_TYPES.includes(cmd.type)) {
      console.error('[mcp-export] type de commande inconnu (pas dans COMMAND_TYPES ou handler manquant) :', cmd.type, path)
    } else if (cmd.type === 'mailbox') {
      agentMailbox(cmd.workspaceId, cmd.fromAgent, cmd.body)
    } else if (cmd.type === 'update-task-status') {
      setTaskStatus(cmd.taskId, cmd.status)
    } else if (cmd.type === 'assign-task') {
      // SPEC-B : achemine docSlug (doc de référence) + readOnly (tâche de consultation) vers le router.
      await agentAssignTask(
        cmd.workspaceId,
        cmd.terminal,
        cmd.instructions,
        cmd.title ?? undefined,
        cmd.files ?? undefined,
        cmd.docSlug ?? undefined,
        cmd.readOnly ?? undefined,
      )
    } else if (cmd.type === 'report-task') {
      await agentReportTask(
        cmd.workspaceId,
        cmd.fromAgent ?? null,
        cmd.status,
        cmd.summary ?? '',
        { filesChanged: cmd.filesChanged ?? null, committed: cmd.committed ?? null },
        cmd.taskId ?? null,
      )
    } else if (cmd.type === 'approve-task') {
      agentApproveTask(cmd.taskId)
    } else if (cmd.type === 'broadcast-command') {
      agentBroadcastCommand(cmd.workspaceId, cmd.command, cmd.terminal ?? undefined)
    } else if (cmd.type === 'restart-agent') {
      agentRestartAgent(cmd.workspaceId, cmd.terminal)
    } else if (cmd.type === 'add-connector') {
      agentAddConnector(cmd.workspaceId, cmd.connector)
    } else if (cmd.type === 'browser-open') {
      // Trace boîte noire : les morts silencieuses observées suivent la séquence open→screenshot (cf. black-box.ts).
      appendAppConsole('log', `[browser] open ${cmd.url} (ws ${cmd.workspaceId})`, 'main')
      navigateBrowser(cmd.workspaceId, cmd.url)
    } else if (cmd.type === 'browser-screenshot') {
      appendAppConsole('log', `[browser] screenshot demandé (ws ${cmd.workspaceId}, req ${cmd.reqId})`, 'main')
      requestBrowserScreenshot(cmd.workspaceId, cmd.reqId)
    } else if (cmd.type === 'docs-import') {
      // Import déclenché par l'outil MCP `import_doc` (orchestrateur). L'issue est déposée sous
      // mcp-state/docs-import/<reqId>.{json,err} par runDocsImport, où l'outil la relit en polling.
      await docsImportCmd.runDocsImport({
        stateDir: dir,
        reqId: cmd.reqId,
        args: { url: cmd.url ?? undefined, markdown: cmd.markdown ?? undefined, label: cmd.label ?? undefined },
        importDoc,
        // Rediffuse la progression au renderer (vue panneau Docs) : sinon l'indicateur d'import déclenché par un
        // AGENT ne s'allume jamais (le panneau n'écoute que docs:import-progress, jusqu'ici émis par l'IPC UI seul).
        onProgress: (p) => {
          for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('docs:import-progress', p)
        },
      })
    } else if (cmd.type === 'flush-archive') {
      agentFlushArchive(cmd.workspaceId)
    } else if (cmd.type === 'reset-orchestrator') {
      appendAppConsole('info', '[reset] flush + /clear demandés sur l’orchestrateur', 'reset-orchestrator')
      void agentResetOrchestrator(cmd.workspaceId, cmd.rehydration ?? null)
    } else if (cmd.type === 'report-system-issue') {
      await recordSystemFeedback(cmd)
    } else if (cmd.type === 'resolve-system-issue') {
      await resolveSystemFeedback(cmd.issueId, cmd.status, cmd.note ?? null)
    } else {
      console.error('[mcp-export] type de commande inconnu (pas dans COMMAND_TYPES ou handler manquant) :', cmd.type, path)
    }
    try {
      unlinkSync(path)
      processedCommands.delete(path) // fichier réellement supprimé → libère l'entrée du Set (sinon il fuit indéfiniment)
    } catch {
      /* ignore : déjà supprimé (on garde l'entrée pour ne pas re-traiter un résidu) */
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
  // Archivage des transcripts de conversation : 1er sweep ~30 s après le boot, puis throttle 2 min. Gzip en
  // STREAMING → pas de jank du process main ; incrémental (dédup) ; $0 (FS only). Cf. services/archive.ts.
  let lastArchiveSweep = 0
  const maybeArchive = (): void => {
    if (Date.now() - lastArchiveSweep < 120_000) return
    lastArchiveSweep = Date.now()
    void sweepArchive()
  }
  setTimeout(maybeArchive, 30_000)
  // Tick 2s : sync de l'état + rejeu des merges reportés (F7) dès que le tronc principal redevient propre.
  setInterval(() => {
    safeMeta()
    void drainPendingMerges()
    tickWatchdog() // WC : surface (sans tuer) les workers busy silencieux > 5 min
    maybeArchive()
    maybeSweepDocsImport() // balaie les issues d'import orphelines (> 1 h), throttle interne 10 min
    maybeSweepScreenshots() // balaie les captures Browser orphelines (> 1 h), throttle interne 10 min
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
  // Balaie les commandes résiduelles d'un run précédent (app fermée mid-traitement, ex. un long docs-import) :
  // les rejouer au boot serait incorrect (état périmé) — on les supprime, et ignoreInitial empêche tout replay.
  try {
    for (const f of readdirSync(commandsDir)) if (f.endsWith('.json') || f.endsWith('.json.tmp')) unlinkSync(join(commandsDir, f))
  } catch {
    /* dossier vide / illisible : rien à balayer */
  }
  // Écritures côté serveur MCP désormais ATOMIQUES (tmp+rename, cf. command-types.mjs) →
  // plus besoin de l'attente de stabilisation chokidar (qui coûtait ~2 s de stabilityThreshold PAR commande).
  // File FIFO : une commande à la fois, dans l'ordre d'arrivée (processCommand est async ;
  // sans chaîne, deux fichiers proches s'entrelacent et l'ordre des mutations n'est pas garanti).
  commandWatcher = chokidar.watch(join(commandsDir, '*.json'), { ignoreInitial: true })
  let cmdChain: Promise<void> = Promise.resolve()
  commandWatcher.on('add', (p: string) => {
    cmdChain = cmdChain.then(() => processCommand(p)).catch(() => {})
  })
}
