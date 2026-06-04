// Oryon Docs (Phase 3) — INGESTION de doc tierce, $0 (zéro appel Claude). Récupère le markdown d'un outil
// (Sentry, Stripe, Mintlify…) puis délègue le découpage + l'écriture atomique au cœur partagé docs-core.mjs
// (FROZEN ici : on ne l'édite pas). Tiers, du plus propre au plus large :
//   1. llms.txt           — sonde <origin>/llms.txt (+ en-têtes X-Llms-Txt/Link + /.well-known/llms.txt),
//                           fetch chaque page liée en markdown (la plupart des docs servent du .md propre).
//   2. page markdown       — <url> en Accept: text/markdown, sinon <url>.md (page unique native markdown).
//   3. llms-full.txt       — <origin>/llms-full.txt (doc entière en un blob → chunké, jamais injecté entier).
//   4. crawl sitemap       — <origin>/sitemap.xml borné (≤300 pages, 10 Mo/page, 15 s/page, dédup canonique)
//                           + turndown (HTML→MD). Erreurs PAR PAGE remontées (jamais silencieuses).
// Une seule dép runtime : `turndown` (pure-JS). Le chunking/anchors/écriture vivent dans docs-core.mjs ; ici on
// ne fait QUE fetcher + assembler. La progression est poussée via le callback onProgress (l'IPC la rediffuse au
// renderer pour la vue progression du panneau Docs).

import TurndownService from 'turndown'
import * as core from '../../shared/docs-core.mjs'

const PAGE_TIMEOUT_MS = 15_000 // timeout par page (fetch)
const MAX_PAGE_BYTES = 10 * 1024 * 1024 // plafond par page (10 Mo)
const MAX_CRAWL_PAGES = 300 // plafond de pages crawlées via sitemap
const CRAWL_CONCURRENCY = 5 // pages crawlées en parallèle (politesse + débit)
const LLMS_CONCURRENCY = 6 // pages llms.txt fetchées en parallèle
const MAX_SITEMAP_NESTED = 25 // sitemaps enfants suivis dans un sitemap-index
const UA = 'OryonDocs/1.0 (+https://github.com/Wrivard/Oryon)'

export type DocOrigin = 'llmstxt' | 'md' | 'llms-full' | 'sitemap' | 'paste'
export interface DocsImportArgs {
  url?: string
  markdown?: string
  label?: string
}
export interface ImportError {
  url: string
  error: string
}
/** État poussé pendant l'import (vue progression du panneau). `page`/`total` cadencent le crawl/multi-pages. */
export interface DocsImportProgress {
  phase: 'probe' | 'index-found' | 'crawl' | 'fetch' | 'chunk' | 'done' | 'error'
  message: string
  page?: number
  total?: number
  title?: string
  url?: string
  error?: string
}
export interface DocsImportResult {
  slug: string
  title: string
  origin: DocOrigin
  chunkCount: number
  pageCount: number
  errors: ImportError[]
}

type Emit = (p: DocsImportProgress) => void
/** Forme d'un chunk renvoyé par docs-core.chunkMarkdown (typé localement : docs-core est du JS non typé). */
interface Chunk {
  title: string
  breadcrumb: string
  anchor: string
  text: string
  charLen: number
  tags: string[]
  sourceUrl: string
}
interface FetchedPage {
  url: string
  title: string
  markdown: string
  chunks: Chunk[]
}
interface FetchResult {
  ok: boolean
  status: number
  text: string
  contentType: string
  headers: Headers
  finalUrl: string
}

