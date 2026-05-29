import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

export function Badge({
  children,
  className,
  tone = 'neutral',
}: {
  children: ReactNode
  className?: string
  tone?: 'neutral' | 'accent'
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1',
        'text-[10px] font-medium tabular-nums leading-none',
        tone === 'accent' ? 'bg-accent-soft text-accent' : 'bg-active text-fg-muted',
        className,
      )}
    >
      {children}
    </span>
  )
}
