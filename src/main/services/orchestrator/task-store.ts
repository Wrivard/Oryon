import { randomUUID as uuid } from 'node:crypto'
import { getDb } from '../../db'
import type { Task } from '../../../shared/types'

/** Résout (ou crée) le projet associé à un chemin (workspace.project_path). */
export function getOrCreateProjectId(name: string, path: string): string {
  const db = getDb()
  const found = db.prepare('SELECT id FROM projects WHERE path = ? LIMIT 1').pluck().get(path) as
    | string
    | undefined
  if (found) return found
  const id = uuid()
  db.prepare('INSERT INTO projects (id, name, description, path) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    null,
    path,
  )
  return id
}

export function createTask(t: {
  workspaceId: string
  projectId: string
  title: string
  role: string
  instructions: string
  dependsOn: string[]
}): Task {
  const now = Date.now()
  const task: Task = {
    id: uuid(),
    project_id: t.projectId,
    workspace_id: t.workspaceId,
    title: t.title,
    role: t.role,
    instructions: t.instructions,
    knowledge: null,
    depends_on: JSON.stringify(t.dependsOn),
    status: 'todo',
    assigned_terminal_id: null,
    created_at: now,
    updated_at: now,
  }
  getDb()
    .prepare(
      `INSERT INTO tasks (id, project_id, workspace_id, title, role, instructions, knowledge, depends_on, status, assigned_terminal_id, created_at, updated_at)
       VALUES (@id, @project_id, @workspace_id, @title, @role, @instructions, @knowledge, @depends_on, @status, @assigned_terminal_id, @created_at, @updated_at)`,
    )
    .run(task)
  return task
}

export function listTasks(workspaceId: string): Task[] {
  return getDb()
    .prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at')
    .all(workspaceId) as Task[]
}

export function getTask(id: string): Task | undefined {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined
}

export function updateTask(
  id: string,
  fields: Partial<Pick<Task, 'status' | 'assigned_terminal_id' | 'instructions' | 'title'>>,
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id, updated_at: Date.now() }
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = @${k}`)
    params[k] = v
  }
  sets.push('updated_at = @updated_at')
  getDb()
    .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`)
    .run(params)
}

/**
 * Réconciliation au DÉMARRAGE (W2) : toute task 'in-progress' est orpheline au boot (aucun PTY worker ne
 * tourne encore ; le terminalBusy in-memory repart vide). On les repasse 'todo' + détache le terminal, sinon
 * un terminal idle s'affiche "busy" pour toujours (busy est DÉRIVÉ des lignes in-progress, cf. mcp-export
 * writeMeta). Les 'in-review' sont CONSERVÉES (elles gardent assigned_terminal_id pour le merge à l'approbation).
 * Retourne le nombre de lignes réconciliées.
 */
export function reconcileStaleTasks(): number {
  const res = getDb()
    .prepare("UPDATE tasks SET status='todo', assigned_terminal_id=NULL, updated_at=? WHERE status='in-progress'")
    .run(Date.now())
  return res.changes
}
