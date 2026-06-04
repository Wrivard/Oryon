// Oryon Docs — CŒUR PARTAGÉ (côté ÉCRITURE), sans Electron (FS + path + os uniquement). Jumeau de
// memory-core.mjs : le process principal l'importe pour écrire le store de doc tierce ; la LECTURE (serveur
// MCP) vit dans src/mcp/docs-read.mjs (Node pur, autonome). Store GLOBAL (toutes apps) sous
// ~/.oryon/docs/, calculé par os.homedir() — AUCUN env à câbler, même chemin que côté MCP. Layout :
//   ~/.oryon/docs/index.ndjson          — 1 ligne/docSet (rebuild atomique self-healing depuis les meta.json)
//   ~/.oryon/docs/<slug>/source.md       — markdown complet nettoyé (viewer / lecture section entière)
//   ~/.oryon/docs/<slug>/meta.json       — mêmes champs que la ligne d'index (source de vérité par docSet)
//   ~/.oryon/docs/<slug>/chunks.ndjson   — 1 ligne/section (unité de retrieval)
// Concurrence multi-agents : écritures atomiques (tmp + rename-retry EPERM/EBUSY, copiés de memory-core qui
// les garde privés). Chunking offline regex, heading-aware, code-fence-safe — $0, zéro dép npm, zéro Claude.
import { promises as fs, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { safeName } from './memory-core.mjs'

const MAX_CHUNK_CHARS = 8000 // cap de sous-split d'une section (jamais coupé à l'intérieur d'un bloc code)
const MERGE_MIN_CHARS = 300 // sous ce seuil de corps, une section est fusionnée dans la précédente (anti mini-chunks)

// ── Atomicité (MIRROIR de memory-core.mjs, qui garde renameRetry/writeAtomic privés ; on ne le modifie pas). ──
// Sous Windows (MoveFileEx), fs.rename ÉCHOUE (EPERM/EBUSY) si un autre process a la destination ouverte en
// lecture — fréquent quand plusieurs agents lisent le même docSet pendant qu'un autre écrit. On retente.
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
/** Écriture atomique (temp + rename-retry) : un lecteur ne voit jamais un fichier à moitié écrit. */
async function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`
  await fs.writeFile(tmp, content, 'utf8')
  await renameRetry(tmp, path)
}

/** Dossier du store GLOBAL de docs (toutes apps). mkdir récursif (best-effort) puis renvoie le chemin. */
export function docsDir() {
  const dir = join(homedir(), '.oryon', 'docs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* best-effort : les writers mkdir leur sous-dossier de toute façon */
  }
  return dir
}

const docSetDir = (slug) => join(docsDir(), safeName(slug))
const indexPath = () => join(docsDir(), 'index.ndjson')

/** Slug d'un titre : minuscules, non-alphanum → '-', bords nettoyés, puis safeName (Windows-safe, cap 120). */
export function slugFor(title) {
  const base = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  return safeName(base || 'doc')
}

// ── Chunking (offline, regex, fence-aware, $0). ──────────────────────────────────────────────────────────
const HEAD_RE = /^(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/ // H1/H2/H3 ATX (ferme les # de fin façon GitHub)
const FENCE_RE = /^[ \t]*```/ // ligne ouvrant/fermant un bloc code triple-backtick
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'via', 'you', 'your'])

/** Retire les liens markdown [texte](url) du texte d'un heading → garde « texte ». Sinon l'URL polluerait
 *  title/breadcrumb/anchor/tags (ancres « configuration-valueshttps… », tags « https/docs/sentry », ~60 % des chunks Sentry). */
function stripMdLinks(s) {
  return String(s).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
}

/** Ancre slug-GitHub d'un heading (minuscule, ponctuation retirée, espaces → '-'). */
function githubSlug(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Ancre unique au sein d'un docSet (dédup style github-slugger : base, base-1, base-2…). */
function uniqueAnchor(seen, base0) {
  const base = base0 || 'section'
  if (!seen.has(base)) {
    seen.set(base, 0)
    return base
  }
  const n = seen.get(base) + 1
  seen.set(base, n)
  return `${base}-${n}`
}

/** Tokens d'un texte (mots ≥ 3, hors stopwords), dédupliqués — alimente les tags d'une section. */
function tokenize(s) {
  return [...new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))]
}

/**
 * Sous-split une section dont le texte dépasse `cap`, SANS jamais couper à l'intérieur d'un bloc code ```.
 * Coupe uniquement à des frontières de ligne, hors fence. Un bloc code plus gros que `cap` reste entier.
 */
