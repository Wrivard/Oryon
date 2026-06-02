// Oryon Archive — LECTURE SEULE des transcripts de conversation archivés sous <projet>/.oryon/archive/.
// Pendant logique des outils archive du serveur MCP (src/mcp/server.mjs), comme memory-core.mjs l'est pour
// la mémoire. Le chemin d'ÉCRITURE de l'archive est src/main/services/archive.ts — ici on ne fait QUE lire :
// pur FS + gunzip (built-in zlib), AUCUNE dépendance npm, AUCUN appel Claude (coût $0). projectDir passé en
// argument (le serveur le résout une fois). Format (cf. archive.ts) :
//   .oryon/archive/index.ndjson          — 1 meta JSON / ligne : { sessionId, agent, role, workspaceId,
//                                           project, bytes, sourceMtimeMs, archivedAt, gz, tasks }
//   .oryon/archive/<slug>/<id>.jsonl.gz  — transcript Claude gzippé (NDJSON). slug = nom worker minuscule,
//                                           ou "orchestrator". `gz` (dans la meta) = "<slug>/<id>.jsonl.gz".
import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'

export const archiveDir = (projectDir) => join(projectDir, '.oryon', 'archive')
const indexPath = (projectDir) => join(archiveDir(projectDir), 'index.ndjson')

const TOOL_RESULT_MAX = 500 // extrait max d'un bloc tool_result dans le texte aplati

/** slug (= nom du sous-dossier) d'une meta : tiré du chemin `gz`, sinon dérivé du rôle/nom. */
function slugOf(meta) {
  if (meta && typeof meta.gz === 'string' && meta.gz.includes('/')) return meta.gz.split('/')[0]
  if (meta && meta.role === 'orchestrator') return 'orchestrator'
  return String((meta && meta.agent) || '').toLowerCase()
}

/** Filtre par agent insensible à la casse : matche le slug OU le nom d'agent. Sans filtre → tout. */
function matchesAgent(meta, agent) {
  if (!agent) return true
  const a = String(agent).trim().toLowerCase()
  if (!a) return true
  return slugOf(meta) === a || String((meta && meta.agent) || '').toLowerCase() === a
}

