import { useEffect, useState } from 'react'
import { Mic, Wand2, PictureInPicture2, ShieldCheck, Zap, SlidersHorizontal, Volume2 } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { toast } from '../../../store/toasts'
import { SectionHeader, SettingRow, Toggle } from './_parts'
import { getAsrDevice } from '../../../lib/voice'

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

/** parse sûr : préserve un 0 légitime, retombe sur `d` si absent/vide/NaN (réglage corrompu). */
function numOr(v: string | undefined, d: number): number {
  if (v == null || v === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export function VoiceGeneral() {
  const [s, setS] = useState<Record<string, string>>({})
  // `loaded` : false jusqu'à ce que getApp réponde. On désactive les contrôles d'ici là pour qu'aucun
  // onChange ne parte contre des valeurs par défaut vides (ce qui écraserait les vrais réglages).
  const [loaded, setLoaded] = useState(false)
  // Backend ASR effectif (diagnostic vitesse) : WebGPU = rapide ; WASM = CPU mono-thread, nettement plus lent.
  const [asrDevice, setAsrDevice] = useState<'webgpu' | 'wasm' | null>(null)
  useEffect(() => {
    void window.bridge.settings.getApp().then((v) => {
      setS(v)
      setLoaded(true)
    })
    void getAsrDevice().then(setAsrDevice)
  }, [])

  const set = async (key: string, v: string) => {
    try {
      await window.bridge.settings.setApp(key, v)
      setS((prev) => ({ ...prev, [key]: v }))
    } catch {
      toast.error("Échec de l'enregistrement.")
    }
  }
  // Le déclenchement (bascule/maintien) change la sémantique de la hotkey côté main (keydown seul vs keydown+keyup)
  // → on ré-enregistre à chaud pour l'appliquer sans redémarrage (comme VoiceHotkeys au changement de raccourci).
  const setMode = (v: 'toggle' | 'hold') => void set('voice.mode', v).then(() => window.bridge.voice.reregisterHotkeys())
  const toggleWidget = async () => {
    const next = (s['voice.showWidget'] ?? '1') === '0'
    try {
      await window.bridge.settings.setApp('voice.showWidget', next ? '1' : '0')
      await window.bridge.voice.setWidget(next)
      setS((prev) => ({ ...prev, 'voice.showWidget': next ? '1' : '0' }))
    } catch {
      toast.error("Échec de l'enregistrement.")
    }
  }
  const privacyOn = (s['voice.privacy'] ?? '0') === '1'
  const togglePrivacy = () => set('voice.privacy', privacyOn ? '0' : '1')

  // Réglages hot-path (lus par useVoice au snapshot de capture). Encodages alignés sur useVoice.ts :
  // autoStop = valeur !== '0' (défaut on), silenceMs = ms brut, boostThreshold = flottant 0–1.
  const autoStopOn = (s['voice.autoStopOnSilence'] ?? '1') !== '0'
  const silenceMs = numOr(s['voice.silenceMs'], 600)
  const boostThreshold = numOr(s['voice.boostThreshold'], 0.82)

  return (
    <div className="space-y-8">
      {/* 1 — Transcription */}
      <section>
        <SectionHeader icon={Mic} title="Transcription" />
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Modèle Whisper</span>
            <select value={s['voice.model'] || 'small'} onChange={(e) => set('voice.model', e.target.value)} disabled={!loaded} className={SELECT_CLS}>
              <option value="tiny">Tiny (très rapide)</option>
              <option value="base">Base</option>
              <option value="small">Small (recommandé QC)</option>
              <option value="medium">Medium (précis, lourd)</option>
              <option value="large">Large (très précis, très lourd)</option>
              <option value="distil-large">Distil-Large (équilibre)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Langue</span>
            <select
              value={s['voice.language'] ?? 'french'}
              onChange={(e) => set('voice.language', e.target.value)}
              disabled={!loaded}
              className={SELECT_CLS}
            >
              <option value="french">Français (Québec)</option>
              <option value="english">Anglais</option>
              <option value="">Auto-détection</option>
            </select>
          </label>
        </div>
        <p className="mt-2 text-[11px] text-fg-subtle">Small + français recommandé pour le québécois.</p>
        <p className="mt-1 flex items-center gap-1.5 text-[11px]">
          <span className="text-fg-subtle">Accélération :</span>
          {asrDevice === 'webgpu' ? (
            <span className="text-accent">⚡ WebGPU (rapide)</span>
          ) : asrDevice === 'wasm' ? (
            <span className="text-fg-muted">⚠ WASM — CPU mono-thread, transcription nettement plus lente (pas de WebGPU sur cette machine)</span>
          ) : (
            <span className="text-fg-subtle">…</span>
          )}
        </p>
      </section>

      {/* 1.4 — Retour sonore */}
      <section>
        <SectionHeader icon={Volume2} title="Retour sonore" />
        <SettingRow
          title="Sons de dictée"
          sub="Bip à l'ouverture et au relâchement de la dictée."
          right={
            <Toggle
              on={(s['voice.cueSounds'] ?? '1') !== '0'}
              onClick={() => set('voice.cueSounds', (s['voice.cueSounds'] ?? '1') !== '0' ? '0' : '1')}
              disabled={!loaded}
              ariaLabel="Sons de dictée"
            />
          }
        />
      </section>

      {/* 1.5 — Mode de dictée */}
      <section>
        <SectionHeader icon={Zap} title="Mode de dictée" />
        <div className="space-y-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Destination</span>
            <select value={s['voice.target'] ?? 'orchestrator'} onChange={(e) => set('voice.target', e.target.value)} disabled={!loaded} className={SELECT_CLS}>
              <option value="orchestrator">Orchestrateur (traitement IA)</option>
              <option value="terminal">Terminal (texte brut)</option>
              <option value="system">Système (colle dans l’app au premier plan)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Déclenchement</span>
            <Segmented<'toggle' | 'hold'>
              value={s['voice.mode'] === 'hold' || s['voice.mode'] === 'ptt' ? 'hold' : 'toggle'}
              options={[
                { v: 'toggle', label: 'Bascule' },
                { v: 'hold', label: 'Maintien (push-to-talk)' },
              ]}
              onChange={setMode}
              disabled={!loaded}
            />
            <span className="text-[11px] text-fg-subtle">
              Maintien : la dictée enregistre tant que le raccourci est pressé et s’arrête au relâchement (sans limite de durée).
            </span>
          </label>
        </div>
      </section>

      {/* 1.6 — Détection de fin de phrase & précision (réglages hot-path lus par useVoice) */}
      <section>
        <SectionHeader icon={SlidersHorizontal} title="Détection & précision" />
        <div className="space-y-4">
          <SettingRow
            title="Arrêt auto sur silence"
            sub="Termine la dictée après un court silence."
            right={<Toggle on={autoStopOn} onClick={() => set('voice.autoStopOnSilence', autoStopOn ? '0' : '1')} disabled={!loaded} ariaLabel="Arrêt auto sur silence" />}
          />
          <label className={cn('flex flex-col gap-1.5', (!autoStopOn || !loaded) && 'opacity-50')}>
            <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-fg-subtle">
              <span>Délai de silence avant arrêt</span>
              <span className="tabular-nums text-fg-muted">{silenceMs} ms</span>
            </span>
            <input
              type="range"
              min={400}
              max={2000}
              step={100}
              value={silenceMs}
              disabled={!autoStopOn || !loaded}
              onChange={(e) => set('voice.silenceMs', e.target.value)}
              className="accent-accent"
            />
          </label>
          <label className={cn('flex flex-col gap-1.5', !loaded && 'opacity-50')}>
            <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-fg-subtle">
              <span>Seuil de boost du vocabulaire</span>
              <span className="tabular-nums text-fg-muted">{boostThreshold.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={boostThreshold}
              disabled={!loaded}
              onChange={(e) => set('voice.boostThreshold', e.target.value)}
              className="accent-accent"
            />
            <span className="text-[11px] text-fg-subtle">Plus haut = correspondances plus strictes (moins de faux positifs).</span>
          </label>
        </div>
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
          disabled={privacyOn || !loaded}
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
          right={<Toggle on={(s['voice.showWidget'] ?? '1') !== '0'} onClick={toggleWidget} disabled={!loaded} ariaLabel="Widget always-on-top" />}
        />
      </section>

      {/* 4 — Confidentialité */}
      <section>
        <SectionHeader icon={ShieldCheck} title="Confidentialité" />
        <SettingRow
          title="Tout local"
          sub="Désactive les 3 appels réseau (apprentissage, smart-formatting, command mode). Tout reste sur l'appareil."
          right={<Toggle on={privacyOn} onClick={togglePrivacy} disabled={!loaded} ariaLabel="Tout local" />}
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
