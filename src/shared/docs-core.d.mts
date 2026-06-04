// Types pour docs-core.mjs (cœur partagé Oryon Docs, côté ÉCRITURE/store). L'implémentation est en JS pur
// (.mjs) pour être importable par le serveur MCP standalone ; ce .d.mts donne les types côté TypeScript
// (docs-import.ts, docs.ipc.ts). Jumeau de memory-core.d.mts.

/** Section indexable produite par chunkMarkdown (avant écriture : pas encore de docSlug/chunkId). */
export interface DocChunk {
  title: string
  breadcrumb: string
  anchor: string
  text: string
  charLen: number
  tags: string[]
  sourceUrl: string
}

/** Section telle que persistée dans <slug>/chunks.ndjson (1 ligne = 1 record). */
export interface DocChunkRecord {
  docSlug: string
  chunkId: number
  title: string
  breadcrumb: string
  anchor: string
  tags: string[]
  sourceUrl: string
  text: string
  charLen: number
}

/** meta.json d'un docSet (= ligne d'index.ndjson). */
export interface DocMeta {
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

export function docsDir(): string
export function slugFor(title: string): string
export function chunkMarkdown(md: string, opts?: { sourceUrl?: string; baseTags?: string[] }): DocChunk[]

export function writeDocSet(args?: {
  slug?: string
  title?: string
  sourceUrl?: string
  origin?: string
  tags?: string[]
  description?: string
  sourceMarkdown?: string
  chunks?: DocChunk[]
  pageCount?: number
}): Promise<{ slug: string; chunkCount: number; pageCount: number }>

export function rebuildIndex(): Promise<{ count: number }>
export function readIndex(): Promise<DocMeta[]>
export function readDocSet(slug: string): Promise<{
  slug: string
  meta: DocMeta | null
  source: string
  chunks: DocChunkRecord[]
  existed: boolean
}>
export function deleteDocSet(slug: string): Promise<{ deleted: boolean }>
