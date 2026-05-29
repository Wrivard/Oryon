import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@renderer/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent font-medium hover:bg-accent-hover active:bg-accent-active',
  secondary: 'bg-bg-elevated text-fg border border-border hover:border-border-strong',
  ghost: 'text-fg-muted hover:text-fg hover:bg-hover',
}

const SIZES: Record<Size, string> = {
  sm: 'h-7 gap-1.5 rounded-sm px-2.5 text-xs',
  md: 'h-8 gap-2 rounded px-3 text-[13px]',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap outline-none',
        'transition duration-fast ease-out active:scale-[0.98]',
        'disabled:pointer-events-none disabled:opacity-50',
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  )
})
