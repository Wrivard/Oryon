import { useEffect } from 'react'
import { SquareTerminal } from 'lucide-react'
import { useAppStore } from '../../store'
import { useTheme } from '../Theme/ThemeProvider'
import { Terminal } from './Terminal'
import { TerminalTab } from './TerminalTab'
import { gridDims } from '../../lib/gridTemplates'
import { cn } from '../../lib/cn'

export default function TerminalGrid() {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const terminals = useAppStore((s) => s.terminals)
  const statuses = useAppStore((s) => s.statuses)
  const focusedTerminalId = useAppStore((s) => s.focusedTerminalId)
  const maximizedTerminalId = useAppStore((s) => s.maximizedTerminalId)
  const setTerminals = useAppStore((s) => s.setTerminals)
  const setFocused = useAppStore((s) => s.setFocused)
  const toggleMaximize = useAppStore((s) => s.toggleMaximize)
  const addTerminalToStore = useAppStore((s) => s.addTerminal)
  const removeTerminalFromStore = useAppStore((s) => s.removeTerminal)
  const bumpCount = useAppStore((s) => s.bumpCount)
  const { theme } = useTheme()

  // Charge (et restaure) les terminaux du workspace actif → monte la grille → spawn PTY + claude.
  useEffect(() => {
    if (!activeWorkspaceId) {
      setTerminals([])
      return
    }
    let cancelled = false
    window.bridge.workspaces.open(activeWorkspaceId).then(({ terminals }) => {
      if (!cancelled) setTerminals(terminals)
    })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, setTerminals])

  if (!activeWorkspaceId) return <EmptyState />

  const onSplit = async () => {
    const t = await window.bridge.workspaces.addTerminal(activeWorkspaceId)
    addTerminalToStore(t)
    bumpCount(activeWorkspaceId, 1)
  }
  const onClose = async (id: string) => {
    await window.bridge.workspaces.removeTerminal(id)
    removeTerminalFromStore(id) // l'unmount du <Terminal> tue le PTY
    bumpCount(activeWorkspaceId, -1)
  }

  const { cols, rows } = gridDims(terminals.length)

  return (
    <div
      className="relative grid h-full gap-px bg-border"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0,1fr))`,
      }}
    >
      {terminals.map((t) => {
        const dot = t.color ?? theme.terminalTabColors[t.pane_index % theme.terminalTabColors.length]
        const focused = focusedTerminalId === t.id
        const maximized = maximizedTerminalId === t.id
        return (
          <div
            key={t.id}
            onMouseDown={() => setFocused(t.id)}
            className={cn(
              'group flex min-h-0 min-w-0 flex-col bg-bg-deep outline-none transition-shadow duration-fast',
              // Maximize = overlay absolu : tous les terminaux restent montés (PTY vivants).
              maximized && 'absolute inset-0 z-20',
            )}
            style={focused && !maximized ? { boxShadow: 'inset 0 0 0 1px var(--accent)' } : undefined}
          >
            <TerminalTab
              name={t.name}
              dotColor={dot}
              status={statuses[t.id] ?? 'spawning'}
              focused={focused}
              maximized={maximized}
              onSplit={onSplit}
              onToggleMaximize={() => toggleMaximize(t.id)}
              onClose={() => onClose(t.id)}
            />
            <div className="min-h-0 flex-1">
              <Terminal term={t} focused={focused} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg-deep">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-bg-panel">
        <SquareTerminal size={22} className="text-fg-subtle" />
      </div>
      <div className="text-center">
        <p className="text-[13px] text-fg-muted">Sélectionne ou crée un workspace</p>
        <p className="mt-1 text-[11px] text-fg-subtle">
          Chaque terminal lance Claude Code dans le dossier du projet
        </p>
      </div>
    </div>
  )
}
