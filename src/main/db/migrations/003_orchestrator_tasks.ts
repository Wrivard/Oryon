import type { Database } from 'better-sqlite3'

/**
 * Migration v3 : colonnes orchestrateur sur `tasks` (Phase 3).
 * Le decomposer produit title/role/dependsOn ; le Kanban a besoin de title/role ;
 * workspace_id permet de scoper directement par workspace.
 */
export const migration003 = {
  version: 3,
  name: 'orchestrator_tasks',
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN title TEXT;
      ALTER TABLE tasks ADD COLUMN role TEXT;
      ALTER TABLE tasks ADD COLUMN workspace_id TEXT;
      ALTER TABLE tasks ADD COLUMN depends_on TEXT;
    `)
  },
}