// ── HTTP borné ───────────────────────────────────────────────────────────────────────────────────────────
/**
 * Lit le corps en STREAMING, plafonné en OCTETS (et non en code-units UTF-16) : on accumule les octets et on
 * ABORT dès le dépassement du cap — au lieu de `res.text()` qui matérialise tout le corps en mémoire avant de
 * slicer (un serveur sans content-length pouvait livrer un corps géant). Le slice par `.length` mécomptait aussi
 * les octets (un caractère multi-octets = 1 code-unit mais 2-4 octets). Repli sur text() si pas de ReadableStream.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body
  if (!body) {
    const t = await res.text()
    const bytes = new TextEncoder().encode(t)
    return bytes.length > maxBytes ? new TextDecoder('utf-8').decode(bytes.subarray(0, maxBytes)) : t
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let kept = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      const remaining = maxBytes - kept
      if (value.length >= remaining) {
        chunks.push(value.subarray(0, remaining))
        kept += remaining
        await reader.cancel().catch(() => {}) // dépassement du cap → abort du reste du flux
        break
      }
      chunks.push(value)
      kept += value.length
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* déjà relâché (cancel) */
    }
  }
  const merged = new Uint8Array(kept)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.length
  }
  return new TextDecoder('utf-8').decode(merged)
}
/** Fetch texte avec timeout + plafond d'octets. Lève sur abort/réseau ; l'appelant filtre via res.ok. */
async function fetchText(
  url: string,
  accept: string,
  timeoutMs = PAGE_TIMEOUT_MS,
  maxBytes = MAX_PAGE_BYTES,
): Promise<FetchResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { Accept: accept, 'User-Agent': UA } })
    const contentType = res.headers.get('content-type') || ''
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared && declared > maxBytes) {
      return { ok: false, status: res.status, text: '', contentType, headers: res.headers, finalUrl: res.url || url }
    }
    const text = res.ok ? await readBodyCapped(res, maxBytes) : ''
    return { ok: res.ok, status: res.status, text, contentType, headers: res.headers, finalUrl: res.url || url }
  } finally {
    clearTimeout(timer)
  }
}
/** fetchText qui ne lève jamais (timeout/réseau → null) — pour les sondes best-effort. */
async function safeFetch(url: string, accept: string): Promise<FetchResult | null> {
  try {
    return await fetchText(url, accept)
  } catch {
    return null
  }
}

// ── Détection de format ──────────────────────────────────────────────────────────────────────────────────
function looksLikeHtml(contentType: string, text: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true
  const head = text.slice(0, 400).toLowerCase()
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<div[\s>]|<script[\s>]/.test(head)
}
function isMarkdownResponse(r: FetchResult): boolean {
  return /text\/(markdown|x-markdown|plain)/i.test(r.contentType) && !looksLikeHtml('', r.text)
}

// ── Petits utilitaires d'URL / texte ─────────────────────────────────────────────────────────────────────
function absolutize(href: string, base: string): string {
  try {
    const u = new URL(href, base)
    return /^https?:$/.test(u.protocol) ? u.toString() : ''
  } catch {
    return ''
  }
}
/** Variante .md d'une URL (page.md) — beaucoup de générateurs (Mintlify, Docusaurus) servent la version markdown. */
function appendMd(u: string): string {
  try {
    const x = new URL(u)
    if (/\.(md|mdx|txt)$/i.test(x.pathname)) return u
    x.pathname = x.pathname.replace(/\/+$/, '').replace(/\.html?$/i, '') + '.md'
    x.search = ''
    x.hash = ''
    return x.toString()
  } catch {
    return u
  }
}
function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}
/** Titre humain depuis le dernier segment de chemin (« getting-started » → « Getting started »). */
function pathTitle(u: string): string {
  try {
    const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || ''
    const t = seg.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim()
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''
  } catch {
    return ''
  }
}
/** 1er titre H1 (`# …`) dans les ~80 premières lignes ; '' si aucun. */
function firstH1(md: string): string {
  const lines = md.split('\n')
  for (let i = 0; i < Math.min(lines.length, 80); i++) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(lines[i])
    if (m) return m[1].trim()
  }
  return ''
}
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x2[fF];/g, '/')
}
/** URLs llms.txt annoncées par en-tête Link (rel contenant « llms »). */
function parseLinkHeader(headers: Headers | null | undefined): string[] {
  const h = headers?.get('link')
  if (!h) return []
  const out: string[] = []
  for (const part of h.split(',')) {
    if (!/rel\s*=\s*"?[^"]*llms/i.test(part)) continue
    const m = /<([^>]+)>/.exec(part)
    if (m) out.push(m[1].trim())
  }
  return out
}

