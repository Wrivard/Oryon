import { ipcMain, BrowserWindow } from 'electron'
import { getDb } from '../db'
import * as core from '../../shared/system-feedback-core.mjs'
import type { SystemFeedbackFilter, SystemFeedbackStatus } from '../../shared/types'

// System Feedback — IPC + écriture du store GLOBAL cross-workspace (~/.oryon/system-feedback/reports.ndjson).
// Les RAPPORTS sont déposés par l'orchestrateur via l'outil MCP report_system_issue : la commande transite par
// mcp-export → recordSystemFeedback() ici (un SEUL writer côté main → pas de course avec la réécriture de statut).
// La vue renderer lit via 'system-feedback:list' et change le statut via 'system-feedback:update-status'.
// Toute écriture émet 'system-feedback:changed' pour rafraîchir la vue en direct.

function broadcastChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('system-feedback:changed')
}

/** Résout nom + chemin d'un workspace depuis son id (attribution cross-workspace). Best-effort → 'unknown'. */
function resolveWorkspace(workspaceId: string | null): { workspace: string; workspacePath?: string } {
  if (!workspaceId) return { workspace: 'unknown' }
  try {
    const row = getDb()
      .prepare('SELECT name, project_path FROM workspaces WHERE id = ?')
      .get(workspaceId) as { name?: string; project_path?: string } | undefined
    if (row) return { workspace: row.name || 'unknown', workspacePath: row.project_path || undefined }
  } catch {
    /* best-effort */
  }
  return { workspace: 'unknown' }
}

/**
 * Dépose un rapport système (déclenché par l'outil MCP report_system_issue via mcp-export). Le core pose
 * id/ts/status ; on résout ici le workspace. Append best-effort (ne throw jamais), puis broadcast UI.
 */
export async function recordSystemFeedback(cmd: {
  workspaceId?: string | null
  agent?: string | null
  category: string
  severity: string
  title: string
  exactError: string
  hypothesizedCause: string
  relevantData?: string | null
  suggestedFix?: string | null
}): Promise<void> {
  const ws = resolveWorkspace(cmd.workspaceId ?? null)
  const written = await core.appendReport({
    workspace: ws.workspace,
    workspacePath: ws.workspacePath,
    agent: cmd.agent || 'orchestrator',
    category: cmd.category,
    severity: cmd.severity,
    title: cmd.title,
    exactError: cmd.exactError,
    hypothesizedCause: cmd.hypothesizedCause,
    relevantData: cmd.relevantData || undefined,
    suggestedFix: cmd.suggestedFix || undefined,
    status: 'open',
  })
  if (written) broadcastChanged()
}

/** Change le statut d'un rapport (déclenché par l'outil MCP resolve_system_issue OU l'UI). */
export async function resolveSystemFeedback(
  issueId: string,
  status: SystemFeedbackStatus,
  note?: string | null,
): Promise<boolean> {
  const ok = await core.updateReportStatus(issueId, status, note ?? undefined, Date.now())
  if (ok) broadcastChanged()
  return ok
}

/** Handlers IPC de la vue System Feedback (lecture + changement de statut). */
export function registerSystemFeedbackIpc(): void {
  ipcMain.handle('system-feedback:list', (_e, filter?: SystemFeedbackFilter) => core.listReports(filter ?? {}))
  ipcMain.handle(
    'system-feedback:update-status',
    async (_e, id: string, status: SystemFeedbackStatus, note?: string) => {
      const ok = await resolveSystemFeedback(id, status, note ?? null)
      return { ok }
    },
  )
}
