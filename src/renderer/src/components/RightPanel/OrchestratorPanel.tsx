import { useEffect, useState } from 'react'
import { Terminal } from '../TerminalGrid/Terminal'
import { useVoiceContext, type OrchestratorBarApi } from '../Voice/VoiceProvider'
import type { Terminal as TermRow } from '@shared/types'

// Onglet Orchestrator : monte le terminal orchestrateur DÉDIÉ du workspace (fable + effort max). Tu tapes le goal
// DIRECTEMENT dans le terminal ; il pilote les workers via les outils MCP. Réutilise le composant <Terminal>
// (spawn PTY + claude + config MCP gérés là-bas ; rendu plein écran claude → scroll molette/PgUp de l'historique).
// La dictée vocale orchestrateur est écrite directement dans le PTY (relue/éditée dans claude lui-même) — plus de
// barre de dictée séparée.
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
        Orchestrator — fable · effort max · pilote la flotte via MCP
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
      {term && <OrchestratorVoiceSink termId={term.id} active={active} />}
    </div>
  )
}

// Récepteur de dictée orchestrateur SANS UI (remplace l'ancienne barre « relis/édite/Entrée »). S'enregistre
// comme cible vocale 'orchestrator' UNIQUEMENT quand le panneau est visible (plusieurs orchestrateurs montés en
// parallèle — un seul doit capter ; au switch l'ancien se désenregistre, le nouveau s'enregistre) et écrit le
// texte dicté DIRECTEMENT dans le PTY du terminal orchestrateur — sans \r : le texte atterrit dans la ligne de
// saisie de claude, l'utilisateur relit/édite puis Entrée dans le terminal lui-même.
function OrchestratorVoiceSink({ termId, active }: { termId: string; active: boolean }): null {
  const { registerOrchestratorBar } = useVoiceContext()
  useEffect(() => {
    if (!active) return
    const api: OrchestratorBarApi = {
      setText: (text) => window.bridge.terminals.write(termId, text),
      // Pas de champ texte/sélection : command-mode insère le résultat directement dans le PTY.
      commandTarget: {
        getSelection: () => null,
        applyResult: (result) => window.bridge.terminals.write(termId, result),
      },
    }
    registerOrchestratorBar(api)
    return () => registerOrchestratorBar(null)
  }, [termId, active, registerOrchestratorBar])
  return null
}