// ── HTML → Markdown (tier crawl + repli des liens llms.txt en HTML) ───────────────────────────────────────
/** Isole le contenu utile (<article> puis <main> puis <body>) pour réduire le boilerplate (nav/footer). */
function extractMainContent(html: string): string {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)
  if (article && article[1].trim().length > 200) return article[1]
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)
  if (main && main[1].trim().length > 200) return main[1]
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  return body ? body[1] : html
}
let _td: TurndownService | null = null
function htmlToMarkdown(html: string): string {
  if (!_td) {
    _td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', hr: '---' })
    _td.remove(['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 'form', 'iframe', 'button'])
  }
  try {
    return _td.turndown(extractMainContent(html)).trim()
  } catch {
    return ''
  }
}
/** Récupère une page liée en markdown : direct (Accept md), sinon .md, sinon conversion HTML→MD en dernier recours. */
async function fetchAsMarkdown(url: string): Promise<{ markdown: string; finalUrl: string } | { error: string }> {
  const r = await safeFetch(url, 'text/markdown, text/plain, text/html;q=0.8')
  if (r?.ok && r.text && !looksLikeHtml(r.contentType, r.text)) return { markdown: r.text, finalUrl: r.finalUrl }
  const mdUrl = appendMd(url)
  if (mdUrl !== url) {
    const r2 = await safeFetch(mdUrl, 'text/markdown, text/plain')
    if (r2?.ok && r2.text && !looksLikeHtml(r2.contentType, r2.text)) return { markdown: r2.text, finalUrl: r2.finalUrl }
  }
  if (r?.ok && r.text) {
    const md = htmlToMarkdown(r.text)
    if (md) return { markdown: md, finalUrl: r.finalUrl }
  }
  return { error: r ? (r.ok ? 'contenu vide' : `HTTP ${r.status}`) : 'timeout/réseau' }
}

// ── llms.txt ─────────────────────────────────────────────────────────────────────────────────────────────
interface LlmsLink {
  title: string
  url: string
  section: string
}
interface LlmsParsed {
  title: string
  description: string
  links: LlmsLink[]
  sections: string[]
}
/** Parse un llms.txt (markdown) : H1 = titre, blockquote = description, H2 = sections, `- [t](url)` = liens. */
function parseLlmsTxt(text: string, baseUrl: string): LlmsParsed {
  let title = ''
  let description = ''
  let section = ''
  const links: LlmsLink[] = []
  const sectionSet = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const h1 = /^#\s+(.+)/.exec(line)
    if (h1) {
      if (!title) title = h1[1].trim()
      continue
    }
    const h2 = /^##\s+(.+)/.exec(line)
    if (h2) {
      section = h2[1].trim()
      sectionSet.add(section)
      continue
    }
    const bq = /^>\s?(.+)/.exec(line)
    if (bq) {
      if (!description) description = bq[1].trim()
      continue
    }
    const link = /^\s*[-*]\s*\[([^\]]+)\]\(\s*([^)\s]+)/.exec(line)
    if (link) {
      const u = absolutize(link[2], baseUrl)
      if (u) links.push({ title: link[1].trim(), url: u, section })
    }
  }
  return { title, description, links, sections: [...sectionSet] }
}

async function tryLlmsTxt(
  url: string,
  originBase: string,
  label: string,
  initial: FetchResult | null,
  emit: Emit,
): Promise<DocsImportResult | null> {
  const xll = initial?.headers.get('x-llms-txt')
  const candidates = [
    ...(xll ? [absolutize(xll, url)] : []),
    ...parseLinkHeader(initial?.headers).map((h) => absolutize(h, url)),
    `${originBase}/llms.txt`,
    `${originBase}/.well-known/llms.txt`,
  ]
  const seen = new Set<string>()
  for (const cand of candidates) {
    if (!cand || seen.has(cand)) continue
    seen.add(cand)
    const r = await safeFetch(cand, 'text/plain, text/markdown')
    if (!r?.ok || !r.text || looksLikeHtml(r.contentType, r.text)) continue
    const parsed = parseLlmsTxt(r.text, cand)
    if (!parsed.links.length) continue // pas un index llms.txt exploitable
    emit({ phase: 'index-found', message: `Index llms.txt trouvé (${parsed.links.length} pages)`, total: parsed.links.length })

    const slots: (FetchedPage | null)[] = new Array(parsed.links.length).fill(null)
    const errors: ImportError[] = []
    let done = 0
    await mapPool(parsed.links, LLMS_CONCURRENCY, async (lnk, i) => {
      const got = await fetchAsMarkdown(lnk.url)
      done++
      if ('error' in got) {
        errors.push({ url: lnk.url, error: got.error })
        emit({ phase: 'fetch', message: `Échec : ${lnk.title}`, page: done, total: parsed.links.length, url: lnk.url, error: got.error })
        return
      }
      const chunks = core.chunkMarkdown(got.markdown, { sourceUrl: got.finalUrl, baseTags: lnk.section ? [lnk.section] : [] }) as Chunk[]
      slots[i] = { url: got.finalUrl, title: lnk.title, markdown: got.markdown, chunks }
      emit({ phase: 'fetch', message: `Récupéré : ${lnk.title}`, page: done, total: parsed.links.length, title: lnk.title, url: lnk.url })
    })
    const pages = slots.filter((p): p is FetchedPage => p != null)
    if (!pages.length) continue // toutes les pages ont échoué → tier suivant
    emit({ phase: 'chunk', message: `Indexation (${pages.length} pages)…` })
    return finishMulti(
      { title: parsed.title || label || hostOf(originBase), origin: 'llmstxt', sourceUrl: cand, tags: parsed.sections, description: parsed.description, pages, errors },
      emit,
    )
  }
  return null
}

