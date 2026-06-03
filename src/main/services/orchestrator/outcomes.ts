// Journal d'outcomes APPEND-ONLY (<projet>/.oryon/outcomes.ndjson) — les « dossiers RH » de la couche feedback.
// Écrit par le MAIN aux points du cycle de vie d'une task (cf. router.ts) ; LU par le serveur MCP
// (src/mcp/outcomes-read.mjs, même pattern que archive-read.mjs). Append-only car un outcome est un ÉVÉNEMENT
// IMMUABLE — le task ledger, lui, se mute en place (re-dispatch écrase, requeue écrase) → zéro historique. La
// VÉRITÉ d'un outcome = l'adjudication de l'orchestrateur (approve/green-gate), PAS l'auto-report du worker
// (biais d'optimisme : ~96% « done » sur les archives, souvent faux). $0 (FS seul), best-effort : ne casse JAMAIS
// le flux d'orchestration.
import { appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

export type OutcomeEvent =
  | 'assigned'
  | 'reported'
  | 'rejected'
  | 'approved'
  | 'merge_conflict'
  | 'merge_deferred'
  | 'cancelled'
  | 'abandoned'

export interface OutcomeRecord {
  ts: number
  event: OutcomeEvent
  taskId: string
  agent: string // terminalName — id worker DURABLE (survit au requeue qui nulle assigned_terminal_id)
  attempt?: number // 1 = dispatch frais, +1 par re-dispatch (boucle de feedback)
  title?: string
  // assigned :
  fresh?: boolean // !open (false ⇒ re-dispatch)
  files?: string[]
  worktreeSync?: string // ok | conflict | dirty | skip
  // reported / rejected :
  report?: string // done | blocked
  summary?: string
  evidence?: { ahead: number; filesChanged: number; worktreeDirty: boolean; mainDirty: boolean; empty: boolean }
  typecheck?: string // green | red | skipped | timeout
  mismatch?: string | null // divergence prose-vs-git (claimed)
  // approve / merge / verdict :
  verdict?: 'pass' | 'needs-work' | 'reject' // DÉRIVÉ de l'action de l'orchestrateur (approve/re-dispatch/cancel)
  mergeOutcome?: string // merged | conflict | deferred-…
  mergeMessage?: string
  reason?: string
}

/** Append 1 ligne JSON dans <projectPath>/.oryon/outcomes.ndjson. Best-effort : ne throw jamais. */
export function recordOutcome(projectPath: string, ev: Omit<OutcomeRecord, 'ts'> & { ts?: number }): void {
  try {
    const p = join(projectPath, '.oryon', 'outcomes.ndjson')
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify({ ...ev, ts: ev.ts ?? Date.now() }) + '\n')
  } catch {
    /* best-effort : un échec d'écriture d'outcome ne doit jamais casser l'orchestration */
  }
}
