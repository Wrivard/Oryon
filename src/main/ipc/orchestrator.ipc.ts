import { ipcMain } from 'electron'
import { submitGoal, runTask, setTaskStatus, stopSwarm, initOrchestrator, approvePlan } from '../services/orchestrator/router'
import { listTasks } from '../services/orchestrator/task-store'
import { listMailbox } from '../services/orchestrator/mailbox'
import type { Task, MailboxMessage, TaskStatus, SubmitMode } from '../../shared/types'

export function registerOrchestratorIpc() {
  initOrchestrator() // installe l'observateur du flux PTY (une fois)

  ipcMain.handle('orchestrator:submit', (_e, workspaceId: string, goal: string, mode: SubmitMode): Promise<Task[]> =>
    submitGoal(workspaceId, goal, mode),
  )
  ipcMain.handle('orchestrator:approvePlan', (_e, workspaceId: string): void => approvePlan(workspaceId))
  ipcMain.handle('orchestrator:listTasks', (_e, workspaceId: string): Task[] => listTasks(workspaceId))
  ipcMain.handle('orchestrator:listMailbox', (_e, workspaceId: string): MailboxMessage[] =>
    listMailbox(workspaceId),
  )
  ipcMain.handle('orchestrator:updateTaskStatus', (_e, taskId: string, status: TaskStatus): void =>
    setTaskStatus(taskId, status),
  )
  ipcMain.handle('orchestrator:runTask', (_e, taskId: string): void => runTask(taskId))
  ipcMain.handle('orchestrator:stop', (_e, workspaceId: string): void => stopSwarm(workspaceId))
}
