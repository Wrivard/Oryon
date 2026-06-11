// Serveur MCP stdio standalone exposant l'état d'Oryon (sortie des terminaux, tasks, mailbox)
// pour débogage depuis un client MCP (ex. la session Claude Code de l'IDE host).
// Process séparé, JS pur (pas de dépendance native) : il LIT les fichiers écrits par mcp-export.ts.
// IMPORTANT : ne JAMAIS écrire sur stdout hors protocole MCP (stdio l'utilise) → logs sur stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
// Client MCP (pour test_connector : sonder une config de serveur tierce depuis CE serveur). Bundlé en prod
// par before-pack.cjs (esbuild --bundle suit ces imports).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { z } from 'zod'
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import * as memory from '../shared/memory-core.mjs'
import * as archive from './archive-read.mjs'
import * as docs from './docs-read.mjs'
import * as outcomes from './outcomes-read.mjs'
import * as systemFeedback from '../shared/system-feedback-core.mjs'

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

// Log de cycle de vie DÉDIÉ (d2) : la stderr du serveur est au mieux noyée dans le scrollback TUI du worker,
// au pire perdue (câblage stdio interne du CLI). On écrit EN PLUS les marqueurs connexion/erreur dans
// <STATE_DIR>/mcp-<nom>.log (STATE_DIR = ORYON_MCP_STATE, PARTAGÉ par tous les agents) → l'orchestrateur lit
// ce fichier via get_mcp_log/mcp_health pour diagnostiquer un MCP worker mort, sans dépendre du scrollback.
const MCP_LOG = DEFAULT_AUTHOR ? join(STATE_DIR, `mcp-${DEFAULT_AUTHOR}.log`) : null
function mcpLog(line) {
  console.error('[oryon-mcp] ' + line) // conserve la stderr existante
  if (!MCP_LOG) return
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(MCP_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* best-effort : ne JAMAIS casser le serveur pour un log */
  }
}

// R4 : HEARTBEAT — chaque serveur MCP réécrit périodiquement l'horodatage courant dans mcp-<nom>.hb. Si le
// serveur MEURT après un boot réussi (« busy zombie » : claude vivant, serveur MCP enfant mort), le .hb cesse
// d'être mis à jour → mcp_health le voit 'stale' (avant : resté 'connected' à vie, limite assumée). $0 (FS seul).
const MCP_HB = DEFAULT_AUTHOR ? join(STATE_DIR, `mcp-${DEFAULT_AUTHOR}.hb`) : null
const HEARTBEAT_MS = 20_000
const HEARTBEAT_STALE_MS = 60_000 // ~3 battements manqués → 'stale'
if (MCP_HB) {
  const beat = () => {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(MCP_HB, String(Date.now()))
    } catch {
      /* best-effort */
    }
  }
  beat()
  const hb = setInterval(beat, HEARTBEAT_MS)
  if (hb.unref) hb.unref() // ne pas maintenir le process en vie juste pour le heartbeat
}

// Role-gate (F2) : un WORKER ne doit PAS LIRE la mémoire partagée — c'est le contexte orchestrateur/session,
// et des workers s'en servaient pour se prendre pour l'orchestrateur (« qu'est-ce que je dois faire ? »).
// Les outils de LECTURE mémoire ne sont exposés qu'au rôle 'orchestrator' (fail-safe : un rôle absent =
// traité comme worker → pas de lecture). Les workers gardent l'écriture (append/create/update), la
// coordination (claim_files) et report_task/send_mailbox.
const isOrchestrator = DEFAULT_ROLE === 'orchestrator'
const readMemoryTool = (...args) => {
  if (isOrchestrator) server.tool(...args)
}

