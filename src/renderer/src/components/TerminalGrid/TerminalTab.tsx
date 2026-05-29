import { SplitSquareHorizontal, Maximize2, Minimize2, X } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { cn } from '../../lib/cn'
import type { TerminalStatus } from '@shared/types'

const STATUS_COLOR: Record<TerminalStatus, string> = {
  spawning: 'var(--fg-subtle)',
  shell_ready: 'var(--warning)',
  claude_starting: 'var(--warning)',
  claude_ready: 'var(--accent)',
  busy: '#3b82f6',
  idle: 'var(--accent)',
  exited: 'var(--danger)',
}

const STATUS_LABEL: Record<TerminalStatus, string> = {
  spawning: 'Démarrage du shell…',
  shell_ready: 'Shell prêt',
  claude_starting: 'Lancement de Claude…',
  claude_ready: 'Claude prêt',
  busy: 'Occupé',
  idle: 'Inactif',
  exited: 'Terminé',
}

export function TerminalTab({
  name,
  dotColor,
  status,
  focused,
  maximized,
  onSplit,
  onToggleMaximize,
  onClose,
}: {
  name: string
  dotColor: string
  status: TerminalStatus
  focused: boolean
  maximized: boolean
  onSplit: () => void
  onToggleMaximize: () => void
  onClose: () => void
}) {
  const statusColor = STATUS_COLOR[status] ?? 'var(--fg-subtle)'
  return (
    <div
      className={cn(
        'flex h-7 shrink-0 items-center gap-2 border-b px-2.5 transition-colors duration-fast',
        focused ? 'border-border bg-bg-elevated' : 'border-border bg-bg-panel',
      )}
    >
      <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
        <span className="h-2 w-2 rounded-full" style={{ background: dotColor }} />
        <span
          className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-bg-panel"
          style={{ background: statusColor }}
          title={STATUS_LABEL[status] ?? status}
        />
      </span>
      <span className="flex-1 truncate text-[11px] font-medium text-fg">{name}</span>
      <span className="text-[9px] uppercase tracking-wide text-fg-subtle">{STATUS_LABEL[status] ?? ''}</span>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100">
        <IconButton label="Diviser (ajouter un terminal)" size="sm" onClick={onSplit}>
          <SplitSquareHorizontal size={12} />
        </IconButton>
        <IconButton
          label={maximized ? 'Restaurer' : 'Agrandir'}
          size="sm"
          onClick={onToggleMaximize}
        >
          {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </IconButton>
        <IconButton label="Fermer" size="sm" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>
    </div>
  )
}
