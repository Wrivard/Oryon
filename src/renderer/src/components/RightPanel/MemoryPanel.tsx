import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Network, FileText, Search, ArrowUpRight, CornerDownLeft, Sparkles } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { cn } from '../../lib/cn'
import { forceLayout } from '../../lib/force-layout'
import type { MemoryNote, MemoryGraph } from '@shared/types'

const WIKILINK = /\[\[([^\]]+)\]\]/g
const INPUT = 'rounded-md border border-border bg-bg-inset px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent'

function MemoryGraphView({ graph, selected, onPick }: { graph: MemoryGraph; selected: string | null; onPick: (id: string, exists: boolean) => void }) {
  const W = 640
  const H = 440
  const layout = useMemo(
    () => forceLayout(graph.nodes.map((n) => n.id), graph.edges, W, H),
    [graph],
  )
  if (!graph.nodes.length)
    return <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">Aucune note à grapher.</div>
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
      {graph.edges.map((e, i) => {
        const a = layout.get(e.from)
        const b = layout.get(e.to)
        if (!a || !b) return null
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth={1} />
      })}
      {graph.nodes.map((n) => {
        const p = layout.get(n.id)
        if (!p) return null
        const active = n.id === selected
        return (
          <g key={n.id} transform={`translate(${p.x},${p.y})`} onClick={() => onPick(n.id, n.exists)} style={{ cursor: 'pointer' }}>
            <circle
              r={active ? 8 : 6}
              fill={n.exists ? 'var(--accent)' : 'var(--bg-elevated)'}
              stroke={n.exists ? 'var(--accent-hover)' : 'var(--fg-subtle)'}
              strokeWidth={active ? 2.5 : 1}
              strokeDasharray={n.exists ? undefined : '3 2'}
            />
            <text x={0} y={-11} textAnchor="middle" fontSize={10} fill={active ? 'var(--accent)' : 'var(--fg-muted)'}>
              {n.title.length > 22 ? n.title.slice(0, 21) + '…' : n.title}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function MemoryPanel({ projectPath }: { projectPath: string }) {
  const [notes, setNotes] = useState<MemoryNote[]>([])
  const [graph, setGraph] = useState<MemoryGraph | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [view, setView] = useState<'editor' | 'graph'>('editor')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const loadedRef = useRef('')

  const reload = async (refreshGraph = view === 'graph') => {
    setNotes(await window.bridge.memory.list(projectPath))
    if (refreshGraph) setGraph(await window.bridge.memory.graph(projectPath))
  }
  useEffect(() => {
    void reload(false)
    setSelected(null)
    setContent('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])
  useEffect(() => {
    if (view === 'graph') void window.bridge.memory.graph(projectPath).then(setGraph)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, projectPath, notes.length])

  // Autosave (debounce) du contenu de la note sélectionnée.
  useEffect(() => {
    if (!selected || content === loadedRef.current) return
    const t = setTimeout(() => {
      void window.bridge.memory.write(projectPath, selected, content).then(() => {
        loadedRef.current = content
        void reload(false)
      })
    }, 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, selected, projectPath])

  const selectNote = async (name: string) => {
    const c = await window.bridge.memory.read(projectPath, name)
    loadedRef.current = c
    setContent(c)
    setSelected(name)
    setView('editor')
  }
  const createNote = async (raw: string) => {
    const name = raw.trim()
    if (!name) return
    await window.bridge.memory.write(projectPath, name, `# ${name}\n\n`)
    setCreating(false)
    setNewName('')
    await reload(false)
    await selectNote(name)
  }
  const openOrCreate = async (target: string) => {
    const hit = notes.find((n) => n.name.toLowerCase() === target.toLowerCase())
    if (hit) await selectNote(hit.name)
    else await createNote(target)
  }
  const del = async () => {
    if (!selected) return
    await window.bridge.memory.delete(projectPath, selected)
    setSelected(null)
    setContent('')
    await reload(false)
  }

  const outLinks = useMemo(() => {
    const s = new Set<string>()
    let m: RegExpExecArray | null
    WIKILINK.lastIndex = 0
    while ((m = WIKILINK.exec(content))) {
      const t = m[1].split('|')[0].trim()
      if (t) s.add(t)
    }
    return [...s]
  }, [content])
  const backlinks = useMemo(
    () => (selected ? notes.filter((n) => n.name !== selected && n.links.some((l) => l.toLowerCase() === selected.toLowerCase())) : []),
    [notes, selected],
  )
  const filtered = notes.filter(
    (n) => !search.trim() || n.title.toLowerCase().includes(search.toLowerCase()) || n.name.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
          <Network size={13} className="text-accent" /> Memory
        </span>
        <div className="relative ml-1 flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher…"
            className="h-6 w-full rounded-sm border border-border bg-bg-inset pl-7 pr-2 text-[11px] text-fg outline-none focus:border-accent"
          />
        </div>
        <div className="flex shrink-0 items-center rounded-md border border-border bg-bg-panel p-0.5">
          {(['editor', 'graph'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                view === v ? 'bg-accent-soft text-accent' : 'text-fg-subtle hover:text-fg',
              )}
            >
              {v === 'editor' ? <FileText size={11} /> : <Network size={11} />}
              {v === 'editor' ? 'Notes' : 'Graphe'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Liste des notes */}
        <div className="flex w-48 shrink-0 flex-col border-r border-border">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">{notes.length} note{notes.length > 1 ? 's' : ''}</span>
            <button onClick={() => setCreating((c) => !c)} className="flex items-center gap-1 rounded px-1 text-[11px] text-fg-subtle hover:text-accent">
              <Plus size={12} /> Nouvelle
            </button>
          </div>
          {creating && (
            <div className="px-2 pb-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createNote(newName)
                  if (e.key === 'Escape') {
                    setCreating(false)
                    setNewName('')
                  }
                }}
                placeholder="nom de la note"
                className={cn(INPUT, 'w-full')}
              />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {filtered.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-fg-subtle">Aucune note.</p>
            ) : (
              filtered.map((n) => (
                <button
                  key={n.name}
                  onClick={() => void selectNote(n.name)}
                  className={cn(
                    'mb-0.5 block w-full rounded-md px-2 py-1.5 text-left transition-colors',
                    selected === n.name ? 'bg-accent-soft' : 'hover:bg-hover',
                  )}
                >
                  <div className={cn('truncate text-[12px]', selected === n.name ? 'text-accent' : 'text-fg')}>{n.title}</div>
                  {n.excerpt && <div className="truncate text-[10px] text-fg-subtle">{n.excerpt}</div>}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Pane principal */}
        <div className="min-h-0 flex-1">
          {view === 'graph' ? (
            <div className="h-full p-2">
              {graph ? (
                <MemoryGraphView
                  graph={graph}
                  selected={selected}
                  onPick={(id, exists) => (exists ? void selectNote(id) : void createNote(id))}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">Chargement du graphe…</div>
              )}
            </div>
          ) : selected ? (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="truncate text-[12px] font-medium text-fg">{selected}</span>
                <span className="ml-auto text-[10px] text-fg-subtle">.oryon/memory/{selected}.md</span>
                <IconButton label="Supprimer la note" size="sm" onClick={() => void del()}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                placeholder={'# Titre\n\nÉcris ta note… lie d’autres notes avec [[wikilinks]].'}
                className="min-h-0 flex-1 resize-none bg-bg-deep px-3 py-2 font-mono text-[12px] leading-relaxed text-fg outline-none"
              />
              {/* Liens sortants + backlinks */}
              {(outLinks.length > 0 || backlinks.length > 0) && (
                <div className="shrink-0 space-y-1.5 border-t border-border px-3 py-2">
                  {outLinks.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-fg-subtle">
                        <ArrowUpRight size={11} /> Liens
                      </span>
                      {outLinks.map((l) => {
                        const exists = notes.some((n) => n.name.toLowerCase() === l.toLowerCase())
                        return (
                          <button
                            key={l}
                            onClick={() => void openOrCreate(l)}
                            className={cn(
                              'rounded px-1.5 py-px text-[11px] transition-colors',
                              exists ? 'bg-accent-soft text-accent hover:bg-accent/20' : 'border border-dashed border-border text-fg-subtle hover:text-fg',
                            )}
                          >
                            {l}
                            {!exists && <Sparkles size={9} className="ml-1 inline" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {backlinks.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-fg-subtle">
                        <CornerDownLeft size={11} /> Backlinks
                      </span>
                      {backlinks.map((n) => (
                        <button
                          key={n.name}
                          onClick={() => void selectNote(n.name)}
                          className="rounded bg-bg-elevated px-1.5 py-px text-[11px] text-fg-muted transition-colors hover:text-fg"
                        >
                          {n.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Network size={22} className="text-fg-subtle" />
              <p className="text-[12px] text-fg-muted">Sélectionne une note, ou crée-en une.</p>
              <p className="max-w-xs text-[11px] text-fg-subtle">
                Les notes vivent en markdown dans <span className="text-fg-muted">.oryon/memory/</span> et se lient via{' '}
                <span className="text-accent">[[wikilinks]]</span>.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
