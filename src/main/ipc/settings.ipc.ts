import { ipcMain, app } from 'electron'
import { v4 as uuid } from 'uuid'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { getDb } from '../db'
import type { McpConnector, McpConnectorInput, SkillInfo } from '../../shared/types'

// ---- app settings (clé/valeur) ----
function getAppSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key] = r.value
  return out
}
export function setAppSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}
/** Réglage app-global lu côté main (ex. modèle agent par défaut injecté au lancement). */
export function appSetting(key: string): string | undefined {
  const v = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get(key) as string | undefined
  return v
}

// ---- connecteurs MCP ----
function resolveProjectId(projectPath?: string | null): string | null {
  if (!projectPath) return null
  return (getDb().prepare('SELECT id FROM projects WHERE path = ?').pluck().get(projectPath) as string | undefined) ?? null
}

function listConnectors(projectPath?: string | null): McpConnector[] {
  const projectId = resolveProjectId(projectPath)
  const rows = getDb()
    .prepare(
      `SELECT * FROM mcp_connectors WHERE scope = 'app' OR (scope = 'project' AND project_id = ?) ORDER BY scope, name`,
    )
    .all(projectId) as Array<Record<string, unknown>>
  return rows.map((r) => ({ ...r, enabled: !!r.enabled })) as McpConnector[]
}

function addConnector(input: McpConnectorInput): McpConnector {
  const row: McpConnector = {
    id: uuid(),
    name: input.name,
    scope: input.scope,
    project_id: input.scope === 'project' ? resolveProjectId(input.projectPath) : null,
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ? JSON.stringify(input.args) : null,
    url: input.url ?? null,
    enabled: true,
    created_at: Date.now(),
  }
  getDb()
    .prepare(
      `INSERT INTO mcp_connectors (id, name, scope, project_id, transport, command, args, url, enabled, created_at)
       VALUES (@id, @name, @scope, @project_id, @transport, @command, @args, @url, 1, @created_at)`,
    )
    .run(row)
  return row
}

/**
 * Construit le fichier de config MCP pour un projet donné : le serveur **oryon** (toujours, pour donner aux
 * agents les outils Oryon Memory + état, pointé sur CE projet via ORYON_PROJECT_DIR) + les connecteurs MCP
 * scope 'app'/'project' activés. Renvoie toujours un chemin (l'oryon est toujours présent).
 */
export function buildProjectMcpConfigForPath(projectPath: string): string | null {
  const projectId = getDb().prepare('SELECT id FROM projects WHERE path = ?').pluck().get(projectPath) as
    | string
    | undefined
  const rows = getDb()
    .prepare(
      `SELECT * FROM mcp_connectors WHERE enabled = 1 AND (scope = 'app' OR (scope = 'project' AND project_id = ?))`,
    )
    .all(projectId ?? null) as Array<Record<string, unknown>>
  const mcpServers: Record<string, unknown> = {}
  // Serveur Oryon : outils mémoire partagée + état, adressés sur le projet travaillé (déterministe via env).
  // En PROD c'est un BUNDLE autonome (scripts/before-pack.cjs : esbuild inline @modelcontextprotocol/sdk + zod
  // + memory-core) → aucune résolution de node_modules. En DEV, la source résout ses deps depuis node_modules.
  const serverPath = app.isPackaged
    ? join(process.resourcesPath, 'mcp', 'server.mjs')
    : join(app.getAppPath(), 'src', 'mcp', 'server.mjs')
  // Lancé via le binaire de l'app en mode node (ELECTRON_RUN_AS_NODE), PAS `node` du PATH : (1) aucune
  // dépendance à un Node système, (2) toujours disponible (c'est notre propre exe). L'ancien `node server.mjs`
  // échouait en prod (« oryon · failed ») car @modelcontextprotocol/sdk vit dans l'asar, invisible à un node
  // standalone hors du repo. process.execPath est figé ici (process principal) → chemin absolu dans le config.
  mcpServers['oryon'] = {
    command: process.execPath,
    args: [serverPath],
    env: { ORYON_PROJECT_DIR: projectPath, ELECTRON_RUN_AS_NODE: '1' },
  }
  for (const r of rows) {
    const name = String(r.name)
    if (name === 'oryon') continue // ne pas écraser notre serveur
    if (r.transport === 'http' && r.url) mcpServers[name] = { type: 'http', url: r.url }
    else if (r.command) mcpServers[name] = { command: r.command, args: r.args ? JSON.parse(String(r.args)) : [] }
  }
  const file = join(app.getPath('userData'), `oryon-mcp-${projectId ?? 'app'}.json`)
  writeFileSync(file, JSON.stringify({ mcpServers }, null, 2))
  return file
}

// ---- skills (lecture seule) ----
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\s*([\s\S]*?)\s*---/)
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(name|description)\s*:\s*(.+)$/)
    if (kv) out[kv[1] as 'name' | 'description'] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}
function listSkills(): SkillInfo[] {
  const dir = join(homedir(), '.claude', 'skills')
  if (!existsSync(dir)) return []
  const out: SkillInfo[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillMd = join(dir, entry.name, 'SKILL.md')
    let fm: { name?: string; description?: string } = {}
    try {
      if (existsSync(skillMd)) fm = parseFrontmatter(readFileSync(skillMd, 'utf8'))
    } catch {
      /* ignore */
    }
    out.push({ name: fm.name ?? entry.name, description: fm.description ?? '', source: 'user' })
  }
  return out
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:getApp', (): Record<string, string> => getAppSettings())
  ipcMain.handle('settings:setApp', (_e, key: string, value: string): void => setAppSetting(key, value))
  ipcMain.handle('settings:listConnectors', (_e, projectPath?: string | null): McpConnector[] => listConnectors(projectPath))
  ipcMain.handle('settings:addConnector', (_e, input: McpConnectorInput): McpConnector => addConnector(input))
  ipcMain.handle('settings:toggleConnector', (_e, id: string, enabled: boolean): void => {
    getDb().prepare('UPDATE mcp_connectors SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  })
  ipcMain.handle('settings:deleteConnector', (_e, id: string): void => {
    getDb().prepare('DELETE FROM mcp_connectors WHERE id = ?').run(id)
  })
  ipcMain.handle('settings:listSkills', (): SkillInfo[] => listSkills())
}