/** Date relative en français (à l'instant / il y a N min|h|j). `now` injectable pour des tests déterministes. */
function relativeFr(ms, now) {
  if (typeof ms !== 'number' || !ms) return ''
  const diff = Math.max(0, now - ms)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return "à l'instant"
  const min = Math.floor(sec / 60)
  if (min < 60) return `il y a ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `il y a ${h} h`
  return `il y a ${Math.floor(h / 24)} j`
}

/** Lit index.ndjson → tableau de meta. Absent/illisible → [] (lignes corrompues ignorées). */
export function readIndex(projectDir) {
  const p = indexPath(projectDir)
  let raw
  try {
    raw = existsSync(p) ? readFileSync(p, 'utf8') : ''
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* ligne corrompue : on l'ignore */
    }
  }
  return out
}

/** Localise le .jsonl.gz d'une session : via le `gz` de l'index (fiable), sinon chemins construits. null si absent. */
function locateGz(projectDir, agent, sessionId) {
  const root = archiveDir(projectDir)
  const candidates = []
  const entry = readIndex(projectDir).find((m) => m.sessionId === sessionId && matchesAgent(m, agent))
  if (entry && entry.gz) candidates.push(join(root, entry.gz))
  const a = String(agent || '').trim()
  if (a) {
    candidates.push(join(root, a.toLowerCase(), `${sessionId}.jsonl.gz`))
    candidates.push(join(root, a, `${sessionId}.jsonl.gz`))
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Décompresse + parse un transcript NDJSON gzippé → tableau d'enreg. (lignes corrompues ignorées). */
function parseGz(gzPath) {
  const raw = gunzipSync(readFileSync(gzPath)).toString('utf8')
  const recs = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      recs.push(JSON.parse(t))
    } catch {
      /* ligne corrompue : on l'ignore */
    }
  }
  return recs
}

/** Texte lisible d'un bloc de contenu (text | tool_use | tool_result). Autres types → ''. */
function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
  if (block.type === 'tool_use') return `[outil: ${block.name || '?'}]`
  if (block.type === 'tool_result') {
    const c = block.content
    let s = ''
    if (typeof c === 'string') s = c
    else if (Array.isArray(c)) s = c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ')
    s = String(s).trim()
    if (!s) return '[résultat outil]'
    return `[résultat outil: ${s.length > TOOL_RESULT_MAX ? s.slice(0, TOOL_RESULT_MAX) + '…' : s}]`
  }
  return ''
}

/** Texte lisible d'un enreg. transcript. null si l'enreg. n'a pas de message exploitable (à ignorer). */
export function recordText(rec) {
  const msg = rec && rec.message
  if (!msg) return null
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('\n')
  return null
}

/** Rôle d'un enreg. (message.role, repli sur type). */
function recordRole(rec) {
  return (rec && rec.message && rec.message.role) || (rec && rec.type) || 'unknown'
}

/**
 * Liste les sessions archivées, plus récentes d'abord. opts: { agent?, limit=30, now=Date.now() }.
 * Filtre par agent (slug OU nom, insensible casse). index absent → [].
 */
export function listArchivedSessions(projectDir, opts = {}) {
  const { agent, limit = 30, now = Date.now() } = opts
  return readIndex(projectDir)
    .filter((m) => matchesAgent(m, agent))
    .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
    .slice(0, Math.max(0, limit))
    .map((m) => ({
      sessionId: m.sessionId,
      agent: m.agent,
      role: m.role,
      archivedAt: m.archivedAt,
      archivedAtRelative: relativeFr(m.archivedAt, now),
      bytes: m.bytes,
      tasks: m.tasks || [],
      gz: m.gz,
    }))
}

/**
 * Lit une session archivée. opts: { agent, sessionId, format='text', maxChars=40000 }.
 * format 'text' = transcript aplati ("<rôle>: <texte>" / ligne), tronqué à maxChars. format 'raw' = enreg.
 * JSON bruts (tronqués à maxChars). { error } si introuvable.
 */
export function readArchivedSession(projectDir, opts = {}) {
  const { agent, sessionId, format = 'text', maxChars = 40000 } = opts
  if (!sessionId) return { error: 'sessionId requis' }
  const gz = locateGz(projectDir, agent, sessionId)
  if (!gz) {
    return {
      error: `Session archivée introuvable (agent="${agent ?? ''}", sessionId="${sessionId}"). Vérifie via list_archived_sessions.`,
    }
  }
  let recs
  try {
    recs = parseGz(gz)
  } catch (e) {
    return { error: `Lecture/décompression impossible (${gz}) : ${String((e && e.message) || e)}` }
  }
  const cap = Math.max(1, maxChars)
  if (format === 'raw') {
    const json = JSON.stringify(recs, null, 2)
    const truncated = json.length > cap
    return {
      sessionId,
      agent: agent ?? null,
      format: 'raw',
      records: recs.length,
      truncated,
      content: truncated ? json.slice(0, cap) + '\n…[tronqué]' : json,
    }
  }
  const lines = []
  for (const rec of recs) {
    const txt = recordText(rec)
    if (txt == null) continue
    const clean = String(txt).trim()
    if (!clean) continue
    lines.push(`${recordRole(rec)}: ${clean}`)
  }
  let flat = lines.join('\n')
  const truncated = flat.length > cap
  if (truncated) flat = flat.slice(0, cap) + '\n…[tronqué]'
  return { sessionId, agent: agent ?? null, format: 'text', records: recs.length, truncated, content: flat }
}

/**
 * Recherche plein-texte (sous-chaîne, insensible casse) dans le texte des sessions archivées.
 * opts: { query, agent?, limit=40, contextChars=160 }. Itère l'index (récent d'abord) et S'ARRÊTE dès `limit`
 * atteint (ne décompresse pas les sessions restantes). Renvoie [{ agent, sessionId, archivedAt, role, snippet }].
 */
export function searchArchive(projectDir, opts = {}) {
  const { query, agent, limit = 40, contextChars = 160 } = opts
  const q = String(query || '').toLowerCase()
  if (!q) return []
  const root = archiveDir(projectDir)
  const sessions = readIndex(projectDir)
    .filter((m) => matchesAgent(m, agent))
    .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
  const results = []
  for (const meta of sessions) {
    if (results.length >= limit) break // assez de matchs : on ne décompresse pas le reste
    if (!meta.gz) continue
    let recs
    try {
      recs = parseGz(join(root, meta.gz))
    } catch {
      continue
    }
    for (const rec of recs) {
      if (results.length >= limit) break
      const txt = recordText(rec)
      if (txt == null) continue
      const hay = String(txt)
      const idx = hay.toLowerCase().indexOf(q)
      if (idx < 0) continue
      const start = Math.max(0, idx - contextChars)
      const end = Math.min(hay.length, idx + q.length + contextChars)
      let snippet = hay.slice(start, end).replace(/\s+/g, ' ').trim()
      if (start > 0) snippet = '…' + snippet
      if (end < hay.length) snippet = snippet + '…'
      results.push({
        agent: meta.agent,
        sessionId: meta.sessionId,
        archivedAt: meta.archivedAt,
        role: recordRole(rec),
        snippet,
      })
    }
  }
  return results
}
