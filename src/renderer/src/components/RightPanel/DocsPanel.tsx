import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { BookOpen, Search, Plus, Link2, Trash2, RefreshCw, Upload, AlertTriangle, ArrowLeft, Loader2, ChevronRight } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { cn } from '../../lib/cn'
import { toast } from '../../store/toasts'
import type { DocSet, DocSetDetail, DocSearchHit, DocsImportProgress } from '@shared/types'

// Panneau Docs (Phase 4) — jumeau LECTURE SEULE de MemoryPanel pour la doc tierce importée ($0). Store GLOBAL
// ~/.oryon/docs (pas de projectPath). Empty-state = hero d'import (URL → llms.txt / markdown collé / drop de
// fichiers) ; à l'import → vue progression pilotée par docs:import-progress (erreurs par-page inline) ; sidebar =
// docSets (ré-importer / supprimer) ; pane droit = source.md en viewer markdown lecture-seule ; recherche →
// résultats classés (clic → ouvre/scrolle la section). Pas d'édition / wikilink / graph (≠ Mémoire).

// ── Rendu markdown minimal (zéro dépendance) : headings ancrés, blocs code, listes, citations, inline. ──────
const INLINE_RE = /\[([^\]]+)\]\(([^)\s]+)[^)]*\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g

/** Ancre slug-GitHub d'un heading (mirroir de docs-core.githubSlug → matche les ancres de search_docs). */
function githubSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Emphase/liens d'un segment de texte (les liens sont rendus en texte accentué — viewer lecture seule, pas de navigation). */
function formatEmphasis(text: string, kp: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] != null)
      out.push(
        <span key={`${kp}l${k++}`} className="text-accent underline decoration-border underline-offset-2" title={m[2]}>
          {m[1]}
        </span>,
      )
    else if (m[3] != null || m[4] != null)
      out.push(
        <strong key={`${kp}b${k++}`} className="font-semibold text-fg">
          {m[3] ?? m[4]}
        </strong>,
      )
    else out.push(<em key={`${kp}i${k++}`}>{m[5] ?? m[6]}</em>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Inline : code spans (`…`, littéraux) puis emphase/liens sur le reste. */
function inlineNodes(text: string): ReactNode[] {
  const out: ReactNode[] = []
  text.split(/(`[^`]+`)/g).forEach((part, pi) => {
    if (!part) return
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`'))
      out.push(
        <code key={`c${pi}`} className="rounded bg-bg-inset px-1 py-px font-mono text-[0.92em] text-fg">
          {part.slice(1, -1)}
        </code>,
      )
    else out.push(...formatEmphasis(part, `p${pi}`))
  })
  return out
}

/** Découpe le markdown en blocs React (fence-aware). Headings → data-anchor pour le saut depuis la recherche. */
function parseBlocks(md: string): ReactNode[] {
  const lines = (md || '').split('\n')
  const out: ReactNode[] = []
  const anchorSeen = new Map<string, number>()
  const para: string[] = []
  let key = 0
  let i = 0
  const flushPara = () => {
    if (!para.length) return
    out.push(
      <p key={`p${key++}`} className="text-[12.5px] leading-relaxed text-fg-muted">
        {inlineNodes(para.join(' '))}
      </p>,
    )
    para.length = 0
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^[ \t]*```(.*)$/.exec(line)
    if (fence) {
      flushPara()
      const lang = fence[1].trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^[ \t]*```/.test(lines[i])) body.push(lines[i++])
      i++ // saute le fence fermant
      out.push(
        <pre key={`code${key++}`} className="overflow-x-auto rounded-md border border-border bg-bg-deep p-2.5">
          {lang && <div className="mb-1 text-[9px] uppercase tracking-wide text-fg-subtle">{lang}</div>}
          <code className="font-mono text-[11.5px] leading-relaxed text-fg">{body.join('\n')}</code>
        </pre>,
      )
      continue
    }
    if (/^\s*<!--.*-->\s*$/.test(line)) {
      i++ // séparateur multi-pages (source.md) : ne pas afficher le commentaire HTML
      continue
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      flushPara()
      const level = h[1].length
      const title = h[2].trim()
      const base = githubSlug(title) || 'section'
      const next = (anchorSeen.get(base) ?? -1) + 1
      anchorSeen.set(base, next)
      const anchor = next === 0 ? base : `${base}-${next}`
      const sz = level <= 1 ? 'text-[16px]' : level === 2 ? 'text-[14px]' : 'text-[12.5px]'
      out.push(
        <div key={`h${key++}`} data-anchor={anchor} className={cn('scroll-mt-2 pt-1 font-semibold text-fg', sz)}>
          {inlineNodes(title)}
        </div>,
      )
      i++
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara()
      out.push(<hr key={`hr${key++}`} className="border-border" />)
      i++
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(
        <blockquote key={`q${key++}`} className="border-l-2 border-border pl-3 text-[12px] italic text-fg-subtle">
          {inlineNodes(quote.join(' '))}
        </blockquote>,
      )
      continue
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara()
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''))
      const inner = items.map((it, idx) => <li key={idx}>{inlineNodes(it)}</li>)
      out.push(
        ordered ? (
          <ol key={`list${key++}`} className="list-decimal space-y-0.5 pl-5 text-[12.5px] leading-relaxed text-fg-muted">
            {inner}
          </ol>
        ) : (
          <ul key={`list${key++}`} className="list-disc space-y-0.5 pl-5 text-[12.5px] leading-relaxed text-fg-muted">
            {inner}
          </ul>
        ),
      )
      continue
    }
    if (!line.trim()) {
      flushPara()
      i++
      continue
    }
    para.push(line.trim())
    i++
  }
  flushPara()
  return out
}

