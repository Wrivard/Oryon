// Schéma canonique SQLite (docs/01-ARCHITECTURE.md §3).
// Appliqué via la migration 001 (db/migrations/001_init.ts).
// `IF NOT EXISTS` rend l'exécution idempotente sur une DB déjà créée.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  project_path  TEXT NOT NULL,
  color         TEXT,
  layout        TEXT NOT NULL DEFAULT 'quad',
  created_at    INTEGER,
  last_opened   INTEGER
);

CREATE TABLE IF NOT EXISTS terminals (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT,
  role          TEXT,
  cwd           TEXT NOT NULL,
  autostart_cmd TEXT,
  pane_index    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  path          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instructions          TEXT NOT NULL,
  knowledge             TEXT,
  status                TEXT NOT NULL DEFAULT 'todo',
  assigned_terminal_id  TEXT,
  created_at            INTEGER,
  updated_at            INTEGER
);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  role          TEXT
);

CREATE TABLE IF NOT EXISTS mailbox (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  from_agent    TEXT,
  to_agent      TEXT,
  body          TEXT NOT NULL,
  created_at    INTEGER
);
`
