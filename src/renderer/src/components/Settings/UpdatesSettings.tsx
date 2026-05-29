import { RefreshCw, Download, CheckCircle2, AlertTriangle } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useUpdateStore } from '../../store/update'
import { ProgressBar } from '../Update/ProgressBar'
import type { UpdateChannel } from '@shared/types'

const SELECT = 'rounded-md border border-border bg-bg-inset px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent'

export function UpdatesSettings() {
  const s = useUpdateStore()
  const busy = s.phase === 'checking' || s.phase === 'downloading'

  return (
    <div className="space-y-8">
      {/* Canal */}
      <section>
        <div className="mb-3 flex items-center gap-2 border-b border-border pb-2">
          <Download size={13} className="text-fg-subtle" />
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Mises à jour</h3>
          <span className="ml-auto text-[11px] text-fg-subtle">version {s.currentVersion || '—'}</span>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg-inset px-3 py-2.5">
          <div>
            <div className="text-[12.5px] text-fg">Canal</div>
            <p className="mt-0.5 text-[11px] text-fg-subtle">Stable = quotidien · Dev = pré-versions (en avance).</p>
          </div>
          <div className="inline-flex gap-1.5">
            {(['stable', 'dev'] as UpdateChannel[]).map((c) => (
              <button
                key={c}
                onClick={() => s.setChannel(c)}
                disabled={s.phase === 'unsupported'}
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-[12px] capitalize transition-colors duration-fast disabled:opacity-40',
                  s.channel === c ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:text-fg',
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Action + état */}
        <div className="mt-3 space-y-2 rounded-lg border border-border bg-bg-inset px-3 py-2.5">
          {s.phase === 'unsupported' ? (
            <p className="text-[12px] text-fg-subtle">Les mises à jour ne sont actives que dans l'app installée (pas en dev).</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <button
                  onClick={s.check}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
                >
                  <RefreshCw size={12} className={cn(s.phase === 'checking' && 'animate-spin')} />
                  Vérifier
                </button>
                {s.phase === 'available' && (
                  <button onClick={s.download} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent transition hover:bg-accent-hover">
                    Télécharger {s.available?.version}
                  </button>
                )}
                {s.phase === 'downloaded' && (
                  <button onClick={s.install} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent transition hover:bg-accent-hover">
                    Installer et redémarrer
                  </button>
                )}
              </div>

              {s.phase === 'up-to-date' && (
                <p className="flex items-center gap-1.5 text-[12px] text-accent">
                  <CheckCircle2 size={13} /> Oryon est à jour.
                </p>
              )}
              {s.phase === 'available' && s.available?.releaseNotes && (
                <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-bg-panel p-2 text-[11px] text-fg-muted">
                  {s.available.releaseNotes}
                </pre>
              )}
              {s.phase === 'downloading' && s.progress && <ProgressBar p={s.progress} />}
              {s.phase === 'error' && (
                <p className="flex items-start gap-1.5 break-words text-[12px] text-danger">
                  <AlertTriangle size={13} className="mt-px shrink-0" /> {s.error || 'Échec de la mise à jour.'}
                </p>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  )
}
