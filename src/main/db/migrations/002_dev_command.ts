import type { Database } from 'better-sqlite3'

/**
 * Migration v2 : commande de dev configurable par workspace (panneau Browser, Phase 2).
 * ALTER ADD COLUMN est sûr et idempotent au niveau migration (user_version gate).
 */
export const migration002 = {
  version: 2,
  name: 'workspace_dev_command',
  up: (db: Database) => {
    db.exec(`ALTER TABLE workspaces ADD COLUMN dev_command TEXT`)
  },
}
