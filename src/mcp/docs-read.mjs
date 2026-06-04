// Oryon Docs — LECTURE SEULE du store de doc tierce sous ~/.oryon/docs/ (GLOBAL, toutes apps). Pendant
// logique des outils docs du serveur MCP (src/mcp/server.mjs), comme archive-read.mjs l'est pour l'archive et
// memory-core.mjs pour la mémoire. L'ÉCRITURE vit dans src/shared/docs-core.mjs — ici on ne fait QUE lire :
// pur FS, AUCUNE dépendance npm, AUCUN appel Claude (coût $0), AUCUN import de docs-core (on recalcule docsDir
// via os.homedir, exactement comme archive-read est autonome). Recherche lexicale pure (scoring copié de
// memory-core.searchMemories), $0, instantanée en-process (le serveur MCP Node pur ne peut pas ouvrir le
// better-sqlite3 ABI-Electron). Layout (cf. docs-core.mjs) :
//   ~/.oryon/docs/index.ndjson          — 1 ligne/docSet { slug, title, sourceUrl, origin, fetchedAt,
//                                          contentHash, pageCount, chunkCount, tags[], description }
//   ~/.oryon/docs/<slug>/chunks.ndjson  — 1 ligne/section { docSlug, chunkId, title, breadcrumb, anchor,
//                                          tags[], sourceUrl, text, charLen }
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SNIPPET_RADIUS = 200 // ± chars autour du 1er hit dans un snippet

const docsDir = () => join(homedir(), '.oryon', 'docs')
const indexPath = () => join(docsDir(), 'index.ndjson')
/** Slug sûr pour construire un chemin (les slugs de l'index sont déjà propres ; on bloque juste la traversée). */
const safeSlug = (s) => String(s || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 140) || 'doc'
const chunksPath = (slug) => join(docsDir(), safeSlug(slug), 'chunks.ndjson')

/** Lit un .ndjson → tableau d'objets. Absent/illisible → [] (lignes malformées ignorées, try/catch par ligne). */
function readNdjson(path) {
  let raw
  try {
    raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
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
      /* ligne malformée : ignorée */
    }
  }
  return out
}

