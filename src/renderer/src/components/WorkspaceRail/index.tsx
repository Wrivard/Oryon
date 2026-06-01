import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Plus, PanelLeftClose, Settings } from 'lucide-react'
import { useAppStore } from '../../store'
import { useTheme } from '../Theme/ThemeProvider'
import { IconButton } from '../ui/IconButton'
import { Badge } from '../ui/Badge'
import { CreateWorkspaceModal } from '../CreateWorkspaceModal'
import { cn } from '../../lib/cn'
import { fadeUp, staggerContainer } from '../../lib/motion'

interface Props {
  onCollapse: () => void
}

export default function WorkspaceRail({ onCollapse }: Props) {
  const { workspaces, activeWorkspaceId, terminalCounts, workspaceActivity, setWorkspaces, setActiveWorkspace, setTerminalCounts } =
    useAppStore()
  const { theme } = useTheme()
  const [modalOpen, setModalOpen] = useState(false)
  const [appInfo, setAppInfo] = useState<{ version: string; isDev: boolean } | null>(null)

  useEffect(() => {
    let cancelled = false
    window.bridge.app
      .info()
      .then((info) => {
        if (!cancelled) setAppInfo(info)
      })
      .catch(() => {
        /* info app indisponible → on n'affiche simplement pas la version */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.bridge.workspaces.list(),
      window.bridge.workspaces.terminalCounts(),
    ]).then(([list, counts]) => {
      if (cancelled) return
      setWorkspaces(list)
      setTerminalCounts(counts)
      // Restauration : auto-sélection du workspace le plus récemment ouvert (liste triée par last_opened).
      useAppStore.setState((s) => (s.activeWorkspaceId ? {} : { activeWorkspaceId: list[0]?.id ?? null }))
    })
    return () => {
      cancelled = true
    }
  }, [setWorkspaces, setTerminalCounts])

  return (
    <div className="flex h-full w-[220px] flex-col bg-bg-panel">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border pl-3 pr-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">Workspaces</span>
        <div className="flex items-center gap-0.5">
          <IconButton label="Réduire le rail" size="sm" onClick={onCollapse}>
            <PanelLeftClose size={14} />
          </IconButton>
          <IconButton label="Nouveau workspace" size="sm" onClick={() => setModalOpen(true)}>
            <Plus size={15} />
          </IconButton>
        </div>
      </div>

      {/* Liste */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {workspaces.length === 0 ? (
          <div className="mt-8 px-3 text-center">
            <p className="text-xs text-fg-muted">Aucun workspace</p>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
              Crée-en un avec <span className="text-accent">+</span> pour lancer des agents Claude Code.
            </p>
          </div>
        ) : (
          <motion.div variants={staggerContainer(0.03)} initial="hidden" animate="show" className="space-y-0.5">
            {workspaces.map((ws, i) => {
              const active = activeWorkspaceId === ws.id
              const dot = ws.color ?? theme.terminalTabColors[i % theme.terminalTabColors.length]
              const count = terminalCounts[ws.id]
              const busy = !!workspaceActivity[ws.id] // swarm en cours (tâches in-progress/in-review) → halo pulsant
              return (
                <motion.button
                  key={ws.id}
                  variants={fadeUp}
                  onClick={() => setActiveWorkspace(ws.id)}
                  className={cn(
                    'group relative flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left outline-none',
                    'transition-colors duration-fast ease-out',
                    active ? 'bg-active' : 'hover:bg-hover',
                  )}
                >
                  {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
                  <span
                    className="relative flex h-2 w-2 shrink-0 items-center justify-center"
                    title={busy ? 'Swarm en cours' : undefined}
                  >
                    {busy && (
                      <span
                        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
                        style={{ background: dot }}
                      />
                    )}
                    <span className="relative h-2 w-2 rounded-full" style={{ background: dot }} />
                  </span>
                  <span
                    className={cn(
                      'flex-1 truncate text-[13px]',
                      active ? 'text-fg' : 'text-fg-muted group-hover:text-fg',
                    )}
                  >
                    {ws.name}
                  </span>
                  {count ? <Badge tone={active ? 'accent' : 'neutral'}>{count}</Badge> : null}
                </motion.button>
              )
            })}
          </motion.div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border p-1.5">
        <button className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-[11px] text-fg-subtle outline-none transition-colors duration-fast hover:bg-hover hover:text-fg-muted">
          <Settings size={13} />
          Réglages
        </button>
        {appInfo && (
          <div className="px-2.5 pt-1 text-[10px] tabular-nums text-fg-subtle" title={appInfo.isDev ? 'Build de développement' : 'Build de production'}>
            v{appInfo.version}
            {appInfo.isDev && <span className="text-warning"> (dev)</span>}
          </div>
        )}
      </div>

      <CreateWorkspaceModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}
