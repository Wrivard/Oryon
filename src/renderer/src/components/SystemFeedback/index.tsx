// Vue System Feedback (entrée « Feedback système » du rail). Surface de REVUE du store GLOBAL cross-workspace
// des rapports déposés par les orchestrateurs (~/.oryon/system-feedback) : problèmes touchant le SYSTÈME Oryon
// (worker / dispatch / merge / design). Lecture via window.bridge.systemFeedback ; marquage revu/résolu en place.
// ⚠ App.tsx importe le named export `SystemFeedbackView` (vue globale, sans props).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { frCA } from 'date-fns/locale/fr-CA'
import { ClipboardList, RefreshCw, AlertTriangle, AlertCircle, Info, ChevronDown, Check, Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { toast } from '../../store/toasts'
import type {
  SystemFeedbackReport,
  SystemFeedbackCategory,
  SystemFeedbackSeverity,
  SystemFeedbackStatus,
} from '@shared/types'

const CATEGORY_LABEL: Record<SystemFeedbackCategory, string> = {
  worker: 'Worker',
  orchestration: 'Orchestration',
  'system-design': 'Design système',
  'oryon-bug': 'Bug Oryon',
  other: 'Autre',
}
const STATUS_LABEL: Record<SystemFeedbackStatus, string> = {
  open: 'Ouvert',
  reviewed: 'Revu',
  resolved: 'Résolu',
  wontfix: 'Ignoré',
}
const STATUS_FILTERS: { key: SystemFeedbackStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'Tous' },
  { key: 'open', label: 'Ouverts' },
  { key: 'reviewed', label: 'Revus' },
  { key: 'resolved', label: 'Résolus' },
  { key: 'wontfix', label: 'Ignorés' },
]
const SEVERITY_FILTERS: { key: SystemFeedbackSeverity | 'all'; label: string }[] = [
  { key: 'all', label: 'Toutes' },
  { key: 'error', label: 'Erreurs' },
  { key: 'warning', label: 'Avert.' },
  { key: 'info', label: 'Infos' },
]
const ACTIONS: { key: SystemFeedbackStatus; label: string }[] = [
  { key: 'reviewed', label: 'Marquer revu' },
  { key: 'resolved', label: 'Résolu' },
  { key: 'wontfix', label: 'Ignorer' },
  { key: 'open', label: 'Rouvrir' },
]

function severityMeta(sev: SystemFeedbackSeverity): { icon: ReactNode; cls: string } {
  if (sev === 'error') return { icon: <AlertCircle size={14} />, cls: 'text-danger' }
  if (sev === 'warning') return { icon: <AlertTriangle size={14} />, cls: 'text-warning' }
  return { icon: <Info size={14} />, cls: 'text-fg-subtle' }
}
function statusTone(s: SystemFeedbackStatus): string {
  if (s === 'open') return 'bg-accent-soft text-accent'
  if (s === 'reviewed') return 'bg-hover text-fg-muted'
  return 'bg-hover text-fg-subtle' // resolved / wontfix
}
function rel(ts: number): string {
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true, locale: frCA })
  } catch {
    return ''
  }
}

