import { BrowserWindow } from 'electron'
import { getDb } from '../../db'
import { addDataObserver, addExitObserver, writeTerminal, hasLiveTerminal } from '../pty-manager'
import { recordMailbox } from './mailbox'
import { getOrCreateProjectId, createTask, listTasks, getTask, updateTask } from './task-store'
import { isGitRepo, worktreeDir, branchFor, refreshWorktreeToHead, branchEvidence } from '../worktrees'
import { enqueueMergeBack } from './merge-back'
import type { OrchestratorEvent, TaskStatus, Workspace } from '../../../shared/types'

// Exécuteur de flotte. L'orchestration EST pilotée par le terminal orchestrateur dédié (claude opus +
// ultracode, cf. workspaces.ipc / OrchestratorPanel), qui découpe le goal, assigne des sous-tasks aux
// workers via MCP (assign_task), review leur travail, puis approuve (approve_task → merge-back). Ce module
// ne contient donc plus de décomposeur ni de machine à états reviewer : juste l'exécution des commandes
// MCP sur les PTY + l'état busy + le réveil de l'orchestrateur quand un worker signale la fin (report_task).

const INJECT_ENTER_DELAY = 200 // ms : laisser claude consommer le paste avant l'Entrée séparée

const terminalBusy = new Map<string, string | null>() // terminalId -> taskId | null
const terminalLastData = new Map<string, number>() // terminalId -> dernier flux (ts) — pour l'interruption
const interrupting = new Set<string>() // terminaux en cours d'ESC (non réutilisables)
let observerInstalled = false