// Gate orchestration (E/c2) : les outils de PILOTAGE de flotte (assign_task/approve_task/broadcast_command +
// restart_agent/mcp_health/get_mcp_log) ne sont exposés qu'au rôle 'orchestrator'. Ferme PAR LE SERVEUR le trou
// « un worker qui dérive s'auto-orchestre » (merge de branche via approve_task, etc.) — même fail-safe que
// readMemoryTool (rôle absent = worker → outils retirés). Le gate ne retire JAMAIS un outil à l'orchestrateur.
const orchestratorTool = (...args) => {
  if (isOrchestrator) server.tool(...args)
}

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
function img(base64) {
  return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }] }
}
function readBrowserConsole(workspaceId) {
  const p = join(STATE_DIR, `browser-console-${workspaceId}.log`)
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
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
// Résout une réf WORKER (id, name « Nell » ou position « #2 ») → terminal de meta.json (orchestrateur exclu),
// avec le MÊME ordre/position que le routeur (pane_index). Sert à mapper terminal → fichier mcp-<name>.log.
function resolveWorkerTerminal(ref) {
  const workers = scopedTerminals(readMeta()).filter((t) => t.role !== 'orchestrator')
  const r = String(ref).trim().replace(/^#/, '')
  const idx = Number(r)
  if (Number.isInteger(idx) && idx >= 1 && idx <= workers.length) return workers[idx - 1]
  return workers.find((t) => t.id === ref || (t.name || '').toLowerCase() === r.toLowerCase()) || null
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

readMemoryTool(
  'list_memories',
  'Liste toutes les notes de mémoire partagée du projet (nom, titre, extrait, liens). Survol bon marché du contexte existant avant de travailler.',
  {},
  async () => text(JSON.stringify(await memory.listMemories(PROJECT_DIR), null, 2)),
)

readMemoryTool(
  'search_memories',
  'Recherche plein-texte (titre + corps) dans la mémoire partagée. Utilise-le pour retrouver ce qu\'un AUTRE agent a noté avant de refaire le travail.',
  { query: z.string().describe('mots-clés'), limit: z.number().optional() },
  async ({ query, limit }) => text(JSON.stringify(await memory.searchMemories(PROJECT_DIR, query, limit ?? 20), null, 2)),
)

readMemoryTool(
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

readMemoryTool(
  'find_backlinks',
  'Notes qui pointent vers une note donnée (signal de coordination : qui dépend de ce contexte).',
  { name: z.string() },
  async ({ name }) => text(JSON.stringify(await memory.findBacklinks(PROJECT_DIR, name), null, 2)),
)

readMemoryTool(
  'get_links',
  "Liens sortants d'une note, séparés en résolus vs non résolus (notes fantômes à créer).",
  { name: z.string() },
  async ({ name }) => text(JSON.stringify(await memory.getLinks(PROJECT_DIR, name), null, 2)),
)

readMemoryTool(
  'get_memory_graph',
  'Topologie du graphe de mémoire (nœuds + arêtes des [[wikilinks]]). Aucune mise en page (concern de l\'UI).',
  {},
  async () => text(JSON.stringify(await memory.buildGraph(PROJECT_DIR), null, 2)),
)

readMemoryTool(
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

// ---- Oryon Archive : LECTURE des transcripts de conversation archivés (.oryon/archive/) ----
// Pur FS + gunzip (built-in) → coût $0, lecture seule (ne modifie jamais l'archive). Exposés à TOUS les
// agents (orchestrateur ET workers) : fouiller l'historique des sessions n'est pas un acte d'orchestration.

server.tool(
  'list_archived_sessions',
  "Liste les sessions de conversation archivées (.oryon/archive), les plus récentes d'abord. Filtre optionnel par agent (slug, ex. \"nell\" ou \"orchestrator\"). Renvoie sessionId, agent, rôle, date (+ relative), taille, tâches liées et chemin gz. Archive vide → []. Survol avant read_archived_session / search_archive.",
  {
    agent: z.string().optional().describe('slug d\'agent (ex. "nell", "orchestrator") ; absent = tous'),
    limit: z.number().optional().describe('nb max de sessions (défaut 30)'),
  },
  async ({ agent, limit }) =>
    text(JSON.stringify(archive.listArchivedSessions(PROJECT_DIR, { agent, limit: limit ?? 30 }), null, 2)),
)

server.tool(
  'read_archived_session',
  "Lit une session archivée (par agent + sessionId, cf. list_archived_sessions). format \"text\" (défaut) = transcript aplati « <rôle>: <texte> » tronqué à maxChars (défaut 40000) ; format \"raw\" = enreg. JSON bruts. Erreur claire si la session est introuvable.",
  {
    agent: z.string().describe('slug d\'agent (ex. "nell", "orchestrator")'),
    sessionId: z.string().describe('id de session (cf. list_archived_sessions)'),
    format: z.enum(['text', 'raw']).optional().describe('"text" (défaut, aplati) ou "raw" (JSON brut)'),
    maxChars: z.number().optional().describe('troncature en caractères (défaut 40000)'),
  },
  async ({ agent, sessionId, format, maxChars }) =>
    text(
      JSON.stringify(
        archive.readArchivedSession(PROJECT_DIR, { agent, sessionId, format: format ?? 'text', maxChars: maxChars ?? 40000 }),
        null,
        2,
      ),
    ),
)

server.tool(
  'search_archive',
  "Recherche plein-texte (sous-chaîne, insensible à la casse) dans le texte des sessions archivées. Filtre optionnel par agent. Renvoie ≤ limit correspondances (défaut 40) : agent, sessionId, date, rôle et un extrait (snippet) autour du match (±contextChars, défaut 160). Pour retrouver une discussion/décision passée sans relire une session entière.",
  {
    query: z.string().describe('sous-chaîne à chercher'),
    agent: z.string().optional().describe('slug d\'agent (ex. "nell") ; absent = tous'),
    limit: z.number().optional().describe('nb max de résultats (défaut 40)'),
    contextChars: z.number().optional().describe('contexte de part et d\'autre du match (défaut 160)'),
  },
  async ({ query, agent, limit, contextChars }) =>
    text(
      JSON.stringify(
        archive.searchArchive(PROJECT_DIR, { query, agent, limit: limit ?? 40, contextChars: contextChars ?? 160 }),
        null,
        2,
      ),
    ),
)

// ---- Oryon Docs : LECTURE des docs tierces importées (~/.oryon/docs, store GLOBAL toutes apps) ----
// Pur FS + scoring lexical en-process (cf. docs-read.mjs) → coût $0, lecture seule. NON-GATÉS (server.tool
// direct, PAS readMemoryTool/orchestratorTool) : la doc est de la RÉFÉRENCE, pas de la coordination → exposés
// à TOUS les agents (orchestrateur ET workers), pour trouver la bonne section sans lire toute la doc.

server.tool(
  'list_docs',
  "Liste les docs tierces importées (~/.oryon/docs, GLOBAL toutes apps), les plus récentes d'abord. Filtre optionnel par tag (insensible casse). Par docSet : slug, title, sourceUrl, origin, fetchedAt, pageCount, chunkCount, tags[], description. Survol bon marché avant search_docs / fetch_doc_section. Aucune doc importée → [].",
  {
    tag: z.string().optional().describe('filtre par tag (insensible à la casse) ; absent = toutes'),
  },
  async ({ tag }) => text(JSON.stringify(docs.listDocs({ tag }))),
)

server.tool(
  'search_docs',
  "Recherche lexicale top-k dans les SECTIONS des docs importées : trouve la bonne section sans lire toute la doc. Filtre optionnel par docSlug (une seule doc) ou tag. Renvoie ≤ limit résultats (défaut 8) classés par score, ligne LEAN : docSlug, breadcrumb (finit par le titre de la section), anchor, snippet (±200 chars, fence-safe), chunkId. Récupère le markdown complet (et le sourceUrl) d'une section via fetch_doc_section (docSlug + anchor).",
  {
    query: z.string().describe('mots-clés (substring, insensible à la casse)'),
    docSlug: z.string().optional().describe('restreint à un seul docSet (cf. list_docs) ; absent = tous'),
    tag: z.string().optional().describe('restreint aux docSets portant ce tag ; absent = tous'),
    limit: z.number().optional().describe('nb max de sections (défaut 8)'),
  },
  async ({ query, docSlug, tag, limit }) =>
    text(JSON.stringify(docs.searchDocs({ query, docSlug, tag, limit: limit ?? 8 }))),
)

server.tool(
  'fetch_doc_section',
  "Renvoie le markdown COMPLET d'une section de doc (par docSlug + anchor, cf. search_docs) : joint les chunks du même heading, blocs code intacts, tronqué à maxChars (défaut 8000 = taille max d'une section non-splittée → une section d'une pièce revient entière) sans couper un fence. Renvoie { docSlug, title, breadcrumb, sourceUrl, markdown } ou { error } si l'ancre est introuvable.",
  {
    docSlug: z.string().describe('slug du docSet (cf. list_docs / search_docs)'),
    anchor: z.string().describe('ancre de la section (cf. search_docs)'),
    maxChars: z.number().optional().describe('troncature en caractères (défaut 8000)'),
  },
  async ({ docSlug, anchor, maxChars }) =>
    text(JSON.stringify(docs.fetchSection({ docSlug, anchor, maxChars: maxChars ?? 8000 }))),
)

// import_doc : ÉCRITURE (≠ les 3 lectures ci-dessus, non-gatées) → GATÉ orchestrateur. L'import vit dans le
// process principal (fetch réseau + turndown, hors de ce serveur Node pur) : on émet une commande 'docs-import'
// (⚠ AUSSI routée dans mcp-export.processCommand, sinon no-op silencieux) avec un reqId, puis on POLLE l'issue
// déposée par le main sous docs-import/<reqId>.json (succès) ou .err (échec) — même request-response que
// browser_screenshot. Un gros crawl qui dépasse le délai rend la main en { pending:true } (l'import continue).
const DOCS_IMPORT_POLL_MS = 500
const DOCS_IMPORT_POLL_TRIES = 180 // ~90 s avant de répondre 'pending' (la plupart des imports finissent bien avant)

orchestratorTool(
  'import_doc',
  "Importe une doc tierce dans le store GLOBAL (~/.oryon/docs) pour la rendre cherchable ensuite via search_docs / fetch_doc_section. Fournis `url` (on sonde son llms.txt, sinon page .md / llms-full.txt / crawl sitemap) OU `markdown` (texte déjà en main). Renvoie le docSet créé { slug, title, origin, chunkCount, pageCount, errors } une fois l'import fini ; un gros crawl qui dépasse ~90 s renvoie { pending:true } (l'import continue côté app — relis sous peu via list_docs / search_docs). WRITE, orchestrateur-only.",
  {
    url: z.string().optional().describe('URL de la doc à importer (sonde llms.txt → page .md → llms-full.txt → sitemap)'),
    markdown: z.string().optional().describe('markdown déjà en main à importer directement (origin "paste")'),
    label: z.string().optional().describe('titre lisible optionnel (sinon dérivé du 1er H1 / de l\'URL)'),
  },
  async ({ url, markdown, label }) => {
    if (!String(url || '').trim() && !String(markdown || '').trim()) {
      return text(JSON.stringify({ ok: false, error: 'Fournis une url ou du markdown à importer.' }))
    }
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ ok: false, error: 'workspace introuvable (Oryon tourne ?)' }))
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    try {
      queueCommand({ type: 'docs-import', workspaceId, reqId, url: url ?? null, markdown: markdown ?? null, label: label ?? null })
    } catch (e) {
      return text(JSON.stringify({ ok: false, error: String(e) }))
    }
    const okPath = join(STATE_DIR, 'docs-import', `${reqId}.json`)
    const errPath = join(STATE_DIR, 'docs-import', `${reqId}.err`)
    // Retire le fichier-résultat dès lecture (best-effort) pour ne pas le laisser fuiter dans docs-import/
    // (le main balaie aussi les orphelins > 1 h, mais on nettoie au plus tôt).
    const cleanupResult = () => {
      try { unlinkSync(okPath) } catch { /* absent / déjà retiré */ }
      try { unlinkSync(errPath) } catch { /* absent / déjà retiré */ }
    }
    for (let i = 0; i < DOCS_IMPORT_POLL_TRIES; i++) {
      if (existsSync(okPath)) {
        try {
          const payload = JSON.parse(readFileSync(okPath, 'utf8'))
          cleanupResult()
          return text(JSON.stringify({ ok: true, ...payload }))
        } catch {
          /* fichier pas encore complètement écrit → retente */
        }
      }
      if (existsSync(errPath)) {
        let m = 'import échoué'
        try {
          m = readFileSync(errPath, 'utf8')
        } catch {
          /* ignore */
        }
        cleanupResult()
        return text(JSON.stringify({ ok: false, error: m }))
      }
      await new Promise((r) => setTimeout(r, DOCS_IMPORT_POLL_MS))
    }
    return text(
      JSON.stringify({
        ok: true,
        pending: true,
        reqId,
        hint: 'Import volumineux toujours en cours (gros crawl ?). Vérifie le résultat sous peu via list_docs / search_docs.',
      }),
    )
  },
)

// ---- Feedback / RH : scorecards de perf des workers + KPIs équipe (orchestrateur-only, lecture seule, $0) ----
// Dérivés du journal d'outcomes (.oryon/outcomes.ndjson, écrit par le main). La VÉRITÉ = TES verdicts d'approbation,
// pas l'auto-report des workers (biais d'optimisme). Consulte AVANT d'assigner + pour calibrer la review.

server.tool(
  'worker_scorecard',
  "Scorecards de perf par worker (analogie RH), dérivées du journal d'outcomes (.oryon/outcomes.ndjson). Par worker : tasksAttempted, approvalRate, firstPassApprovalRate, avgAttempts, blocked, evidenceGateRejections, mergeConflicts, abandoned, dernière activité. Consulte-le AVANT d'assigner (gros/risqué → worker au meilleur track record ; faible → review plus serrée). Vide tant qu'aucune task n'a tourné sous cette version.",
  {},
  async () => text(JSON.stringify(outcomes.workerScorecards(PROJECT_DIR), null, 2)),
)

server.tool(
  'team_metrics',
  "KPIs d'équipe (analogie dashboard manager) dérivés du journal d'outcomes : débit (events/tasks distinctes), re-dispatch rate, taux d'approbation, rejets evidence-gate, conflits/defers de merge, blocked, abandons. Pour suivre la santé du process dans le temps.",
  {},
  async () => text(JSON.stringify(outcomes.teamMetrics(PROJECT_DIR), null, 2)),
)

// ---- System Feedback : store GLOBAL cross-workspace de rapports sur le SYSTÈME Oryon (orchestrateur-only) ----
// L'orchestrateur dépose un rapport CURÉ quand il rencontre un problème touchant le système (worker/dispatch/
// merge/design) — distinct des outcomes (auto, par tâche) et de la mémoire (par projet). L'humain relit
// périodiquement (~/.oryon/system-feedback) pour décider des optimisations. Écriture via le main (sérialise +
// broadcast UI) ; lecture en direct sur le FS ($0).

orchestratorTool(
  'report_system_issue',
  "Dépose un RAPPORT dans le store GLOBAL cross-workspace de feedback système (~/.oryon/system-feedback). À utiliser quand tu rencontres un problème touchant le SYSTÈME Oryon lui-même (coordination des workers, dispatch, merge-back, worktrees, design de l'orchestrateur) — PAS un problème de tâche ordinaire. Donne l'erreur EXACTE (preuve verbatim), la cause que tu SUPPOSES, et les données pertinentes (ids de tâches, preuve git, compteurs). L'humain relit ces rapports pour améliorer Oryon. Consulte list_system_issues AVANT pour éviter un doublon.",
  {
    category: z
      .enum(['worker', 'orchestration', 'system-design', 'oryon-bug', 'other'])
      .describe('bucket : worker / orchestration (dispatch, merge) / system-design / bug Oryon / autre'),
    severity: z.enum(['info', 'warning', 'error']).describe('gravité'),
    title: z.string().describe('résumé court (1 ligne)'),
    exactError: z.string().describe('erreur / preuve VERBATIM (message, sortie git, wake-line)'),
    hypothesizedCause: z.string().describe('pourquoi tu penses que ça arrive'),
    relevantData: z.string().optional().describe('libre : ids de tâches, preuve git, outcomes, compteurs'),
    suggestedFix: z.string().optional().describe('piste de correction optionnelle'),
  },
  async ({ category, severity, title, exactError, hypothesizedCause, relevantData, suggestedFix }) => {
    try {
      const id = queueCommand({
        type: 'report-system-issue',
        workspaceId: currentWorkspaceId() ?? null,
        agent: DEFAULT_AUTHOR ?? 'orchestrator',
        category,
        severity,
        title,
        exactError,
        hypothesizedCause,
        relevantData: relevantData ?? null,
        suggestedFix: suggestedFix ?? null,
      })
      return text(JSON.stringify({ queued: true, id }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

orchestratorTool(
  'list_system_issues',
  "Liste les rapports du store GLOBAL de feedback système (TOUS workspaces confondus), récents d'abord. Filtre optionnel par status (open/reviewed/resolved/wontfix) et category. Consulte-le AVANT report_system_issue pour ne pas dupliquer un rapport existant.",
  {
    status: z.enum(['open', 'reviewed', 'resolved', 'wontfix']).optional().describe('filtre par statut'),
    category: z.enum(['worker', 'orchestration', 'system-design', 'oryon-bug', 'other']).optional().describe('filtre par bucket'),
    limit: z.number().optional().describe('nombre max (défaut 50)'),
  },
  async ({ status, category, limit }) => {
    try {
      const rows = await systemFeedback.listReports({
        status,
        category,
        limit: typeof limit === 'number' ? limit : 50,
      })
      return text(JSON.stringify(rows, null, 2))
    } catch (e) {
      return text(JSON.stringify({ error: String(e) }))
    }
  },
)

orchestratorTool(
  'resolve_system_issue',
  "Change le statut d'un rapport de feedback système (par id) : reviewed / resolved / wontfix, avec une note optionnelle. Sert surtout à l'humain via l'UI, mais tu peux marquer un doublon 'resolved'.",
  {
    id: z.string().describe('id du rapport (cf. list_system_issues)'),
    status: z.enum(['open', 'reviewed', 'resolved', 'wontfix']),
    note: z.string().optional().describe('note de revue optionnelle'),
  },
  async ({ id, status, note }) => {
    try {
      const cmdId = queueCommand({ type: 'resolve-system-issue', issueId: id, status, note: note ?? null })
      return text(JSON.stringify({ queued: true, id: cmdId }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
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
    try {
      const id = queueCommand({ type: 'mailbox', workspaceId, fromAgent: from, body })
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
    try {
      const id = queueCommand({ type: 'update-task-status', taskId, status })
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
// Tout nouveau type émis ici DOIT être ajouté à src/shared/command-types.mjs + un handler dans mcp-export.processCommand.
function queueCommand(cmd) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const full = { id, ...cmd }
  const dir = join(STATE_DIR, 'commands')
  mkdirSync(dir, { recursive: true })
  // Écriture ATOMIQUE (tmp → rename) : le watcher main ne voit JAMAIS un JSON partiel,
  // ce qui permet de surveiller sans awaitWriteFinish (latence ~0 au lieu de ~2 s).
  const tmp = join(dir, `${id}.json.tmp`)
  writeFileSync(tmp, JSON.stringify(full, null, 2))
  let lastErr
  for (let i = 0; i < 5; i++) {
    try { renameSync(tmp, join(dir, `${id}.json`)); return id } catch (e) { lastErr = e }
  }
  throw lastErr
}

orchestratorTool(
  'open_browser',
  "Ouvre une URL dans le panneau Browser d'Oryon (preview in-app) : ramène le workspace au premier plan, bascule sur l'onglet Browser et y navigue le webview. Pour afficher un site qu'on développe ici (ex. http://localhost:5173, après avoir lancé le dev server dans un terminal).",
  {
    url: z.string().describe('URL à ouvrir (http(s):// ; un host nu type localhost:5173 est préfixé http://)'),
  },
  async ({ url }) => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ ok: false, error: 'Workspace introuvable' }))
    const id = queueCommand({ type: 'browser-open', workspaceId, url })
    return text(JSON.stringify({ ok: true, id, workspaceId, url }))
  },
)

orchestratorTool(
  'browser_console',
  "Renvoie les logs récents de la console du navigateur (panneau Browser in-app) du workspace — log/info/warn/error de la page ouverte, pour déboguer un site qu'on développe ici. Vide tant qu'aucun site n'est ouvert (cf. open_browser).",
  {},
  async () => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text('Workspace introuvable.')
    const out = readBrowserConsole(workspaceId)
    return text(out || '(console vide — ouvre un site avec open_browser puis recharge/interagis)')
  },
)

orchestratorTool(
  'read_app_log',
  "Logs récents de la console de la FENÊTRE PRINCIPALE d'Oryon (renderer hôte) — pour déboguer le runtime de l'app elle-même (ex. les sondes [voice] de la dictée : REC start / auto-stop / transcribe). `filter` = sous-chaîne à matcher (ex. '[voice]') ; `lines` = nombre de dernières lignes (défaut 60).",
  {
    filter: z.string().optional().describe("sous-chaîne à matcher (ex. '[voice]') ; absent = toutes les lignes"),
    lines: z.number().optional().describe('nombre de dernières lignes à renvoyer (défaut 60)'),
  },
  async ({ filter, lines }) => {
    const p = join(STATE_DIR, 'app-console.log')
    let raw = ''
    try {
      raw = existsSync(p) ? readFileSync(p, 'utf8') : ''
    } catch {
      raw = ''
    }
    if (!raw) return text("(console principale vide — relance Oryon pour charger le capteur, puis reproduis l'action)")
    let arr = raw.split('\n').filter(Boolean)
    if (filter) arr = arr.filter((l) => l.includes(filter))
    const n = lines && lines > 0 ? lines : 60
    return text(arr.slice(-n).join('\n') || `(aucune ligne ne matche « ${filter} »)`)
  },
)

orchestratorTool(
  'browser_screenshot',
  "Capture le panneau Browser in-app (site actuellement affiché) et renvoie l'image, pour VOIR le rendu et proposer des améliorations visuelles. Nécessite un site ouvert (open_browser) dans le workspace actif.",
  {},
  async () => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text('Workspace introuvable.')
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    queueCommand({ type: 'browser-screenshot', workspaceId, reqId })
    const shot = join(STATE_DIR, 'screenshots', `${reqId}.png`)
    const err = join(STATE_DIR, 'screenshots', `${reqId}.err`)
    // Request-response : le renderer capture la webview (webview.capturePage) → le main écrit le PNG. Poll ~12s.
    for (let i = 0; i < 60; i++) {
      if (existsSync(shot)) {
        try {
          return img(readFileSync(shot).toString('base64'))
        } catch {
          /* fichier pas encore complet → retente */
        }
      }
      if (existsSync(err)) {
        let m = 'échec'
        try {
          m = readFileSync(err, 'utf8')
        } catch {
          /* ignore */
        }
        return text(`Screenshot impossible : ${m} (un site est-il ouvert dans le panneau Browser ?)`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return text('Screenshot : délai dépassé (le panneau Browser a-t-il un site ouvert ? lance open_browser, attends le chargement, réessaie).')
  },
)

orchestratorTool(
  'assign_task',
  "Donne une sous-task à UN worker (par name « Nell » ou position « #2 »). Le worker la fait dans son worktree git puis signale la fin (report_task). Émets plusieurs assign_task pour paralléliser. Le taskId arrive dans la notification de fin (ou via list_tasks).",
  {
    terminal: z.string().describe('name (ex. "Nell") ou position (ex. "#2") du worker'),
    instructions: z.string().describe('contrat auto-suffisant : objectif + fichiers IN/OUT-scope + definition-of-done. Cap 3-5 items couplés / fichiers disjoints, sinon SPLIT en plusieurs assign.'),
    title: z.string().optional().describe('titre court (sinon dérivé des instructions)'),
    files: z.array(z.string()).optional().describe('fichiers (relatifs) que ce worker va éditer → réservés (claim) ; un assign dont les fichiers chevauchent une task active est REFUSÉ.'),
    docSlug: z.string().optional().describe('slug d\'une doc importée pertinente (cf. list_docs) → injecté au contrat pour que le worker la cherche directement (search_docs scopé).'),
    readOnly: z.boolean().optional().describe('tâche de consultation, aucun commit attendu → skippe l\'evidence-gate « branche vide » au report.'),
  },
  async ({ terminal, instructions, title, files, docSlug, readOnly }) => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ queued: false, error: 'workspace introuvable (Oryon tourne ?)' }))
    try {
      const id = queueCommand({ type: 'assign-task', workspaceId, terminal, instructions, title: title ?? null, files: files ?? null, docSlug: docSlug ?? null, readOnly: readOnly ?? null })
      return text(JSON.stringify({ queued: true, id, terminal }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

orchestratorTool(
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
    files_changed: z.array(z.string()).optional().describe('chemins relatifs que tu as touchés (cross-check vs git ; ne remplace PAS le commit)'),
    committed: z.boolean().optional().describe('true si tu as bien commité ton travail dans TA branche'),
    task_id: z.string().optional().describe('l\'id [task …] reçu dans ton contrat — fournis-le TOUJOURS si tu l\'as'),
  },
  async ({ status, summary, fromAgent, files_changed, committed, task_id }) => {
    const from = fromAgent ?? DEFAULT_AUTHOR ?? 'unknown'
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ queued: false, error: 'workspace introuvable' }))
    try {
      const id = queueCommand({ type: 'report-task', workspaceId, fromAgent: from, status, summary, filesChanged: files_changed ?? null, committed: committed ?? null, taskId: task_id ?? null })
      return text(JSON.stringify({ queued: true, id, status }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

orchestratorTool(
  'broadcast_command',
  "Envoie une commande dans les terminaux des workers : une slash-command claude (ex. \"/effort high\", \"/model fable\") pour changer leur effort/modèle/réglages, ou une instruction libre. Par défaut à TOUS les workers vivants ; cible-en un seul via `terminal`. Niveaux d'effort valides : low|medium|high|max.",
  {
    command: z.string().describe('la ligne à envoyer (ex. "/effort high", "/model fable")'),
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

// ---- Diagnostic & réparation d'un worker/MCP mort (orchestrateur-only, lacune d1/d2/d3) ----

orchestratorTool(
  'restart_agent',
  "Tue puis relance le terminal claude d'UN worker (par name « Nell » ou position « #2 ») : SEULE façon de relancer un serveur MCP mort (il est enfant du `claude`). À utiliser quand un worker ne répond plus / son MCP est tombé (cf. mcp_health). kill+recreate sérialisé côté main ; ne touche QUE le terminal ciblé. Attends qu'il soit prêt avant de le re-piloter.",
  { terminal: z.string().describe('name (ex. "Nell") ou position (ex. "#2") du worker à relancer') },
  async ({ terminal }) => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ queued: false, error: 'workspace introuvable (Oryon tourne ?)' }))
    try {
      const id = queueCommand({ type: 'restart-agent', workspaceId, terminal })
      return text(JSON.stringify({ queued: true, id, terminal }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

// ---- Continuité de l'orchestrateur : flush d'archive + reset de contexte (orchestrateur-only) ----

orchestratorTool(
  'flush_archive',
  "Force un archivage immédiat des transcripts de conversation (.oryon/archive/), sans attendre le sweep périodique (throttle 2 min). Sauvegarde l'historique en vol — utile avant un reset_orchestrator ou une opération risquée. Relisible ensuite via list_archived_sessions / search_archive. Coût $0 (FS + gzip).",
  {},
  async () => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ queued: false, error: 'workspace introuvable' }))
    try {
      const id = queueCommand({ type: 'flush-archive', workspaceId })
      return text(JSON.stringify({ queued: true, id }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

orchestratorTool(
  'reset_orchestrator',
  "Repart d'un contexte FRAIS sans perdre la donnée : flush l'archive, puis injecte /clear dans TON propre terminal (l'orchestrateur), puis une ligne de ré-hydration ~1 s après. À appeler quand le contexte devient lourd (au lieu de laisser la compaction se déclencher) — APRÈS avoir écrit/màj le curseur de reprise en mémoire partagée (create_memory/update_memory « orchestrator-resume »). La conversation complète reste relisible (search_archive / read_archived_session, agent « orchestrator »). ⚠ Vide ta conversation courante : ne l'appelle que volontairement, en fin de tour.",
  {
    rehydration: z
      .string()
      .optional()
      .describe('ligne injectée après /clear (défaut : « lis le curseur orchestrator-resume puis reprends »)'),
  },
  async ({ rehydration }) => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ queued: false, error: 'workspace introuvable' }))
    try {
      const id = queueCommand({ type: 'reset-orchestrator', workspaceId, rehydration: rehydration ?? null })
      return text(JSON.stringify({ queued: true, id }))
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

orchestratorTool(
  'mcp_health',
  "Diagnostique l'état du serveur MCP d'un worker (par name « Nell » / position « #2 ») via son log + heartbeat dédiés : renvoie status connected|stale|failed|unknown (stale = heartbeat expiré = MCP probablement MORT après un boot réussi, le « busy zombie ») + heartbeatAgeMs + dernière erreur. Sers-t'en quand un worker semble ne plus répondre, AVANT de décider un restart_agent.",
  { terminal: z.string().describe('name ou #position du worker') },
  async ({ terminal }) => {
    const t = resolveWorkerTerminal(terminal)
    if (!t) return text(JSON.stringify({ status: 'unknown', error: `terminal "${terminal}" introuvable` }))
    const p = join(STATE_DIR, `mcp-${t.name}.log`)
    const log = existsSync(p) ? readFileSync(p, 'utf8') : ''
    const lines = log.split('\n').filter(Boolean)
    const failed = lines.some((l) => /ÉCHEC connexion/.test(l))
    const connected = lines.some((l) => /connecté/.test(l))
    // R4 : fraîcheur du heartbeat → détecte un MCP mort APRÈS un boot réussi (busy zombie). Si le .hb a cessé
    // d'être mis à jour, le serveur MCP n'est plus vivant, même si le log montrait 'connecté'.
    let hbAgeMs = null
    try {
      const hbPath = join(STATE_DIR, `mcp-${t.name}.hb`)
      if (existsSync(hbPath)) hbAgeMs = Date.now() - (parseInt(readFileSync(hbPath, 'utf8').trim(), 10) || 0)
    } catch {
      /* pas de .hb (worker sur une version sans heartbeat) → on retombe sur connected/failed */
    }
    const stale = hbAgeMs !== null && hbAgeMs > HEARTBEAT_STALE_MS
    const status = failed ? 'failed' : stale ? 'stale' : connected ? 'connected' : 'unknown'
    const lastError = [...lines].reverse().find((l) => /ÉCHEC|error|exception/i.test(l)) ?? null
    return text(
      JSON.stringify(
        {
          terminal: t.name,
          status,
          heartbeatAgeMs: hbAgeMs,
          lastError,
          lastLine: lines[lines.length - 1] ?? null,
          logLines: lines.length,
        },
        null,
        2,
      ),
    )
  },
)

orchestratorTool(
  'get_mcp_log',
  "Lit le log de cycle de vie DÉDIÉ du serveur MCP d'un worker (connexion/erreurs), par name « Nell » ou position « #2 ». Complète get_terminal_output (qui montre le TUI) pour diagnostiquer un MCP qui ne répond plus.",
  { terminal: z.string().describe('name ou #position du worker') },
  async ({ terminal }) => {
    const t = resolveWorkerTerminal(terminal)
    if (!t) return text(`Terminal "${terminal}" introuvable (workers : ${scopedTerminals(readMeta()).filter((x) => x.role !== 'orchestrator').map((x) => x.name).join(', ') || '(aucun)'})`)
    const p = join(STATE_DIR, `mcp-${t.name}.log`)
    const log = existsSync(p) ? readFileSync(p, 'utf8') : ''
    return text(log || `(aucun log MCP pour ${t.name} — le serveur n'a pas écrit de marqueur : pas démarré, ou version sans log dédié)`)
  },
)

// ---- Installer-via-l'agent : tester + ajouter un connecteur MCP (orchestrateur-only, wizard d'install) ----
// test_connector ouvre une VRAIE session MCP (initialize + tools/list) vers la config fournie pour la VALIDER
// avant de l'enregistrer ; exécuté DANS ce serveur (le SDK client est bundlé) → $0 (aucun appel Claude).
// add_connector enfile l'ajout côté main (DB + régénération des configs).
const PROBE_TIMEOUT_MS = 15000
async function probeMcp({ transport: tr, command, args, url, env, headers }) {
  let client
  let transport
  try {
    if (tr === 'stdio') {
      if (!command) return { ok: false, error: 'command requis (stdio)' }
      const childEnv = { ...getDefaultEnvironment(), ...(env || {}) }
      delete childEnv.ANTHROPIC_API_KEY // hygiène coût $0 : le serveur testé n'hérite pas de la clé API
      transport = new StdioClientTransport({ command, args: args || [], env: childEnv, stderr: 'ignore' })
    } else {
      if (!url) return { ok: false, error: `url requis (${tr})` }
      const u = new URL(url)
      const requestInit = headers ? { headers } : undefined
      transport =
        tr === 'sse' ? new SSEClientTransport(u, { requestInit }) : new StreamableHTTPClientTransport(u, { requestInit })
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
  client = new Client({ name: 'oryon-probe', version: '0.1.0' }, { capabilities: {} })
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`timeout (${PROBE_TIMEOUT_MS / 1000}s) — serveur injoignable ?`)), PROBE_TIMEOUT_MS),
  )
  try {
    await Promise.race([client.connect(transport), timeout])
    const res = await Promise.race([client.listTools(), timeout])
    const tools = Array.isArray(res?.tools) ? res.tools.map((t) => ({ name: t.name, description: t.description })) : []
    return { ok: true, toolCount: tools.length, tools }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally {
    try {
      await client.close()
    } catch {
      /* best-effort */
    }
    try {
      await transport.close()
    } catch {
      /* best-effort */
    }
  }
}

orchestratorTool(
  'test_connector',
  "Teste une config de serveur MCP SANS l'enregistrer : ouvre une session (initialize + tools/list) et renvoie { ok, toolCount, tools[] } ou { ok:false, error }. À utiliser pour VALIDER une config (command/url + secrets) trouvée dans la doc AVANT add_connector. Read-only, aucun effet persistant, $0.",
  {
    transport: z.enum(['stdio', 'http', 'sse']),
    command: z.string().optional().describe('stdio : exécutable (ex. "npx")'),
    args: z.array(z.string()).optional().describe('stdio : arguments'),
    url: z.string().optional().describe('http/sse : endpoint'),
    env: z.record(z.string()).optional().describe("stdio : variables d'env (secrets)"),
    headers: z.record(z.string()).optional().describe('http/sse : en-têtes (ex. {"Authorization":"Bearer …"})'),
  },
  async (input) => text(JSON.stringify(await probeMcp(input), null, 2)),
)

orchestratorTool(
  'add_connector',
  "Ajoute un connecteur MCP pour l'utilisateur (rendu dispo à TOUS les agents du projet). Sert à connecter un serveur MCP que l'utilisateur a demandé, une fois sa config trouvée et VALIDÉE (test_connector). Mets les secrets (token/clé) dans env (stdio) ou headers (http/sse), JAMAIS en clair dans args/url. scope 'app' = global, 'project' = projet courant.",
  {
    name: z.string().describe('nom court unique (ex. "supabase", "github")'),
    transport: z.enum(['stdio', 'http', 'sse']),
    scope: z.enum(['app', 'project']).optional().describe("'app' (défaut) = global ; 'project' = projet courant"),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string()).optional(),
    headers: z.record(z.string()).optional(),
  },
  async ({ name, transport: tr, scope, command, args, url, env, headers }) => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return text(JSON.stringify({ queued: false, error: 'workspace introuvable (Oryon tourne ?)' }))
    try {
      const id = queueCommand({
        type: 'add-connector',
        workspaceId,
        connector: {
          name,
          transport: tr,
          scope: scope || 'app',
          command: command || null,
          args: args || null,
          url: url || null,
          env: env || null,
          headers: headers || null,
        },
      })
      return text(
        JSON.stringify({ queued: true, id, name, hint: 'Ajout enfilé côté Oryon. Confirme via Réglages → Connecteurs.' }),
      )
    } catch (e) {
      return text(JSON.stringify({ queued: false, error: String(e) }))
    }
  },
)

const transport = new StdioServerTransport()
try {
  await server.connect(transport)
  mcpLog('connecté (state: ' + STATE_DIR + ' | memory: ' + MEMORY_DIR + ')')
} catch (e) {
  // Marqueur 'failed' exploitable par mcp_health (les échecs d'IMPORT, eux, crashent avant ce code → 'unknown').
  mcpLog('ÉCHEC connexion: ' + String(e))
  throw e
}
