import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Info, CheckCircle2, X, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { transitionFast } from '../../lib/motion'
import { useToastStore, type ToastVariant } from '../../store/toasts'

const META: Record<ToastVariant, { icon: LucideIcon; color: string; bar: string }> = {
  error: { icon: AlertTriangle, color: 'text-danger', bar: 'bg-danger' },
  info: { icon: Info, color: 'text-fg-muted', bar: 'bg-accent' },
  success: { icon: CheckCircle2, color: 'text-accent', bar: 'bg-accent' },
}

/** Pile de notifications brandées (bas-droite, au-dessus de l'orchestrator bar). Monté une fois dans App. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  const pause = useToastStore((s) => s.pause)
  const resume = useToastStore((s) => s.resume)

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const m = META[t.variant]
          const Icon = m.icon
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24, scale: 0.97 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, scale: 0.97 }}
              transition={transitionFast}
              role={t.variant === 'error' ? 'alert' : 'status'}
              aria-live={t.variant === 'error' ? 'assertive' : 'polite'}
              onMouseEnter={() => pause(t.id)}
              onMouseLeave={() => resume(t.id)}
              className="pointer-events-auto relative w-80 overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-md"
            >
              <div className="flex items-start gap-2.5 px-3 py-2.5">
                <Icon size={15} className={cn('mt-0.5 shrink-0', m.color)} />
                <div className="min-w-0 flex-1">
                  {t.title && <div className="truncate text-[12px] font-semibold text-fg" title={t.title}>{t.title}</div>}
                  <div className="line-clamp-3 break-words text-[12px] leading-snug text-fg-muted" title={t.message}>
                    {t.message}
                  </div>
                </div>
                <button
                  aria-label="Fermer"
                  onClick={() => dismiss(t.id)}
                  className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-fg-subtle transition-colors duration-fast hover:bg-hover hover:text-fg"
                >
                  <X size={13} />
                </button>
              </div>
              {t.duration > 0 && (
                <span
                  className={cn('absolute bottom-0 left-0 h-[2px] origin-left', m.bar)}
                  style={{ animation: `toast-bar ${t.duration}ms linear forwards`, animationPlayState: t.timer ? 'running' : 'paused' }}
                />
              )}
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