// ── Page markdown unique ─────────────────────────────────────────────────────────────────────────────────
async function tryMarkdownPage(url: string, label: string, initial: FetchResult | null, emit: Emit): Promise<DocsImportResult | null> {
  let markdown = ''
  let finalUrl = url
  if (initial?.ok && initial.text && isMarkdownResponse(initial)) {
    markdown = initial.text
    finalUrl = initial.finalUrl
  } else {
    const mdUrl = appendMd(url)
    if (mdUrl !== url) {
      const r = await safeFetch(mdUrl, 'text/markdown, text/plain')
      if (r?.ok && r.text && !looksLikeHtml(r.contentType, r.text)) {
        markdown = r.text
        finalUrl = r.finalUrl
      }
    }
  }
  if (!markdown.trim() || looksLikeHtml('', markdown)) return null
  emit({ phase: 'chunk', message: 'Indexation de la page…' })
  const chunks = core.chunkMarkdown(markdown, { sourceUrl: finalUrl, baseTags: [] }) as Chunk[]
  if (!chunks.length) return null
  return finishSingle({ title: firstH1(markdown) || label || pathTitle(url) || hostOf(url), origin: 'md', sourceUrl: finalUrl, tags: [], description: '', markdown, chunks }, emit)
}

// ── llms-full.txt ────────────────────────────────────────────────────────────────────────────────────────
async function tryLlmsFull(originBase: string, label: string, emit: Emit): Promise<DocsImportResult | null> {
  const r = await safeFetch(`${originBase}/llms-full.txt`, 'text/plain, text/markdown')
  if (!r?.ok || !r.text || r.text.length < 200 || looksLikeHtml(r.contentType, r.text)) return null
  emit({ phase: 'chunk', message: 'Découpage de llms-full.txt…' })
  const chunks = core.chunkMarkdown(r.text, { sourceUrl: r.finalUrl, baseTags: [] }) as Chunk[]
  if (!chunks.length) return null
  return finishSingle({ title: firstH1(r.text) || label || hostOf(originBase), origin: 'llms-full', sourceUrl: r.finalUrl, tags: [], description: '', markdown: r.text, chunks }, emit)
}

