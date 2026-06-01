import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpConnectorInput, McpImportCandidate, McpTestResult, McpTransport } from '../../shared/types'

// Sonde MCP : teste un connecteur AVANT enregistrement (handshake réel) et détecte les connecteurs
// importables depuis les configs MCP existantes. AUCUN appel Claude ($0) — on ne fait qu'ouvrir une session
// MCP vers le serveur configuré (stdio = spawn local court ; http/sse = requête vers l'endpoint).

const TEST_TIMEOUT_MS = 15_000
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

/** Ouvre une session MCP (initialize + tools/list) puis la referme. Renvoie le nombre d'outils ou l'erreur. */
export async function testConnector(input: McpConnectorInput): Promise<McpTestResult> {
  let transport: AnyTransport
  try {
    if (input.transport === 'stdio') {
      if (!input.command || !input.command.trim()) return { ok: false, error: 'Commande requise (stdio).' }
      // Base d'env SÛRE (PATH/HOME… via getDefaultEnvironment) + env du connecteur ; ANTHROPIC_API_KEY retiré
      // par hygiène coût $0 (le serveur testé ne doit pas hériter de la clé API).
      const env: Record<string, string> = { ...getDefaultEnvironment(), ...(input.env ?? {}) }
      delete env.ANTHROPIC_API_KEY
      transport = new StdioClientTransport({
        command: input.command,
        args: input.args ?? [],
        env,
        stderr: 'ignore',
      })
    } else {
      if (!input.url || !input.url.trim()) return { ok: false, error: `URL requise (${input.transport}).` }
      const url = new URL(input.url)
      const requestInit = input.headers ? { headers: input.headers } : undefined
      transport =
        input.transport === 'sse'
          ? new SSEClientTransport(url, { requestInit })
          : new StreamableHTTPClientTransport(url, { requestInit })
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const client = new Client({ name: 'oryon-probe', version: '0.1.0' }, { capabilities: {} })
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timeout (${TEST_TIMEOUT_MS / 1000}s) — serveur injoignable ?`)), TEST_TIMEOUT_MS),
  )
  try {
    await Promise.race([client.connect(transport), timeout])
    const tools = (await Promise.race([client.listTools(), timeout])) as { tools: unknown[] }
    return { ok: true, toolCount: Array.isArray(tools.tools) ? tools.tools.length : 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    try {
      await client.close()
    } catch {
      /* best-effort */
    }
    try {
      await transport.close()
    } catch {
      /* best-effort (tue le process stdio le cas échéant) */
    }
  }
}

// ---- import depuis configs MCP existantes ----

function entryToCandidate(source: string, name: string, cfg: unknown): McpImportCandidate | null {
  if (!isRecord(cfg) || name === 'oryon') return null
  if (typeof cfg.command === 'string') {
    return {
      source,
      name,
      transport: 'stdio',
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
      env: isRecord(cfg.env) ? (cfg.env as Record<string, string>) : undefined,
    }
  }
  if (typeof cfg.url === 'string') {
    const transport: McpTransport = cfg.type === 'sse' ? 'sse' : 'http'
    return {
      source,
      name,
      transport,
      url: cfg.url,
      headers: isRecord(cfg.headers) ? (cfg.headers as Record<string, string>) : undefined,
    }
  }
  return null
}

function collectFrom(source: string, mcpServers: unknown, out: McpImportCandidate[]): void {
  if (!isRecord(mcpServers)) return
  for (const [name, cfg] of Object.entries(mcpServers)) {
    const c = entryToCandidate(source, name, cfg)
    if (c) out.push(c)
  }
}

/**
 * Détecte les connecteurs importables depuis : (1) ~/.claude.json (mcpServers user + projects[*].mcpServers),
 * (2) la config Claude Desktop (<appData>/Claude/claude_desktop_config.json). Best-effort : un fichier absent
 * ou illisible est ignoré. Le serveur « oryon » est exclu (interne). `appDataDir` = app.getPath('appData').
 */
export function detectImportCandidates(appDataDir: string): McpImportCandidate[] {
  const out: McpImportCandidate[] = []
  try {
    const p = join(homedir(), '.claude.json')
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
      collectFrom('~/.claude.json', j.mcpServers, out)
      if (isRecord(j.projects)) {
        for (const proj of Object.values(j.projects)) collectFrom('~/.claude.json', isRecord(proj) ? proj.mcpServers : null, out)
      }
    }
  } catch {
    /* ~/.claude.json absent / illisible */
  }
  try {
    const p = join(appDataDir, 'Claude', 'claude_desktop_config.json')
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
      collectFrom('Claude Desktop', j.mcpServers, out)
    }
  } catch {
    /* config Claude Desktop absente / illisible */
  }
  return out
}
