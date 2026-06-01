import { useEffect, useState } from 'react'
import { History, Copy, Check } from 'lucide-react'
import type { VoiceHistoryItem } from '@shared/types'
import { SectionHeader, EmptyState } from './_parts'

// Plafond identique au cap de la table voice_history (2000) : on récupère donc TOUT l'historique
// existant en un seul appel (la table est déjà triée created_at DESC côté SQL).
const HISTORY_CAP = 2000

// Dupliqué (volontairement) de VoiceStats : helper minuscule, on évite d'élargir le diff à VoiceStats.
function relativeTime(ts: number | null): string {
  if (!ts) return '—'
  const ms = ts > 1e12 ? ts : ts * 1000
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `il y a ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `il y a ${h} h`
  return `il y a ${Math.floor(h / 24)} j`
}

const HEADER_ACTION = 'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent'
const COPY_BTN = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-fg'

/** Sous-page Voix → Historique : liste l'intégralité des transcripts passés, copie unitaire + globale. */
export function VoiceHistory() {
  const [history, setHistory] = useState<VoiceHistoryItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [copiedAll, setCopiedAll] = useState(false)

  useEffect(() => {
    void window.bridge.voice
      .listHistory(HISTORY_CAP)
      .then(setHistory)
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  // Copie via le clipboard Electron (window.bridge.app.copyText), comme le Toaster — pas de nouvel IPC.
  const copyOne = (h: VoiceHistoryItem) => {
    void window.bridge.app
      .copyText(h.text)
      .then(() => {
        setCopiedId(h.id)
        setTimeout(() => setCopiedId((id) => (id === h.id ? null : id)), 1500)
      })
      .catch(() => {})
  }

  const copyAll = () => {
    if (history.length === 0) return
    const blob = history.map((h) => h.text).join('\n\n')
    void window.bridge.app
      .copyText(blob)
      .then(() => {
        setCopiedAll(true)
        setTimeout(() => setCopiedAll(false), 1500)
      })
      .catch(() => {})
  }

  // Squelette tant que le fetch n'est pas résolu : évite un faux état vide.
  if (!loaded) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg border border-border bg-bg-inset" />
        ))}
      </div>
    )
  }

  return (
    <div>
      <SectionHeader
        icon={History}
        title="Historique"
        count={history.length}
        action={
          history.length > 0 && (
            <button onClick={copyAll} aria-label="Tout copier" className={HEADER_ACTION}>
              {copiedAll ? <Check size={12} /> : <Copy size={12} />}
              {copiedAll ? 'Copié' : 'Tout copier'}
            </button>
          )
        }
      />
      {history.length === 0 ? (
        <EmptyState icon={History} title="Aucune dictée encore." hint="Appuie sur Ctrl+Shift+Espace pour commencer." />
      ) : (
        <div className="space-y-1.5">
          {history.map((h) => (
            <div key={h.id} className="flex items-start gap-3 rounded-lg border border-border bg-bg-inset px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="line-clamp-3 text-[12px] text-fg" title={h.text}>
                  {h.text}
                </p>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-fg-subtle">
                  <span>{relativeTime(h.created_at)}</span>
                  <span>·</span>
                  <span>{h.word_count ?? 0} mots</span>
                  {h.duration_ms != null && (
                    <>
                      <span>·</span>
                      <span>{(h.duration_ms / 1000).toFixed(1)}s</span>
                    </>
                  )}
                  {h.source && <span className="rounded bg-bg-elevated px-1 py-px uppercase tracking-wide">{h.source}</span>}
                </div>
              </div>
              <button onClick={() => copyOne(h)} aria-label="Copier la dictée" title="Copier" className={COPY_BTN}>
                {copiedId === h.id ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