function splitOnCap(text, cap) {
  const lines = text.split('\n')
  const out = []
  let buf = []
  let len = 0
  let inFence = false
  for (const line of lines) {
    const lineLen = line.length + 1
    if (len > 0 && !inFence && len + lineLen > cap) {
      out.push(buf.join('\n'))
      buf = []
      len = 0
    }
    buf.push(line)
    len += lineLen
    if (FENCE_RE.test(line)) inFence = !inFence
  }
  if (buf.length) out.push(buf.join('\n'))
  return out.length ? out : ['']
}

/**
 * Découpe un markdown en sections par heading H1/H2 SEULEMENT (fence-aware : un « # » dans un bloc code n'est PAS
 * un heading ; un H3 reste du CORPS de sa section parente). Les liens markdown d'un heading sont réduits à leur
 * texte. Chaque section : { title, breadcrumb ('H1 > H2'), anchor (slug GitHub), text, charLen, tags }. Une section
 * dont le corps fait < ~300 chars est fusionnée dans la précédente ; les sections > ~8000 chars sont sous-splittées
 * sans couper un bloc code (chaque sous-morceau garde le même title/breadcrumb/anchor). opts: { sourceUrl, baseTags }.
 */
export function chunkMarkdown(md, opts = {}) {
  const { sourceUrl = '', baseTags = [] } = opts
  const lines = String(md || '').split('\n')
  const stack = [null, null, null] // index 1..2 = H1/H2 courants (les H3 ne créent plus de section)
  const seenAnchors = new Map()
  const sections = []
  let current = null
  let inFence = false

  const flush = () => {
    if (current && current.lines.join('\n').trim()) {
      const text = current.lines.join('\n').replace(/[ \t\r\n]+$/, '')
      sections.push({ title: current.title, breadcrumb: current.breadcrumb, anchor: current.anchor, text, tags: current.tags })
    }
  }

  for (const line of lines) {
    const fence = FENCE_RE.test(line)
    if (!inFence && !fence) {
      const h = HEAD_RE.exec(line)
      if (h && h[1].length <= 2) {
        // H1/H2 = frontière de section ; un H3 (level 3) n'en crée pas → il retombe comme corps de la section courante.
        flush()
        const level = h[1].length
        const title = stripMdLinks(h[2])
        stack[level] = title
        for (let l = level + 1; l <= 2; l++) stack[l] = null
        const breadcrumb = [stack[1], stack[2]].filter((x, i) => i < level && x).join(' > ')
        const anchor = uniqueAnchor(seenAnchors, githubSlug(title))
        const tags = [...new Set([...baseTags.map((t) => String(t)), ...tokenize(breadcrumb)])]
        current = { title, breadcrumb, anchor, tags, lines: [line] }
        continue
      }
    }
    if (!current) {
      // Préambule (texte avant tout heading) : section sans titre pour ne perdre aucun contenu.
      const anchor = uniqueAnchor(seenAnchors, 'overview')
      current = { title: '', breadcrumb: '', anchor, tags: [...new Set(baseTags.map((t) => String(t)))], lines: [] }
    }
    current.lines.push(line)
    if (fence) inFence = !inFence
  }
  flush()

  // Fusion des mini-sections (corps < MERGE_MIN_CHARS) dans la précédente : supprime les chunks isolés (ex. un
  // « ### Parameters » d'une ligne, ou une section H2 quasi vide). Le texte n'est jamais perdu — il rejoint la
  // section précédente (sœur/parent), qui garde son title/breadcrumb/anchor.
  const merged = []
  for (const s of sections) {
    const prev = merged[merged.length - 1]
    if (prev && s.text.trim().length < MERGE_MIN_CHARS) {
      prev.text = `${prev.text}\n\n${s.text}`.replace(/[ \t\r\n]+$/, '')
      prev.tags = [...new Set([...prev.tags, ...s.tags])]
    } else {
      merged.push({ ...s })
    }
  }

  // Sous-split code-fence-safe → liste plate de chunks (sourceUrl stampé pour le multi-pages éventuel).
  const chunks = []
  for (const s of merged) {
    for (const text of splitOnCap(s.text, MAX_CHUNK_CHARS)) {
      chunks.push({ title: s.title, breadcrumb: s.breadcrumb, anchor: s.anchor, text, charLen: text.length, tags: s.tags, sourceUrl })
    }
  }
  return chunks
}

