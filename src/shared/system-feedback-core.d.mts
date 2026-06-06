// Types pour system-feedback-core.mjs (cœur partagé du store GLOBAL de feedback système). L'implémentation est
// en JS pur (.mjs) pour être importable par le serveur MCP standalone ; ce .d.mts donne les types côté
// TypeScript (system-feedback.ipc.ts).
import type { SystemFeedbackReport, SystemFeedbackFilter, SystemFeedbackStatus } from './types'

export function feedbackDir(): string
export function reportsPath(): string
export function genId(): string

/** Input d'écriture : enums tolérés en `string` (validés en amont par le schéma Zod de l'outil MCP). */
export interface SystemFeedbackInput {
  workspace: string
  workspacePath?: string
  agent: string
  category: string
  severity: string
  title: string
  exactError: string
  hypothesizedCause: string
  relevantData?: string
  suggestedFix?: string
  status?: string
  id?: string
  ts?: number
}

export function appendReport(record: SystemFeedbackInput): Promise<SystemFeedbackReport | null>
export function listReports(filter?: SystemFeedbackFilter): Promise<SystemFeedbackReport[]>
export function updateReportStatus(
  id: string,
  status: SystemFeedbackStatus,
  note?: string,
  reviewedAt?: number,
): Promise<boolean>
