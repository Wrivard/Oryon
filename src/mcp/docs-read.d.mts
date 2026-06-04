// Types pour docs-read.mjs (cœur LECTURE Oryon Docs, recherche lexicale $0). L'implémentation est en JS pur
// (.mjs) pour le serveur MCP standalone ; ce .d.mts donne les types côté TypeScript (docs.ipc.ts, qui réutilise
// la MÊME recherche que les outils MCP). Fonctions SYNCHRONES (readFileSync en-process). Jumeau d'archive-read.

/** Ligne d'index.ndjson renvoyée par listDocs. */
export interface DocListEntry {
  slug: string
  title: string
  sourceUrl: string
  origin: string
  fetchedAt: number
  contentHash: string
  pageCount: number
  chunkCount: number
  tags: string[]
  description: string
}
export function listDocs(opts?: { tag?: string }): DocListEntry[]

/** Résultat de recherche LEAN (SPEC-A, top-k sections, snippet ±200 chars code-fence-safe) : pas de title (= fin du breadcrumb) ni sourceUrl (cf. fetchSection). */
export interface DocSearchHit {
  docSlug: string
  breadcrumb: string
  anchor: string
  snippet: string
  chunkId: number
  score: number
}
export function searchDocs(opts?: { query?: string; docSlug?: string; tag?: string; limit?: number }): DocSearchHit[]

export function fetchSection(opts?: { docSlug?: string; anchor?: string; maxChars?: number }):
  | { docSlug: string; title: string; breadcrumb: string; sourceUrl: string; markdown: string }
  | { error: string }
