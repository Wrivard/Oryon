// Oryon System Feedback — CŒUR PARTAGÉ (FS + path + os, sans Electron). Jumeau de docs-core.mjs /
// memory-core.mjs : importé par le process principal (system-feedback.ipc.ts, via mcp-export) ET par le
// serveur MCP standalone (src/mcp/server.mjs), pour une seule implémentation du store.
//
// Store GLOBAL cross-workspace de RAPPORTS SYSTÈME : l'orchestrateur de N'IMPORTE QUEL workspace y dépose
// un rapport structuré quand il rencontre un problème touchant le SYSTÈME Oryon (worker / dispatch / merge /
// design) — PAS un problème de tâche ordinaire. L'humain (et l'orchestrateur via list_system_issues) les
// relit périodiquement pour décider des optimisations. GLOBAL (toutes apps), sous ~/.oryon/system-feedback/,
// calculé par os.homedir() — AUCUN env à câbler, même chemin côté MCP et côté main. Layout :
//   ~/.oryon/system-feedback/reports.ndjson — 1 ligne JSON par rapport (append-only ; statut réécrit atomiquement)
//
// Concurrence : append atomique au niveau OS (appendFile) ; la réécriture (changement de statut) est sérialisée
// par le process principal (seul writer du rewrite) + atomique (tmp + rename-retry EPERM/EBUSY, copiés de docs-core).
import { promises as fs, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// ── Atomicité (MIRROIR de docs-core.mjs/memory-core.mjs). Sous Windows (MoveFileEx), fs.rename ÉCHOUE
// (EPERM/EBUSY) si un autre process tient la destination ouverte en lecture — on retente. ──
let tmpSeq = 0
async function renameRetry(from, to) {
  for (let i = 0; i < 6; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = e && e.code
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || i === 5) {
        await fs.unlink(from).catch(() => {})
        throw e
      }
      await new Promise((r) => setTimeout(r, 25 + i * 30))
    }
  }
}
async function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`
  await fs.writeFile(tmp, content, 'utf8')
  await renameRetry(tmp, path)
}

/** Dossier du store GLOBAL de feedback système (toutes apps). mkdir récursif best-effort puis renvoie le chemin. */
export function feedbackDir() {
  const dir = join(homedir(), '.oryon', 'system-feedback')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* best-effort */
  }
  return dir
}

/** Chemin du journal append-only des rapports. */
export const reportsPath = () => join(feedbackDir(), 'reports.ndjson')

/** Identifiant unique d'un rapport. */
export const genId = () => randomUUID()

/**
 * Append BEST-EFFORT d'un rapport (ne throw JAMAIS — un rapport perdu vaut mieux qu'un crash du main).
 * Complète id/ts/status si absents. Retourne le record écrit, ou null en cas d'échec.
 */
export async function appendReport(record) {
  try {
    const full = {
      ...record,
      id: record.id || genId(),
      ts: typeof record.ts === 'number' ? record.ts : Date.now(),
      status: record.status || 'open',
    }
    feedbackDir() // garantit le dossier
    await fs.appendFile(reportsPath(), JSON.stringify(full) + '\n', 'utf8')
    return full
  } catch {
    return null
  }
}

/**
 * Lit + parse tous les rapports (ignore lignes vides/malformées sans planter). Filtre par status/category
 * si fournis, trie par ts DÉCROISSANT, applique limit si fourni. Fichier absent → [].
 */
export async function listReports(filter = {}) {
  let raw
  try {
    raw = await fs.readFile(reportsPath(), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let r
    try {
      r = JSON.parse(s)
    } catch {
      continue
    }
    if (filter.status && r.status !== filter.status) continue
    if (filter.category && r.category !== filter.category) continue
    out.push(r)
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  return typeof filter.limit === 'number' && filter.limit >= 0 ? out.slice(0, filter.limit) : out
}

/**
 * Met à jour le statut (et la note de revue) d'UN rapport, par id. Réécriture ATOMIQUE du fichier entier.
 * Retourne true si l'id a été trouvé, false sinon.
 */
export async function updateReportStatus(id, status, note, reviewedAt) {
  let raw
  try {
    raw = await fs.readFile(reportsPath(), 'utf8')
  } catch {
    return false
  }
  let found = false
  const next = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let r
    try {
      r = JSON.parse(s)
    } catch {
      next.push(s) // ligne malformée préservée telle quelle
      continue
    }
    if (r.id === id) {
      found = true
      if (status) r.status = status
      if (note !== undefined) r.reviewNote = note || undefined
      r.reviewedAt = typeof reviewedAt === 'number' ? reviewedAt : Date.now()
    }
    next.push(JSON.stringify(r))
  }
  if (!found) return false
  await writeAtomic(reportsPath(), next.join('\n') + '\n')
  return true
}
