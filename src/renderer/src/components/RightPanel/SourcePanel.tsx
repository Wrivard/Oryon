import { useCallback, useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, X, RefreshCw, GitCompareArrows, History, RotateCcw, CheckCheck, XCircle } from 'lucide-react'
import { useAppStore } from '../../store'
import { cn } from '../../lib/cn'
import { transitionFast } from '../../lib/motion'
import type { SourceStatus, SourceFileChange, SourceDiff, GitCommit, SourceFileStatus } from '@shared/types'

const STATUS_META: Record<SourceFileStatus, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'text-[#e2b341] bg-[#e2b341]/12' },
  A: { label: 'A', cls: 'text-accent bg-accent-soft' },
  '?': { label: 'U', cls: 'text-accent bg-accent-soft' },
  D: { label: 'D', cls: 'text-danger bg-danger/12' },
  R: { label: 'R', cls: 'text-[#7aa2f7] bg-[#7aa2f7]/12' },
}

export function SourcePanel({ projectPath, active }: { projectPath: string; active: boolean }) {
  const [status, setStatus] = useState<SourceStatus | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<SourceDiff | null>(null)
  const [history, setHistory] = useState<GitCommit[] | null>(null) // !null = drawer ouvert pour `selected`
  const [refAt, setRefAt] = useState<{ ref: string; content: string; language: string } | null>(null)
  const [nonce, setNonce] = useState(0) // bump après une action → refetch du diff même si `selected` inchangé

  const refresh = useCallback(async () => {
    const s = await window.bridge.source.status(projectPath)
    setStatus(s)
    setSelected((cur) => (cur && s.files.some((f) => f.path === cur) ? cur : (s.files[0]?.path ?? null)))
  }, [projectPath])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  // Charger le diff du fichier sélectionné. setDiff(null) d'abord → pas de flash de l'ancien diff
  // pendant le fetch (l'éditeur reste monté). `nonce` force un refetch après accept/reject/revert.
  useEffect(() => {
    setRefAt(null)
    setHistory(null)
    setDiff(null)
    if (!selected) return
    let alive = true
    void window.bridge.source.diff(projectPath, selected).then((d) => {
      if (alive) setDiff(d)
    })
    return () => {
      alive = false
    }
  }, [selected, projectPath, nonce])

  const act = async (fn: Promise<void>) => {
    await fn
    setNonce((n) => n + 1) // refetch du diff (utile après revert : `selected` inchangé mais contenu modifié)
    await refresh()
  }
  const accept = (f: string) => void act(window.bridge.source.accept(projectPath, f))
  const reject = (f: string) => void act(window.bridge.source.reject(projectPath, f))
  const acceptAll = () => void act(window.bridge.source.acceptAll(projectPath))
  const rejectAll = () => {
    if (window.confirm('Rejeter TOUS les changements (restaurer à HEAD) ? Action destructive.')) {
      void act(window.bridge.source.rejectAll(projectPath))
    }
  }

  const openHistory = async () => {
    if (!selected) return
    if (history) {
      setHistory(null)
      setRefAt(null)
      return
    }
    setHistory(await window.bridge.source.log(projectPath, selected))
  }
  const viewAtRef = async (ref: string) => {
    if (!selected) return
    const r = await window.bridge.source.fileAtRef(projectPath, selected, ref)
    setRefAt({ ref, ...r })
  }
  const revertTo = (ref: string) => {
    if (!selected) return
    if (window.confirm(`Restaurer ${selected} à ${ref.slice(0, 7)} ?`)) {
      void act(window.bridge.source.revertFile(projectPath, selected, ref)).then(() => {
        setHistory(null)
        setRefAt(null)
      })
    }
  }

  if (status && !status.isGit) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-bg-elevated">
          <GitCompareArrows size={20} className="text-fg-subtle" />
        </div>
        <p className="max-w-[230px] text-[12px] leading-relaxed text-fg-subtle">
          Ce projet n'est pas un dépôt git. Le suivi par snapshots locaux arrivera ici.
        </p>
      </div>
    )
  }

  const files = status?.files ?? []

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          Source · {files.length} fichier{files.length > 1 ? 's' : ''}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={acceptAll}
            disabled={files.length === 0}
            title="Tout accepter (stager)"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-fg-subtle transition-colors hover:text-accent disabled:opacity-40"
          >
            <CheckCheck size={12} /> Tout
          </button>
          <button
            onClick={rejectAll}
            disabled={files.length === 0}
            title="Tout rejeter (restaurer à HEAD)"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-fg-subtle transition-colors hover:text-danger disabled:opacity-40"
          >
            <XCircle size={12} /> Reset
          </button>
          <button
            onClick={() => void refresh()}
            title="Rafraîchir"
            className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* Liste des fichiers */}
      <div className="max-h-[38%] shrink-0 overflow-y-auto border-b border-border">
        {files.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] text-fg-subtle">Aucun changement en attente.</p>
        ) : (
          files.map((f: SourceFileChange) => {
            const meta = STATUS_META[f.status]
            const isSel = selected === f.path
            return (
              <div
                key={f.path}
                className={cn(
                  'group flex items-center gap-2 px-2.5 py-1.5 text-[11px] transition-colors',
                  isSel ? 'bg-accent-soft' : 'hover:bg-hover',
                  f.staged && 'opacity-60',
                )}
              >
                <button onClick={() => setSelected(f.path)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold', meta.cls)}>
                    {meta.label}
                  </span>
                  <span className={cn('truncate', isSel ? 'text-fg' : 'text-fg-muted')}>{f.path}</span>
                  {f.staged && <Check size={11} className="shrink-0 text-accent" />}
                  <span className="ml-auto shrink-0 tabular-nums text-[10px] text-fg-subtle">
                    {f.additions > 0 && <span className="text-accent">+{f.additions}</span>}{' '}
                    {f.deletions > 0 && <span className="text-danger">−{f.deletions}</span>}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  {!f.staged && (
                    <button
                      onClick={() => accept(f.path)}
                      title="Accepter (stager)"
                      className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-accent hover:text-on-accent"
                    >
                      <Check size={12} />
                    </button>
                  )}
                  <button
                    onClick={() => reject(f.path)}
                    title="Rejeter (restaurer à HEAD)"
                    className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-danger"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Sous-barre fichier sélectionné + historique */}
      {selected && (
        <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border px-2.5">
          <span className="truncate text-[10px] text-fg-subtle">
            {refAt ? `${selected} · ${refAt.ref.slice(0, 7)} → courant` : selected}
          </span>
          <button
            onClick={openHistory}
            title="Historique du fichier (versions plus anciennes)"
            className={cn(
              'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
              history ? 'text-accent' : 'text-fg-subtle hover:text-fg',
            )}
          >
            <History size={11} /> Historique
          </button>
        </div>
      )}

      {/* Diff / Historique */}
      <div className="relative min-h-0 flex-1">
        <AnimatePresence>
          {history && (
            <motion.div
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={transitionFast}
              className="absolute inset-0 z-10 overflow-y-auto bg-bg-panel"
            >
              {history.length === 0 ? (
                <p className="px-3 py-4 text-center text-[11px] text-fg-subtle">Aucun commit pour ce fichier.</p>
              ) : (
                history.map((c) => (
                  <div key={c.hash} className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 hover:bg-hover">
                    <button onClick={() => viewAtRef(c.hash)} className="flex min-w-0 flex-1 flex-col items-start text-left">
                      <span className="truncate text-[11px] text-fg-muted">{c.subject}</span>
                      <span className="text-[9px] tabular-nums text-fg-subtle">
                        {c.shortHash} · {c.author} · {c.date}
                      </span>
                    </button>
                    <button
                      onClick={() => revertTo(c.hash)}
                      title="Restaurer le fichier à cette version"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-accent"
                    >
                      <RotateCcw size={12} />
                    </button>
                  </div>
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {diff ? (
          <DiffEditor
            theme="oryon-dark"
            language={refAt?.language ?? diff.language}
            original={refAt ? refAt.content : diff.original}
            modified={diff.modified}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">
            {files.length ? 'Sélectionne un fichier' : ''}
          </div>
        )}
      </div>
    </div>
  )
}
