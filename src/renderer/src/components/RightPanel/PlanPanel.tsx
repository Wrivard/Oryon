import { AnimatePresence, motion } from 'motion/react'
import { Check, X, ListChecks, CheckCheck } from 'lucide-react'
import { useAppStore } from '../../store'
import { transitionFast } from '../../lib/motion'

// Panneau Plan : file d'approbation des étapes 'proposed' (mode Plan de l'orchestrator bar).
// Approuver une étape la passe 'todo' → l'orchestrateur la dispatche ; rejeter la passe 'cancelled'.
// L'état se met à jour réactivement via l'événement 'tasks' (store), aucune relecture manuelle.
export function PlanPanel() {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const tasks = useAppStore((s) => s.tasks)
  const proposed = tasks.filter((t) => t.status === 'proposed')

  const approveStep = (id: string) => void window.bridge.orchestrator.updateTaskStatus(id, 'todo')
  const rejectStep = (id: string) => void window.bridge.orchestrator.updateTaskStatus(id, 'cancelled')
  const approveAll = () => {
    if (activeWorkspaceId) void window.bridge.orchestrator.approvePlan(activeWorkspaceId)
  }

  if (proposed.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-bg-elevated">
          <ListChecks size={20} className="text-fg-subtle" />
        </div>
        <p className="max-w-[230px] text-[12px] leading-relaxed text-fg-subtle">
          Aucun plan en attente. Soumets un objectif en mode <span className="font-medium text-accent">Plan</span> pour
          proposer des étapes à approuver avant exécution.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          Plan · {proposed.length} étape{proposed.length > 1 ? 's' : ''}
        </span>
        <button
          onClick={approveAll}
          className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition duration-fast hover:bg-accent-hover active:scale-95"
        >
          <CheckCheck size={13} />
          Tout approuver
        </button>
      </div>

      <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        <AnimatePresence initial={false}>
          {proposed.map((t, i) => (
            <motion.li
              key={t.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 24, transition: { duration: 0.12 } }}
              transition={transitionFast}
              className="group rounded-lg border border-border bg-bg-inset p-2.5"
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-bg-panel text-[10px] font-semibold tabular-nums text-fg-muted">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[12.5px] font-medium text-fg">{t.title}</span>
                    <span className="shrink-0 rounded bg-bg-panel px-1.5 py-px text-[9px] uppercase tracking-wide text-fg-subtle">
                      {t.role}
                    </span>
                  </div>
                  {t.instructions && t.instructions !== t.title && (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fg-subtle">{t.instructions}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-60 transition-opacity duration-fast group-hover:opacity-100">
                  <button
                    onClick={() => rejectStep(t.id)}
                    title="Rejeter l'étape"
                    aria-label="Rejeter l'étape"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors duration-fast hover:bg-hover hover:text-danger"
                  >
                    <X size={13} />
                  </button>
                  <button
                    onClick={() => approveStep(t.id)}
                    title="Approuver l'étape → dispatcher à un agent"
                    aria-label="Approuver l'étape"
                    className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent transition-colors duration-fast hover:bg-accent hover:text-on-accent"
                  >
                    <Check size={13} />
                  </button>
                </div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </div>
  )
}
