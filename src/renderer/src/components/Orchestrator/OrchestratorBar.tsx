import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Mic, ArrowUp, Sparkles, Square, ChevronDown, ChevronUp, History, Zap, ListChecks, Wand2, RotateCcw } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { useVoice } from '../../hooks/useVoice'
import { useVoiceCommand } from '../../hooks/useVoiceCommand'
import { toast } from '../../store/toasts'
import { useAppStore } from '../../store'
import { cn } from '../../lib/cn'
import { transitionFast } from '../../lib/motion'
import type { TaskStatus, SubmitMode } from '@shared/types'

const STATUS_DOT: Record<TaskStatus, string> = {
  proposed: '#a78bfa',
  todo: 'var(--fg-subtle)',
  'in-progress': '#3b82f6',
  'in-review': 'var(--warning)',
  complete: 'var(--accent)',
  cancelled: 'var(--danger)',
}

const MODES: { id: SubmitMode; label: string; icon: typeof Zap; title: string }[] = [
  { id: 'direct', label: 'Direct', icon: Zap, title: 'Direct : découpage local instantané (1 ligne/élément = 1 agent)' },
  { id: 'ai', label: 'AI', icon: Sparkles, title: 'AI : compréhension d’intention + décomposition LLM, auto-dispatch' },
  { id: 'plan', label: 'Plan', icon: ListChecks, title: 'Plan : propose des étapes à approuver avant dispatch (panneau Plan)' },
]

const HISTORY_KEY = (wid: string) => `bf:goalHistory:${wid}`

// Couleur de l'auteur dans la mailbox : l'interprétation d'intention ressort (accent), les notices
// système s'effacent (subtle), les agents prennent un bleu doux distinct du travail réel.
function authorClass(from: string | null): string {
  if (from === 'intention') return 'text-accent'
  if (from === 'système') return 'text-fg-subtle'
  return 'text-[#7aa2f7]'
}