// ── Crawl sitemap ────────────────────────────────────────────────────────────────────────────────────────
function sameOrigin(u: string, originBase: string): boolean {
  try {
    return new URL(u).origin === originBase
  } catch {
    return false
  }
}
function isAssetUrl(u: string): boolean {
  try {
    return /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|pdf|zip|woff2?|ttf|mp4|webm)$/i.test(new URL(u).pathname)
  } catch {
    return true
  }
}
/** URL canonique pour la dédup : origine + chemin sans slash final, query/hash retirés. */
function canonicalize(u: string): string {
  try {
    const x = new URL(u)
    x.hash = ''
    x.search = ''
    const p = x.pathname.replace(/\/+$/, '') || '/'
    return `${x.origin}${p}`
  } catch {
    return u
  }
}
/** Suit un sitemap (et les sitemap-index imbriqués, bornés) → Set d'URLs de page canoniques, même origine. */
async function ingestSitemap(xml: string, originBase: string, out: Set<string>, depth: number): Promise<void> {
  if (depth > 2 || out.size >= MAX_CRAWL_PAGES) return
  const locs: string[] = []
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) locs.push(decodeEntities(m[1].trim()))
  if (/<sitemapindex[\s>]/i.test(xml)) {
    let nested = 0
    for (const loc of locs) {
      if (out.size >= MAX_CRAWL_PAGES || nested >= MAX_SITEMAP_NESTED) break
      if (!sameOrigin(loc, originBase)) continue
      nested++
      const r = await safeFetch(loc, 'application/xml, text/xml')
      if (r?.ok && r.text) await ingestSitemap(r.text, originBase, out, depth + 1)
    }
    return
  }
  for (const loc of locs) {
    if (out.size >= MAX_CRAWL_PAGES) break
    if (!sameOrigin(loc, originBase) || isAssetUrl(loc)) continue
    out.add(canonicalize(loc))
  }
}
async function collectSitemapUrls(originBase: string): Promise<string[]> {
  const out = new Set<string>()
  for (const root of [`${originBase}/sitemap.xml`, `${originBase}/sitemap_index.xml`, `${originBase}/sitemap-index.xml`]) {
    const r = await safeFetch(root, 'application/xml, text/xml')
    if (!r?.ok || !r.text) continue
    await ingestSitemap(r.text, originBase, out, 0)
    if (out.size) break
  }
  return [...out]
}

async function crawlSitemap(originBase: string, label: string, emit: Emit): Promise<DocsImportResult | null> {
  emit({ phase: 'crawl', message: 'Lecture du sitemap…' })
  const urls = await collectSitemapUrls(originBase)
  if (!urls.length) return null
  const capped = urls.slice(0, MAX_CRAWL_PAGES)
  const dropped = urls.length - capped.length
  emit({ phase: 'crawl', message: `Sitemap : ${capped.length} pages${dropped > 0 ? ` (plafonné, ${dropped} ignorées)` : ''}`, total: capped.length })

  const slots: (FetchedPage | null)[] = new Array(capped.length).fill(null)
  const errors: ImportError[] = []
  let done = 0
  await mapPool(capped, CRAWL_CONCURRENCY, async (u, i) => {
    const r = await safeFetch(u, 'text/html, application/xhtml+xml, text/markdown;q=0.8')
    done++
    if (!r?.ok || !r.text) {
      const error = r ? `HTTP ${r.status}` : 'timeout/réseau'
      errors.push({ url: u, error })
      emit({ phase: 'fetch', message: `Échec : ${pathTitle(u) || u}`, page: done, total: capped.length, url: u, error })
      return
    }
    const md = looksLikeHtml(r.contentType, r.text) ? htmlToMarkdown(r.text) : r.text
    if (!md.trim()) {
      errors.push({ url: u, error: 'contenu vide après conversion' })
      return
    }
    const title = firstH1(md) || pathTitle(u) || hostOf(u)
    const chunks = core.chunkMarkdown(md, { sourceUrl: u, baseTags: [] }) as Chunk[]
    slots[i] = { url: u, title, markdown: md, chunks }
    emit({ phase: 'fetch', message: `Récupéré : ${title}`, page: done, total: capped.length, title, url: u })
  })
  const pages = slots.filter((p): p is FetchedPage => p != null)
  if (!pages.length) return null
  emit({ phase: 'chunk', message: `Indexation (${pages.length} pages)…` })
  return finishMulti({ title: label || hostOf(originBase), origin: 'sitemap', sourceUrl: originBase, tags: [], description: '', pages, errors }, emit)
}

// ── Assemblage + écriture (via docs-core) ────────────────────────────────────────────────────────────────
/**
 * Rend les ancres uniques À TRAVERS les pages d'un même docSet (les pages d'un crawl/llms.txt sont chunkées
 * séparément → deux pages peuvent réutiliser « overview »). Sans ça, fetch_doc_section fusionnerait des sections
 * sans rapport. On préserve l'intégrité intra-section : tous les chunks d'une même ancre d'une page → même
 * nouvelle ancre.
 */
