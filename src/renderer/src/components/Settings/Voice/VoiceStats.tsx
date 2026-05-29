import { useEffect, useState } from 'react'
import { Mic, Type, Gauge, Clock, Sparkles, BookOpenText, TrendingUp, History } from 'lucide-react'
import type { VoiceStats as VStats, VoiceHistoryItem } from '@shared/types'
import { SectionHeader, EmptyState, StatCard } from './_parts'

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

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

export function VoiceStats({ onGoToDict }: { onGoToDict: () => void }) {
  const [stats, setStats] = useState<VStats | null>(null)
  const [history, setHistory] = useState<VoiceHistoryItem[]>([])
  useEffect(() => {
    void window.bridge.voice.stats().then(setStats)
    void window.bridge.voice.listHistory(8).then(setHistory)
  }, [])

  const s = stats
  return (
    <div>
      {/* Cartes */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard icon={Mic} label="Dictées" value={s?.dictationCount ?? 0} sub="au total" />
        <StatCard icon={Type} label="Mots dictés" value={(s?.totalWords ?? 0).toLocaleString('fr-CA')} sub="transcrits localement" />
        <StatCard icon={Gauge} label="Moyenne" value={s?.avgWords ?? 0} sub="mots / dictée" />
        <StatCard icon={Clock} label="Temps sauvé" value={fmtDuration(s?.timeSavedSec ?? 0)} sub="vs frappe à 130 mots/min" />
        <StatCard icon={Sparkles} label="Appris auto" value={s?.autoLearnedCount ?? 0} sub="termes ✨" accent onClick={onGoToDict} />
        <StatCard icon={BookOpenText} label="Vocabulaire" value={s?.vocabCount ?? 0} sub="termes actifs" onClick={onGoToDict} />
      </div>

      {/* Mots les plus corrigés */}
      <div className="mt-6">
        <SectionHeader icon={TrendingUp} title="Mots les plus corrigés" />
        {!s?.mostCorrected.length ? (
          <EmptyState icon={TrendingUp} title="Aucune correction enregistrée." hint="Le dictionnaire apprendra à mesure que tu corriges." />
        ) : (
          <div className="space-y-2">
            {s.mostCorrected.map((c) => {
              const pct = Math.round((c.count / s.mostCorrected[0].count) * 100)
              return (
                <div key={c.word} className="flex items-center gap-3">
                  <span className="w-28 truncate text-[12px] text-fg" title={c.word}>
                    {c.word}
                  </span>
                  <div className="h-1.5 flex-1 rounded-full bg-bg-elevated">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-8 text-right text-[11px] tabular-nums text-fg-subtle">{c.count}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Historique récent */}
      <div className="mt-6">
        <SectionHeader icon={History} title="Historique récent" />
        {history.length === 0 ? (
          <EmptyState icon={History} title="Aucune dictée encore." hint="Appuie sur Ctrl+Shift+Espace pour commencer." />
        ) : (
          <div className="space-y-1.5">
            {history.map((h) => (
              <div key={h.id} className="rounded-lg border border-border bg-bg-inset px-3 py-2">
                <p className="line-clamp-1 text-[12px] text-fg" title={h.text}>
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
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
