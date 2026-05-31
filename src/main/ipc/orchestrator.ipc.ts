import { ipcMain } from 'electron'
import { setTaskStatus, stopSwarm, initOrchestrator } from '../services/orchestrator/router'
import { listTasks } from '../services/orchestrator/task-store'
import { listMailbox } from '../services/orchestrator/mailbox'
import type { Task, MailboxMessage, TaskStatus } from '../../shared/types'

// L'orchestration est pilotée par le terminal orchestrateur dédié (via outils MCP, cf. router/mcp-export).
// Ce module n'expose plus que la LECTURE de l'état (tasks/mailbox), la mise à jour manuelle de statut
// (drag-drop du panneau Tasks) et l'arrêt du travail en cours.
export function registerOrchestratorIpc() {
  initOrchestrator() // installe l'observateur du flux PTY (une fois)

  ipcMain.handle('orchestrator:listTasks', (_e, workspaceId: string): Task[] => listTasks(workspaceId))
  ipcMain.handle('orchestrator:listMailbox', (_e, workspaceId: string): MailboxMessage[] =>
    listMailbox(workspaceId),
  )
  ipcMain.handle('orchestrator:updateTaskStatus', (_e, taskId: string, status: TaskStatus): void =>
    setTaskStatus(taskId, status),
  )
  ipcMain.handle('orchestrator:stop', (_e, workspaceId: string): void => stopSwarm(workspaceId))
}
