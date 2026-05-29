import type { UpdateProgress } from '@shared/types'

const mo = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

/** Barre de progression brandée (téléchargement d'update). Réutilisée par le toast et les Réglages. */
export function ProgressBar({ p }: { p: UpdateProgress }) {
  const pct = Math.max(0, Math.min(100, Math.round(p.percent)))
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-inset">
        <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-fg-subtle">
        <span>
          {pct}% · {mo(p.transferred)}/{mo(p.total)} Mo
        </span>
        <span>{mo(p.bytesPerSecond)} Mo/s</span>
      </div>
    </div>
  )
}
