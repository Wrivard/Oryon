import { useEffect } from 'react'
import { SquareTerminal } from 'lucide-react'
import type { Terminal as TermRow } from '@shared/types'
import { useAppStore } from '../../store'
import { useTheme } from '../Theme/ThemeProvider'
import { Terminal } from './Terminal'
import { TerminalTab } from './TerminalTab'
import { gridDims } from '../../lib/gridTemplates'
import { cn } from '../../lib/cn'

// Référence stable pour un workspace sans terminaux : renvoyer un nouveau [] à chaque rendu casserait
// le cache de getSnapshot (useSyncExternalStore/zustand) → boucle de rendu.
const EMPTY_TERMINALS: TermRow[] = []

export default function TerminalGrid({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const terminals = useAppStore((s) => s.terminalsByWorkspace[workspaceId] ?? EMPTY_TERMINALS)
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

  // Charge (et restaure) les terminaux de CE workspace au 1er montage → monte la grille → spawn PTY + claude.
  // La grille est montée une seule fois (key=workspaceId) : cet effet ne tourne donc qu'à l'ouverture,
  // et le switch ne la démonte jamais (les <Terminal> restent montés → PTY vivants).
  useEffect(() => {
    let cancelled = false
    window.bridge.workspaces.open(workspaceId).then(({ terminals }) => {
      if (!cancelled) setTerminals(workspaceId, terminals)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceId, setTerminals])

  // À l'activation, parité avec l'ancien comportement (chaque switch focalisait le 1er terminal) : si le
  // terminal focalisé n'appartient pas à CE workspace, focalise-en le premier (sinon le focus reste sur un
  // terminal désormais caché d'un autre workspace).
  useEffect(() => {
    if (!active || terminals.length === 0) return
    if (!terminals.some((t) => t.id === useAppStore.getState().focusedTerminalId)) {
      setFocused(terminals[0].id)
    }
  }, [active, terminals, setFocused])

  const onSplit = async () => {
    const t = await window.bridge.workspaces.addTerminal(workspaceId)
    addTerminalToStore(t)
    bumpCount(workspaceId, 1)
  }
  const onClose = async (id: string) => {
    await window.bridge.workspaces.removeTerminal(id)
    removeTerminalFromStore(id) // l'unmount du <Terminal> tue le PTY
    bumpCount(workspaceId, -1)
  }

  const { cols, rows } = gridDims(terminals.length)

  return (
    <div
      // Caché (display:none) quand inactif : les <Terminal> RESTENT montés → PTY + scrollback vivants.
      // C'est le levier du switch non destructif (même principe que l'overlay maximize, généralisé).
      className={cn('relative grid h-full gap-px bg-border', !active && 'hidden')}
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
              <Terminal term={t} focused={focused} active={active} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function EmptyState() {
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
