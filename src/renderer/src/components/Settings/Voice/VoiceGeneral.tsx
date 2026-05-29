import { useEffect, useState } from 'react'
import { Mic, Wand2, PictureInPicture2, ShieldCheck } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { SectionHeader, SettingRow, Toggle } from './_parts'

type Fmt = 'none' | 'light' | 'medium' | 'high'

function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: { v: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className={cn('inline-flex gap-1.5', disabled && 'pointer-events-none opacity-50')}>
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          disabled={disabled}
          className={cn(
            'rounded-md border px-2.5 py-1.5 text-[12px] transition-colors duration-fast',
            value === o.v ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const SELECT_CLS =
  'rounded-md border border-border bg-bg-inset px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent'

export function VoiceGeneral() {
  const [s, setS] = useState<Record<string, string>>({})
  useEffect(() => {
    void window.bridge.settings.getApp().then(setS)
  }, [])

  const set = async (key: string, v: string) => {
    await window.bridge.settings.setApp(key, v)
    setS((prev) => ({ ...prev, [key]: v }))
  }
  const toggleWidget = async () => {
    const next = (s['voice.showWidget'] ?? '1') === '0'
    await window.bridge.settings.setApp('voice.showWidget', next ? '1' : '0')
    await window.bridge.voice.setWidget(next)
    setS((prev) => ({ ...prev, 'voice.showWidget': next ? '1' : '0' }))
  }
  const privacyOn = (s['voice.privacy'] ?? '0') === '1'
  const togglePrivacy = () => set('voice.privacy', privacyOn ? '0' : '1')

  return (
    <div className="space-y-8">
      {/* 1 — Transcription */}
      <section>
        <SectionHeader icon={Mic} title="Transcription" />
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Modèle Whisper</span>
            <select value={s['voice.model'] || 'small'} onChange={(e) => set('voice.model', e.target.value)} className={SELECT_CLS}>
              <option value="tiny">Tiny (très rapide)</option>
              <option value="base">Base</option>
              <option value="small">Small (recommandé QC)</option>
              <option value="medium">Medium (précis, lourd)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Langue</span>
            <select
              value={s['voice.language'] ?? 'french'}
              onChange={(e) => set('voice.language', e.target.value)}
              className={SELECT_CLS}
            >
              <option value="french">Français (Québec)</option>
              <option value="english">Anglais</option>
              <option value="">Auto-détection</option>
            </select>
          </label>
        </div>
        <p className="mt-2 text-[11px] text-fg-subtle">Small + français recommandé pour le québécois.</p>
      </section>

      {/* 2 — Nettoyage du texte (formatting) */}
      <section className={cn(privacyOn && 'opacity-50')} title={privacyOn ? 'Désactivé en mode tout-local' : undefined}>
        <SectionHeader icon={Wand2} title="Nettoyage du texte" />
        <Segmented<Fmt>
          value={(s['voice.formatting'] ?? 'light') as Fmt}
          options={[
            { v: 'none', label: 'Aucun' },
            { v: 'light', label: 'Léger' },
            { v: 'medium', label: 'Moyen' },
            { v: 'high', label: 'Élevé' },
          ]}
          onChange={(v) => set('voice.formatting', v)}
          disabled={privacyOn}
        />
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-fg-subtle">
          <ShieldCheck size={12} className="mt-px shrink-0 text-accent" />
          Les terminaux restent en mode code-safe (aucune capitalisation ni ponctuation forcée), peu importe ce niveau.
        </p>
      </section>

      {/* 3 — Widget flottant */}
      <section>
        <SectionHeader icon={PictureInPicture2} title="Widget flottant" />
        <SettingRow
          title="Widget always-on-top"
          sub="Pastille de dictée par-dessus toutes les fenêtres."
          right={<Toggle on={(s['voice.showWidget'] ?? '1') !== '0'} onClick={toggleWidget} />}
        />
      </section>

      {/* 4 — Confidentialité */}
      <section>
        <SectionHeader icon={ShieldCheck} title="Confidentialité" />
        <SettingRow
          title="Tout local"
          sub="Désactive les 3 appels réseau (apprentissage, smart-formatting, command mode). Tout reste sur l'appareil."
          right={<Toggle on={privacyOn} onClick={togglePrivacy} />}
        />
        <p className={cn('mt-2 text-[11px]', privacyOn ? 'text-accent' : 'text-fg-subtle')}>
          {privacyOn
            ? 'Mode 100% local actif.'
            : 'Apprentissage et formatage intelligent autorisés à appeler le réseau (CLI subscription, $0).'}
        </p>
      </section>
    </div>
  )
}
