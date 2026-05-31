// Serveur MCP stdio standalone exposant l'état d'Oryon (sortie des terminaux, tasks, mailbox)
// pour débogage depuis un client MCP (ex. la session Claude Code de l'IDE host).
// Process séparé, JS pur (pas de dépendance native) : il LIT les fichiers écrits par mcp-export.ts.
// IMPORTANT : ne JAMAIS écrire sur stdout hors protocole MCP (stdio l'utilise) → logs sur stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
// Workspace de CE terminal : scope l'état (terminaux/tasks/mailbox) à son SEUL workspace. Chaque PTY a son
// propre serveur MCP avec cet env → un orchestrateur ne voit/pilote jamais les terminaux d'un autre workspace.
const WORKSPACE_ID = process.env.ORYON_WORKSPACE_ID || ''

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
// Scope au workspace courant (WORKSPACE_ID). Sans env (anciens terminaux), ne filtre pas (compat).
function scopedTerminals(meta) {
  const list = meta.terminals ?? []
  return WORKSPACE_ID ? list.filter((t) => t.workspace_id === WORKSPACE_ID) : list
}
function scopedTasks(meta) {
  const list = meta.tasks ?? []
  return WORKSPACE_ID ? list.filter((t) => t.workspace_id === WORKSPACE_ID) : list
}
function scopedMailbox(meta) {
  const list = meta.mailbox ?? []
  return WORKSPACE_ID ? list.filter((m) => m.workspace_id === WORKSPACE_ID) : list
}

const server = new McpServer({ name: 'oryon', version: '0.1.0' })

server.tool(
  'list_terminals',
  "Liste les terminaux WORKERS d'Oryon (id, name, role, workspace, busy, task courant). L'orchestrateur s'exclut lui-même. Appelle-le AVANT assign_task pour cibler des workers libres (busy:false).",
  {},
  async () =>
    text(JSON.stringify(scopedTerminals(readMeta()).filter((t) => t.role !== 'orchestrator'), null, 2)),
)

server.tool(
  'get_terminal_output',
  "Renvoie la sortie récente (scrollback, ~20KB, ANSI nettoyé) d'un terminal par son name (ex. \"Nell\") ou son id.",
  { terminal: z.string().describe('Nom du terminal (ex. "Nell") ou son id') },
  async ({ terminal }) => {
    const ts = scopedTerminals(readMeta())
    const t = ts.find(
      (x) => x.id === terminal || (x.name || '').toLowerCase() === terminal.toLowerCase(),
    )
    if (!t) {
      return text(
        `Terminal "${terminal}" introuvable. Disponibles : ${ts.map((x) => x.name).join(', ') || '(aucun — Oryon tourne ?)'}`,
      )
    }
    const out = readTermLog(t.id)
    return text(out || `(aucune sortie capturée pour ${t.name} — Oryon tourne ? le terminal a-t-il produit du texte ?)`)
  },
)

server.tool(
  'list_tasks',
  "Liste les tâches de l'orchestrateur (de ce workspace) : title, role, status, dépendances, terminal assigné.",
  {},
  async () => text(JSON.stringify(scopedTasks(readMeta()), null, 2)),
)

