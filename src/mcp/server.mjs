// Serveur MCP stdio standalone exposant l'état d'Oryon (sortie des terminaux, tasks, mailbox)
// pour débogage depuis un client MCP (ex. la session Claude Code de l'IDE host).
// Process séparé, JS pur (pas de dépendance native) : il LIT les fichiers écrits par mcp-export.ts.
// IMPORTANT : ne JAMAIS écrire sur stdout hors protocole MCP (stdio l'utilise) → logs sur stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as memory from '../shared/memory-core.mjs'

const APPDATA =
  process.env.APPDATA ||
  (process.env.HOME ? join(process.env.HOME, 'AppData', 'Roaming') : process.cwd())
const STATE_DIR = process.env.ORYON_MCP_STATE || join(APPDATA, 'Oryon', 'mcp-state')

// Dossier du PROJET pour Oryon Memory : env explicite, sinon on remonte depuis cwd vers un .oryon/.git,
// sinon cwd. (STATE_DIR global reste pour terminals/tasks/mailbox.)
const PROJECT_DIR = process.env.ORYON_PROJECT_DIR || (await memory.findProjectDir(process.cwd()))
const MEMORY_DIR = memory.memDir(PROJECT_DIR)
// Identité de l'agent (injectée via l'env du PTY par Oryon) → provenance auto des écritures mémoire.
const DEFAULT_AUTHOR = process.env.ORYON_AGENT_NAME || undefined
const DEFAULT_ROLE = process.env.ORYON_AGENT_ROLE || undefined

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

// ---- Oryon Memory : substrat de contexte PARTAGÉ entre agents (notes markdown + [[wikilinks]]) ----
// Toutes ces opérations sont du pur FS (aucun appel Claude → coût $0). Écritures sûres en parallèle :
// préférer append_memory (sans conflit) ; update_memory utilise la concurrence optimiste (expectedUpdated).

server.tool(
  'list_memories',
  'Liste toutes les notes de mémoire partagée du projet (nom, titre, extrait, liens). Survol bon marché du contexte existant avant de travailler.',
  {},
  async () => text(JSON.stringify(await memory.listMemories(PROJECT_DIR), null, 2)),
)

server.tool(
  'search_memories',
  'Recherche plein-texte (titre + corps) dans la mémoire partagée. Utilise-le pour retrouver ce qu\'un AUTRE agent a noté avant de refaire le travail.',
  { query: z.string().describe('mots-clés'), limit: z.number().optional() },
  async ({ query, limit }) => text(JSON.stringify(await memory.searchMemories(PROJECT_DIR, query, limit ?? 20), null, 2)),
)

server.tool(
  'read_memory',
  "Lit le contenu complet d'une note par son nom. Renvoie existed:false si absente (ne devine pas).",
  { name: z.string() },
  async ({ name }) => text(JSON.stringify(await memory.readMemory(PROJECT_DIR, name), null, 2)),
)

server.tool(
  'append_memory',
  'Ajoute (atomique, sans conflit) une entrée à une note (la crée si absente). PATTERN PRÉFÉRÉ pour journaliser du contexte quand plusieurs agents écrivent en parallèle. Renseigne author = ton nom d\'agent.',
  { name: z.string(), content: z.string(), author: z.string().optional(), role: z.string().optional() },
  async ({ name, content, author, role }) =>
    text(JSON.stringify(await memory.appendMemory(PROJECT_DIR, name, content, { author: author ?? DEFAULT_AUTHOR, role: role ?? DEFAULT_ROLE }), null, 2)),
)

server.tool(
  'create_memory',
  'Crée une NOUVELLE note. N\'écrase pas si elle existe (renvoie existed:true). Le nom renvoyé est normalisé (slug).',
  { name: z.string(), content: z.string().optional(), author: z.string().optional(), role: z.string().optional() },
  async ({ name, content, author, role }) =>
    text(JSON.stringify(await memory.createMemory(PROJECT_DIR, name, content ?? '', { author: author ?? DEFAULT_AUTHOR, role: role ?? DEFAULT_ROLE }), null, 2)),
)

server.tool(
  'update_memory',
  'Réécrit entièrement une note (concurrence optimiste). Fournis expectedUpdated (mtime lu via read_memory) ; si le disque a changé depuis, renvoie {conflict:true, current} SANS écraser — relis et fusionne.',
  { name: z.string(), content: z.string(), expectedUpdated: z.number().optional() },
  async ({ name, content, expectedUpdated }) => text(JSON.stringify(await memory.writeMemory(PROJECT_DIR, name, content, { expectedUpdated }), null, 2)),
)

server.tool(
  'find_backlinks',
  'Notes qui pointent vers une note donnée (signal de coordination : qui dépend de ce contexte).',
  { name: z.string() },
  async ({ name }) => text(JSON.stringify(await memory.findBacklinks(PROJECT_DIR, name), null, 2)),
)

server.tool(
  'get_links',
  "Liens sortants d'une note, séparés en résolus vs non résolus (notes fantômes à créer).",
  { name: z.string() },
  async ({ name }) => text(JSON.stringify(await memory.getLinks(PROJECT_DIR, name), null, 2)),
)

server.tool(
  'get_memory_graph',
  'Topologie du graphe de mémoire (nœuds + arêtes des [[wikilinks]]). Aucune mise en page (concern de l\'UI).',
  {},
  async () => text(JSON.stringify(await memory.buildGraph(PROJECT_DIR), null, 2)),
)

server.tool(
  'suggest_connections',
  'Notes liées à une note via des [[wikilinks]] partagés (heuristique pure, sans IA). Pour découvrir du contexte connexe.',
  { name: z.string(), limit: z.number().optional() },
  async ({ name, limit }) => text(JSON.stringify(await memory.suggestConnections(PROJECT_DIR, name, limit ?? 10), null, 2)),
)

server.tool(
  'delete_memory',
  'Supprime une note. Renvoie deleted:false si elle n\'existait pas.',
  { name: z.string() },
  async ({ name }) => text(JSON.stringify(await memory.deleteMemory(PROJECT_DIR, name), null, 2)),
)

server.tool(
  'rename_memory',
  'Renomme une note ET réécrit tous les [[wikilinks]] qui la visent dans les autres notes (préserve la cohérence du graphe). Préfère ceci à supprimer+recréer.',
  { oldName: z.string(), newName: z.string() },
  async ({ oldName, newName }) => text(JSON.stringify(await memory.renameMemory(PROJECT_DIR, oldName, newName), null, 2)),
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[oryon-mcp] connecté (state: ' + STATE_DIR + ' | memory: ' + MEMORY_DIR + ')')
