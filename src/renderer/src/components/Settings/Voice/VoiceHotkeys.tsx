import { useEffect, useState } from 'react'
import { Keyboard, Info } from 'lucide-react'
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

export function VoiceHotkeys() {
  const [s, setS] = useState<Record<string, string>>({})
  useEffect(() => {
    void window.bridge.settings.getApp().then(setS)
  }, [])
  const set = async (key: string, v: string) => {
    await window.bridge.settings.setApp(key, v)
    setS((prev) => ({ ...prev, [key]: v }))
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
            <input
              value={s[h.key] ?? h.ph}
              onChange={(e) => set(h.key, e.target.value)}
              placeholder="Combinaison…"
              className="w-44 shrink-0 rounded-md border border-border-strong bg-bg-elevated px-2 py-1 text-center font-mono text-[11px] text-fg outline-none focus:border-accent"
            />
          </div>
        ))}
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-subtle">
        <Info size={12} /> Les raccourcis s'appliquent au redémarrage.
      </p>
    </section>
  )
}
