import { create } from 'zustand'
import type { Workspace, Terminal, TerminalStatus, Task, MailboxMessage } from '@shared/types'

interface AppStore {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  /** Terminaux du workspace actif (montés dans la grille). */
  terminals: Terminal[]
  statuses: Record<string, TerminalStatus>
  focusedTerminalId: string | null
  maximizedTerminalId: string | null
  /** workspaceId -> nombre de terminaux (badges du rail). */
  terminalCounts: Record<string, number>

  /** Orchestrateur (workspace actif). */
  tasks: Task[]
  mailbox: MailboxMessage[]
  setTasks: (t: Task[]) => void
  setMailbox: (m: MailboxMessage[]) => void
  addMailbox: (m: MailboxMessage) => void

  /** Contexte projet pour le boost vocal DYNAMIQUE (INC3) — éphémère, jamais persisté. */
  projectVocab: string[] // identifiants + stems de fichiers (boost transcription)
  projectFiles: string[] // basenames (file-tagging « tag X » → « @X »)
  setProjectContext: (terms: string[], files: string[]) => void

  setWorkspaces: (ws: Workspace[]) => void
  setActiveWorkspace: (id: string | null) => void
  setTerminals: (t: Terminal[]) => void
  addTerminal: (t: Terminal) => void
  removeTerminal: (id: string) => void
  setStatus: (id: string, s: TerminalStatus) => void
  setFocused: (id: string | null) => void
  toggleMaximize: (id: string) => void
  setTerminalCounts: (c: Record<string, number>) => void
  bumpCount: (workspaceId: string, delta: number) => void
}

export const useAppStore = create<AppStore>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  terminals: [],
  statuses: {},
  focusedTerminalId: null,
  maximizedTerminalId: null,
  terminalCounts: {},
  tasks: [],
  mailbox: [],
  projectVocab: [],
  projectFiles: [],

  setTasks: (tasks) => set({ tasks }),
  setMailbox: (mailbox) => set({ mailbox }),
  addMailbox: (m) => set((s) => ({ mailbox: [...s.mailbox, m].slice(-200) })),
  setProjectContext: (projectVocab, projectFiles) => set({ projectVocab, projectFiles }),

  setWorkspaces: (workspaces) => set({ workspaces }),
  setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId, maximizedTerminalId: null }),
  setTerminals: (terminals) =>
    set({ terminals, focusedTerminalId: terminals[0]?.id ?? null, maximizedTerminalId: null }),
  addTerminal: (t) => set((s) => ({ terminals: [...s.terminals, t], focusedTerminalId: t.id })),
  removeTerminal: (id) =>
    set((s) => {
      const idx = s.terminals.findIndex((t) => t.id === id)
      const remaining = s.terminals.filter((t) => t.id !== id)
      let focusedTerminalId = s.focusedTerminalId
      if (focusedTerminalId === id) {
        // Auto-focus le terminal adjacent (suivant, sinon précédent).
        focusedTerminalId = (remaining[idx] ?? remaining[idx - 1] ?? remaining[0])?.id ?? null
      }
      return {
        terminals: remaining,
        focusedTerminalId,
        maximizedTerminalId: s.maximizedTerminalId === id ? null : s.maximizedTerminalId,
      }
    }),
  setStatus: (id, st) => set((s) => ({ statuses: { ...s.statuses, [id]: st } })),
  setFocused: (focusedTerminalId) => set({ focusedTerminalId }),
  toggleMaximize: (id) =>
    set((s) => ({ maximizedTerminalId: s.maximizedTerminalId === id ? null : id })),
  setTerminalCounts: (terminalCounts) => set({ terminalCounts }),
  bumpCount: (wid, delta) =>
    set((s) => ({
      terminalCounts: { ...s.terminalCounts, [wid]: Math.max(0, (s.terminalCounts[wid] ?? 0) + delta) },
    })),
}))