/** Plages [start,end) des blocs code triple-backtick (fence non fermée → jusqu'à la fin). Sert au fence-safe. */
function fenceRanges(text) {
  const ranges = []
  let offset = 0
  let open = -1
  for (const line of text.split('\n')) {
    if (/^[ \t]*```/.test(line)) {
      if (open < 0) open = offset
      else {
        ranges.push({ start: open, end: offset + line.length })
        open = -1
      }
    }
    offset += line.length + 1
  }
  if (open >= 0) ranges.push({ start: open, end: text.length })
  return ranges
}

/** Termes de recherche : query minuscule, whitespace-split, non vides (substring → pas d'opérateur FTS à casser). */
function sanitizeTerms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Score d'un chunk vs termes — algo de memory-core.searchMemories : titre +10 / breadcrumb+tags +5 /
 *  corps +3 + bonus fréquence min(6,count), sommé par terme (substring insensible à la casse). */
function scoreChunk(c, terms) {
  const title = String(c.title || '').toLowerCase()
  const meta = (String(c.breadcrumb || '') + ' ' + (Array.isArray(c.tags) ? c.tags.join(' ') : '')).toLowerCase()
  const text = String(c.text || '').toLowerCase()
  let score = 0
  for (const term of terms) {
    if (title.includes(term)) score += 10
    if (meta.includes(term)) score += 5
    if (text.includes(term)) score += 3 + Math.min(6, text.split(term).length - 1)
  }
  return score
}

/** Index du 1er hit (n'importe quel terme) dans un texte. { idx:-1 } si aucun. */
function firstHit(text, terms) {
  const lower = text.toLowerCase()
  let idx = -1
  let len = 0
  for (const term of terms) {
    const i = lower.indexOf(term)
    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i
      len = term.length
    }
  }
  return { idx, len }
}

/** Snippet ±200 chars autour du 1er hit, JAMAIS coupé dans un bloc code (la fenêtre s'étend aux frontières du fence). */
function snippetFor(text, terms) {
  const t = String(text || '')
  if (!t) return ''
  const { idx, len } = firstHit(t, terms)
  let start = idx < 0 ? 0 : Math.max(0, idx - SNIPPET_RADIUS)
  let end = idx < 0 ? Math.min(t.length, SNIPPET_RADIUS * 2) : Math.min(t.length, idx + len + SNIPPET_RADIUS)
  for (const f of fenceRanges(t)) {
    if (start > f.start && start < f.end) start = f.start // fenêtre démarre DANS un fence → étend à son ouverture
    if (end > f.start && end < f.end) end = f.end // fenêtre finit DANS un fence → étend à sa fermeture
  }
  let snip = t.slice(start, end).trim()
  if (start > 0) snip = '…' + snip
  if (end < t.length) snip = snip + '…'
  return snip
}

/** Tronque un markdown à `cap` sans couper dans un bloc code (coupe avant le fence, à une frontière de ligne). */
function truncateNoFence(text, cap) {
  if (text.length <= cap) return text
  let cut = cap
  for (const f of fenceRanges(text)) {
    if (cut > f.start && cut < f.end) {
      cut = f.start
      break
    }
  }
  let s = text.slice(0, cut)
  const nl = s.lastIndexOf('\n')
  if (nl > cap * 0.5) s = s.slice(0, nl)
  return s.replace(/[ \t\r\n]+$/, '') + '\n…[tronqué]'
}

/** Liste les docSets importés (lit index.ndjson), récents d'abord. opts: { tag? } (filtre tag insensible casse). */
export function listDocs({ tag } = {}) {
  let docs = readNdjson(indexPath())
  if (tag) {
    const t = String(tag).toLowerCase()
    docs = docs.filter((d) => Array.isArray(d.tags) && d.tags.some((x) => String(x).toLowerCase() === t))
  }
  return docs.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))
}

/**
 * Recherche lexicale top-k sur les sections. opts: { query, docSlug?, tag?, limit=8 }. Scanne tous les
 * chunks.ndjson (ou un seul docSet si docSlug ; restreint aux docSets taggés si tag), score façon
 * searchMemories. Renvoie [{ docSlug, title, breadcrumb, anchor, sourceUrl, snippet, chunkId, score }].
 */
export function searchDocs({ query, docSlug, tag, limit = 8 } = {}) {
  const terms = sanitizeTerms(query)
  if (!terms.length) return []
  const slugs = docSlug ? [String(docSlug)] : listDocs({ tag }).map((d) => d.slug).filter(Boolean)
  const results = []
  for (const slug of slugs) {
    for (const c of readNdjson(chunksPath(slug))) {
      const score = scoreChunk(c, terms)
      if (score <= 0) continue
      results.push({
        docSlug: c.docSlug || slug,
        title: c.title || '',
        breadcrumb: c.breadcrumb || '',
        anchor: c.anchor || '',
        sourceUrl: c.sourceUrl || '',
        snippet: snippetFor(c.text, terms),
        chunkId: c.chunkId,
        score,
      })
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit))
}

/**
 * Markdown complet d'UNE section. opts: { docSlug, anchor, maxChars=12000 }. Joint les chunks de même anchor
 * (= même heading, incl. sous-morceaux), ordre chunkId, tronqué à maxChars sans couper un fence.
 * Renvoie { docSlug, title, breadcrumb, sourceUrl, markdown } ou { error }.
 */
export function fetchSection({ docSlug, anchor, maxChars = 12000 } = {}) {
  if (!docSlug || !anchor) return { error: 'docSlug et anchor requis' }
  const matching = readNdjson(chunksPath(docSlug)).filter((c) => c.anchor === anchor)
  if (!matching.length) return { error: `Section introuvable (docSlug="${docSlug}", anchor="${anchor}"). Vérifie via search_docs.` }
  matching.sort((a, b) => (a.chunkId || 0) - (b.chunkId || 0))
  const first = matching[0]
  const markdown = truncateNoFence(matching.map((c) => c.text).join('\n'), Math.max(1, maxChars))
  return { docSlug: String(docSlug), title: first.title || '', breadcrumb: first.breadcrumb || '', sourceUrl: first.sourceUrl || '', markdown }
}
