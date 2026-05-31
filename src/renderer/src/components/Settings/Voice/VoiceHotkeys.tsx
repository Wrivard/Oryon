import { useEffect, useState } from 'react'
import { Keyboard, Info, RotateCcw } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { SectionHeader } from './_parts'

const ROWS = [
  {
    key: 'voice.hotkey.toggle',
    label: 'Dictée (push-to-talk / toggle)',
    sub: 'Maintenir pour dicter, ou appuyer pour basculer.',
    ph: 'Ctrl+Shift+Space',
  },
  {
    key: 'voice.hotkey.command',
    label: 'Mode commande',
    sub: 'Transformer la sélection par la voix.',
    ph: 'Ctrl+Shift+.',
  },
]

function normalizeAccelerator(e: React.KeyboardEvent): string | null {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  if (e.metaKey) parts.push('Cmd')

  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key === 'Enter') key = 'Return'
  else if (key === 'Escape') key = 'Escape'
  else if (key === 'Backspace') key = 'Backspace'
  else if (key === 'Tab') key = 'Tab'
  else if (key === 'ArrowUp') key = 'Up'
  else if (key === 'ArrowDown') key = 'Down'
  else if (key === 'ArrowLeft') key = 'Left'
  else if (key === 'ArrowRight') key = 'Right'
  else if (key.length === 1) key = key.toUpperCase()

  if (!key || key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null

  parts.push(key)
  return parts.join('+')
}

export function VoiceHotkeys() {
  const [s, setS] = useState<Record<string, string>>({})
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.bridge.settings.getApp().then(setS)
  }, [])

  const set = async (key: string, v: string) => {
    await window.bridge.settings.setApp(key, v)
    setS((prev) => ({ ...prev, [key]: v }))
  }

  const handleRecord = (rowKey: string) => {
    if (recording === rowKey) return
    setRecording(rowKey)
    setError(null)

    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const accel = normalizeAccelerator(e as any)
      if (!accel) return

      const otherKey = rowKey === 'voice.hotkey.toggle' ? 'voice.hotkey.command' : 'voice.hotkey.toggle'
      if (accel === (s[otherKey] ?? '')) {
        setError(`Collision : « ${accel} » est déjà utilisé pour ${otherKey === 'voice.hotkey.toggle' ? 'Dictée' : 'Mode commande'}`)
        setTimeout(() => setRecording(null), 2000)
        return
      }

      void set(rowKey, accel)
      setRecording(null)
    }

    const cleanup = () => {
      window.removeEventListener('keydown', handler)
      setRecording(null)
    }

    window.addEventListener('keydown', handler)
    setTimeout(cleanup, 10000)
  }

  return (
    <section>
      <SectionHeader icon={Keyboard} title="Raccourcis clavier" />
      <div className="space-y-4">
        {ROWS.map((h) => (
          <div key={h.key} className="flex items-center justify-between gap-4 rounded-lg border border-border bg-bg-inset px-3 py-3">
            <div className="min-w-0">
              <div className="text-[12.5px] text-fg">{h.label}</div>
              <p className="mt-0.5 text-[11px] text-fg-subtle">{h.sub}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className={cn('w-44 rounded-md border px-2 py-1 text-center font-mono text-[11px]', recording === h.key ? 'border-accent bg-accent-soft text-accent animate-pulse' : 'border-border-strong bg-bg-elevated text-fg')}>
                {recording === h.key ? 'Appuyez sur la combinaison…' : s[h.key] ?? h.ph}
              </div>
              <button
                onClick={() => handleRecord(h.key)}
                disabled={recording !== null && recording !== h.key}
                className={cn('flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] transition', recording === h.key ? 'bg-accent-soft text-accent' : 'border border-border text-fg-muted hover:text-fg disabled:opacity-40')}
              >
                <RotateCcw size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <div className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-[11px] text-danger">{error}</div>}
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-subtle">
        <Info size={12} /> Les raccourcis s'appliquent au redémarrage.
      </p>
    </section>
  )
}
