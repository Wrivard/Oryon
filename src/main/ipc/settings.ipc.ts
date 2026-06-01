import { ipcMain, app, safeStorage, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db'
import { MCP_CATALOG } from '../services/mcp-catalog'
import { testConnector, detectImportCandidates } from '../services/mcp-probe'
import type {
  McpConnector,
  McpConnectorInput,
  McpConnectorUpdate,
  McpConnectorSecrets,
  McpScope,
  McpTransport,
  McpCatalogEntry,
  McpImportCandidate,
  McpImportResult,
  McpTestResult,
} from '../../shared/types'

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

// ---- secrets (env/headers) chiffrés au repos ----
// Chiffrés via Electron safeStorage (DPAPI sous Windows / Keychain / libsecret). Stockés préfixés
// `enc:v1:` + base64 ; repli en JSON clair si le coffre OS est indisponible (le préfixe disambigue
// la lecture). Déchiffrés UNIQUEMENT à la génération du config (just-in-time, écrit en 0o600) et pour
// préremplir le formulaire d'édition (connectorSecrets) — jamais renvoyés par listConnectors.
const ENC_PREFIX = 'enc:v1:'
function encryptSecrets(obj: Record<string, string> | null | undefined): string | null {
  if (!obj || Object.keys(obj).length === 0) return null
  const json = JSON.stringify(obj)
  if (safeStorage.isEncryptionAvailable()) return ENC_PREFIX + safeStorage.encryptString(json).toString('base64')
  return json
}
function decryptSecrets(stored: unknown): Record<string, string> {
  if (typeof stored !== 'string' || stored.length === 0) return {}
  try {
    if (stored.startsWith(ENC_PREFIX)) {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
      return JSON.parse(safeStorage.decryptString(buf)) as Record<string, string>
    }
    return JSON.parse(stored) as Record<string, string>
  } catch {
    return {}
  }
}

/** Mappe une ligne DB vers le type public : enabled→bool, présence de secrets (jamais les VALEURS). */
function rowToConnector(r: Record<string, unknown>): McpConnector {
  return {
    id: String(r.id),
    name: String(r.name),
    scope: r.scope as McpScope,
    project_id: (r.project_id as string | null) ?? null,
    transport: r.transport as McpTransport,
    command: (r.command as string | null) ?? null,
    args: (r.args as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    enabled: !!r.enabled,
    created_at: (r.created_at as number | null) ?? null,
    catalog_id: (r.catalog_id as string | null) ?? null,
    hasEnv: typeof r.env === 'string' && r.env.length > 0,
    hasHeaders: typeof r.headers === 'string' && r.headers.length > 0,
  }
}

function listConnectors(projectPath?: string | null): McpConnector[] {
  const projectId = resolveProjectId(projectPath)
  const rows = getDb()
    .prepare(
      `SELECT * FROM mcp_connectors WHERE scope = 'app' OR (scope = 'project' AND project_id = ?) ORDER BY scope, name`,
    )
    .all(projectId) as Array<Record<string, unknown>>
  return rows.map(rowToConnector)
}

/** Validation de forme (a4) : refuse un nom vide / réservé, et exige command (stdio) ou url (http/sse). Évite
 *  les connecteurs « morts » (affichés activés mais jamais injectés car ignorés à la génération). */
function assertValidConnector(c: { name?: string; transport?: McpTransport; command?: string | null; url?: string | null }): void {
  const name = (c.name ?? '').trim()
  if (!name) throw new Error('Le nom du connecteur est requis.')
  if (name === 'oryon') throw new Error('« oryon » est réservé au serveur interne d\'Oryon — choisis un autre nom.')
  if (c.transport === 'stdio') {
    if (!c.command || !String(c.command).trim()) throw new Error('Un connecteur stdio requiert une commande.')
  } else if (!c.url || !String(c.url).trim()) {
    throw new Error(`Un connecteur ${c.transport} requiert une URL.`)
  }
}

export function addConnector(input: McpConnectorInput): McpConnector {
  assertValidConnector(input)
  const id = uuid()
  const row = {
    id,
    name: input.name,
    scope: input.scope,
    project_id: input.scope === 'project' ? resolveProjectId(input.projectPath) : null,
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ? JSON.stringify(input.args) : null,
    url: input.url ?? null,
    env: encryptSecrets(input.env),
    headers: encryptSecrets(input.headers),
    catalog_id: input.catalogId ?? null,
    created_at: Date.now(),
  }
  getDb()
    .prepare(
      `INSERT INTO mcp_connectors (id, name, scope, project_id, transport, command, args, url, env, headers, catalog_id, enabled, created_at)
       VALUES (@id, @name, @scope, @project_id, @transport, @command, @args, @url, @env, @headers, @catalog_id, 1, @created_at)`,
    )
    .run(row)
  regenerateAllConfigs()
  const saved = getDb().prepare('SELECT * FROM mcp_connectors WHERE id = ?').get(id) as Record<string, unknown>
  return rowToConnector(saved)
}

/** Édition d'un connecteur : champ absent = inchangé ; env/headers à null = vidés. Régénère les configs. */
function updateConnector(input: McpConnectorUpdate): McpConnector | null {
  const cur = getDb().prepare('SELECT name, transport, command, url FROM mcp_connectors WHERE id = ?').get(input.id) as
    | { name: string; transport: McpTransport; command: string | null; url: string | null }
    | undefined
  if (!cur) return null
  // Valide la forme APRÈS application du patch (champ absent du patch = valeur courante).
  assertValidConnector({
    name: input.name ?? cur.name,
    transport: input.transport ?? cur.transport,
    command: input.command !== undefined ? input.command : cur.command,
    url: input.url !== undefined ? input.url : cur.url,
  })
  const sets: string[] = []
  const params: Record<string, unknown> = { id: input.id }
  if (input.name !== undefined) { sets.push('name = @name'); params.name = input.name }
  if (input.transport !== undefined) { sets.push('transport = @transport'); params.transport = input.transport }
  if (input.command !== undefined) { sets.push('command = @command'); params.command = input.command }
  if (input.args !== undefined) { sets.push('args = @args'); params.args = input.args ? JSON.stringify(input.args) : null }
  if (input.url !== undefined) { sets.push('url = @url'); params.url = input.url }
  if (input.env !== undefined) { sets.push('env = @env'); params.env = input.env === null ? null : encryptSecrets(input.env) }
  if (input.headers !== undefined) { sets.push('headers = @headers'); params.headers = input.headers === null ? null : encryptSecrets(input.headers) }
  if (sets.length > 0) {
    getDb().prepare(`UPDATE mcp_connectors SET ${sets.join(', ')} WHERE id = @id`).run(params)
    regenerateAllConfigs()
  }
  const saved = getDb().prepare('SELECT * FROM mcp_connectors WHERE id = ?').get(input.id) as Record<string, unknown>
  return rowToConnector(saved)
}

/** Secrets DÉCHIFFRÉS d'un connecteur — pour préremplir le formulaire d'édition (jamais via la liste). */
function connectorSecrets(id: string): McpConnectorSecrets {
  const row = getDb().prepare('SELECT env, headers FROM mcp_connectors WHERE id = ?').get(id) as
    | { env: unknown; headers: unknown }
    | undefined
  return { env: decryptSecrets(row?.env), headers: decryptSecrets(row?.headers) }
}

/** Sonde un connecteur DÉJÀ enregistré (par id) : reconstruit son input (secrets déchiffrés, args reparsés) et
 *  lance le handshake MCP (initialize + tools/list) → statut connecté/échec + liste des outils. Read-only. */
async function probeConnector(id: string): Promise<McpTestResult> {
  const r = getDb().prepare('SELECT * FROM mcp_connectors WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!r) return { ok: false, error: 'Connecteur introuvable.' }
  let args: string[] | undefined
  try {
    args = r.args ? (JSON.parse(String(r.args)) as string[]) : undefined
  } catch {
    args = undefined
  }
  return testConnector({
    name: String(r.name),
    scope: r.scope as McpScope,
    transport: r.transport as McpTransport,
    command: (r.command as string | null) ?? undefined,
    args,
    url: (r.url as string | null) ?? undefined,
    env: decryptSecrets(r.env),
    headers: decryptSecrets(r.headers),
  })
}

/** Importe des candidats détectés dans un scope donné. Saute ceux déjà présents (même name+scope) ou de forme
 *  invalide (rejetés par addConnector, ex. stdio sans command dans la config source). */
function importConnectors(candidates: McpImportCandidate[], scope: McpScope, projectPath?: string | null): McpImportResult {
  const installed: string[] = []
  const skipped: string[] = []
  const projectId = scope === 'project' ? resolveProjectId(projectPath) : null
  for (const cand of candidates) {
    const name = cand?.name?.trim()
    if (!name || name === 'oryon') {
      skipped.push(cand?.name ?? '(sans nom)')
      continue
    }
    const dupe = getDb()
      .prepare('SELECT 1 FROM mcp_connectors WHERE name = @name AND scope = @scope AND project_id IS @pid')
      .get({ name, scope, pid: projectId })
    if (dupe) {
      skipped.push(name)
      continue
    }
    try {
      addConnector({
        name,
        scope,
        projectPath: scope === 'project' ? projectPath : null,
        transport: cand.transport,
        command: cand.command,
        args: cand.args,
        url: cand.url,
        env: cand.env,
        headers: cand.headers,
      })
      installed.push(name)
    } catch {
      skipped.push(name)
    }
  }
  return { installed, skipped }
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
    // ORYON_MCP_STATE : MÊME dossier d'état que mcp-export (userData/mcp-state). Sans lui, server.mjs retombe
    // sur APPDATA/Oryon/mcp-state, qui DIFFÈRE en dev (« Oryon Dev ») → le serveur lirait un meta.json périmé
    // et écrirait ses commandes dans le mauvais dossier (assign/report/broadcast jamais traités par le main).
    env: {
      ORYON_PROJECT_DIR: projectPath,
      ORYON_MCP_STATE: join(app.getPath('userData'), 'mcp-state'),
      ELECTRON_RUN_AS_NODE: '1',
    },
  }
  for (const r of rows) {
    const name = String(r.name)
    if (name === 'oryon') continue // ne pas écraser notre serveur
    const env = decryptSecrets(r.env)
    const headers = decryptSecrets(r.headers)
    if ((r.transport === 'http' || r.transport === 'sse') && r.url) {
      const server: Record<string, unknown> = { type: String(r.transport), url: r.url }
      if (Object.keys(headers).length > 0) server.headers = headers
      mcpServers[name] = server
    } else if (r.command) {
      const server: Record<string, unknown> = { command: r.command, args: r.args ? JSON.parse(String(r.args)) : [] }
      if (Object.keys(env).length > 0) server.env = env
      mcpServers[name] = server
    }
  }
  const file = join(app.getPath('userData'), `oryon-mcp-${projectId ?? 'app'}.json`)
  // Écriture atomique en 0o600 : le fichier contient des secrets DÉCHIFFRÉS (env/headers) que le CLI
  // doit lire en clair ; temp+rename évite qu'un claude au boot lise un JSON tronqué (cf. mcp-export.ts).
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  return file
}

/**
 * Réécrit les fichiers de config MCP de TOUS les projets enrôlés pour refléter l'état courant de la DB.
 * Appelé après chaque mutation de connecteur (add/update/toggle/delete) : sans ça, l'action n'a aucun
 * effet sur disque tant qu'un nouveau terminal claude n'est pas spawné. Ne relance PAS les agents vivants
 * (ils relisent au prochain spawn). Un projet illisible n'interrompt pas la régénération des autres.
 */
function regenerateAllConfigs(): void {
  const paths = getDb().prepare('SELECT path FROM projects').pluck().all() as string[]
  for (const p of paths) {
    try {
      buildProjectMcpConfigForPath(p)
    } catch {
      /* projet illisible / chemin disparu : on continue les autres */
    }
  }
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:getApp', (): Record<string, string> => getAppSettings())
  ipcMain.handle('settings:setApp', (_e, key: string, value: string): void => {
    setAppSetting(key, value)
    // Propagation live aux renderers : un réglage changé dans la modale in-window ne déclenche AUCUN event
    // 'focus', donc un consommateur qui le cache (ex. VoiceProvider → voice.target) resterait périmé et
    // router­ait la dictée vers l'ANCIENNE cible. On notifie pour appliquer le changement immédiatement.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('settings:appChanged', { key, value })
    }
  })
  ipcMain.handle('settings:listConnectors', (_e, projectPath?: string | null): McpConnector[] => listConnectors(projectPath))
  ipcMain.handle('settings:addConnector', (_e, input: McpConnectorInput): McpConnector => addConnector(input))
  ipcMain.handle('settings:updateConnector', (_e, input: McpConnectorUpdate): McpConnector | null => updateConnector(input))
  ipcMain.handle('settings:connectorSecrets', (_e, id: string): McpConnectorSecrets => connectorSecrets(id))
  ipcMain.handle('settings:testConnector', (_e, input: McpConnectorInput): Promise<McpTestResult> => testConnector(input))
  ipcMain.handle('settings:probeConnector', (_e, id: string): Promise<McpTestResult> => probeConnector(id))
  ipcMain.handle('settings:listMcpCatalog', (): McpCatalogEntry[] => MCP_CATALOG)
  ipcMain.handle('settings:importMcpCandidates', (): McpImportCandidate[] => detectImportCandidates(app.getPath('appData')))
  ipcMain.handle(
    'settings:importConnectors',
    (_e, candidates: McpImportCandidate[], scope: McpScope, projectPath?: string | null): McpImportResult =>
      importConnectors(candidates, scope, projectPath),
  )
  ipcMain.handle('settings:toggleConnector', (_e, id: string, enabled: boolean): void => {
    getDb().prepare('UPDATE mcp_connectors SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
    regenerateAllConfigs()
  })
  ipcMain.handle('settings:deleteConnector', (_e, id: string): void => {
    getDb().prepare('DELETE FROM mcp_connectors WHERE id = ?').run(id)
    regenerateAllConfigs()
  })
}