function dedupeAnchorsAcrossPages(pages: FetchedPage[]): void {
  if (pages.length <= 1) return
  const seen = new Set<string>()
  const alloc = (base0: string): string => {
    const base = base0 || 'section'
    if (!seen.has(base)) {
      seen.add(base)
      return base
    }
    let n = 1
    let cand = `${base}-${n}`
    while (seen.has(cand)) cand = `${base}-${++n}`
    seen.add(cand)
    return cand
  }
  for (const p of pages) {
    const remap = new Map<string, string>()
    for (const c of p.chunks) {
      let mapped = remap.get(c.anchor)
      if (!mapped) {
        mapped = alloc(c.anchor)
        remap.set(c.anchor, mapped)
      }
      c.anchor = mapped
    }
  }
}

// Sérialise les écritures d'un même slug (course au ré-import : 2 imports concurrents du même docSet).
const slugChain = new Map<string, Promise<unknown>>()
function withSlugLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = slugChain.get(slug) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  slugChain.set(
    slug,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

async function writeDocSet(args: {
  title: string
  origin: DocOrigin
  sourceUrl: string
  tags: string[]
  description: string
  sourceMarkdown: string
  chunks: Chunk[]
  pageCount: number
}): Promise<DocsImportResult> {
  let slug = core.slugFor(args.title) as string
  // Re-import STABLE + anti-collision (une seule lecture d'index) :
  // (1) un docSet existe DÉJÀ pour cette même source web → réutilise SON slug (écrase en place ; un changement de
  //     titre ne crée pas d'orphelin). Dédup par sourceUrl (clé stable). Pas de short-circuit contentHash : un
  //     re-import doit re-chunker (applique le nouveau chunker).
  // (2) sinon, si le slug dérivé du titre COLLISIONNE avec un AUTRE docSet (titres sluggifiant pareil : non-ASCII
  //     → "doc", ponctuation, ou paste de même titre) → désambiguïse (slug-2…) pour NE PAS écraser silencieusement
  //     l'autre docSet (sinon rebuildIndex n'en garderait qu'un → perte de données muette).
  try {
    const idx = (await core.readIndex()) as Array<{ slug?: string; sourceUrl?: string }>
    const existing = args.sourceUrl ? idx.find((e) => e.sourceUrl && e.sourceUrl === args.sourceUrl) : undefined
    if (existing?.slug) {
      slug = existing.slug
    } else {
      const taken = new Set(idx.map((e) => e.slug).filter(Boolean) as string[])
      if (taken.has(slug)) {
        let n = 2
        while (taken.has(`${slug}-${n}`)) n++
        slug = `${slug}-${n}`
      }
    }
  } catch {
    /* index illisible : on retombe sur le slug dérivé du titre */
  }
  const w = (await withSlugLock(slug, () =>
    core.writeDocSet({
      slug,
      title: args.title,
      sourceUrl: args.sourceUrl,
      origin: args.origin,
      tags: args.tags,
      description: args.description,
      sourceMarkdown: args.sourceMarkdown,
      chunks: args.chunks,
      pageCount: args.pageCount,
    }),
  )) as { slug: string; chunkCount: number; pageCount: number }
  return { slug: w.slug, title: args.title, origin: args.origin, chunkCount: w.chunkCount, pageCount: w.pageCount, errors: [] }
}

/** Écrit un docSet multi-pages (chunks per-page + source.md concaténée), ancres dédupliquées + erreurs jointes. */
async function finishMulti(
  p: { title: string; origin: DocOrigin; sourceUrl: string; tags: string[]; description: string; pages: FetchedPage[]; errors: ImportError[] },
  emit: Emit,
): Promise<DocsImportResult> {
  dedupeAnchorsAcrossPages(p.pages)
  const chunks = p.pages.flatMap((pg) => pg.chunks)
  const sourceMarkdown = p.pages.map((pg) => `<!-- source: ${pg.url} -->\n\n${pg.markdown}`).join('\n\n---\n\n')
  const res = await writeDocSet({ title: p.title, origin: p.origin, sourceUrl: p.sourceUrl, tags: p.tags, description: p.description, sourceMarkdown, chunks, pageCount: p.pages.length })
  res.errors = p.errors
  emit({ phase: 'done', message: `Fini (${res.chunkCount} sections, ${res.pageCount} pages${p.errors.length ? `, ${p.errors.length} erreurs` : ''})`, total: res.chunkCount })
  return res
}

/** Écrit un docSet à page unique (paste / md / llms-full). */
async function finishSingle(
  p: { title: string; origin: DocOrigin; sourceUrl: string; tags: string[]; description: string; markdown: string; chunks: Chunk[] },
  emit: Emit,
): Promise<DocsImportResult> {
  const res = await writeDocSet({ title: p.title, origin: p.origin, sourceUrl: p.sourceUrl, tags: p.tags, description: p.description, sourceMarkdown: p.markdown, chunks: p.chunks, pageCount: 1 })
  emit({ phase: 'done', message: `Fini (${res.chunkCount} sections)`, total: res.chunkCount })
  return res
}

// ── Concurrence bornée (préserve l'ordre via l'index) ────────────────────────────────────────────────────
async function mapPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const n = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) break
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}