export default function OrchestratorBar() {
  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)
  const [history, setHistory] = useState<string[]>([])
  const [histOpen, setHistOpen] = useState(false)
  const [mode, setModeState] = useState<SubmitMode>('direct')
  const inputRef = useRef<HTMLInputElement>(null)
  // Auto-add ✨ (INC4) : snapshot du champ juste après une dictée. Si l'utilisateur l'édite avant submit,
  // on apprend les termes corrigés. Effacé au submit / à un choix d'historique (édition non liée à la dictée).
  const dictatedRef = useRef<string | null>(null)
  // Dictée vocale → ajoute le texte transcrit dans l'input de l'orchestrateur.
  const voice = useVoice((t) => {
    setInput((v) => {
      const next = (v.trim() ? v.trim() + ' ' : '') + t
      dictatedRef.current = next
      return next
    })
    inputRef.current?.focus()
  }, 'orchestrator')

  // Command mode (INC9) : la voix transforme la sélection / insère au curseur dans le champ. Undo dispo.
  const cmdUndoRef = useRef<string | null>(null)
  const [showUndo, setShowUndo] = useState(false)
  const cmd = useVoiceCommand({
    getSelection: () => {
      const el = inputRef.current
      if (!el) return null
      return { value: el.value, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length }
    },
    applyResult: (result, sel) => {
      cmdUndoRef.current = sel.value
      setInput(sel.value.slice(0, sel.start) + result + sel.value.slice(sel.end))
      setShowUndo(true)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) {
          el.focus()
          const pos = sel.start + result.length
          el.setSelectionRange(pos, pos)
        }
      })
    },
  })
  const undoCommand = () => {
    if (cmdUndoRef.current != null) setInput(cmdUndoRef.current)
    cmdUndoRef.current = null
    setShowUndo(false)
  }
  // L'undo s'efface après quelques secondes.
  useEffect(() => {
    if (!showUndo) return
    const t = setTimeout(() => setShowUndo(false), 8000)
    return () => clearTimeout(t)
  }, [showUndo])

  // Mode de décomposition persisté (défaut : Direct/instantané).
  useEffect(() => {
    const saved = localStorage.getItem('bf:orchMode')
    if (saved === 'direct' || saved === 'ai' || saved === 'plan') setModeState(saved)
  }, [])
  const setMode = (m: SubmitMode) => {
    setModeState(m)
    localStorage.setItem('bf:orchMode', m)
  }
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const tasks = useAppStore((s) => s.tasks)
  const mailbox = useAppStore((s) => s.mailbox)
  // Les étapes 'proposed' (mode Plan) vivent dans le panneau Plan, pas dans le bandeau Swarm.
  const swarmTasks = tasks.filter((t) => t.status !== 'proposed')

  // Historique des prompts persisté par workspace.
  useEffect(() => {
    setHistOpen(false)
    if (!activeWorkspaceId) {
      setHistory([])
      return
    }
    try {
      const raw = localStorage.getItem(HISTORY_KEY(activeWorkspaceId))
      setHistory(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      setHistory([])
    }
  }, [activeWorkspaceId])

  const pushHistory = (goal: string) => {
    if (!activeWorkspaceId) return
    const next = [goal, ...history.filter((g) => g !== goal)].slice(0, 50)
    setHistory(next)
    localStorage.setItem(HISTORY_KEY(activeWorkspaceId), JSON.stringify(next))
  }

  const handleSubmit = async () => {
    const goal = input.trim()
    if (!goal || !activeWorkspaceId || busy) return
    // Auto-add ✨ : si une dictée a été éditée avant l'envoi, apprends les termes corrigés (fire-and-forget).
    const dictated = dictatedRef.current
    dictatedRef.current = null
    if (dictated && dictated.trim() !== goal) void window.bridge.voice.learnFromEdit(dictated.trim(), goal, 'orchestrator')
    setBusy(true)
    setInput('')
    try {
      await window.bridge.orchestrator.submit(activeWorkspaceId, goal, mode)
      pushHistory(goal)
      setOpen(true)
    } catch (e) {
      toast.error((e as Error).message, { title: 'Décomposition échouée' })
    } finally {
      setBusy(false)
    }
  }

  const stop = () => {
    if (activeWorkspaceId) void window.bridge.orchestrator.stop(activeWorkspaceId)
  }

  const pickHistory = (g: string) => {
    dictatedRef.current = null // choix d'historique ≠ édition d'une dictée
    setInput(g)
    setHistOpen(false)
    inputRef.current?.focus()
  }

  return (
    <div className="shrink-0 border-t border-border bg-bg-panel">
      {/* Panneau swarm (plan + mailbox) */}
      <AnimatePresence initial={false}>
        {swarmTasks.length > 0 && open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transitionFast}
            className="overflow-hidden border-b border-border"
          >
            <div className="grid grid-cols-2 gap-px bg-border">
              <div className="max-h-44 overflow-y-auto bg-bg-panel p-2">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                    Swarm · {swarmTasks.length}
                  </span>
                  <button
                    onClick={stop}
                    className="flex items-center gap-1 text-[10px] text-fg-subtle transition-colors hover:text-danger"
                  >
                    <Square size={9} />
                    Stop
                  </button>
                </div>
                <div className="space-y-0.5">
                  {swarmTasks.map((t, i) => (
                    <div key={t.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px]">
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: STATUS_DOT[t.status] }}
                        title={t.status}
                      />
                      <span className="shrink-0 tabular-nums text-fg-subtle">#{i + 1}</span>
                      <span className="flex-1 truncate text-fg-muted">{t.title}</span>
                      <span className="shrink-0 text-[9px] uppercase tracking-wide text-fg-subtle">{t.role}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="max-h-44 overflow-y-auto bg-bg-panel p-2">
                <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                  Mailbox
                </span>
                {mailbox.length === 0 ? (
                  <p className="text-[10px] text-fg-subtle">Aucun message</p>
                ) : (
                  <div className="space-y-0.5 font-mono">
                    {mailbox.slice(-40).map((m) => (
                      <div key={m.id} className="text-[10px] leading-snug">
                        <span className={cn('font-medium', authorClass(m.from_agent))}>{m.from_agent}</span>{' '}
                        <span className="text-fg-muted">{m.body}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input + dropup historique */}
      <div className="relative px-3 py-2.5">
        <AnimatePresence>
          {histOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setHistOpen(false)} />
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={transitionFast}
                className="absolute inset-x-3 bottom-full z-50 mb-2 max-h-64 overflow-y-auto rounded-lg border border-border bg-bg-elevated shadow-lg"
              >
                <div className="sticky top-0 border-b border-border bg-bg-elevated px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                  Historique des prompts
                </div>
                {history.length === 0 ? (
                  <p className="px-3 py-3 text-[11px] text-fg-subtle">Aucun prompt encore</p>
                ) : (
                  history.map((g, i) => (
                    <button
                      key={i}
                      onClick={() => pickHistory(g)}
                      className="block w-full truncate px-3 py-2 text-left text-[12px] text-fg-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
                    >
                      {g}
                    </button>
                  ))
                )}
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Bandeau command mode (INC9) : écoute / transformation / undo */}
        {(cmd.state !== 'idle' || showUndo) && (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px]">
            {cmd.state === 'listening' && (
              <span className="flex items-center gap-1.5 text-accent">
                <Wand2 size={12} />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" />
                Mode commande — parle, puis re-appuie le raccourci ·{' '}
                <span className="rounded border border-border px-1 text-fg-subtle">Échap</span> annule
              </span>
            )}
            {cmd.state === 'processing' && (
              <span className="flex items-center gap-1.5 text-warning">
                <Wand2 size={12} className="animate-pulse" /> Transformation…
                {cmd.slow && <span className="text-fg-subtle">plus long que d'habitude…</span>}
              </span>
            )}
            {cmd.state === 'idle' && showUndo && (
              <>
                <span className="text-fg-subtle">Commande appliquée.</span>
                <button
                  onClick={undoCommand}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent transition-colors hover:bg-hover"
                >
                  <RotateCcw size={11} /> Annuler
                </button>
              </>
            )}
          </div>
        )}

        <div
          className={cn(
            'flex items-center gap-2 rounded-lg border bg-bg-inset px-2.5 py-1.5',
            'transition-colors duration-fast ease-out',
            cmd.state !== 'idle' ? 'border-accent shadow-ring' : focused ? 'border-accent shadow-ring' : 'border-border',
          )}
        >
          <IconButton
            label="Historique des prompts"
            size="sm"
            active={histOpen}
            onClick={() => setHistOpen((o) => !o)}
          >
            <History size={15} />
          </IconButton>
          <div className="flex shrink-0 items-center rounded-md border border-border bg-bg-panel p-0.5">
            {MODES.map((m) => {
              const Icon = m.icon
              const isActive = mode === m.id
              return (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  title={m.title}
                  className={cn(
                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors duration-fast',
                    isActive ? 'bg-accent-soft text-accent' : 'text-fg-subtle hover:text-fg',
                  )}
                >
                  <Icon size={11} />
                  {m.label}
                </button>
              )
            })}
          </div>
          <input
            ref={inputRef}
            aria-label="But à donner à l'orchestrateur"
            className="flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-subtle"
            placeholder={
              busy && mode !== 'direct'
                ? 'Décomposition en cours…'
                : activeWorkspaceId
                  ? "Dis à l'orchestrateur ce qu'il faut construire…"
                  : 'Sélectionne un workspace pour orchestrer…'
            }
            value={input}
            disabled={!activeWorkspaceId || busy}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSubmit()
              }
            }}
          />
          {swarmTasks.length > 0 && (
            <IconButton
              label={open ? 'Masquer le swarm' : 'Afficher le swarm'}
              size="sm"
              onClick={() => setOpen((o) => !o)}
            >
              {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </IconButton>
          )}
          <IconButton
            label={cmd.state !== 'idle' ? 'Micro occupé par le command mode' : voice.state === 'listening' ? 'Arrêter la dictée' : 'Dictée vocale'}
            size="sm"
            active={voice.state !== 'idle'}
            disabled={cmd.state !== 'idle'}
            onClick={voice.toggle}
          >
            <Mic
              size={15}
              className={cn(
                voice.state === 'listening' && 'animate-pulse text-danger',
                voice.state === 'processing' && 'text-warning',
              )}
            />
          </IconButton>
          <IconButton
            label={voice.state !== 'idle' ? 'Micro occupé par la dictée' : cmd.state === 'listening' ? 'Arrêter la commande' : 'Commande vocale (transforme la sélection)'}
            size="sm"
            active={cmd.state !== 'idle'}
            disabled={voice.state !== 'idle'}
            onClick={cmd.toggle}
          >
            <Wand2
              size={15}
              className={cn(
                cmd.state === 'listening' && 'animate-pulse text-accent',
                cmd.state === 'processing' && 'text-warning',
              )}
            />
          </IconButton>
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || !activeWorkspaceId || busy}
            aria-label="Envoyer"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded bg-accent text-on-accent',
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
