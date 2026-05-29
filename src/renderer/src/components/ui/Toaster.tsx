import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, Info, CheckCircle2, X, Copy, Check, ChevronDown, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { transitionFast } from '../../lib/motion'
import { useToastStore, type Toast, type ToastVariant } from '../../store/toasts'

const META: Record<ToastVariant, { icon: LucideIcon; color: string; bar: string }> = {
  error: { icon: AlertTriangle, color: 'text-danger', bar: 'bg-danger' },
  info: { icon: Info, color: 'text-fg-muted', bar: 'bg-accent' },
  success: { icon: CheckCircle2, color: 'text-accent', bar: 'bg-accent' },
}

function ToastItem({
  t,
  dismiss,
  pause,
  resume,
}: {
  t: Toast
  dismiss: (id: number) => void
  pause: (id: number) => void
  resume: (id: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const m = META[t.variant]
  const Icon = m.icon
  const long = t.message.length > 90 || t.message.includes('\n')

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    next ? pause(t.id) : resume(t.id) // déplié = on fige le timer pour laisser lire
  }
  const copy = () => {
    void navigator.clipboard?.writeText((t.title ? t.title + '\n' : '') + t.message).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 24, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.97 }}
      transition={transitionFast}
      role={t.variant === 'error' ? 'alert' : 'status'}
      aria-live={t.variant === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => pause(t.id)}
      onMouseLeave={() => {
        if (!expanded) resume(t.id)
      }}
      className="pointer-events-auto relative w-80 overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-md"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Icon size={15} className={cn('mt-0.5 shrink-0', m.color)} />
        <div className="min-w-0 flex-1">
          {t.title && (
            <div className="truncate text-[12px] font-semibold text-fg" title={t.title}>
              {t.title}
            </div>
          )}
          <div
            onClick={long ? toggle : undefined}
            className={cn(
              'break-words text-[12px] leading-snug text-fg-muted',
              expanded ? 'max-h-48 overflow-y-auto whitespace-pre-wrap pr-1' : 'line-clamp-3',
              long && 'cursor-pointer',
            )}
          >
            {t.message}
          </div>
          {long && (
            <div className="mt-1.5 flex items-center gap-3">
              <button onClick={toggle} className="flex items-center gap-0.5 text-[10px] text-fg-subtle transition-colors hover:text-fg">
                <ChevronDown size={11} className={cn('transition-transform', expanded && 'rotate-180')} />
                {expanded ? 'Réduire' : 'Détails'}
              </button>
              <button onClick={copy} className="flex items-center gap-0.5 text-[10px] text-fg-subtle transition-colors hover:text-fg">
                {copied ? <Check size={10} className="text-accent" /> : <Copy size={10} />}
                {copied ? 'Copié' : 'Copier'}
              </button>
            </div>
          )}
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
}

/** Pile de notifications brandées (bas-droite). Discrètes par défaut (3 lignes), dépliables pour l'erreur complète + copie. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  const pause = useToastStore((s) => s.pause)
  const resume = useToastStore((s) => s.resume)

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} t={t} dismiss={dismiss} pause={pause} resume={resume} />
        ))}
      </AnimatePresence>
    </div>
  )
}