// ── Écriture / index. ────────────────────────────────────────────────────────────────────────────────────
const INDEX_FIELDS = ['slug', 'title', 'sourceUrl', 'origin', 'fetchedAt', 'contentHash', 'pageCount', 'chunkCount', 'tags', 'description']

/** Projette une meta sur les champs de la ligne d'index (mêmes champs, ordre stable). */
function indexLineOf(meta) {
  const o = {}
  for (const k of INDEX_FIELDS) o[k] = meta[k]
  return o
}

/**
 * Écrit ATOMIQUEMENT un docSet : <slug>/source.md, <slug>/meta.json, <slug>/chunks.ndjson, puis rebuildIndex().
 * { slug, title, sourceUrl, origin, tags, description, sourceMarkdown, chunks, pageCount? }.
 */
export async function writeDocSet({ slug, title, sourceUrl, origin, tags, description, sourceMarkdown, chunks, pageCount } = {}) {
  const s = safeName(slug || slugFor(title))
  const folder = docSetDir(s)
  await fs.mkdir(folder, { recursive: true }).catch(() => {})

  const records = (chunks || []).map((c, i) => ({
    docSlug: s,
    chunkId: i,
    title: c.title || '',
    breadcrumb: c.breadcrumb || '',
    anchor: c.anchor || '',
    tags: Array.isArray(c.tags) ? c.tags : [],
    sourceUrl: c.sourceUrl || sourceUrl || '',
    text: c.text || '',
    charLen: c.charLen != null ? c.charLen : String(c.text || '').length,
  }))

  const contentHash = createHash('sha256').update(String(sourceMarkdown || '')).digest('hex').slice(0, 16)
  const pages = pageCount != null ? pageCount : new Set(records.map((r) => r.sourceUrl).filter(Boolean)).size || 1
  const meta = {
    slug: s,
    title: title || s,
    sourceUrl: sourceUrl || '',
    origin: origin || 'paste',
    fetchedAt: Date.now(),
    contentHash,
    pageCount: pages,
    chunkCount: records.length,
    tags: Array.isArray(tags) ? tags : [],
    description: description || '',
  }

  await writeAtomic(join(folder, 'source.md'), String(sourceMarkdown || ''))
  await writeAtomic(join(folder, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  await writeAtomic(join(folder, 'chunks.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''))
  await rebuildIndex()
  return { slug: s, chunkCount: records.length, pageCount: pages }
}

/** Réécrit index.ndjson atomiquement depuis les <slug>/meta.json (self-healing : ignore les dossiers sans meta valide). */
export async function rebuildIndex() {
  const dir = docsDir()
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    entries = []
  }
  const lines = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    try {
      const meta = JSON.parse(await fs.readFile(join(dir, ent.name, 'meta.json'), 'utf8'))
      if (meta && meta.slug) lines.push(JSON.stringify(indexLineOf(meta)))
    } catch {
      /* pas de meta.json / JSON invalide : on ignore ce dossier (self-healing) */
    }
  }
  await writeAtomic(indexPath(), lines.join('\n') + (lines.length ? '\n' : ''))
  return { count: lines.length }
}

/** Lit index.ndjson → tableau de lignes. Absent/illisible → [] (lignes malformées ignorées). */
export async function readIndex() {
  let raw = ''
  try {
    raw = await fs.readFile(indexPath(), 'utf8')
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

/** Lit un docSet complet : { slug, meta, source, chunks, existed }. Fichiers absents tolérés. */
export async function readDocSet(slug) {
  const folder = docSetDir(slug)
  const read = async (f) => {
    try {
      return await fs.readFile(join(folder, f), 'utf8')
    } catch {
      return ''
    }
  }
  let meta = null
  try {
    const raw = await read('meta.json')
    meta = raw ? JSON.parse(raw) : null
  } catch {
    meta = null
  }
  const source = await read('source.md')
  const chunks = []
  for (const line of (await read('chunks.ndjson')).split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      chunks.push(JSON.parse(t))
    } catch {
      /* ligne malformée : ignorée */
    }
  }
  return { slug: safeName(slug), meta, source, chunks, existed: !!meta }
}

/** Supprime un docSet (rm récursif du dossier <slug>/) puis rebuildIndex(). Idempotent. */
export async function deleteDocSet(slug) {
  await fs.rm(docSetDir(slug), { recursive: true, force: true }).catch(() => {})
  await rebuildIndex()
  return { deleted: true }
}
