import { useEffect, useState } from 'react'
import { Terminal } from '../TerminalGrid/Terminal'
import type { Terminal as TermRow } from '@shared/types'

// Onglet Orchestrator : monte le terminal orchestrateur DÉDIÉ du workspace (9e terminal, opus + ultracode).
// Tu tapes le goal directement dedans ; il pilote les 8 workers via les outils MCP (assign_task / approve_task)
// et review leur travail. Réutilise le composant <Terminal> (spawn PTY + claude + MCP config gérés là-bas).
export function OrchestratorPanel({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const [term, setTerm] = useState<TermRow | null>(null)

  useEffect(() => {
    let cancelled = false
    setTerm(null)
    window.bridge.workspaces.getOrchestrator(workspaceId).then((t) => {
      if (!cancelled) setTerm(t)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  return (
    <div className="flex h-full flex-col bg-bg-deep">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-3 text-[11px] text-fg-subtle">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        Orchestrator — opus · effort max · pilote la flotte via MCP
      </div>
      <div className="min-h-0 flex-1">
        {term ? (
          <Terminal key={term.id} term={term} focused={active} />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">
            Démarrage de l'orchestrateur…
          </div>
        )}
      </div>
    </div>
  )
}