// ── API publique ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * Importe une doc tierce. `markdown` collé → import direct (origin 'paste') ; sinon `url` → tiers
 * llms.txt → page md → llms-full.txt → crawl sitemap (1er qui produit du contenu gagne). Lève si rien trouvé /
 * URL invalide ; les erreurs PAR PAGE n'interrompent pas (remontées dans result.errors + via onProgress).
 */
export async function importDoc(argsIn: DocsImportArgs, onProgress: Emit = () => {}): Promise<DocsImportResult> {
  const emit: Emit = (p) => {
    try {
      onProgress(p)
    } catch {
      /* l'UI ne doit jamais casser l'import */
    }
  }
  // Garantit un événement TERMINAL : tout échec émet phase:'error' AVANT de relancer, sinon un consommateur de
  // progression (ex. le badge d'import déclenché par un agent) resterait bloqué « en cours » sur un import raté.
  try {
    return await importDocCore(argsIn, emit)
  } catch (e) {
    const msg = String((e && (e as Error).message) || e || 'import échoué')
    emit({ phase: 'error', message: msg, error: msg })
    throw e
  }
}

async function importDocCore(argsIn: DocsImportArgs, emit: Emit): Promise<DocsImportResult> {
  const markdown = (argsIn.markdown || '').trim()
  const label = (argsIn.label || '').trim()
  const url = (argsIn.url || '').trim()

  if (markdown) {
    emit({ phase: 'chunk', message: 'Découpage du markdown collé…' })
    const chunks = core.chunkMarkdown(markdown, { sourceUrl: '', baseTags: [] }) as Chunk[]
    if (!chunks.length) throw new Error('Le markdown fourni est vide.')
    return finishSingle({ title: label || firstH1(markdown) || 'Document collé', origin: 'paste', sourceUrl: '', tags: [], description: '', markdown, chunks }, emit)
  }

  if (!url) throw new Error('Fournis une URL ou du markdown à importer.')
  let originBase: string
  try {
    originBase = new URL(url).origin
  } catch {
    throw new Error(`URL invalide : ${url}`)
  }

  const initial = await safeFetch(url, 'text/markdown, text/plain, text/html;q=0.8')

  emit({ phase: 'probe', message: 'Sonde llms.txt…' })
  const viaLlms = await tryLlmsTxt(url, originBase, label, initial, emit)
  if (viaLlms) return viaLlms

  emit({ phase: 'probe', message: 'Sonde page markdown…' })
  const viaMd = await tryMarkdownPage(url, label, initial, emit)
  if (viaMd) return viaMd

  emit({ phase: 'probe', message: 'Sonde llms-full.txt…' })
  const viaFull = await tryLlmsFull(originBase, label, emit)
  if (viaFull) return viaFull

  const viaCrawl = await crawlSitemap(originBase, label, emit)
  if (viaCrawl) return viaCrawl

  throw new Error(`Aucune doc trouvée pour ${url} (ni llms.txt, ni page markdown, ni llms-full.txt, ni sitemap.xml).`)
}

/** Re-synchronise un docSet depuis sa source web d'origine (meta.sourceUrl). Lève si collé (pas de source). */
export async function reimportDoc(slug: string, onProgress: Emit = () => {}): Promise<DocsImportResult> {
  const ds = (await core.readDocSet(slug)) as { meta: { title?: string; sourceUrl?: string } | null }
  if (!ds.meta) throw new Error(`Doc introuvable : ${slug}`)
  if (!ds.meta.sourceUrl) throw new Error(`« ${ds.meta.title || slug} » a été collé : pas de source web à re-synchroniser.`)
  return importDoc({ url: ds.meta.sourceUrl, label: ds.meta.title }, onProgress)
}