export function SystemFeedbackView(): JSX.Element {
  const [reports, setReports] = useState<SystemFeedbackReport[] | null>(null)
  const [statusFilter, setStatusFilter] = useState<SystemFeedbackStatus | 'all'>('all')
  const [severityFilter, setSeverityFilter] = useState<SystemFeedbackSeverity | 'all'>('all')
  const [categoryFilter, setCategoryFilter] = useState<SystemFeedbackCategory | 'all'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')

  const load = async (): Promise<void> => {
    try {
      // Borne le payload (store curé = petit ; cap large pour ne jamais charger un store géant d'un coup).
      setReports(await window.bridge.systemFeedback.list({ limit: 500 }))
    } catch {
      setReports([])
    }
  }

  // Montage + abonnement live : un orchestrateur qui dépose/résout un rapport émet 'system-feedback:changed'.
  useEffect(() => {
    void load()
    const onChanged = () => void load()
    window.bridge.systemFeedback.onChanged(onChanged)
    return () => window.bridge.systemFeedback.offChanged(onChanged)
  }, [])

  const filtered = useMemo(() => {
    const list = reports ?? []
    return list.filter(
      (r) =>
        (statusFilter === 'all' || r.status === statusFilter) &&
        (severityFilter === 'all' || r.severity === severityFilter) &&
        (categoryFilter === 'all' || r.category === categoryFilter),
    )
  }, [reports, statusFilter, severityFilter, categoryFilter])

  const openCount = useMemo(() => (reports ?? []).filter((r) => r.status === 'open').length, [reports])
  const totalCount = reports?.length ?? 0

  const applyStatus = async (r: SystemFeedbackReport, status: SystemFeedbackStatus): Promise<void> => {
    setBusyId(r.id)
    try {
      // Le main broadcast 'system-feedback:changed' sur succès → onChanged → load() rafraîchit la liste (pas de double-fetch).
      await window.bridge.systemFeedback.updateStatus(r.id, status, noteDraft.trim() || undefined)
    } catch (e) {
      toast.error((e as Error).message, { title: 'Mise à jour échouée' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* Barre d'outils */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <ClipboardList size={16} className="shrink-0 text-fg-muted" />
        <h2 className="text-[15px] font-semibold tracking-tight text-fg">Feedback système</h2>
        {openCount > 0 && (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
            {openCount} ouvert{openCount > 1 ? 's' : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as SystemFeedbackCategory | 'all')}
            aria-label="Filtrer par catégorie"
            className="h-7 rounded-md border border-border bg-bg-inset px-2 text-[12px] text-fg-muted outline-none"
          >
            <option value="all">Toutes catégories</option>
            {(Object.keys(CATEGORY_LABEL) as SystemFeedbackCategory[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
          <button
            onClick={() => void load()}
            aria-label="Rafraîchir"
            title="Rafraîchir"
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition hover:bg-hover hover:text-fg active:scale-95"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {/* Filtre de statut */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-0.5 rounded-full border border-border bg-bg-inset p-0.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                'h-6 rounded-full px-3 text-[11px] font-medium transition',
                statusFilter === f.key ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:text-fg',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5 rounded-full border border-border bg-bg-inset p-0.5">
          {SEVERITY_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setSeverityFilter(f.key)}
              className={cn(
                'h-6 rounded-full px-3 text-[11px] font-medium transition',
                severityFilter === f.key ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:text-fg',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Liste */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {reports === null ? (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-fg-subtle">
            <Loader2 size={14} className="animate-spin" /> Chargement…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center animate-fade-up">
            <div className="rounded-2xl border border-border bg-bg-elevated p-1.5 shadow-md">
              <div className="rounded-xl bg-bg-panel p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                <ClipboardList size={24} strokeWidth={1.5} className="text-fg-subtle" />
              </div>
            </div>
            <div className="space-y-1.5">
              <h3 className="text-[14px] font-semibold text-fg">
                {totalCount === 0 ? 'Aucun rapport système' : 'Rien dans ce filtre'}
              </h3>
              {totalCount === 0 ? (
                <p className="mx-auto max-w-sm text-[12px] leading-relaxed text-fg-subtle">
                  Les orchestrateurs de tes workspaces déposent ici un rapport quand ils rencontrent un problème
                  touchant le système Oryon (worker, dispatch, merge, design). Relis-les périodiquement pour
                  décider des optimisations.
                </p>
              ) : (
                <>
                  <p className="mx-auto max-w-sm text-[12px] leading-relaxed text-fg-subtle">
                    Aucun rapport ne correspond aux filtres actuels.
                  </p>
                  <button
                    onClick={() => {
                      setStatusFilter('all')
                      setSeverityFilter('all')
                      setCategoryFilter('all')
                    }}
                    className="mt-1 rounded-full border border-border bg-bg-elevated px-3 py-1 text-[12px] font-medium text-fg-muted transition hover:border-border-strong hover:text-fg active:scale-[0.98]"
                  >
                    Réinitialiser les filtres
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map((r) => {
              const sev = severityMeta(r.severity)
              const open = expandedId === r.id
              return (
                <div key={r.id} className="overflow-hidden rounded-lg border border-border bg-bg-panel">
                  <button
                    onClick={() => {
                      if (open) {
                        setExpandedId(null)
                        setNoteDraft('')
                      } else {
                        setExpandedId(r.id)
                        setNoteDraft(r.reviewNote ?? '') // préremplit avec la note existante (édition)
                      }
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-hover"
                  >
                    <span className={cn('shrink-0', sev.cls)}>{sev.icon}</span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-fg">{r.title}</span>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-subtle">
                        <span className="shrink-0">{CATEGORY_LABEL[r.category] ?? r.category}</span>
                        <span>·</span>
                        <span className="truncate">{r.workspace}</span>
                        <span>·</span>
                        <span className="shrink-0">{rel(r.ts)}</span>
                      </div>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                        statusTone(r.status),
                      )}
                    >
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                    <ChevronDown
                      size={15}
                      className={cn('shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')}
                    />
                  </button>
                  {open && (
                    <div className="border-t border-border px-3 py-3 animate-fade-up">
                      <Field label="Erreur exacte">{r.exactError}</Field>
                      <Field label="Cause supposée">{r.hypothesizedCause}</Field>
                      {r.relevantData && <Field label="Données pertinentes">{r.relevantData}</Field>}
                      {r.suggestedFix && <Field label="Correction proposée">{r.suggestedFix}</Field>}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-fg-subtle">
                        <span>Déposé par {r.agent}</span>
                        {r.workspacePath && (
                          <span className="max-w-full truncate" title={r.workspacePath}>
                            · {r.workspacePath}
                          </span>
                        )}
                        {typeof r.reviewedAt === 'number' && <span>· Révisé {rel(r.reviewedAt)}</span>}
                      </div>
                      <input
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        placeholder="Note de revue (optionnel) — jointe au changement de statut"
                        aria-label="Note de revue"
                        className="mt-3 w-full rounded-md border border-border bg-bg-inset px-2.5 py-1.5 text-[12px] text-fg outline-none placeholder:text-fg-subtle focus:border-border-strong"
                      />
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {ACTIONS.filter((a) => a.key !== r.status).map((a) => (
                          <button
                            key={a.key}
                            onClick={() => void applyStatus(r, a.key)}
                            disabled={busyId === r.id}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-elevated px-3 py-1 text-[11.5px] font-medium text-fg-muted transition hover:border-border-strong hover:text-fg active:scale-[0.98] disabled:opacity-50"
                          >
                            {busyId === r.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : a.key === 'resolved' ? (
                              <Check size={12} />
                            ) : null}
                            {a.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mb-2.5">
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-fg-muted">
        {children}
      </div>
    </div>
  )
}
