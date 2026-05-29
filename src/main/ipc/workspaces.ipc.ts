import { ipcMain } from 'electron'
import { v4 as uuid } from 'uuid'
import { getDb } from '../db'
import { buildClaudeCommand } from '../services/claude-launcher'
import { killTerminal } from '../services/pty-manager'
import { isGitRepo, ensureWorktree, pruneMergedWorktrees } from '../services/worktrees'
import {
  AGENT_NAMES,
  LAYOUT_PANES,
  type Workspace,
  type Terminal,
  type CreateWorkspaceInput,
  type UpdateWorkspaceInput,
  type WorkspaceWithTerminals,
} from '../../shared/types'

function listTerminals(workspaceId: string): Terminal[] {
  return getDb()
    .prepare('SELECT * FROM terminals WHERE workspace_id = ? ORDER BY pane_index')
    .all(workspaceId) as Terminal[]
}

export function registerWorkspacesIpc() {
  ipcMain.handle('workspaces:list', (): Workspace[] => {
    return getDb().prepare('SELECT * FROM workspaces ORDER BY last_opened DESC').all() as Workspace[]
  })

  // Flux A (01-ARCHITECTURE §4) : insert workspace + project + N terminals selon le layout.
  ipcMain.handle('workspaces:create', (_e, data: CreateWorkspaceInput): WorkspaceWithTerminals => {
    const db = getDb()
    const now = Date.now()
    const layout = data.layout ?? 'eight'
    const paneCount = LAYOUT_PANES[layout] ?? 8

    const ws: Workspace = {
      id: uuid(),
      name: data.name,
      project_path: data.projectPath,
      color: data.color ?? null,
      layout,
      created_at: now,
      last_opened: now,
      dev_command: null,
    }
    const autostart = buildClaudeCommand() // "claude"
    // Un worktree git par agent (isolation des éditions + git diff). SERIAL (sync execFileSync dans cette
    // boucle unique) → jamais de course sur .git/worktrees/index.lock. cwd reste = MAIN (ancre mémoire/run) ;
    // le worktree ne sert que de cwd au shell (cf. terminals.ipc / Terminal.tsx). Projet non-git → null.
    const isGit = isGitRepo(data.projectPath)
    const terminals: Terminal[] = Array.from({ length: paneCount }, (_, i) => {
      const name = AGENT_NAMES[i % AGENT_NAMES.length]
      return {
        id: uuid(),
        workspace_id: ws.id,
        name,
        color: null,
        role: 'free',
        cwd: data.projectPath,
        autostart_cmd: autostart,
        pane_index: i,
        worktree_path: isGit ? ensureWorktree(data.projectPath, name) : null,
      }
    })

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO workspaces (id, name, project_path, color, layout, created_at, last_opened, dev_command)
         VALUES (@id, @name, @project_path, @color, @layout, @created_at, @last_opened, @dev_command)`,
      ).run(ws)
      db.prepare(`INSERT INTO projects (id, name, description, path) VALUES (?, ?, ?, ?)`).run(
        uuid(),
        data.name,
        null,
        data.projectPath,
      )
      const insTerm = db.prepare(
        `INSERT INTO terminals (id, workspace_id, name, color, role, cwd, autostart_cmd, pane_index, worktree_path)
         VALUES (@id, @workspace_id, @name, @color, @role, @cwd, @autostart_cmd, @pane_index, @worktree_path)`,
      )
      for (const t of terminals) insTerm.run(t)
    })
    tx()

    return { workspace: ws, terminals }
  })

  ipcMain.handle('workspaces:open', (_e, id: string): WorkspaceWithTerminals => {
    const db = getDb()
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace | undefined
    if (!ws) throw new Error(`Workspace ${id} introuvable`)
    const now = Date.now()
    db.prepare('UPDATE workspaces SET last_opened = ? WHERE id = ?').run(now, id)
    return { workspace: { ...ws, last_opened: now }, terminals: listTerminals(id) }
  })

  ipcMain.handle('workspaces:listTerminals', (_e, workspaceId: string): Terminal[] =>
    listTerminals(workspaceId),
  )

  ipcMain.handle('workspaces:terminalCounts', (): Record<string, number> => {
    const rows = getDb()
      .prepare('SELECT workspace_id, COUNT(*) AS n FROM terminals GROUP BY workspace_id')
      .all() as Array<{ workspace_id: string; n: number }>
    const out: Record<string, number> = {}
    for (const r of rows) out[r.workspace_id] = r.n
    return out
  })

  ipcMain.handle('workspaces:addTerminal', (_e, workspaceId: string): Terminal => {
    const db = getDb()
    const existing = listTerminals(workspaceId)
    const nextIndex = existing.reduce((m, t) => Math.max(m, t.pane_index), -1) + 1
    const projectPath = db.prepare('SELECT project_path FROM workspaces WHERE id = ?').pluck().get(workspaceId) as string
    const name = AGENT_NAMES[nextIndex % AGENT_NAMES.length]
    const t: Terminal = {
      id: uuid(),
      workspace_id: workspaceId,
      name,
      color: null,
      role: 'free',
      cwd: projectPath,
      autostart_cmd: buildClaudeCommand(),
      pane_index: nextIndex,
      worktree_path: isGitRepo(projectPath) ? ensureWorktree(projectPath, name) : null,
    }
    db.prepare(
      `INSERT INTO terminals (id, workspace_id, name, color, role, cwd, autostart_cmd, pane_index, worktree_path)
       VALUES (@id, @workspace_id, @name, @color, @role, @cwd, @autostart_cmd, @pane_index, @worktree_path)`,
    ).run(t)
    return t
  })

  ipcMain.handle('workspaces:removeTerminal', (_e, id: string): void => {
    getDb().prepare('DELETE FROM terminals WHERE id = ?').run(id)
  })

  ipcMain.handle('workspaces:delete', (_e, id: string): void => {
    const db = getDb()
    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace | undefined
    // Tue d'abord les PTY éventuellement vivants (no-op si jamais spawnés), puis supprime.
    for (const t of listTerminals(id)) killTerminal(t.id)
    // Teardown des worktrees : retire UNIQUEMENT ceux entièrement mergés (+ leur branche). Les branches
    // non mergées sont CONSERVÉES (travail récupérable) — on les signale en console (plus d'UI après delete).
    if (ws && isGitRepo(ws.project_path)) {
      const retained = pruneMergedWorktrees(ws.project_path)
      if (retained.length) {
        console.warn(`[worktrees] branches d'agents non mergées CONSERVÉES (merge manuel possible) :`, retained.join(', '))
      }
    }
    // FK terminals ON DELETE CASCADE (foreign_keys=ON) → terminaux supprimés en cascade.
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  })

  ipcMain.handle('workspaces:update', (_e, id: string, data: UpdateWorkspaceInput): Workspace => {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | Workspace
      | undefined
    if (!existing) throw new Error(`Workspace ${id} introuvable`)
    const updated: Workspace = {
      ...existing,
      name: data.name ?? existing.name,
      layout: data.layout ?? existing.layout,
      color: data.color ?? existing.color,
      dev_command: data.devCommand ?? existing.dev_command,
      last_opened: Date.now(),
    }
    db.prepare(
      `UPDATE workspaces SET name=@name, layout=@layout, color=@color, dev_command=@dev_command, last_opened=@last_opened WHERE id=@id`,
    ).run({
      id: updated.id,
      name: updated.name,
      layout: updated.layout,
      color: updated.color,
      dev_command: updated.dev_command,
      last_opened: updated.last_opened,
    })
    return updated
  })
}