server.tool(
  'list_mailbox',
  "Messages récents de la mailbox de l'orchestrateur (de ce workspace) : handoffs, done, approved…",
  {},
  async () => text(JSON.stringify(scopedMailbox(readMeta()), null, 2)),
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

// ---- Orchestration : tâches et mailbox (MCP→main via file de commandes) ----

server.tool(
  'get_task',
  'Récupère une tâche par ID ou titre. Lit depuis meta.json (synchronisé par le main tous les 2s).',
  { query: z.string().describe('ID de tâche ou titre (recherche par substring)') },
  async ({ query }) => {
    const tasks = scopedTasks(readMeta())
    const q = query.trim().toLowerCase()
    const found = tasks.find((t) => t.id === query || (t.title || '').toLowerCase().includes(q))
    if (!found) {
      return text(JSON.stringify({ found: false, query, available: tasks.length }))
    }
    return text(JSON.stringify({ found: true, task: found }))
  },
)

server.tool(
  'claim_files',
  'Réserve un ensemble de fichiers pour un agent (évite les conflits d\'édition). Relâche avec action:"release".',
  {
    action: z.enum(['claim', 'release']).describe('claim ou release'),
    files: z.array(z.string()).describe('liste de chemins relatifs (projet root)'),
    agentName: z.string().optional().describe('nom de l\'agent (auto-fourni par ORYON_AGENT_NAME)'),
  },
  async ({ action, files, agentName }) => {
    const agent = agentName ?? DEFAULT_AUTHOR ?? 'unknown'
    const results = []
    for (const f of files) {
      try {
        const res =
          action === 'claim'
            ? await memory.claimFile(PROJECT_DIR, f, agent)
            : await memory.releaseClaim(PROJECT_DIR, f)
        results.push({ file: f, ...res })
      } catch (e) {
        results.push({ file: f, error: String(e) })
      }
    }
    return text(JSON.stringify(results, null, 2))
  },
)

server.tool(
  'send_mailbox',
  'Poste un message dans la mailbox de l\'orchestrateur (dequeue par le main).',
  {
    body: z.string().describe('contenu du message'),
    fromAgent: z.string().optional().describe('auteur (auto=ORYON_AGENT_NAME)'),
  },
  async ({ body, fromAgent }) => {
    const from = fromAgent ?? DEFAULT_AUTHOR ?? 'unknown'
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) {
      return text(JSON.stringify({ queued: false, error: 'Workspace not found — Oryon agent name not registered' }))
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const cmd = { id, type: 'mailbox', workspaceId, fromAgent: from, body }
    try {
      mkdirSync(join(STATE_DIR, 'commands'), { recursive: true })
      writeFileSync(join(STATE_DIR, 'commands', `${id}.json`), JSON.stringify(cmd, null, 2))
      return text(JSON.stringify({ queued: true, id, workspaceId }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

server.tool(
  'update_task_status',
  'Modifie le statut d\'une tâche (queued pour le main ; voir list_tasks pour les statuts valides).',
  {
    taskId: z.string().describe('ID de la tâche'),
    status: z.enum(['todo', 'in-progress', 'in-review', 'complete', 'cancelled', 'blocked']),
  },
  async ({ taskId, status }) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const cmd = { id, type: 'update-task-status', taskId, status }
    try {
      mkdirSync(join(STATE_DIR, 'commands'), { recursive: true })
      writeFileSync(join(STATE_DIR, 'commands', `${id}.json`), JSON.stringify(cmd, null, 2))
      return text(JSON.stringify({ queued: true, id, taskId, status }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

// ---- Pilotage de flotte par l'orchestrateur (assign/approve) + signal de fin des workers (report) ----

/** workspaceId de CE terminal : via l'env ORYON_WORKSPACE_ID (robuste), repli sur le nom dans meta.json. */
function currentWorkspaceId() {
  if (WORKSPACE_ID) return WORKSPACE_ID
  const meta = readMeta()
  return meta.terminals?.find((t) => t.name === process.env.ORYON_AGENT_NAME)?.workspace_id
}
/** Enfile une commande MCP→main (fichier JSON surveillé par mcp-export). */
function queueCommand(cmd) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const full = { id, ...cmd }
  mkdirSync(join(STATE_DIR, 'commands'), { recursive: true })
  writeFileSync(join(STATE_DIR, 'commands', `${id}.json`), JSON.stringify(full, null, 2))
  return id
}

server.tool(
  'assign_task',
  "Donne une sous-task à UN worker (par name « Nell » ou position « #2 »). Le worker la fait dans son worktree git puis signale la fin (report_task). Émets plusieurs assign_task pour paralléliser. Le taskId arrive dans la notification de fin (ou via list_tasks).",
  {
    terminal: z.string().describe('name (ex. "Nell") ou position (ex. "#2") du worker'),
    instructions: z.string().describe('instruction concrète et auto-suffisante (1-3 phrases)'),
    title: z.string().optional().describe('titre court (sinon dérivé des instructions)'),
  },
  async ({ terminal, instructions, title }) => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ queued: false, error: 'workspace introuvable (Oryon tourne ?)' }))
    try {
      const id = queueCommand({ type: 'assign-task', workspaceId, terminal, instructions, title: title ?? null })
      return text(JSON.stringify({ queued: true, id, terminal }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

server.tool(
  'approve_task',
  "Valide une task revue → merge-back de la branche du worker dans le tronc principal (sérialisé, conflict-safe). Utilise le taskId reçu dans la notification de fin.",
  { taskId: z.string().describe('id de la task à approuver') },
  async ({ taskId }) => {
    try {
      const id = queueCommand({ type: 'approve-task', taskId })
      return text(JSON.stringify({ queued: true, id, taskId }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

server.tool(
  'report_task',
  "POUR LES WORKERS : signale la fin de ta task assignée. Appelle-le UNE fois, à la toute fin. L'orchestrateur sera réveillé pour reviewer ton travail.",
  {
    status: z.enum(['done', 'blocked']).describe('done = terminé ; blocked = impossible de continuer'),
    summary: z.string().describe('résumé d\'une ligne de ce que tu as changé (tes propres mots)'),
    fromAgent: z.string().optional().describe('ton nom d\'agent (auto = ORYON_AGENT_NAME)'),
  },
  async ({ status, summary, fromAgent }) => {
    const from = fromAgent ?? DEFAULT_AUTHOR ?? 'unknown'
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ queued: false, error: 'workspace introuvable' }))
    try {
      const id = queueCommand({ type: 'report-task', workspaceId, fromAgent: from, status, summary })
      return text(JSON.stringify({ queued: true, id, status }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

server.tool(
  'broadcast_command',
  "Envoie une commande dans les terminaux des workers : une slash-command claude (ex. \"/effort high\", \"/model opus\") pour changer leur effort/modèle/réglages, ou une instruction libre. Par défaut à TOUS les workers vivants ; cible-en un seul via `terminal`. Niveaux d'effort valides : low|medium|high|max.",
  {
    command: z.string().describe('la ligne à envoyer (ex. "/effort high", "/model opus")'),
    terminal: z.string().optional().describe('name ou #position d\'un worker précis (sinon : tous)'),
  },
  async ({ command, terminal }) => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ queued: false, error: 'workspace introuvable' }))
    try {
      const id = queueCommand({ type: 'broadcast-command', workspaceId, command, terminal: terminal ?? null })
      return text(JSON.stringify({ queued: true, id, command, terminal: terminal ?? 'all' }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[oryon-mcp] connecté (state: ' + STATE_DIR + ' | memory: ' + MEMORY_DIR + ')')