// ---- helpers ----
function broadcast(e: OrchestratorEvent): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('orchestrator:event', e)
}
function emitTasks(workspaceId: string): void {
  broadcast({ type: 'tasks', workspaceId, tasks: listTasks(workspaceId) })
}
function getWorkspace(id: string): Workspace | undefined {
  return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace | undefined
}
// Workers seulement : le terminal orchestrateur (role='orchestrator', pane_index -1) n'est PAS une cible
// de dispatch — on l'exclut partout (résolution par position #N, libération, etc.).
function terminalIds(workspaceId: string): string[] {
  return (
    getDb()
      .prepare(
        "SELECT id FROM terminals WHERE workspace_id = ? AND (role IS NULL OR role != 'orchestrator') ORDER BY pane_index",
      )
      .all(workspaceId) as Array<{ id: string }>
  ).map((r) => r.id)
}
/** Id du terminal orchestrateur dédié d'un workspace (pour le réveiller via injection). null si absent. */
function orchestratorTerminalId(workspaceId: string): string | null {
  return (
    (getDb()
      .prepare("SELECT id FROM terminals WHERE workspace_id = ? AND role = 'orchestrator' LIMIT 1")
      .pluck()
      .get(workspaceId) as string | undefined) ?? null
  )
}
function terminalName(id: string | null): string {
  if (!id) return '?'
  return (
    (getDb().prepare('SELECT name FROM terminals WHERE id = ?').pluck().get(id) as string | undefined) ??
    id.slice(0, 6)
  )
}
function freeTerminalForTask(taskId: string): void {
  for (const [tid, busy] of terminalBusy) if (busy === taskId) terminalBusy.set(tid, null)
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Interrompt un agent (double ESC : le TUI claude a parfois besoin de deux pour casser un tour en cours),
 * puis attend ~600 ms de silence (cap 3 s). Gate via `interrupting` pour ne pas réassigner un PTY encore
 * en train de répondre. Fire-and-forget.
 */
async function interruptTerminal(id: string): Promise<void> {
  if (!hasLiveTerminal(id)) return
  interrupting.add(id)
  try {
    writeTerminal(id, '\x1b')
    await delay(120)
    if (hasLiveTerminal(id)) writeTerminal(id, '\x1b')
    const start = Date.now()
    while (Date.now() - start < 3000) {
      await delay(200)
      if (Date.now() - (terminalLastData.get(id) ?? 0) > 600) break
    }
  } finally {
    interrupting.delete(id)
  }
}

/** Aplati un prompt multi-ligne en UNE ligne (le PTY claude en bracketed-paste soumettrait sur un \n). */
function oneLinePrompt(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
/** Écrit une ligne dans un PTY puis l'Entrée comme événement séparé (claude TUI = bracketed paste). */
function pasteLine(terminalId: string, line: string): void {
  writeTerminal(terminalId, line)
  setTimeout(() => {
    if (hasLiveTerminal(terminalId)) writeTerminal(terminalId, '\r')
  }, INJECT_ENTER_DELAY)
}
/** Résout un worker par nom (« Nell ») ou position (« #2 ») parmi les terminaux du workspace. */
function resolveWorker(workspaceId: string, ref: string): string {
  const ids = terminalIds(workspaceId)
  const r = ref.trim().replace(/^#/, '')
  let id: string | undefined
  const idx = Number(r)
  if (Number.isInteger(idx) && idx >= 1 && idx <= ids.length) id = ids[idx - 1]
  if (!id) id = ids.find((x) => terminalName(x).toLowerCase() === r.toLowerCase())
  if (!id) throw new Error(`terminal « ${ref} » introuvable`)
  if (!hasLiveTerminal(id)) throw new Error(`terminal « ${terminalName(id)} » hors-ligne`)
  if (interrupting.has(id)) throw new Error(`terminal « ${terminalName(id)} » en cours d'interruption`)
  return id
}

// ---- cycle de vie ----
export function initOrchestrator(): void {
  if (observerInstalled) return
  observerInstalled = true
  addDataObserver((id) => terminalLastData.set(id, Date.now()))
  addExitObserver((id) => {
    terminalBusy.delete(id)
    terminalLastData.delete(id)
  })
}

// ---- API tasks (panneau Tasks : drag-drop de statut) ----
export function setTaskStatus(taskId: string, status: TaskStatus): void {
  const t = getTask(taskId)
  if (!t) return
  updateTask(taskId, { status })
  if (status === 'complete' || status === 'cancelled' || status === 'todo') freeTerminalForTask(taskId)
  if (t.workspace_id) emitTasks(t.workspace_id)
}

/** Stoppe le travail en cours d'un workspace : interrompt les workers occupés + remet les tasks en todo. */
export function stopSwarm(workspaceId: string): void {
  for (const t of listTasks(workspaceId)) {
    if (t.status === 'in-progress' || t.status === 'in-review') {
      updateTask(t.id, { status: 'todo', assigned_terminal_id: null })
    }
  }
  for (const id of terminalIds(workspaceId)) {
    if (terminalBusy.get(id)) void interruptTerminal(id)
    terminalBusy.set(id, null)
  }
  emitTasks(workspaceId)
}

// ---- API pilotée par les outils MCP ----

/** Poste un message dans la mailbox de l'orchestrateur. Appelé par send_mailbox (MCP tool). */
export function agentMailbox(workspaceId: string, fromAgent: string | null, body: string): void {
  const msg = recordMailbox(workspaceId, fromAgent, body)
  broadcast({ type: 'mailbox', workspaceId, message: msg })
}

/**
 * assign_task (MCP) : l'orchestrateur donne une sous-task à UN worker. Crée la task en DB (in-progress),
 * rafraîchit le worktree du worker à MAIN-HEAD, puis injecte le prompt. Le worker signalera la fin via
 * report_task. Renvoie le terminal résolu + l'id de task (que l'orchestrateur approuvera ensuite).
 */
export function agentAssignTask(
  workspaceId: string,
  terminalRef: string,
  instructions: string,
  title?: string,
): { terminal: string; taskId: string } {
  const ws = getWorkspace(workspaceId)
  if (!ws) throw new Error(`Workspace ${workspaceId} introuvable`)
  const id = resolveWorker(workspaceId, terminalRef)
  const projectId = getOrCreateProjectId(ws.name, ws.project_path)
  const task = createTask({
    workspaceId,
    projectId,
    title: (title && title.trim()) || instructions.slice(0, 80),
    role: 'builder',
    instructions,
    dependsOn: [],
  })
  updateTask(task.id, { status: 'in-progress', assigned_terminal_id: id })
  terminalBusy.set(id, task.id)
  // Anti stale-fork : amène le worktree du worker à MAIN-HEAD (inclut les tasks déjà mergées). No-op si à jour.
  if (isGitRepo(ws.project_path)) refreshWorktreeToHead(ws.project_path, terminalName(id))
  const prompt = oneLinePrompt(
    [
      `[task ${task.id}]`,
      instructions,
      'You are a FOCUSED IMPLEMENTATION WORKER, not an orchestrator: do ONLY the task above — never orchestrate, never ask the user what to do, never wait for further direction.',
      'Work EXCLUSIVELY inside your current git worktree (a full mirror of the repo). NEVER `cd` to another directory and never edit files outside this worktree — the main project tree and the other agents’ worktrees are OFF-LIMITS.',
      'Touch only the files the task names; make surgical changes; respect repo conventions; never run destructive commands.',
      'Do NOT read shared/session memory (it is orchestrator context, not your task). Use search_memories ONLY if the task explicitly asks you to.',
      'When the task is GENUINELY finished: commit your changes to your branch, confirm with `git status`/`git diff` that the work is actually present, then call report_task with status "done" (or "blocked" if you truly cannot proceed) and a truthful one-line summary. NEVER report "done" unless the committed diff really contains the changes.',
    ].join(' '),
  )
  pasteLine(id, prompt)
  emitTasks(workspaceId)
  return { terminal: terminalName(id), taskId: task.id }
}

/**
 * report_task (MCP) : un worker signale la fin de sa task. On libère le terminal, passe la task en
 * 'in-review' (ou 'blocked'), et on RÉVEILLE le terminal orchestrateur en lui injectant une notification
 * (un agent interactif ne reçoit rien passivement). L'état task reste durable (panneau Tasks) en repli.
 */
export function agentReportTask(
  workspaceId: string,
  fromAgent: string | null,
  status: string,
  summary: string,
): { ok: boolean; taskId?: string } {
  const ids = terminalIds(workspaceId)
  const termId = fromAgent
    ? ids.find((x) => terminalName(x).toLowerCase() === fromAgent.toLowerCase())
    : undefined
  // Task in-progress la plus récente de ce worker.
  const task = [...listTasks(workspaceId)]
    .reverse()
    .find((t) => t.assigned_terminal_id === termId && t.status === 'in-progress')
  const blocked = status.toLowerCase() === 'blocked'

  // PORTE À PREUVES (F4/F8) : on lit l'état git RÉEL de la branche du worker, jamais sa seule prose.
  const ws = getWorkspace(workspaceId)
  const ev = ws && fromAgent && isGitRepo(ws.project_path) ? branchEvidence(ws.project_path, fromAgent) : null

  // Un "done" sur une branche VIDE (0 commit + worktree propre = aucun travail) est REJETÉ : task gardée
  // in-progress, worker renvoyé committer, et orchestrateur prévenu (jamais d'acceptation muette du rapport).
  if (!blocked && task && fromAgent && ev && ev.empty) {
    if (termId && hasLiveTerminal(termId)) {
      pasteLine(
        termId,
        oneLinePrompt(
          `[oryon evidence-gate] Rapport "done" REJETÉ : ta branche ${branchFor(fromAgent)} est à 0 commit d'avance et ton worktree est propre — AUCUN travail trouvé. Si tu as fait le travail, COMMITE-le dans CE worktree (jamais ailleurs) puis re-appelle report_task ; sinon report_task status:"blocked" avec la raison.`,
        ),
      )
    }
    emitTasks(workspaceId)
    const orchE = orchestratorTerminalId(workspaceId)
    if (orchE && hasLiveTerminal(orchE)) {
      pasteLine(
        orchE,
        oneLinePrompt(
          `[oryon] ⚠ ${fromAgent} a rapporté "done" mais sa branche est VIDE (0 commit, worktree propre)${ev.mainDirty ? ' ET le tronc principal est SALE (contamination probable — il a peut-être édité MAIN au lieu de son worktree)' : ''}. Rapport rejeté, worker invité à committer. Inspecte (get_terminal_output ${fromAgent}) ou réassigne.`,
        ),
      )
    }
    return { ok: true, taskId: task.id }
  }

  if (task) updateTask(task.id, { status: blocked ? 'blocked' : 'in-review' }) // garde assigned_terminal_id → merge à l'approbation
  if (termId) terminalBusy.set(termId, null)
  broadcast({
    type: 'mailbox',
    workspaceId,
    message: recordMailbox(workspaceId, fromAgent, `${status}${summary ? ' — ' + summary : ''}`),
  })
  emitTasks(workspaceId)
  // Réveille l'orchestrateur AVEC l'évidence git machine à côté de la prose du worker (F4/F8) + alerte contamination (F3).
  const orch = orchestratorTerminalId(workspaceId)
  if (orch && hasLiveTerminal(orch)) {
    const wt = fromAgent ? ` Inspecte: git -C .oryon/agents/${fromAgent.toLowerCase()} diff.` : ''
    const tid = task ? ` [taskId=${task.id}]` : ''
    let evidence = ''
    if (ev) {
      evidence = ` [preuve: ${ev.ahead} commit(s), ${ev.filesChanged.length} fichier(s)${ev.worktreeDirty ? ', worktree non commité' : ''}${ev.empty ? ' ⚠ BRANCHE VIDE' : ''}]`
      if (ev.mainDirty) evidence += ' ⚠ TRONC PRINCIPAL SALE — contamination possible (un worker a peut-être édité MAIN)'
    }
    const wake = oneLinePrompt(
      `[oryon] ${fromAgent ?? 'un worker'} a terminé "${task?.title ?? ''}" (${status})${tid}: ${summary}.${evidence}${wt} Vérifie le diff puis approve_task si OK, sinon réassigne avec un feedback précis.`,
    )
    pasteLine(orch, wake)
  }
  return { ok: true, taskId: task?.id }
}

/**
 * approve_task (MCP) : l'orchestrateur valide une task revue → 'complete' + merge-back de la branche du
 * worker vers le tronc principal (sérialisé + conflict-safe, cf. enqueueMergeBack). Réutilise l'intégration
 * existante (rebase-before-merge, green-gate, branche conservée sur conflit).
 */
export function agentApproveTask(taskId: string): { ok: boolean; message: string } {
  const t = getTask(taskId)
  if (!t) return { ok: false, message: `task ${taskId} introuvable` }
  const wsId = t.workspace_id
  if (wsId) {
    const ws = getWorkspace(wsId)
    if (ws && isGitRepo(ws.project_path) && t.assigned_terminal_id) {
      const agent = terminalName(t.assigned_terminal_id)
      // État HONNÊTE (F7/F8) : on NE passe PAS 'complete' tout de suite — uniquement quand le merge ATTERRIT
      // (onDone). Sur conflit/defer, la task RETOURNE en 'in-review' pour que l'orchestrateur la reprenne
      // (le message système onConflict explique la raison). Évite l'illusion 'complete' sur branche non mergée.
      void enqueueMergeBack({
        mainPath: ws.project_path,
        worktree: worktreeDir(ws.project_path, agent),
        branch: branchFor(agent),
        agent,
        task: t.title ?? 'task',
        onDone: (m) => {
          updateTask(taskId, { status: 'complete' })
          emitTasks(wsId)
          agentMailbox(wsId, 'système', m)
        },
        onConflict: (m) => {
          updateTask(taskId, { status: 'in-review' })
          emitTasks(wsId)
          agentMailbox(wsId, 'système', m)
        },
      })
      emitTasks(wsId)
      return {
        ok: true,
        message: `task « ${t.title ?? taskId} » approuvée → merge-back enfilé (statut 'complete' seulement après merge réussi)`,
      }
    }
    // Pas de git / pas de worktree → complétion directe.
    updateTask(taskId, { status: 'complete' })
    emitTasks(wsId)
  } else {
    updateTask(taskId, { status: 'complete' })
  }
  return { ok: true, message: `task « ${t.title ?? taskId} » approuvée` }
}

/**
 * broadcast_command (MCP) : injecte une commande (slash-command claude comme /effort high ou /model opus,
 * ou une instruction libre) dans TOUS les workers vivants, ou un seul via `terminalRef`. Sert à régler
 * l'effort / le modèle / les réglages des terminaux (ce que assign_task ne fait pas).
 */
export function agentBroadcastCommand(
  workspaceId: string,
  command: string,
  terminalRef?: string,
): { count: number; command: string } {
  // « ultracode »/« ultra » n'est pas un niveau valide (le CLI claude : low|medium|high|max) — on mappe
  // sur le sommet, /effort max, pour que « mets-les en ultracode » fasse ce que l'utilisateur attend.
  const mapped = /^\/?(effort\s+)?(ultra|ultracode)$/i.test(command.trim()) ? '/effort max' : command
  const line = oneLinePrompt(mapped)
  const targets = terminalRef
    ? [resolveWorker(workspaceId, terminalRef)]
    : terminalIds(workspaceId).filter((id) => hasLiveTerminal(id) && !interrupting.has(id))
  for (const id of targets) pasteLine(id, line)
  if (terminalRef && targets.length) agentMailbox(workspaceId, 'orchestrateur', `\`${line}\` → ${terminalName(targets[0])}`)
  else agentMailbox(workspaceId, 'orchestrateur', `\`${line}\` → ${targets.length} worker(s)`)
  return { count: targets.length, command: line }
}
