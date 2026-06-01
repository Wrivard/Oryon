import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/cn'

// Primitives partagées des sous-pages Voice (contrat anti-« trop compacté » : espacements généreux,
// en-têtes avec filet, cartes inset). Réutilisent la géométrie DS existante (toggle h-3.5 w-6, etc.).

export function SectionHeader({
  icon: Icon,
  title,
  count,
  action,
}: {
  icon: LucideIcon
  title: string
  count?: number
  action?: ReactNode
}) {
  return (
    <div className="mb-3 flex items-center gap-2 border-b border-border pb-2">
      <Icon size={13} className="text-fg-subtle" />
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
      {count != null && <CountChip n={count} />}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  )
}

export function CountChip({ n }: { n: number }) {
  return <span className="rounded bg-bg-elevated px-1.5 py-px text-[10px] tabular-nums text-fg-subtle">{n}</span>
}

export function EmptyState({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <Icon size={18} className="mx-auto mb-2 text-fg-subtle" />
      <p className="text-[12px] text-fg-muted">{title}</p>
      {hint && <p className="mt-1 text-[11px] text-fg-subtle">{hint}</p>}
    </div>
  )
}

// Réutilise la géométrie EXACTE du switch existant (h-3.5 w-6, knob blanc h-2.5 w-2.5, translate-x-2.5).
export function Toggle({
  on,
  onClick,
  disabled,
  title,
  ariaLabel,
}: {
  on: boolean
  onClick: () => void
  disabled?: boolean
  title?: string
  ariaLabel?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      role="switch"
      aria-checked={on}
      className={cn(
        'h-3.5 w-6 shrink-0 rounded-full p-0.5 transition-colors',
        on ? 'bg-accent' : 'bg-bg-elevated',
        disabled && 'opacity-50',
      )}
    >
      <span className={cn('block h-2.5 w-2.5 rounded-full bg-white transition-transform', on && 'translate-x-2.5')} />
    </button>
  )
}

export function SettingRow({
  title,
  sub,
  right,
  dim,
}: {
  title: string
  sub?: string
  right: ReactNode
  dim?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-inset px-3 py-2.5',
        dim && 'opacity-50',
      )}
    >
      <div className="min-w-0">
        <div className="text-[12.5px] text-fg">{title}</div>
        {sub && <p className="mt-0.5 text-[11px] text-fg-subtle">{sub}</p>}
      </div>
      <div className="shrink-0">{right}</div>
    </div>
  )
}

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  icon: LucideIcon
  label: string
  value: string | number
  sub?: string
  accent?: boolean
  onClick?: () => void
}) {
  const cls = cn(
    'rounded-lg border border-border bg-bg-inset p-4 text-left',
    onClick && 'transition-colors hover:border-border-strong',
  )
  const content = (
    <>
      <div className="flex items-center gap-2 text-fg-subtle">
        <Icon size={13} />
        <span className="text-[10px] uppercase tracking-wide">{label}</span>
      </div>
      <div className={cn('mt-2 text-[22px] font-semibold tabular-nums', accent ? 'text-accent' : 'text-fg')}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-fg-subtle">{sub}</div>}
    </>
  )
  return onClick ? (
    <button onClick={onClick} className={cls}>
      {content}
    </button>
  ) : (
    <div className={cls}>{content}</div>
  )
}
