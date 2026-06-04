// Oryon — LECTURE des outcomes de task (<projet>/.oryon/outcomes.ndjson) pour la couche feedback. Pur FS, $0,
// lecture seule : le MAIN écrit (services/orchestrator/outcomes.ts), ici on AGRÈGE en scorecards / métriques.
// Même pattern que archive-read.mjs / memory-core.mjs (le serveur MCP ne partage pas l'ABI SQLite du main).
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const outcomesPath = (projectDir) => join(projectDir, '.oryon', 'outcomes.ndjson')

/** Lit outcomes.ndjson → tableau d'événements (récents inclus). Absent/illisible → []. Lignes corrompues ignorées. */
export function readOutcomes(projectDir) {
  let raw
  try {
    const p = outcomesPath(projectDir)
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
      /* ligne corrompue ignorée */
    }
  }
  return out
}

function relFr(ms, now) {
  if (!ms) return ''
  const sec = Math.floor(Math.max(0, now - ms) / 1000)
  if (sec < 60) return "à l'instant"
  const m = Math.floor(sec / 60)
  if (m < 60) return `il y a ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `il y a ${h} h`
  return `il y a ${Math.floor(h / 24)} j`
}

/** Regroupe les événements par taskId (= une chaîne d'essais). */
function groupByTask(evs) {
  const byTask = new Map()
  for (const e of evs) {
    if (!e.taskId) continue
    let r = byTask.get(e.taskId)
    if (!r) {
      r = { agent: e.agent, events: [] }
      byTask.set(e.taskId, r)
    }
    if (e.agent && e.agent !== '?') r.agent = e.agent // dernier agent connu (l'agent réel survit au requeue)
    r.events.push(e)
  }
  return byTask
}

/**
 * SCORECARDS par worker — la « review de perf » du manager, dérivée d'outcomes.ndjson. firstPassApprovalRate =
 * task approuvée au 1er essai SANS rejet evidence-gate. avgAttempts = essais moyens jusqu'à l'état final.
 */
export function workerScorecards(projectDir, { now = Date.now() } = {}) {
  const byTask = groupByTask(readOutcomes(projectDir))
  const per = new Map()
  const stat = (agent) => {
    let s = per.get(agent)
    if (!s) {
      s = { agent, tasks: 0, approved: 0, firstPass: 0, blocked: 0, rejected: 0, abandoned: 0, conflicts: 0, attempts: 0, lastActive: 0 }
      per.set(agent, s)
    }
    return s
  }
  for (const [, r] of byTask) {
    const evx = r.events
    const s = stat(r.agent || '?')
    s.tasks++
    const maxAttempt = Math.max(1, ...evx.map((e) => e.attempt || 1))
    s.attempts += maxAttempt
    s.lastActive = Math.max(s.lastActive, ...evx.map((e) => e.ts || 0))
    const approved = evx.some((e) => e.event === 'approved')
    const everRejected = evx.some((e) => e.event === 'rejected')
    if (approved) {
      s.approved++
      if (maxAttempt === 1 && !everRejected) s.firstPass++
    }
    if (evx.some((e) => e.event === 'reported' && e.report === 'blocked')) s.blocked++
    if (everRejected) s.rejected++
    if (evx.some((e) => e.event === 'abandoned')) s.abandoned++
    if (evx.some((e) => e.event === 'merge_conflict')) s.conflicts++
  }
  return [...per.values()]
    .map((s) => ({
      agent: s.agent,
      tasksAttempted: s.tasks,
      approved: s.approved,
      approvalRate: s.tasks ? +(s.approved / s.tasks).toFixed(2) : 0,
      firstPassApprovalRate: s.tasks ? +(s.firstPass / s.tasks).toFixed(2) : 0,
      avgAttempts: s.tasks ? +(s.attempts / s.tasks).toFixed(2) : 0,
      blocked: s.blocked,
      evidenceGateRejections: s.rejected,
      mergeConflicts: s.conflicts,
      abandoned: s.abandoned,
      lastActiveRelative: relFr(s.lastActive, now),
    }))
    .sort((a, b) => b.tasksAttempted - a.tasksAttempted)
}

/** MÉTRIQUES ÉQUIPE — KPIs globaux du manager (débit, re-dispatch, conflits, taux d'approbation). */
export function teamMetrics(projectDir, { now = Date.now() } = {}) {
  const evs = readOutcomes(projectDir)
  const count = (ev) => evs.filter((e) => e.event === ev).length
  const distinctTasks = new Set(evs.filter((e) => e.taskId).map((e) => e.taskId)).size
  const reDispatches = evs.filter((e) => e.event === 'assigned' && e.fresh === false).length
  const approved = count('approved')
  return {
    totalEvents: evs.length,
    distinctTasks,
    assigned: count('assigned'),
    reDispatches,
    approved,
    approvalRate: distinctTasks ? +(approved / distinctTasks).toFixed(2) : 0,
    reDispatchRate: distinctTasks ? +(reDispatches / distinctTasks).toFixed(2) : 0,
    blockedReports: evs.filter((e) => e.event === 'reported' && e.report === 'blocked').length,
    evidenceGateRejections: count('rejected'),
    mergeConflicts: count('merge_conflict'),
    mergeDeferred: count('merge_deferred'),
    cancelled: count('cancelled'),
    abandoned: count('abandoned'),
    workers: workerScorecards(projectDir, { now }).length,
  }
}
