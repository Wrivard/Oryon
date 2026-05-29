import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Search } from 'lucide-react'
import { transitionFast } from '../../lib/motion'
import { cn } from '../../lib/cn'

function fuzzyFilter(query: string, files: string[]): string[] {
  if (!query.trim()) return files.slice(0, 60)
  const q = query.toLowerCase()
  const matches: string[] = []
  for (const f of files) {
    const name = f.toLowerCase()
    let idx = 0
    for (let i = 0; i < name.length && idx < q.length; i++) {
      if (name[i] === q[idx]) idx++
    }
    if (idx === q.length) matches.push(f)
    if (matches.length >= 60) break
  }
  return matches
}

function rel(root: string, p: string): string {
  return p.startsWith(root) ? p.slice(root.length).replace(/^[\\/]/, '') : p
}

export function QuickOpen({
  open,
  files,
  rootPath,
  onClose,
  onOpenFile,
}: {
  open: boolean
  files: string[]
  rootPath: string
  onClose: () => void
  onOpenFile: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => fuzzyFilter(query, files), [query, files])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSel(0)
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => setSel(0), [query])

  const choose = (f: string | undefined) => {
    if (!f) return
    onOpenFile(f)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transitionFast}
          onMouseDown={onClose}
        >
          <motion.div
            className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-bg-panel shadow-lg"
            initial={{ opacity: 0, scale: 0.98, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={transitionFast}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search size={14} className="shrink-0 text-fg-subtle" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Rechercher un fichier"
                placeholder="Rechercher un fichier…"
                className="flex-1 bg-transparent py-2.5 text-[13px] text-fg outline-none placeholder:text-fg-subtle"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSel((s) => Math.min(s + 1, results.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSel((s) => Math.max(s - 1, 0))
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    choose(results[sel])
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    onClose()
                  }
                }}
              />
            </div>
            <div className="max-h-[50vh] overflow-y-auto py-1">
              {results.length === 0 ? (
                <div className="px-3 py-3 text-[12px] text-fg-subtle">Aucun fichier</div>
              ) : (
                results.map((f, i) => {
                  const r = rel(rootPath, f)
                  const slash = Math.max(r.lastIndexOf('/'), r.lastIndexOf('\\'))
                  const name = slash >= 0 ? r.slice(slash + 1) : r
                  const dir = slash >= 0 ? r.slice(0, slash) : ''
                  return (
                    <button
                      key={f}
                      onMouseEnter={() => setSel(i)}
                      onClick={() => choose(f)}
                      className={cn(
                        'flex w-full items-baseline gap-2 px-3 py-1.5 text-left outline-none',
                        i === sel ? 'bg-accent-soft' : 'hover:bg-hover',
                      )}
                    >
                      <span className={cn('text-[12px]', i === sel ? 'text-accent' : 'text-fg')}>{name}</span>
                      {dir && <span className="truncate text-[10px] text-fg-subtle">{dir}</span>}
                    </button>
                  )
                })
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
