// Serveur MCP stdio standalone exposant l'état d'Oryon (sortie des terminaux, tasks, mailbox)
// pour débogage depuis un client MCP (ex. la session Claude Code de l'IDE host).
// Process séparé, JS pur (pas de dépendance native) : il LIT les fichiers écrits par mcp-export.ts.
// IMPORTANT : ne JAMAIS écrire sur stdout hors protocole MCP (stdio l'utilise) → logs sur stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const APPDATA =
  process.env.APPDATA ||
  (process.env.HOME ? join(process.env.HOME, 'AppData', 'Roaming') : process.cwd())
const STATE_DIR = process.env.ORYON_MCP_STATE || join(APPDATA, 'Oryon', 'mcp-state')

function readMeta() {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, 'meta.json'), 'utf8'))
  } catch {
    return { terminals: [], tasks: [], mailbox: [], updatedAt: 0 }
  }
}
function readTermLog(id) {
  const p = join(STATE_DIR, `term-${id}.log`)
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}
function text(t) {
  return { content: [{ type: 'text', text: t }] }
}

const server = new McpServer({ name: 'oryon', version: '0.1.0' })

server.tool(
  'list_terminals',
  'Liste les terminaux (agents) d\'Oryon : id, name, role, workspace.',
  {},
  async () => text(JSON.stringify(readMeta().terminals, null, 2)),
)

server.tool(
  'get_terminal_output',
  "Renvoie la sortie récente (scrollback, ~20KB, ANSI nettoyé) d'un terminal par son name (ex. \"Nell\") ou son id.",
  { terminal: z.string().describe('Nom du terminal (ex. "Nell") ou son id') },
  async ({ terminal }) => {
    const m = readMeta()
    const t = m.terminals.find(
      (x) => x.id === terminal || (x.name || '').toLowerCase() === terminal.toLowerCase(),
    )
    if (!t) {
      return text(
        `Terminal "${terminal}" introuvable. Disponibles : ${m.terminals.map((x) => x.name).join(', ') || '(aucun — Oryon tourne ?)'}`,
      )
    }
    const out = readTermLog(t.id)
    return text(out || `(aucune sortie capturée pour ${t.name} — Oryon tourne ? le terminal a-t-il produit du texte ?)`)
  },
)

server.tool(
  'list_tasks',
  "Liste les tâches de l'orchestrateur : title, role, status, dépendances, terminal assigné.",
  {},
  async () => text(JSON.stringify(readMeta().tasks, null, 2)),
)

server.tool(
  'list_mailbox',
  "Messages récents de la mailbox de l'orchestrateur (handoffs, done, approved…).",
  {},
  async () => text(JSON.stringify(readMeta().mailbox, null, 2)),
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[oryon-mcp] connecté (state dir: ' + STATE_DIR + ')')
