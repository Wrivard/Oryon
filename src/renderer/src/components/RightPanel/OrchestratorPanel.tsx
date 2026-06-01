import { useEffect, useRef, useState } from 'react'
import { Mic, Loader2, Download, Send } from 'lucide-react'
import { Terminal } from '../TerminalGrid/Terminal'
import { useVoiceContext, type OrchestratorBarApi } from '../Voice/VoiceProvider'
import { cn } from '../../lib/cn'
import type { Terminal as TermRow } from '@shared/types'

// Onglet Orchestrator : monte le terminal orchestrateur DÉDIÉ du workspace (9e terminal, opus + ultracode).
// Tu tapes le goal directement dedans ; il pilote les 8 workers via les outils MCP (assign_task / approve_task)
// et review leur travail. Réutilise le composant <Terminal> (spawn PTY + claude + MCP config gérés là-bas).
// + barre de dictée vocale : la dictée orchestrateur y atterrit (review/édite), Entrée l'envoie au PTY, et une
//   édition avant envoi alimente la boucle d'apprentissage ✨ (learnFromEdit).
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
      {term && <OrchestratorDictationBar termId={term.id} active={active} />}
    </div>
  )
}

function OrchestratorDictationBar({ termId, active }: { termId: string; active: boolean }) {
  const { registerOrchestratorBar, toggle, voiceState } = useVoiceContext()
  const [value, setValue] = useState('')
  const injectedRef = useRef('') // texte dicté de référence pour l'apprentissage ✨ (diff injecté vs édité)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Enregistre cette barre comme cible orchestrateur (dictée + command-mode) UNIQUEMENT quand elle est
  // visible : plusieurs orchestrateurs sont montés en parallèle (un par workspace ouvert), un seul doit
  // capter la dictée. Au switch, l'ancien se désenregistre (cleanup), le nouveau s'enregistre.
  useEffect(() => {
    if (!active) return
    const api: OrchestratorBarApi = {
      setText: (text) => {
        injectedRef.current = text
        setValue(text)
        requestAnimationFrame(() => taRef.current?.focus())
      },
      commandTarget: {
        getSelection: () => {
          const el = taRef.current
          if (!el) return null
          return { value: el.value, start: el.selectionStart, end: el.selectionEnd }
        },
        applyResult: (result, sel) => {
          setValue(sel.value.slice(0, sel.start) + result + sel.value.slice(sel.end))
          requestAnimationFrame(() => taRef.current?.focus())
        },
      },
    }
    registerOrchestratorBar(api)
    return () => registerOrchestratorBar(null)
  }, [active, registerOrchestratorBar])

  const send = () => {
    const text = value.trim()
    if (!text) return
    const injected = injectedRef.current.trim()
    // Apprentissage ✨ : si le texte dicté a été édité avant l'envoi, on apprend la correction (côté main, $0).
    if (injected && injected !== text) void window.bridge.voice.learnFromEdit(injected, text, 'orchestrator')
    window.bridge.terminals.write(termId, text + '\r')
    setValue('')
    injectedRef.current = ''
  }

  const busy = voiceState === 'processing' || voiceState === 'downloading'
  const micLabel =
    voiceState === 'listening'
      ? 'Arrêter la dictée'
      : voiceState === 'processing'
        ? 'Transcription en cours…'
        : voiceState === 'downloading'
          ? 'Téléchargement du modèle vocal…'
          : 'Dicter (ou utilise la hotkey globale)'

  return (
    <div className="shrink-0 border-t border-border bg-bg-panel p-2">
      <div className="flex items-end gap-2">
        <button
          onClick={toggle}
          disabled={busy}
          aria-label={micLabel}
          aria-pressed={voiceState === 'listening'}
          title={micLabel}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors',
            voiceState === 'listening'
              ? 'animate-pulse border-danger bg-danger-soft text-danger'
              : 'border-border text-fg-muted hover:text-fg',
            busy && 'opacity-60',
          )}
        >
          {voiceState === 'processing' ? (
            <Loader2 size={14} className="animate-spin" />
          ) : voiceState === 'downloading' ? (
            <Download size={14} />
          ) : (
            <Mic size={14} />
          )}
        </button>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Dictée orchestrateur — relis/édite puis Entrée pour envoyer · Maj+Entrée = nouvelle ligne"
          rows={2}
          className="min-h-0 flex-1 resize-none rounded-md border border-border bg-bg-inset px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
        />
        <button
          onClick={send}
          disabled={!value.trim()}
          aria-label="Envoyer à l'orchestrateur"
          className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-accent px-2.5 text-[11px] text-accent transition-colors hover:bg-accent-soft disabled:opacity-40"
        >
          <Send size={12} /> Envoyer
        </button>
      </div>
    </div>
  )
}
