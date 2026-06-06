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

  /** Demande d'ouverture d'une URL dans le panneau Browser (commande MCP open_browser). nonce = re-déclenche. */
  browserOpenRequest: { workspaceId: string; url: string; nonce: number } | null
  requestOpenBrowser: (workspaceId: string, url: string) => void

  setWorkspaces: (ws: Workspace[]) => void
  /** Remplace en place un workspace édité (nom/couleur) dans la liste. */
  patchWorkspace: (ws: Workspace) => void
  /** Retire un workspace supprimé : nettoie terminaux/activité/compteurs/ouverts et réassigne l'actif. */
  removeWorkspace: (id: string) => void
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

  /** Vue Calendar active (entrée du rail au-dessus des workspaces) : true = grand calendrier, false = grilles terminaux. */
  calendarMode: boolean
  setCalendarMode: (enabled: boolean) => void

  /** Vue System Feedback active (entrée du rail) : true = revue des rapports système (cross-workspace), false = grilles/calendrier. */
  feedbackMode: boolean
  setFeedbackMode: (enabled: boolean) => void
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
  calendarMode: false,
  feedbackMode: false,
  tasks: [],
  mailbox: [],
  projectVocab: [],
  projectFiles: [],
  openFileRequest: null,
  browserOpenRequest: null,

  setTasks: (tasks) => set({ tasks }),
  setMailbox: (mailbox) => set({ mailbox }),
  addMailbox: (m) => set((s) => ({ mailbox: [...s.mailbox, m].slice(-200) })),
  setProjectContext: (projectVocab, projectFiles) => set({ projectVocab, projectFiles }),
  requestOpenFile: (path, line) =>
    set((s) => ({ openFileRequest: { path, line, nonce: (s.openFileRequest?.nonce ?? 0) + 1 } })),
  // open_browser (MCP) : ramène le workspace au premier plan + arme la requête (RightPanel bascule sur
  // l'onglet Browser, BrowserPanel navigue le webview). Même schéma que openFileRequest (inspect→code).
  requestOpenBrowser: (workspaceId, url) =>
    set((s) => ({
      activeWorkspaceId: workspaceId,
      maximizedTerminalId: null,
      browserOpenRequest: { workspaceId, url, nonce: (s.browserOpenRequest?.nonce ?? 0) + 1 },
    })),

  setWorkspaces: (workspaces) => set({ workspaces }),
  patchWorkspace: (ws) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === ws.id ? ws : w)) })),
  removeWorkspace: (id) =>
    set((s) => {
      const terminalsByWorkspace = { ...s.terminalsByWorkspace }
      const workspaceActivity = { ...s.workspaceActivity }
      const terminalCounts = { ...s.terminalCounts }
      delete terminalsByWorkspace[id]
      delete workspaceActivity[id]
      delete terminalCounts[id]
      const workspaces = s.workspaces.filter((w) => w.id !== id)
      const openWorkspaceIds = s.openWorkspaceIds.filter((w) => w !== id)
      // Si on supprime l'actif, on retombe sur le plus récent restant (sinon null → écran « Aucun workspace »).
      const activeWorkspaceId = s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId
      return { workspaces, terminalsByWorkspace, workspaceActivity, terminalCounts, openWorkspaceIds, activeWorkspaceId }
    }),
  // Activer un workspace quitte les vues globales du rail (Calendar / System Feedback) — sélection exclusive.
  setActiveWorkspace: (activeWorkspaceId) =>
    set({ activeWorkspaceId, maximizedTerminalId: null, calendarMode: false, feedbackMode: false }),
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
  // Les deux vues globales du rail sont mutuellement exclusives (une seule à la fois).
  setCalendarMode: (calendarMode) => set({ calendarMode, feedbackMode: false }),
  setFeedbackMode: (feedbackMode) => set({ feedbackMode, calendarMode: false }),
}))
