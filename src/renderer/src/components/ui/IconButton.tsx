import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@renderer/lib/cn'

type Size = 'sm' | 'md'

const SIZES: Record<Size, string> = {
  sm: 'h-6 w-6 rounded-sm',
  md: 'h-7 w-7 rounded',
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size
  /** Obligatoire pour l'accessibilité (bouton sans texte). */
  label: string
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = 'md', label, active = false, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center outline-none',
        'transition duration-fast ease-out active:scale-90',
        'disabled:pointer-events-none disabled:opacity-40',
        active ? 'bg-accent-soft text-accent' : 'text-fg-subtle hover:bg-hover hover:text-fg',
        SIZES[size],
        className,
      )}
      {...rest}
    />
  )
})
