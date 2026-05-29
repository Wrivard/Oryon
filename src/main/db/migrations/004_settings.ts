import type { Database } from 'better-sqlite3'

/**
 * Migration v4 : module Settings (Phase 4).
 * - app_settings : clé/valeur global app (modèle agent par défaut, voice, thème…).
 * - mcp_connectors : serveurs MCP gérés par Oryon, scope 'app' (toujours actifs) ou 'project'
 *   (liés à un projet). Injectés aux agents via --mcp-config selon le projet du terminal.
 */
export const migration004 = {
  version: 4,
  name: 'settings',
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS mcp_connectors (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        scope      TEXT NOT NULL DEFAULT 'app',   -- 'app' | 'project'
        project_id TEXT,                          -- requis si scope='project'
        transport  TEXT NOT NULL DEFAULT 'stdio', -- 'stdio' | 'http'
        command    TEXT,                          -- stdio : exécutable
        args       TEXT,                          -- stdio : JSON array d'arguments
        url        TEXT,                          -- http : endpoint
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_scope ON mcp_connectors(scope, project_id);
    `)
  },
}
