import type { Database } from 'better-sqlite3'

/**
 * Migration v11 : secrets + catalogue pour les connecteurs MCP (wizard plug-and-play).
 * - env        : JSON CHIFFRÉ (safeStorage) des variables d'env (transport stdio).
 * - headers    : JSON CHIFFRÉ (safeStorage) des en-têtes http/sse (ex. Authorization).
 * - catalog_id : id d'entrée du catalogue si le connecteur vient du wizard (sinon NULL).
 * `ALTER TABLE ADD COLUMN` est non destructif : colonnes NULL sur les lignes existantes.
 */
export const migration011 = {
  version: 11,
  name: 'mcp_secrets',
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE mcp_connectors ADD COLUMN env TEXT;
      ALTER TABLE mcp_connectors ADD COLUMN headers TEXT;
      ALTER TABLE mcp_connectors ADD COLUMN catalog_id TEXT;
    `)
  },
}
