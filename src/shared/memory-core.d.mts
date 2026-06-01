// Types pour memory-core.mjs (cœur partagé Oryon Memory). L'implémentation est en JS pur (.mjs) pour être
// importable par le serveur MCP standalone ; ce .d.ts donne les types côté TypeScript (memory.ipc.ts).
import type { MemoryNote, MemoryGraph } from './types'

export function safeName(name: string): string
export function memDir(projectDir: string): string
export function linkKey(s: string): string
export function parseLinks(content: string): string[]
export function titleOf(content: string, name: string): string
export function excerptOf(content: string): string

export interface MemoryNoteWithBody extends MemoryNote {
  body: string
}
export function loadAll(projectDir: string): Promise<MemoryNoteWithBody[]>
export function listMemories(projectDir: string): Promise<MemoryNote[]>

export interface MemoryReadResult {
  name: string
  title: string
  content: string
  links: string[]
  updated: number
  existed: boolean
}
export function readMemory(projectDir: string, name: string): Promise<MemoryReadResult>

export interface MemorySearchHit {
  name: string
  title: string
  excerpt: string
  score: number
}
export function searchMemories(projectDir: string, query: string, limit?: number): Promise<MemorySearchHit[]>

export interface MemoryWriteResult {
  name?: string
  updated?: number
  existed?: boolean
  conflict?: boolean
  current?: string
}
export function writeMemory(
  projectDir: string,
  name: string,
  content: string,
  opts?: { expectedUpdated?: number },
): Promise<MemoryWriteResult>
export function appendMemory(
  projectDir: string,
  name: string,
  content: string,
  opts?: { author?: string; role?: string; ts?: string },
): Promise<{ name: string; updated: number; existed: boolean }>
export function createMemory(
  projectDir: string,
  name: string,
  content: string,
  opts?: { author?: string; role?: string },
): Promise<{ name: string; existed: boolean }>
export function deleteMemory(projectDir: string, name: string): Promise<{ deleted: boolean }>
export function buildGraph(projectDir: string): Promise<MemoryGraph>
export function findBacklinks(projectDir: string, name: string): Promise<{ name: string; title: string }[]>
export function getLinks(projectDir: string, name: string): Promise<{ outgoing: string[]; unresolved: string[] }>
export function suggestConnections(
  projectDir: string,
  name: string,
  limit?: number,
): Promise<{ name: string; title: string; sharedLinks: number; score: number }[]>
export function renameMemory(projectDir: string, oldName: string, newName: string): Promise<{ name: string }>
export function findProjectDir(startCwd: string): Promise<string>

// ---- Claims (réservation de fichiers par agent, coordination anti-conflit) ----
export interface FileClaim {
  agent: string
  uuid: string
  ts: number
}
export function readClaims(projectDir: string): Promise<Record<string, FileClaim>>
export function claimFile(
  projectDir: string,
  filepath: string,
  agentName: string,
  opts?: { uuid?: string },
): Promise<{ conflict: boolean; owner?: string; uuid: string }>
export function releaseClaim(projectDir: string, filepath: string): Promise<{ released: boolean }>
export function releaseClaimsByAgent(projectDir: string, agentName: string): Promise<{ released: number }>
