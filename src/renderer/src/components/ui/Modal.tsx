import { useEffect, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { X } from 'lucide-react'
import { IconButton } from './IconButton'
import { transitionFast } from '../../lib/motion'

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transitionFast}
          onMouseDown={onClose}
        >
          <motion.div
            role="dialog"
            aria-label={title}
            className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-bg-panel shadow-lg"
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={transitionFast}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex h-11 items-center justify-between border-b border-border px-4">
              <h2 className="text-[13px] font-semibold">{title}</h2>
              <IconButton label="Fermer" size="sm" onClick={onClose}>
                <X size={15} />
              </IconButton>
            </div>
            <div className="p-4">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
