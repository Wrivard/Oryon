import { create } from 'zustand'
import type { Workspace, Terminal, TerminalStatus, Task, MailboxMessage } from '@shared/types'

interface AppStore {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  /** Terminaux montés, indexés par workspace. Tous les workspaces visités cette session restent
   *  présents (leurs <Terminal> restent montés → PTY + scrollback xterm vivants en arrière-plan). */
  terminalsByWorkspace: Record<string, Terminal[]>
  /** Workspaces déjà activés cette session : montés en parallèle, JAMAIS retirés au switch. */
  openWorkspaceIds: string[]
  statuses: Record<string, TerminalStatus>
  focusedTerminalId: string | null
  maximizedTerminalId: string | null
  /** workspaceId -> nombre de terminaux (badges du rail). */
  terminalCounts: Record<string, number>
  /** workspaceId -> swarm avec du travail en cours (tâches in-progress/in-review) → pastille d'activité du rail. */
  workspaceActivity: Record<string, boolean>

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

  /** Demande d'ouverture d'un fichier dans l'éditeur (inspect→code du Browser). nonce = re-déclenche. */
  openFileRequest: { path: string; line?: number; nonce: number } | null
  requestOpenFile: (path: string, line?: number) => void

  setWorkspaces: (ws: Workspace[]) => void
  setActiveWorkspace: (id: string | null) => void
  /** Marque un workspace comme ouvert (monté en arrière-plan). Idempotent ; jamais retiré au switch. */
  openWorkspace: (id: string) => void
  setTerminals: (workspaceId: string, t: Terminal[]) => void
  addTerminal: (t: Terminal) => void
  removeTerminal: (id: string) => void
  setStatus: (id: string, s: TerminalStatus) => void
  setFocused: (id: string | null) => void
  toggleMaximize: (id: string) => void
  setTerminalCounts: (c: Record<string, number>) => void
  bumpCount: (workspaceId: string, delta: number) => void
  /** Active/éteint la pastille d'activité d'un workspace (swarm de fond). No-op si inchangé. */
  setWorkspaceActivity: (id: string, active: boolean) => void
}

export const useAppStore = create<AppStore>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  terminalsByWorkspace: {},
  openWorkspaceIds: [],
  statuses: {},
  focusedTerminalId: null,
  maximizedTerminalId: null,
  terminalCounts: {},
  workspaceActivity: {},
  tasks: [],
  mailbox: [],
  projectVocab: [],
  projectFiles: [],
  openFileRequest: null,

  setTasks: (tasks) => set({ tasks }),
  setMailbox: (mailbox) => set({ mailbox }),
  addMailbox: (m) => set((s) => ({ mailbox: [...s.mailbox, m].slice(-200) })),
  setProjectContext: (projectVocab, projectFiles) => set({ projectVocab, projectFiles }),
  requestOpenFile: (path, line) =>
    set((s) => ({ openFileRequest: { path, line, nonce: (s.openFileRequest?.nonce ?? 0) + 1 } })),

  setWorkspaces: (workspaces) => set({ workspaces }),
  setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId, maximizedTerminalId: null }),
  openWorkspace: (id) =>
    set((s) => (s.openWorkspaceIds.includes(id) ? {} : { openWorkspaceIds: [...s.openWorkspaceIds, id] })),
  // Pose les terminaux d'UN workspace (clé = workspaceId). N'altère plus le focus : à l'activation
  // c'est TerminalGrid qui le pilote (un workspace de fond ne doit pas voler le focus).
  setTerminals: (workspaceId, terminals) =>
    set((s) => ({ terminalsByWorkspace: { ...s.terminalsByWorkspace, [workspaceId]: terminals } })),
  addTerminal: (t) =>
    set((s) => ({
      terminalsByWorkspace: {
        ...s.terminalsByWorkspace,
        [t.workspace_id]: [...(s.terminalsByWorkspace[t.workspace_id] ?? []), t],
      },
      focusedTerminalId: t.id,
    })),
  removeTerminal: (id) =>
    set((s) => {
      const wsId = Object.keys(s.terminalsByWorkspace).find((w) =>
        s.terminalsByWorkspace[w].some((t) => t.id === id),
      )
      if (!wsId) return {}
      const list = s.terminalsByWorkspace[wsId]
      const idx = list.findIndex((t) => t.id === id)
      const remaining = list.filter((t) => t.id !== id)
      let focusedTerminalId = s.focusedTerminalId
      if (focusedTerminalId === id) {
        // Auto-focus le terminal adjacent (suivant, sinon précédent).
        focusedTerminalId = (remaining[idx] ?? remaining[idx - 1] ?? remaining[0])?.id ?? null
      }
      return {
        terminalsByWorkspace: { ...s.terminalsByWorkspace, [wsId]: remaining },
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
  setWorkspaceActivity: (id, active) =>
    set((s) => (s.workspaceActivity[id] === active ? {} : { workspaceActivity: { ...s.workspaceActivity, [id]: active } })),
}))
