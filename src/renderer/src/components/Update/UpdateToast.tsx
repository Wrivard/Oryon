import { AnimatePresence, motion } from 'motion/react'
import { ArrowUpCircle, X } from 'lucide-react'
import { transitionFast } from '../../lib/motion'
import { useUpdateStore } from '../../store/update'
import { useUiStore } from '../../store/ui'
import { ProgressBar } from './ProgressBar'

// Toast d'update brandé (bas-droite, au-dessus des toasts standards). Visible seulement quand pertinent.
export function UpdateToast() {
  const phase = useUpdateStore((s) => s.phase)
  const available = useUpdateStore((s) => s.available)
  const progress = useUpdateStore((s) => s.progress)
  const download = useUpdateStore((s) => s.download)
  const install = useUpdateStore((s) => s.install)
  const apply = useUpdateStore((s) => s.apply)
  const openSettings = useUiStore((s) => s.openSettings)

  const show = phase === 'available' || phase === 'downloading' || phase === 'downloaded'

  return (
    <div className="pointer-events-none fixed bottom-[5.5rem] right-4 z-[60] flex justify-end">
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ opacity: 0, x: 24, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24, scale: 0.97 }}
            transition={transitionFast}
            role="status"
            className="pointer-events-auto w-80 rounded-lg border border-accent/40 bg-bg-elevated p-3 shadow-md"
          >
            <div className="flex items-start gap-2.5">
              <ArrowUpCircle size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold text-fg">
                  {phase === 'downloaded' ? 'Mise à jour prête' : `Oryon ${available?.version ?? ''} disponible`}
                </div>
                {phase === 'downloading' && progress ? (
                  <div className="mt-2">
                    <ProgressBar p={progress} />
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    {phase === 'available' && (
                      <>
                        <button onClick={download} className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover">
                          Télécharger
                        </button>
                        <button onClick={() => openSettings('updates')} className="text-[11px] text-fg-subtle transition-colors hover:text-fg">
                          Détails
                        </button>
                      </>
                    )}
                    {phase === 'downloaded' && (
                      <button onClick={install} className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover">
                        Installer et redémarrer
                      </button>
                    )}
                  </div>
                )}
              </div>
              <button
                aria-label="Ignorer"
                onClick={() => apply({ phase: 'idle', channel: useUpdateStore.getState().channel, currentVersion: useUpdateStore.getState().currentVersion })}
                className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
              >
                <X size={13} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