function MarkdownView({ source }: { source: string }) {
  const blocks = useMemo(() => parseBlocks(source), [source])
  return <div className="space-y-2.5">{blocks}</div>
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────
function timeAgo(ms: number): string {
  if (!ms) return ''
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return "à l'instant"
  const m = Math.floor(s / 60)
  if (m < 60) return `il y a ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `il y a ${h} h`
  return `il y a ${Math.floor(h / 24)} j`
}
/** Repli si l'ancre exacte n'existe pas dans le rendu : 1er heading dont le texte matche le titre du hit. */
function findHeadingByText(root: HTMLElement, title: string): Element | null {
  const t = title.trim().toLowerCase()
  if (!t) return null
  for (const el of root.querySelectorAll('[data-anchor]')) if ((el.textContent || '').trim().toLowerCase() === t) return el
  return null
}

const FILE_RE = /\.(md|mdx|txt)$/i

export function DocsPanel() {
  const [docs, setDocs] = useState<DocSet[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<DocSetDetail | null>(null)
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<DocSearchHit[]>([])
  // Hero d'import
  const [url, setUrl] = useState('')
  const [paste, setPaste] = useState('')
  const [pasteLabel, setPasteLabel] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  // Progression d'import
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<DocsImportProgress[]>([])
  const [importFailed, setImportFailed] = useState<string | null>(null)
  const [reimporting, setReimporting] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const viewerRef = useRef<HTMLDivElement>(null)
  const pendingAnchor = useRef<{ slug: string; anchor: string; title: string } | null>(null)
  const importingRef = useRef(false) // gate : n'afficher la progression que pour un import lancé ICI

  const reload = async () => setDocs(await window.bridge.docs.list())

  // Montage + abonnements live (docs:changed = écritures UI/agents ; docs:import-progress = progression).
  useEffect(() => {
    void reload()
    window.bridge.docs.onChanged(() => void reload())
    window.bridge.docs.onProgress((p) => {
      if (!importingRef.current) return
      setProgress((prev) => [...prev, p])
      if (p.phase === 'error') setImportFailed(p.error || p.message)
    })
    return () => {
      window.bridge.docs.offChanged()
      window.bridge.docs.offProgress()
    }
  }, [])

  // Recherche lexicale (globale), debounce.
  useEffect(() => {
    if (!search.trim()) {
      setHits([])
      return
    }
    const t = setTimeout(() => {
      void window.bridge.docs.search(search, { limit: 30 }).then(setHits).catch(() => setHits([]))
    }, 200)
    return () => clearTimeout(t)
  }, [search, docs.length])

  // Saut vers la section après ouverture d'un résultat de recherche (sinon scroll en haut).
  useEffect(() => {
    if (!detail) return
    const pend = pendingAnchor.current
    requestAnimationFrame(() => {
      const root = viewerRef.current
      if (!root) return
      if (pend && pend.slug === detail.slug) {
        pendingAnchor.current = null
        const el = root.querySelector(`[data-anchor="${pend.anchor}"]`) ?? findHeadingByText(root, pend.title)
        if (el) {
          ;(el as HTMLElement).scrollIntoView({ block: 'start' })
          return
        }
      }
      root.scrollTop = 0
    })
  }, [detail])

  const openDoc = async (slug: string) => {
    setSelected(slug)
    setSearch('')
    setDetail(null)
    try {
      setDetail(await window.bridge.docs.read(slug))
    } catch (e) {
      toast.error((e as Error).message, { title: 'Lecture du doc impossible' })
    }
  }

  const openHit = async (hit: DocSearchHit) => {
    pendingAnchor.current = { slug: hit.docSlug, anchor: hit.anchor, title: hit.title }
    setSelected(hit.docSlug)
    setSearch('')
    setDetail(null)
    try {
      setDetail(await window.bridge.docs.read(hit.docSlug))
    } catch (e) {
      pendingAnchor.current = null
      toast.error((e as Error).message, { title: 'Lecture du doc impossible' })
    }
  }

  const beginImport = () => {
    importingRef.current = true
    setImporting(true)
    setProgress([])
    setImportFailed(null)
    setSelected(null)
    setSearch('')
  }
  const endImport = () => {
    importingRef.current = false
    setImporting(false)
  }

  const runImport = async (args: { url?: string; markdown?: string; label?: string }) => {
    beginImport()
    try {
      const res = await window.bridge.docs.import(args)
      await reload()
      await openDoc(res.slug)
      if (res.errors.length) toast.info(`${res.errors.length} page(s) en échec`, { title: `« ${res.title} » importé` })
      else toast.success(`« ${res.title} » importé (${res.chunkCount} sections)`)
    } catch (e) {
      setImportFailed((e as Error).message)
    } finally {
      endImport()
    }
  }

  const doReimport = async (slug: string) => {
    setReimporting(slug)
    beginImport()
    try {
      const res = await window.bridge.docs.reimport(slug)
      await reload()
      await openDoc(res.slug)
      toast.success(`« ${res.title} » re-synchronisé (${res.chunkCount} sections)`)
    } catch (e) {
      setImportFailed((e as Error).message)
    } finally {
      endImport()
      setReimporting(null)
    }
  }

  const doDelete = async (slug: string) => {
    setConfirmDelete(null)
    try {
      await window.bridge.docs.delete(slug)
      if (selected === slug) {
        setSelected(null)
        setDetail(null)
      }
      await reload()
    } catch (e) {
      toast.error((e as Error).message, { title: 'Suppression impossible' })
    }
  }

  const importFiles = async (files: File[]) => {
    const valid = files.filter((f) => FILE_RE.test(f.name))
    if (!valid.length) {
      toast.error('Dépose des fichiers .md, .mdx ou .txt')
      return
    }
    for (const f of valid) {
      const text = await f.text().catch(() => '')
      if (text.trim()) await runImport({ markdown: text, label: f.name.replace(FILE_RE, '') })
    }
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    void importFiles([...(e.dataTransfer?.files ?? [])])
  }

  const showHero = () => {
    endImport()
    setSelected(null)
    setDetail(null)
    setSearch('')
    setImportFailed(null)
  }

  const latest = progress[progress.length - 1]
  const pageErrors = progress.filter((p) => p.error)
  const pct = latest?.page != null && latest?.total ? Math.min(100, Math.round((latest.page / Math.max(1, latest.total)) * 100)) : 0
  const view = importing || importFailed ? 'progress' : search.trim() ? 'results' : selected ? 'viewer' : 'hero'

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-bg-deep/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-accent px-8 py-6 text-accent">
            <Upload size={24} />
            <span className="text-[13px] font-medium">Dépose tes fichiers .md / .txt</span>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
          <BookOpen size={13} className="text-accent" /> Docs
        </span>
        <div className="relative ml-1 flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher dans les docs…"
            className="h-6 w-full rounded-sm border border-border bg-bg-inset pl-7 pr-2 text-[11px] text-fg outline-none focus:border-accent"
          />
        </div>
        <button
          onClick={showHero}
          title="Importer une doc"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle hover:text-accent"
        >
          <Plus size={12} /> Importer
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar docSets */}
        <div className="flex w-52 shrink-0 flex-col border-r border-border">
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-fg-subtle">
            {docs.length} doc{docs.length !== 1 ? 's' : ''}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {docs.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-fg-subtle">Aucune doc importée.</p>
            ) : (
              docs.map((d) => (
                <div
                  key={d.slug}
                  className={cn('group mb-0.5 rounded-md px-2 py-1.5 transition-colors', selected === d.slug ? 'bg-accent-soft' : 'hover:bg-hover')}
                >
                  <button onClick={() => void openDoc(d.slug)} className="block w-full text-left">
                    <div className={cn('truncate text-[12px]', selected === d.slug ? 'text-accent' : 'text-fg')}>{d.title}</div>
                    <div className="mt-0.5 text-[10px] text-fg-subtle">
                      {d.chunkCount} section{d.chunkCount !== 1 ? 's' : ''}
                      {d.fetchedAt ? ` · ${timeAgo(d.fetchedAt)}` : ''}
                    </div>
                    {d.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {d.tags.slice(0, 4).map((t) => (
                          <span key={t} className="rounded bg-bg-elevated px-1 py-px text-[9px] text-fg-muted">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                  <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    {d.sourceUrl && (
                      <IconButton label="Ré-importer" size="sm" disabled={reimporting === d.slug} onClick={() => void doReimport(d.slug)}>
                        <RefreshCw size={12} className={cn(reimporting === d.slug && 'animate-spin')} />
                      </IconButton>
                    )}
                    {confirmDelete === d.slug ? (
                      <span className="flex items-center gap-1 text-[10px] text-danger">
                        Supprimer ?
                        <button onClick={() => void doDelete(d.slug)} className="rounded px-1 font-medium hover:bg-hover">
                          Oui
                        </button>
                        <button onClick={() => setConfirmDelete(null)} className="rounded px-1 hover:bg-hover">
                          Non
                        </button>
                      </span>
                    ) : (
                      <IconButton label="Supprimer" size="sm" onClick={() => setConfirmDelete(d.slug)}>
                        <Trash2 size={12} />
                      </IconButton>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Pane droit */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {view === 'progress' ? (
            <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
              <div className="flex items-center gap-2">
                {importFailed ? <AlertTriangle size={15} className="text-danger" /> : <Loader2 size={15} className="animate-spin text-accent" />}
                <span className="text-[13px] font-medium text-fg">
                  {importFailed ? 'Import échoué' : reimporting ? 'Re-synchronisation…' : 'Import en cours…'}
                </span>
              </div>
              {importFailed ? (
                <>
                  <p className="rounded-md border border-danger/40 bg-danger/10 p-2.5 text-[12px] text-danger">{importFailed}</p>
                  <button
                    onClick={showHero}
                    className="flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-fg-muted hover:text-fg"
                  >
                    <ArrowLeft size={12} /> Retour
                  </button>
                </>
              ) : (
                <>
                  {latest && <p className="text-[12px] text-fg-muted">{latest.message}</p>}
                  {latest?.page != null && latest?.total ? (
                    <div className="space-y-1">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-inset">
                        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <p className="text-[10px] tabular-nums text-fg-subtle">
                        {latest.page} / {latest.total}
                      </p>
                    </div>
                  ) : null}
                  {pageErrors.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[10px] uppercase tracking-wide text-fg-subtle">
                        {pageErrors.length} erreur{pageErrors.length !== 1 ? 's' : ''} de page
                      </p>
                      <div className="max-h-48 space-y-1 overflow-y-auto">
                        {pageErrors.slice(-50).map((p, idx) => (
                          <div key={idx} className="flex items-start gap-1.5 rounded border border-border bg-bg-inset px-2 py-1 text-[10px]">
                            <AlertTriangle size={11} className="mt-px shrink-0 text-warning" />
                            <span className="min-w-0 flex-1 text-fg-muted">
                              <span className="text-fg-subtle">{p.error}</span> — <span className="break-all">{p.url}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : view === 'results' ? (
            <div className="h-full overflow-y-auto p-2">
              {hits.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">Aucun résultat.</div>
              ) : (
                <div className="space-y-1.5">
                  <p className="px-1 text-[10px] uppercase tracking-wide text-fg-subtle">
                    {hits.length} résultat{hits.length !== 1 ? 's' : ''}
                  </p>
                  {hits.map((h) => {
                    const doc = docs.find((d) => d.slug === h.docSlug)
                    return (
                      <button
                        key={`${h.docSlug}:${h.chunkId}`}
                        onClick={() => void openHit(h)}
                        className="block w-full rounded-md border border-border bg-bg-inset p-2.5 text-left transition-colors hover:border-accent/60 hover:bg-hover"
                      >
                        <div className="flex items-center gap-1 text-[10px] text-fg-subtle">
                          <span className="shrink-0 text-accent">{doc?.title || h.docSlug}</span>
                          {h.breadcrumb && (
                            <>
                              <ChevronRight size={10} className="shrink-0" />
                              <span className="truncate">{h.breadcrumb}</span>
                            </>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[12.5px] font-medium text-fg">{h.title || h.breadcrumb || 'Section'}</div>
                        {h.snippet && <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-fg-muted">{h.snippet}</p>}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ) : view === 'viewer' ? (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="truncate text-[12px] font-medium text-fg">{detail?.meta?.title || selected}</span>
                {detail?.meta && (
                  <span className="ml-auto shrink-0 text-[10px] text-fg-subtle">
                    {detail.meta.chunkCount} section{detail.meta.chunkCount !== 1 ? 's' : ''} · {detail.meta.pageCount} page
                    {detail.meta.pageCount !== 1 ? 's' : ''}
                    {detail.meta.fetchedAt ? ` · ${timeAgo(detail.meta.fetchedAt)}` : ''}
                  </span>
                )}
              </div>
              <div ref={viewerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {!detail ? (
                  <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">Chargement…</div>
                ) : detail.source.trim() ? (
                  <MarkdownView source={detail.source} />
                ) : (
                  <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">Doc vide.</div>
                )}
              </div>
            </div>
          ) : (
            // Hero d'import (empty-state / « Importer »)
            <div className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto px-8 py-10 text-center">
              <BookOpen size={26} className="text-fg-subtle" />
              <div className="space-y-1">
                <h2 className="text-[14px] font-medium text-fg">Importer une doc</h2>
                <p className="text-[11px] text-fg-subtle">
                  Colle une URL — on trouve son <span className="text-fg-muted">llms.txt</span> tout seul (sinon markdown / sitemap).
                </p>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  const u = url.trim()
                  if (u) {
                    void runImport({ url: u })
                    setUrl('')
                  }
                }}
                className="flex w-full max-w-md items-center gap-2"
              >
                <div className="relative flex-1">
                  <Link2 size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
                  <input
                    autoFocus
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://docs.exemple.com"
                    className="h-9 w-full rounded-md border border-border bg-bg-inset pl-8 pr-3 text-[12px] text-fg outline-none focus:border-accent"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!url.trim()}
                  className="h-9 rounded-md bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
                >
                  Importer
                </button>
              </form>
              <button onClick={() => setShowPaste((s) => !s)} className="text-[11px] text-fg-subtle hover:text-fg">
                ou colle du markdown / dépose des fichiers .md
              </button>
              {showPaste && (
                <div className="w-full max-w-md space-y-2 text-left">
                  <input
                    value={pasteLabel}
                    onChange={(e) => setPasteLabel(e.target.value)}
                    placeholder="Titre (optionnel)"
                    className="h-7 w-full rounded-md border border-border bg-bg-inset px-2.5 text-[11px] text-fg outline-none focus:border-accent"
                  />
                  <textarea
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder="# Colle ton markdown ici…"
                    className="h-32 w-full resize-none rounded-md border border-border bg-bg-inset p-2.5 font-mono text-[11px] text-fg outline-none focus:border-accent"
                  />
                  <button
                    onClick={() => {
                      const md = paste.trim()
                      if (!md) return
                      void runImport({ markdown: md, label: pasteLabel.trim() || undefined })
                      setPaste('')
                      setPasteLabel('')
                    }}
                    disabled={!paste.trim()}
                    className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
                  >
                    Importer le markdown
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
