import { useEffect, useRef, useState } from 'react'
import { Bot, ArrowUp, Trash2 } from 'lucide-react'
import { useAppStore } from '../../store'
import { toast } from '../../store/toasts'
import { cn } from '../../lib/cn'
import type { ChatMessage } from '@shared/types'

const CHAT_KEY = (wid: string) => `bf:orchChat:${wid}`

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Panneau de chat DÉDIÉ avec l'orchestrateur : une vraie conversation multi-tours. L'orchestrateur
// répond ET pilote les terminaux (injection directe, cf. agent.ts). Le suivi du swarm/mailbox reste
// dans le bandeau et le panneau Plan ; ici, c'est le fil de discussion.
export function OrchestratorChat() {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Transcript persisté par workspace (rechargé au changement de workspace).
  useEffect(() => {
    if (!activeWorkspaceId) {
      setChat([])
      return
    }
    try {
      const raw = localStorage.getItem(CHAT_KEY(activeWorkspaceId))
      setChat(raw ? (JSON.parse(raw) as ChatMessage[]) : [])
    } catch {
      setChat([])
    }
  }, [activeWorkspaceId])

  // Auto-scroll vers le bas à chaque message / pendant la réflexion.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [chat, busy])

  const persist = (next: ChatMessage[]) => {
    setChat(next)
    if (activeWorkspaceId) localStorage.setItem(CHAT_KEY(activeWorkspaceId), JSON.stringify(next.slice(-100)))
  }

  const send = async () => {
    const text = input.trim()
    if (!text || !activeWorkspaceId || busy) return
    const userMsg: ChatMessage = { id: makeId(), role: 'user', body: text, created_at: Date.now() }
    const withUser = [...chat, userMsg]
    persist(withUser)
    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto' // reset la hauteur auto-grow après envoi
    setBusy(true)
    try {
      const reply = await window.bridge.orchestrator.chat(activeWorkspaceId, text)
      persist([...withUser, reply])
    } catch (e) {
      toast.error((e as Error).message, { title: 'Orchestrateur' })
      persist([...withUser, { id: makeId(), role: 'assistant', body: `⚠ ${(e as Error).message}`, created_at: Date.now() }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg-panel">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          <Bot size={13} />
          Orchestrateur
        </div>
        {chat.length > 0 && (
          <button
            onClick={() => persist([])}
            title="Effacer la conversation"
            className="flex items-center gap-1 text-[10px] text-fg-subtle transition-colors hover:text-danger"
          >
            <Trash2 size={11} />
            Effacer
          </button>
        )}
      </div>

      <div ref={threadRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {chat.length === 0 && !busy && (
          <div className="mt-6 px-2 text-center text-[12px] leading-relaxed text-fg-subtle">
            {activeWorkspaceId ? (
              <>
                Parle à l'orchestrateur comme à un lead.
                <br />
                Il répond, pose des questions, et pousse des sous-tâches aux terminaux.
              </>
            ) : (
              'Sélectionne un workspace pour discuter.'
            )}
          </div>
        )}
        {chat.map((m) => (
          <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[88%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[12.5px] leading-snug',
                m.role === 'user' ? 'bg-accent-soft text-fg' : 'bg-bg-inset text-fg-muted',
              )}
            >
              {m.body}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-lg bg-bg-inset px-3 py-2 text-[12.5px] text-fg-subtle">
              <span className="animate-pulse">réflexion…</span>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-2.5">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-bg-inset px-2.5 py-1.5 focus-within:border-accent focus-within:shadow-ring">
          <textarea
            ref={inputRef}
            rows={1}
            aria-label="Message à l'orchestrateur"
            className="max-h-32 flex-1 resize-none bg-transparent py-1 text-[13px] text-fg outline-none placeholder:text-fg-subtle"
            placeholder={
              busy
                ? 'Orchestrateur en réflexion…'
                : activeWorkspaceId
                  ? 'Demande quelque chose…'
                  : 'Sélectionne un workspace…'
            }
            value={input}
            disabled={!activeWorkspaceId || busy}
            onChange={(e) => {
              setInput(e.target.value)
              const el = e.target
              el.style.height = 'auto'
              el.style.height = Math.min(el.scrollHeight, 128) + 'px'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button
            onClick={send}
            disabled={!input.trim() || !activeWorkspaceId || busy}
            aria-label="Envoyer"
            className={cn(
              'mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded bg-accent text-on-accent',
              'transition duration-fast ease-out hover:bg-accent-hover active:scale-90',
              'disabled:pointer-events-none disabled:opacity-40',
            )}
          >
            {busy ? <span className="text-[11px]">…</span> : <ArrowUp size={15} strokeWidth={2.5} />}
          </button>
        </div>
      </div>
    </div>
  )
}
