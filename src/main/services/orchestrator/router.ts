import { app, BrowserWindow } from 'electron'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../../db'
import {
  addDataObserver,
  addExitObserver,
  writeTerminal,
  hasLiveTerminal,
  createTerminal,
  killTerminal,
} from '../pty-manager'
import { ensureClaudeReady, normalizeClaudeAutostart, enforceAgentSpawn } from '../claude-launcher'
import { sweepArchive } from '../archive'
import { recordOutcome } from './outcomes'
import { buildProjectMcpConfigForPath, addConnector } from '../../ipc/settings.ipc'
import { makeCoalescedSender } from '../../ipc/terminals.ipc'
import { recordMailbox } from './mailbox'
import { getOrCreateProjectId, createTask, listTasks, getTask, updateTask } from './task-store'
import {
  isGitRepo,
  worktreeDir,
  branchFor,
  refreshWorktreeToHead,
  branchEvidence,
  ensureWorktree,
  provisionWorktreeDeps,
  ORCHESTRATOR_TASK_FILE,
} from '../worktrees'
import { enqueueMergeBack } from './merge-back'
import { verifyWorktree } from './green-gate'
import { rotateOrchestratorResumeId } from '../claude-session'
import { readClaims, claimFile, releaseClaimsByAgent, CLAIM_TTL_MS } from '../../../shared/memory-core.mjs'
import type { OrchestratorEvent, TaskStatus, Workspace } from '../../../shared/types'

// Exécuteur de flotte. L'orchestration EST pilotée par le terminal orchestrateur dédié (claude opus +
// ultracode, cf. workspaces.ipc / OrchestratorPanel), qui découpe le goal, assigne des sous-tasks aux
// workers via MCP (assign_task), review leur travail, puis approuve (approve_task → merge-back). Ce module
// ne contient donc plus de décomposeur ni de machine à états reviewer : juste l'exécution des commandes
// MCP sur les PTY + l'état busy + le réveil de l'orchestrateur quand un worker signale la fin (report_task).

const INJECT_ENTER_DELAY = 200 // ms : laisser claude consommer le paste avant l'Entrée séparée
const RESET_REHYDRATE_DELAY = 1000 // ms : laisser /clear vider le contexte avant d'injecter la ré-hydration
const RESUBMIT_ECHO_SETTLE_MS = 700 // R1 : laisser l'écho du collage du contrat retomber avant de juger l'activité
const RESUBMIT_CHECK_MS = 1200 // R1 : fenêtre sans flux APRÈS l'écho ⇒ contrat resté au prompt (non soumis) ⇒ re-Entrée
const RETRY_CAP = 3 // R2 : au-delà, une task re-dispatchée BOUCLE → on flague l'orchestrateur (stop / escalade utilisateur)
const DEFAULT_REHYDRATION =
  "Reprise après reset du contexte. D'abord lis le curseur de reprise avec l'outil mémoire (read_memory « orchestrator-resume », ou list_memories s'il est absent). La conversation complète d'avant le reset est archivée et relisible via search_archive / read_archived_session (agent « orchestrator »). Reprends le fil à partir de là."

const terminalBusy = new Map<string, string | null>() // terminalId -> taskId | null
const terminalLastData = new Map<string, number>() // terminalId -> dernier flux (ts) — pour l'interruption
const interrupting = new Set<string>() // terminaux en cours d'ESC (non réutilisables)
const stallNotified = new Set<string>() // terminaux déjà signalés "silencieux" (watchdog WC) — anti-spam
const terminalAssignedAt = new Map<string, number>() // R3 : ts du dernier dispatch → détecte un worker MORT-NÉ (jamais émis)
const attemptByTask = new Map<string, number>() // capture : nb d'essais par task (assign/re-dispatch) pour outcomes.ndjson
const terminalRecycle = new Set<string>() // terminaux déjà servis cette session → /clear avant une NOUVELLE tâche (recyclage worker : contexte frais par tâche). Vidé à la sortie du PTY.
const readOnlyByTask = new Map<string, boolean>() // SPEC-B : tasks de consultation (aucun commit attendu) → skip l'evidence-gate « branche vide »
const STALL_MS = 5 * 60_000 // worker busy sans flux depuis 5 min → surfacé à l'orchestrateur (JAMAIS tué)
const DEADBORN_DEMOTE_MS = 10 * 60_000 // mort-né (0 octet depuis le dispatch) muet > 10 min (> STALL_MS : la notif précède) → tâche rétrogradée
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
// Seuil (caractères) au-delà duquel un contrat aplati en bracketed-paste se tronque (le MILIEU se perd) :
// au-dessus, on livre le contrat COMPLET par fichier dans le worktree et on ne colle qu'un pointeur court.
const CONTRACT_PASTE_MAX = 1200
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
    terminalAssignedAt.delete(id)
    terminalRecycle.delete(id) // PTY mort = session perdue → la prochaine tâche du futur spawn repart fraîche (pas de /clear inutile)
    stallNotified.delete(id)
    // R7 : un terminal qui MEURT laissait sa task in-progress orpheline (zombie dans le board) ET, sur
    // restart_agent (kill→recreate), la task restait collée au worker mort (P1-4). On la REMET en todo +
    // libère ses claims → requeue propre, réassignable. Event-driven (à la mort réelle) = pas de race transitoire.
    try {
      const wsId = getDb().prepare('SELECT workspace_id FROM terminals WHERE id = ?').pluck().get(id) as
        | string
        | undefined
      if (!wsId) return
      const wsRow = getWorkspace(wsId)
      let touched = false
      for (const t of listTasks(wsId)) {
        if (t.assigned_terminal_id === id && (t.status === 'in-progress' || t.status === 'in-review')) {
          updateTask(t.id, { status: 'todo', assigned_terminal_id: null })
          readOnlyByTask.delete(t.id) // SPEC-B : worker mort → purge le flag read-only (sinon fuite mémoire)
          if (wsRow)
            recordOutcome(wsRow.project_path, {
              event: 'abandoned',
              taskId: t.id,
              agent: terminalName(id),
              attempt: attemptByTask.get(t.id),
              title: t.title ?? undefined,
              reason: 'worker-exit',
            })
          touched = true
        }
      }
      if (touched) {
        const ws = getWorkspace(wsId)
        if (ws && isGitRepo(ws.project_path))
          releaseClaimsByAgent(ws.project_path, terminalName(id)).catch((e) =>
            console.error('[router] releaseClaimsByAgent', e),
          )
        emitTasks(wsId)
      }
    } catch {
      /* best-effort : la mort d'un terminal ne doit jamais throw dans l'observer */
    }
  })
}

// ---- API tasks (panneau Tasks : drag-drop de statut) ----
export function setTaskStatus(taskId: string, status: TaskStatus): void {
  const t = getTask(taskId)
  if (!t) return
  updateTask(taskId, { status })
  if (status === 'cancelled' && t.workspace_id) {
    const wsC = getWorkspace(t.workspace_id)
    if (wsC)
      recordOutcome(wsC.project_path, {
        event: 'cancelled',
        taskId,
        agent: t.assigned_terminal_id ? terminalName(t.assigned_terminal_id) : '?',
        attempt: attemptByTask.get(taskId),
        verdict: 'reject', // annulation manuelle = rejet du manager
        title: t.title ?? undefined,
      })
  }
  if (status === 'complete' || status === 'cancelled' || status === 'todo') {
    freeTerminalForTask(taskId)
    readOnlyByTask.delete(taskId) // SPEC-B : task quitte l'état actif → purge le flag read-only
    // W6(b) : libère les claims de l'agent quand sa task quitte l'état actif (sinon claim fantôme).
    if (t.assigned_terminal_id && t.workspace_id) {
      const ws = getWorkspace(t.workspace_id)
      if (ws && isGitRepo(ws.project_path))
        releaseClaimsByAgent(ws.project_path, terminalName(t.assigned_terminal_id)).catch((e) =>
          console.error('[router] releaseClaimsByAgent', e),
        )
    }
  }
  if (t.workspace_id) emitTasks(t.workspace_id)
}

/** Stoppe le travail en cours d'un workspace : interrompt les workers occupés + remet les tasks en todo. */
export function stopSwarm(workspaceId: string): void {
  for (const t of listTasks(workspaceId)) {
    if (t.status === 'in-progress' || t.status === 'in-review') {
      updateTask(t.id, { status: 'todo', assigned_terminal_id: null })
      readOnlyByTask.delete(t.id) // SPEC-B : stop → purge le flag read-only
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
export async function agentAssignTask(
  workspaceId: string,
  terminalRef: string,
  instructions: string,
  title?: string,
  files?: string[],
  docSlug?: string,
  readOnly?: boolean,
): Promise<{ terminal: string; taskId: string }> {
  const ws = getWorkspace(workspaceId)
  if (!ws) throw new Error(`Workspace ${workspaceId} introuvable`)
  const id = resolveWorker(workspaceId, terminalRef)
  const projectId = getOrCreateProjectId(ws.name, ws.project_path)

  // O2 : projet NON-GIT = AUCUNE isolation (pas de worktree/branche → tous les workers partagent le MÊME dossier,
  // pas de review-par-diff, pas de merge-back). On FORCE le séquentiel : refuser un 2e worker actif en parallèle
  // (sinon N agents piétinent le même répertoire). Recommander `git init` pour le parallélisme + la review par diff.
  if (!isGitRepo(ws.project_path)) {
    const others = listTasks(workspaceId).filter(
      (t) =>
        (t.status === 'in-progress' || t.status === 'in-review') &&
        t.assigned_terminal_id &&
        t.assigned_terminal_id !== id,
    )
    if (others.length) {
      const orchE = orchestratorTerminalId(workspaceId)
      if (orchE && hasLiveTerminal(orchE)) {
        pasteLine(
          orchE,
          oneLinePrompt(
            `[oryon] ⚠ assign à ${terminalName(id)} REFUSÉ : projet NON-GIT = zéro isolation (dossier partagé). Travaille SÉQUENTIELLEMENT (un seul worker à la fois) ou \`git init\` le projet pour le parallélisme + la review par diff. Worker(s) actif(s) : ${others
              .map((t) => terminalName(t.assigned_terminal_id as string))
              .join(', ')}.`,
          ),
        )
      }
      return { terminal: terminalName(id), taskId: '' } // pas de dispatch
    }
  }

  // W6(b) : refuse un dispatch dont les fichiers chevauchent ceux RÉSERVÉS (claims) par une AUTRE task active.
  // Indirection file-de-commandes : impossible de renvoyer l'erreur au caller MCP → on réveille l'orchestrateur
  // (même pattern que la porte-à-preuves) et on N'envoie PAS la task. PAS de throw (sinon retry en boucle).
  if (files && files.length) {
    const me = terminalName(id).toLowerCase()
    const norm = (f: string): string => f.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    const activeOthers = new Set(
      listTasks(workspaceId)
        .filter((t) => (t.status === 'in-progress' || t.status === 'in-review') && t.assigned_terminal_id)
        .map((t) => terminalName(t.assigned_terminal_id as string).toLowerCase())
        .filter((n) => n !== me),
    )
    let claimsMap: Record<string, { agent: string; uuid: string; ts: number }> = {}
    try {
      claimsMap = await readClaims(ws.project_path)
    } catch {
      /* pas de claims.json → aucun conflit */
    }
    const conflicts: string[] = []
    for (const f of files) {
      const nf = norm(f)
      for (const [cf, c] of Object.entries(claimsMap)) {
        const nc = norm(cf)
        const overlap = nf === nc || nf.startsWith(`${nc}/`) || nc.startsWith(`${nf}/`) // préfixe-aware (répertoires)
        const fresh = c && Date.now() - Number(c.ts || 0) <= CLAIM_TTL_MS // claim expiré (TTL) → ignoré (W6)
        if (overlap && c && c.agent && fresh && c.agent.toLowerCase() !== me && activeOthers.has(c.agent.toLowerCase())) {
          conflicts.push(`${f} (réservé par ${c.agent})`)
          break
        }
      }
    }
    if (conflicts.length) {
      const orchE = orchestratorTerminalId(workspaceId)
      if (orchE && hasLiveTerminal(orchE)) {
        pasteLine(
          orchE,
          oneLinePrompt(
            `[oryon] ⚠ assign à ${terminalName(id)} REFUSÉ (W6) : fichier(s) déjà réservé(s) par une task active — ${conflicts.join(', ')}. Attends son approve_task, ou donne des fichiers disjoints.`,
          ),
        )
      }
      return { terminal: terminalName(id), taskId: '' } // pas de dispatch
    }
  }
  // Réutilise la task OUVERTE de CE terminal si elle existe (re-dispatch : refresh W1, boucle de feedback,
  // retry après "blocked") au lieu d'en créer une 2e → plus de lignes en double dans le board (W2).
  const open = [...listTasks(workspaceId)]
    .reverse()
    .find((t) => t.assigned_terminal_id === id && (t.status === 'in-progress' || t.status === 'in-review'))
  const wantTitle = title && title.trim() ? title.trim() : null
  // Recyclage SILENCIEUX = bug ledger (rapport c0834efb) : si l'assign porte un titre DIFFÉRENT de la tâche
  // ouverte, c'est un AUTRE travail → on rétrograde la vieille au board (todo + détachée ; claims libérés par le
  // flux existant) et on en crée une fraîche, au lieu d'empiler outcomes/titre mensonger sur le même id.
  const reuse = open && (!wantTitle || wantTitle === (open.title ?? '').trim())
  // Recyclage worker : ce terminal a-t-il DÉJÀ servi cette session ? (lu AVANT de le (re)marquer.) recycling =
  // NOUVELLE tâche (pas un re-dispatch de la même = !reuse) sur un worker à historique → on /clear son contexte
  // avant de livrer (cf. deliverContract) → contexte FRAIS par tâche, comme le promet le rôle (faux jusqu'ici :
  // le contrat se collait par-dessus toute la conversation précédente). Un re-dispatch (reuse) GARDE son contexte
  // (il doit corriger son propre travail). 1re tâche après spawn : has(id)=false → pas de /clear (déjà frais).
  const recycling = !reuse && terminalRecycle.has(id)
  terminalRecycle.add(id)
  let task
  if (reuse) {
    // Re-dispatch légitime (même tâche) : refresh W1, feedback, retry après "blocked". Met le titre à jour si fourni.
    updateTask(open.id, { status: 'in-progress', instructions, assigned_terminal_id: id, ...(wantTitle ? { title: wantTitle } : {}) })
    task = { ...open, instructions, status: 'in-progress' as TaskStatus, assigned_terminal_id: id, ...(wantTitle ? { title: wantTitle } : {}) }
  } else {
    if (open) updateTask(open.id, { status: 'todo', assigned_terminal_id: null }) // titre ≠ → la vieille retourne au board
    task = createTask({
      workspaceId,
      projectId,
      title: wantTitle || instructions.slice(0, 80),
      role: 'builder',
      instructions,
      dependsOn: [],
    })
    updateTask(task.id, { status: 'in-progress', assigned_terminal_id: id })
  }
  terminalBusy.set(id, task.id)
  // SPEC-B : mémorise si la task est read-only (consultation, aucun commit attendu) pour que report_task
  // skippe l'evidence-gate « branche vide ». Re-dispatch : on (re)pose la valeur, sinon on purge un état périmé.
  if (readOnly) readOnlyByTask.set(task.id, true)
  else readOnlyByTask.delete(task.id)
  terminalAssignedAt.set(id, Date.now()) // R3 : repère temporel pour détecter un worker mort-né
  stallNotified.delete(id) // re-dispatch → le watchdog pourra de nouveau signaler ce terminal
  const attempt = (attemptByTask.get(task.id) ?? 0) + 1 // capture : essai courant (1 = frais, +1 par re-dispatch)
  attemptByTask.set(task.id, attempt)
  // W6(b) : réserve les fichiers de l'assigné pour que le prochain assign parallèle voie le chevauchement.
  if (files && files.length) {
    for (const f of files) {
      try {
        await claimFile(ws.project_path, f, terminalName(id))
      } catch {
        /* best-effort */
      }
    }
  }
  // Anti stale-fork (W1) : amène le worktree du worker à MAIN-HEAD (inclut les tasks déjà mergées). On AGIT
  // sur le résultat — un worktree resté périmé (conflit) ou sali ne doit PAS être avalé en silence.
  const refreshed = isGitRepo(ws.project_path) ? refreshWorktreeToHead(ws.project_path, terminalName(id)) : 'skip'
  const staleNote =
    refreshed === 'conflict'
      ? 'NOTE: ton worktree n’a PAS pu être synchronisé sur main (conflit avec des commits locaux périmés) — fais `git merge main` / résous, ou report_task "blocked" si tu es coincé.'
      : refreshed === 'dirty'
        ? 'NOTE: ton worktree a des changements non commités et n’a PAS été synchronisé sur main — réconcilie avant de dépendre de code déjà mergé.'
        : ''
  // Q5 : sur un RE-DISPATCH (task ouverte réutilisée : boucle de feedback / retry), le worker a déjà le rôle en
  // contexte (system-prompt durable + 1er dispatch) → on n'envoie QUE le corps du contrat (pas le rappel de rôle
  // verbeux) pour éviter la confusion « bloc de rôle sans tâche » + le coût en tokens. Fresh task → rappel complet.
  const roleReminder = open && !recycling
    ? []
    : [
        'You are a FOCUSED IMPLEMENTATION WORKER, not an orchestrator: do ONLY the task above — never orchestrate, never ask the user what to do, never wait for further direction.',
        'Work EXCLUSIVELY inside your current git worktree (a full mirror of the repo). NEVER `cd` to another directory and never edit files outside this worktree — the main project tree and the other agents’ worktrees are OFF-LIMITS.',
        'Touch only the files the task names; make surgical changes; respect repo conventions; never run destructive commands.',
        'Do NOT read shared/session memory (it is orchestrator context, not your task). Use search_memories ONLY if the task explicitly asks you to.',
        'When the task is GENUINELY finished: commit your changes to your branch, confirm with `git status`/`git diff` that the work is actually present, then call report_task with status "done" (or "blocked" if you truly cannot proceed) and a truthful one-line summary. NEVER report "done" unless the committed diff really contains the changes.',
      ]
  // SPEC-B : si l'orchestrateur a nommé un docSlug, pointe le worker vers la BONNE doc importée directement
  // (search_docs scopé, pas de découverte list_docs). N'invente pas l'API : si la doc manque, escalade via report_task.
  const docNote =
    docSlug && docSlug.trim()
      ? `Doc de référence : utilise search_docs({query:'…', docSlug:'${docSlug.trim()}'}) pour grounder ton implémentation sur l'API réelle (ne devine pas ; si la doc manque, report_task "blocked-pending-docs: <outil>").`
      : ''
  // Anti-troncature (rapport system-feedback f89da23d, reproduit le 2026-06-11 : 3 dispatchs/6 perdus) : le
  // bracketed-paste perd le MILIEU des longs prompts (~>1200 c). Au-delà du seuil, le contrat COMPLET (multi-
  // ligne, lisible) est écrit dans <worktree>/ORCHESTRATOR-TASK.md et seul un POINTEUR court est collé.
  const fullInline = oneLinePrompt([`[task ${task.id}]`, instructions, docNote, staleNote, ...roleReminder].join(' '))
  const wtDir = isGitRepo(ws.project_path) ? worktreeDir(ws.project_path, terminalName(id)) : null
  const contractPath = wtDir ? join(wtDir, ORCHESTRATOR_TASK_FILE) : null
  // Livraison du contrat, FACTORISÉE pour pouvoir la DIFFÉRER après un /clear de recyclage (sinon le filet
  // anti-busy-zombie ci-dessous mesurerait l'écho du /clear au lieu de celui du contrat). R1 est armé ICI,
  // APRÈS la livraison réelle, dans les deux chemins (frais ou recyclé).
  const deliverContract = (): void => {
    if (!hasLiveTerminal(id)) return
    if (contractPath && fullInline.length > CONTRACT_PASTE_MAX) {
      const body = [`# Tâche [task ${task.id}] — ${task.title ?? ''}`, '', instructions, docNote, staleNote, ...roleReminder]
        .filter(Boolean)
        .join('\n\n')
      try {
        writeFileSync(contractPath, body, 'utf8')
        pasteLine(
          id,
          oneLinePrompt(
            `[task ${task.id}] Ton contrat COMPLET est dans le fichier ${ORCHESTRATOR_TASK_FILE} à la RACINE de ton worktree — lis-le en entier et exécute-le. ${staleNote}`,
          ),
        )
      } catch {
        pasteLine(id, fullInline) // échec d'écriture (rare) → repli inline, pas pire qu'avant
      }
    } else {
      if (contractPath) {
        try {
          unlinkSync(contractPath)
        } catch {
          /* absent : rien à nettoyer */
        }
      } // jamais de contrat PÉRIMÉ lisible
      pasteLine(id, fullInline)
    }
    // R1 : filet anti-« busy zombie », armé APRÈS la livraison. La race paste/Entrée fait que l'Entrée de
    // pasteLine ne soumet parfois PAS → contrat collé au prompt, terminal « busy » mais rien ne tourne. On
    // distingue l'ÉCHO du collage (flux immédiat) du DÉMARRAGE de claude (flux continu) : après l'écho, si AUCUN
    // nouveau flux, claude est resté au prompt → on renvoie une Entrée nue (soumet le buffer correct ; inoffensif sinon).
    setTimeout(() => {
      if (!hasLiveTerminal(id)) return
      const afterEcho = terminalLastData.get(id) ?? 0
      setTimeout(() => {
        if (hasLiveTerminal(id) && (terminalLastData.get(id) ?? 0) <= afterEcho) writeTerminal(id, '\r')
      }, RESUBMIT_CHECK_MS)
    }, RESUBMIT_ECHO_SETTLE_MS)
  }
  // Recyclage : worker réutilisé pour une NOUVELLE tâche → /clear d'abord (contexte FRAIS), puis livraison après
  // RESET_REHYDRATE_DELAY (laisser /clear vider le contexte avant que le contrat n'arrive — pattern reset_orchestrator).
  // L'identité de rôle (--append-system-prompt-file) SURVIT au /clear ; seule la conversation de la tâche passée part.
  if (recycling) {
    pasteLine(id, '/clear')
    setTimeout(deliverContract, RESET_REHYDRATE_DELAY)
  } else {
    deliverContract()
  }
  // CAPTURE : événement 'assigned' (outcomes.ndjson) — essai, frais vs re-dispatch, fichiers, état worktree.
  recordOutcome(ws.project_path, {
    event: 'assigned',
    taskId: task.id,
    agent: terminalName(id),
    attempt,
    title: task.title ?? undefined,
    fresh: !open,
    files: files && files.length ? files : undefined,
    worktreeSync: refreshed,
  })
  // R2 : cap de retry — au-delà de RETRY_CAP re-dispatchs, la task BOUCLE (worker bloqué OU contrat à revoir).
  // On FLAGGE fort l'orchestrateur pour qu'il STOPPE (change de worker / redécoupe / consulte l'utilisateur) ;
  // pas de refus dur (il peut avoir une bonne raison).
  if (open && attempt >= RETRY_CAP) {
    const orchE = orchestratorTerminalId(workspaceId)
    if (orchE && hasLiveTerminal(orchE))
      pasteLine(
        orchE,
        oneLinePrompt(
          `[oryon] ⚠ la task "${task.title ?? task.id}" a été re-dispatchée ${attempt}× (cap ${RETRY_CAP}) à ${terminalName(id)} — elle BOUCLE. STOP : change de worker, redécoupe le contrat, ou consulte l'utilisateur. Ne ré-essaie pas à l'identique.`,
        ),
      )
  }
  // (R1 anti-busy-zombie est désormais armé DANS deliverContract, après la livraison réelle du contrat — sinon
  //  le délai du /clear de recyclage fausserait la mesure de flux.)
  // Si le worktree est resté périmé, préviens l'orchestrateur (signal actionnable, pas d'échec muet — W1).
  if (refreshed === 'conflict' || refreshed === 'dirty') {
    const orchE = orchestratorTerminalId(workspaceId)
    if (orchE && hasLiveTerminal(orchE)) {
      pasteLine(
        orchE,
        oneLinePrompt(
          `[oryon] ⚠ worktree de ${terminalName(id)} non synchronisé sur main (${refreshed}) avant dispatch — il pourrait ne pas voir des dépendances déjà mergées. Resynchronise si la task en dépend.`,
        ),
      )
    }
  }
  emitTasks(workspaceId)
  return { terminal: terminalName(id), taskId: task.id }
}

/**
 * report_task (MCP) : un worker signale la fin de sa task. On libère le terminal, passe la task en
 * 'in-review' (ou 'blocked'), et on RÉVEILLE le terminal orchestrateur en lui injectant une notification
 * (un agent interactif ne reçoit rien passivement). L'état task reste durable (panneau Tasks) en repli.
 */
export async function agentReportTask(
  workspaceId: string,
  fromAgent: string | null,
  status: string,
  summary: string,
  claimed?: { filesChanged: string[] | null; committed: boolean | null },
  taskId?: string | null,
): Promise<{ ok: boolean; taskId?: string }> {
  const ids = terminalIds(workspaceId)
  const termId = fromAgent
    ? ids.find((x) => terminalName(x).toLowerCase() === fromAgent.toLowerCase())
    : undefined
  // Attribution du rapport. La déduction nom→terminal→« dernière in-progress » est CE qui, après un rebinding
  // PTY (011), a clos la tâche du voisin (rapport a99d20e5). Le contrat injecté porte DÉJÀ `[task <id>]` ; si le
  // worker renvoie ce jeton il est PRIORITAIRE (identité explicite > déduction). Repli sans jeton = déduction.
  let task = [...listTasks(workspaceId)]
    .reverse()
    .find((t) => t.assigned_terminal_id === termId && t.status === 'in-progress')
  if (taskId) {
    const t = getTask(taskId)
    if (t && t.workspace_id === workspaceId) {
      if (termId && t.assigned_terminal_id && t.assigned_terminal_id !== termId)
        console.error('[router] report_task : jeton taskId ≠ déduction par nom', {
          taskId,
          fromAgent,
          tokenTerminal: t.assigned_terminal_id,
          nameTerminal: termId,
        })
      task = t // jeton explicite prioritaire
    }
  }
  const blocked = status.toLowerCase() === 'blocked'

  // Dédoublonnage (W2, belt-and-suspenders) : démote toute AUTRE ligne in-progress du même terminal
  // (une éventuelle dupe antérieure au fix) pour qu'elle ne traîne pas dans le board.
  if (termId) {
    for (const t of listTasks(workspaceId)) {
      if (t.assigned_terminal_id === termId && t.status === 'in-progress' && t.id !== task?.id) {
        updateTask(t.id, { status: 'todo', assigned_terminal_id: null })
      }
    }
  }

  // PORTE À PREUVES (F4/F8) : on lit l'état git RÉEL de la branche du worker, jamais sa seule prose.
  const ws = getWorkspace(workspaceId)
  const ev = ws && fromAgent && isGitRepo(ws.project_path) ? branchEvidence(ws.project_path, fromAgent) : null

  // Un "done" sur une branche VIDE (0 commit + worktree propre = aucun travail) est REJETÉ : task gardée
  // in-progress, worker renvoyé committer, et orchestrateur prévenu (jamais d'acceptation muette du rapport).
  // SPEC-B : sauf si la task est read-only (consultation pure) — un "done" sans commit y est LÉGITIME, on ne
  // rejette pas et on n'enregistre pas l'outcome `empty-branch` (corrige le faux positif Nell + Cole).
  if (!blocked && task && fromAgent && ev && ev.empty && !readOnlyByTask.get(task.id)) {
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
    if (ws)
      recordOutcome(ws.project_path, {
        event: 'rejected',
        taskId: task.id,
        agent: fromAgent ?? '?',
        attempt: attemptByTask.get(task.id),
        reason: 'empty-branch',
        evidence: ev
          ? { ahead: ev.ahead, filesChanged: ev.filesChanged.length, worktreeDirty: ev.worktreeDirty, mainDirty: ev.mainDirty, empty: ev.empty }
          : undefined,
      })
    return { ok: true, taskId: task.id }
  }

  if (task) updateTask(task.id, { status: blocked ? 'blocked' : 'in-review' }) // garde assigned_terminal_id → merge à l'approbation
  if (task && ws)
    recordOutcome(ws.project_path, {
      event: 'reported',
      taskId: task.id,
      agent: fromAgent ?? '?',
      attempt: attemptByTask.get(task.id),
      report: blocked ? 'blocked' : 'done',
      summary,
      evidence: ev
        ? { ahead: ev.ahead, filesChanged: ev.filesChanged.length, worktreeDirty: ev.worktreeDirty, mainDirty: ev.mainDirty, empty: ev.empty }
        : undefined,
    })
  if (termId) terminalBusy.set(termId, null)
  broadcast({
    type: 'mailbox',
    workspaceId,
    message: recordMailbox(workspaceId, fromAgent, `${status}${summary ? ' — ' + summary : ''}`),
  })
  emitTasks(workspaceId)
  // Green-gate ADVISORY au report (W5) : typecheck le WORKTREE du worker (best-effort) pour informer la revue.
  // Ne bloque JAMAIS (le gate autoritaire reste verifyMain à l'approve, sur le tronc mergé). Seulement si du
  // vrai travail existe (branche non vide, pas "blocked") ; no-op si le worktree n'a pas de node_modules.
  let gateNote = ''
  if (ws && ev && !ev.empty && !blocked && fromAgent && isGitRepo(ws.project_path)) {
    try {
      const gate = await verifyWorktree(worktreeDir(ws.project_path, fromAgent), ws.project_path)
      if (!gate.skipped && !gate.timedOut) {
        gateNote = ` [typecheck ${gate.green ? '✓ vert' : '✗ ROUGE'}]`
        if (!gate.green) gateNote += ` — extrait: ${oneLinePrompt(gate.log.slice(-500))}`
      }
    } catch {
      /* best-effort : un échec du gate ne casse jamais le report */
    }
  }
  // WC : recoupe la prose du worker (claimed, optionnel) avec la preuve git — git gagne. Purement additif.
  let mismatch = ''
  if (claimed && ev) {
    if (claimed.committed === true && ev.ahead === 0) mismatch += ' ⚠ worker dit "committé" mais 0 commit authored'
    if (claimed.filesChanged && claimed.filesChanged.length) {
      const n = (f: string): string => f.replace(/\\/g, '/').toLowerCase()
      const evset = new Set(ev.filesChanged.map(n))
      const missing = claimed.filesChanged.filter((f) => !evset.has(n(f)))
      if (missing.length) mismatch += ` ⚠ fichiers réclamés absents du diff: ${missing.slice(0, 8).join(', ')}`
    }
  }
  // Réveille l'orchestrateur AVEC l'évidence git machine à côté de la prose du worker (F4/F8) + alerte contamination (F3).
  const orch = orchestratorTerminalId(workspaceId)
  if (orch && hasLiveTerminal(orch)) {
    const wt = fromAgent ? ` Inspecte: git -C .oryon/agents/${fromAgent.toLowerCase()} diff.` : ''
    const tid = task ? ` [taskId=${task.id}]` : ''
    let evidence = ''
    if (ev) {
      evidence = ` [preuve: ${ev.ahead} commit(s), ${ev.filesChanged.length} fichier(s)${ev.worktreeDirty ? ', worktree non commité' : ''}${ev.empty ? ' ⚠ BRANCHE VIDE' : ''}]`
      // V1 : la LISTE des fichiers (cap 12) directement dans la wake-line — l'orchestrateur juge le périmètre
      // (et repère un hors-scope) sans round-trip `git diff`. Les chemins sont déjà calculés par branchEvidence.
      if (ev.filesChanged.length)
        evidence += ` Fichiers: ${ev.filesChanged
          .slice(0, 12)
          .map((f) => f.replace(/\\/g, '/'))
          .join(', ')}${ev.filesChanged.length > 12 ? ` (+${ev.filesChanged.length - 12})` : ''}.`
      if (ev.mainDirty) evidence += ' ⚠ TRONC PRINCIPAL SALE — contamination possible (un worker a peut-être édité MAIN)'
    }
    // C1 : sur un projet git, si le rapport n'a PAS pu être rattaché à un worker connu (fromAgent manquant/
    // inconnu → ev null), la porte à preuves est court-circuitée → on le FLAG au lieu de gober la prose en silence.
    if (!ev && ws && isGitRepo(ws.project_path))
      evidence =
        ' ⚠ AUCUNE preuve git (rapport non rattaché à un worker connu — fromAgent manquant/inconnu) : ne te fie PAS à la prose, vérifie le worktree manuellement.'
    const wake = oneLinePrompt(
      `[oryon] ${fromAgent ?? 'un worker'} a terminé "${task?.title ?? ''}" (${status})${tid}: ${summary}.${evidence}${gateNote}${mismatch}${wt} Vérifie le diff puis approve_task si OK, sinon réassigne avec un feedback précis.`,
    )
    pasteLine(orch, wake)
  }
  return { ok: true, taskId: task?.id }
}

/**
 * Watchdog (WC) : signale à l'orchestrateur tout worker BUSY silencieux depuis > STALL_MS (peut-être bloqué,
 * en attente d'input, ou en boucle). SURFACE uniquement — JAMAIS de kill/interrupt automatique. Appelé sur le
 * tick 2 s de mcp-export. Anti-spam via stallNotified (réarmé au prochain dispatch / à la mort du terminal).
 */
export function tickWatchdog(): void {
  const now = Date.now()
  for (const [tid, busy] of terminalBusy) {
    if (!busy || interrupting.has(tid) || !hasLiveTerminal(tid)) continue
    const last = terminalLastData.get(tid)
    // R3 : référence = dernier flux, ou (worker MORT-NÉ : jamais émis un octet) l'instant du dispatch — pour ne
    // plus rater un claude qui hang/crash au lancement sans rien écrire (avant : last===undefined → jamais flaggé).
    const ref = last ?? terminalAssignedAt.get(tid)
    if (ref === undefined || now - ref <= STALL_MS) continue
    const deadOnArrival = last === undefined
    // 013 : un mort-né encore muet au-delà de DEADBORN_DEMOTE_MS ne se réveillera pas seul → on RÉTROGRADE sa tâche
    // (en plus de la notification déjà émise à STALL_MS). On reste donc surveillé entre les deux seuils : stallNotified
    // ne court-circuite plus le mort-né, il n'empêche que la RE-notification.
    const demote = deadOnArrival && now - ref > DEADBORN_DEMOTE_MS
    if (stallNotified.has(tid) && !demote) continue
    const wsId = (getDb().prepare('SELECT workspace_id FROM terminals WHERE id = ?').pluck().get(tid) as
      | string
      | undefined)
    if (!wsId) continue
    const orch = orchestratorTerminalId(wsId)
    if (!orch || !hasLiveTerminal(orch)) continue
    const name = terminalName(tid)
    const t = getTask(busy)
    const ws = getWorkspace(wsId)
    const ev = ws && isGitRepo(ws.project_path) ? branchEvidence(ws.project_path, name) : null
    const mins = Math.round((now - ref) / 60000)
    const evidence = ev ? ` [preuve: ${ev.ahead} commit(s), ${ev.filesChanged.length} fichier(s)]` : ''
    if (demote) {
      // Rétrograde au board + libère le terminal + ses claims + outcome 'abandoned' (aligné sur l'exit-observer R7).
      // UNIQUEMENT le mort-né (zéro octet) — JAMAIS « silencieux mais a déjà émis » (un claude qui réfléchit est légitime).
      updateTask(busy, { status: 'todo', assigned_terminal_id: null })
      terminalBusy.set(tid, null)
      if (ws && isGitRepo(ws.project_path))
        releaseClaimsByAgent(ws.project_path, name).catch((e) => console.error('[router] releaseClaimsByAgent', e))
      if (ws)
        recordOutcome(ws.project_path, {
          event: 'abandoned',
          taskId: busy,
          agent: name,
          attempt: attemptByTask.get(busy),
          title: t?.title ?? undefined,
          reason: 'dead-born-demote',
        })
      pasteLine(
        orch,
        oneLinePrompt(
          `[oryon watchdog] tâche "${t?.title ?? ''}" RÉTROGRADÉE todo (${name} mort-né : aucune sortie depuis ~${mins} min) — réassigne-la (restart_agent puis assign_task) ou inspecte le terminal.`,
        ),
      )
      stallNotified.add(tid)
      continue
    }
    const msg = deadOnArrival
      ? `[oryon watchdog] ${name} n'a produit AUCUNE sortie depuis le dispatch (~${mins} min) sur "${t?.title ?? ''}" — claude a peut-être planté au lancement ou son serveur MCP est mort. Vérifie (get_terminal_output ${name} / mcp_health ${name}) puis restart_agent si besoin. (aucun kill automatique)`
      : `[oryon watchdog] ${name} silencieux depuis ~${mins} min sur "${t?.title ?? ''}"${evidence}. Peut-être bloqué / en attente d'input / en boucle — inspecte (get_terminal_output ${name}) puis relance ou réassigne. (aucun kill automatique)`
    pasteLine(orch, oneLinePrompt(msg))
    stallNotified.add(tid)
  }
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
          releaseClaimsByAgent(ws.project_path, agent).catch((e) =>
            console.error('[router] releaseClaimsByAgent', e),
          ) // W6(b) : la task est mergée → libère ses claims
          recordOutcome(ws.project_path, {
            event: 'approved',
            taskId,
            agent,
            attempt: attemptByTask.get(taskId),
            verdict: 'pass', // l'approbation EST l'adjudication du manager (= la vérité, pas l'auto-report)
            mergeOutcome: 'merged',
            mergeMessage: m,
          })
          attemptByTask.delete(taskId)
          readOnlyByTask.delete(taskId) // SPEC-B : task terminée → purge son flag read-only
          emitTasks(wsId)
          agentMailbox(wsId, 'système', m)
        },
        onConflict: (m) => {
          updateTask(taskId, { status: 'in-review' })
          recordOutcome(ws.project_path, {
            event: /conflit|conflict/i.test(m) ? 'merge_conflict' : 'merge_deferred',
            taskId,
            agent,
            attempt: attemptByTask.get(taskId),
            mergeMessage: m,
          })
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
 * broadcast_command (MCP) : injecte une commande (slash-command claude comme /effort high ou /model fable,
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
  // V2 : un broadcast à TOUS saute les workers OCCUPÉS (busy) — leur injecter une ligne en plein tour
  // déraillerait leur tâche. Un broadcast CIBLÉ (terminalRef) reste honoré (intention explicite de l'orchestrateur).
  let busySkipped = 0
  const targets = terminalRef
    ? [resolveWorker(workspaceId, terminalRef)]
    : terminalIds(workspaceId).filter((id) => {
        if (!hasLiveTerminal(id) || interrupting.has(id)) return false
        if (terminalBusy.get(id)) {
          busySkipped++
          return false
        }
        return true
      })
  for (const id of targets) pasteLine(id, line)
  if (terminalRef && targets.length) agentMailbox(workspaceId, 'orchestrateur', `\`${line}\` → ${terminalName(targets[0])}`)
  else
    agentMailbox(
      workspaceId,
      'orchestrateur',
      `\`${line}\` → ${targets.length} worker(s)${busySkipped ? ` (${busySkipped} occupé(s) ignoré(s))` : ''}`,
    )
  return { count: targets.length, command: line }
}

/**
 * flush_archive (MCP) : force un sweep d'archive immédiat (bypass du throttle 2 min de maybeArchive). Sauve
 * les transcripts de conversation en vol sous .oryon/archive/ (relisibles via les outils d'archive). Gzip en
 * streaming, $0, fire-and-forget — aucune injection PTY (le caller MCP a déjà son accusé queued:true).
 */
export function agentFlushArchive(_workspaceId: string): void {
  void sweepArchive().catch((e) => console.error('[oryon] flush_archive a échoué :', e))
}

/**
 * reset_orchestrator (MCP, orchestrateur-only) : flush l'archive PUIS injecte `/clear` dans le PTY de
 * l'orchestrateur lui-même (que broadcast_command/terminalIds excluent), enfin une ligne de ré-hydration
 * ~1 s plus tard (le temps que /clear vide le contexte). Permet de repartir d'un contexte frais — peu
 * coûteux — sans perdre la donnée : la conversation complète reste archivée et relisible (search_archive /
 * read_archived_session) et le curseur de reprise vit dans la mémoire partagée (read_memory). Le sweep
 * pré-/clear capture tout sauf le dernier tour, que le prochain sweep (tick/quit) ré-archive par dédup.
 */
export async function agentResetOrchestrator(
  workspaceId: string,
  rehydration: string | null,
): Promise<void> {
  const orchE = orchestratorTerminalId(workspaceId)
  if (!orchE || !hasLiveTerminal(orchE)) {
    console.warn('[oryon] reset_orchestrator : orchestrateur introuvable ou hors-ligne')
    return
  }
  // 1) Flush best-effort AVANT le clear (capture l'historique jusqu'au tour précédent).
  try {
    await sweepArchive()
  } catch (e) {
    console.error('[oryon] reset_orchestrator : flush a échoué (on continue) :', e)
  }
  if (!hasLiveTerminal(orchE)) return
  // 2) /clear vide le contexte (le system-prompt rôle + CLAUDE.md + MEMORY.md survivent au clear).
  pasteLine(orchE, '/clear')
  // 3) Ré-hydration après ~1 s (laisser /clear s'exécuter avant que la ligne n'arrive).
  const line = oneLinePrompt(rehydration && rehydration.trim() ? rehydration : DEFAULT_REHYDRATION)
  setTimeout(() => {
    if (hasLiveTerminal(orchE)) pasteLine(orchE, line)
  }, RESET_REHYDRATE_DELAY)
  // 4) Rendre le reset DURABLE (bug 052e7397) : roter l'id de session de reprise. Le /clear ci-dessus fait
  //    forker claude vers une nouvelle session pour CE run, mais l'épinglage de reprise restait sur <termId>
  //    (la conversation PRÉ-reset) → au prochain redémarrage de l'app, l'ancien orchestrateur RESSUSCITAIT et
  //    rejouait le travail. Après rotation, le restart démarre une session NEUVE, ré-hydratée depuis
  //    git/ledger/mémoire (le but même du reset) au lieu de rejouer le passé.
  rotateOrchestratorResumeId(join(app.getPath('userData'), 'mcp-state'), orchE)
}

/** Envoie sur un canal IPC à toutes les fenêtres (single-window en pratique) → recâble le flux d'un PTY recréé. */
function sendToAllWindows(channel: string, ...payload: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...payload)
}
/** Résout une réf worker (name « Nell » / position « #2 ») → id, SANS exiger qu'il soit vivant (un mort se relance). */
function resolveWorkerIdAllowDead(workspaceId: string, ref: string): string | null {
  const ids = terminalIds(workspaceId)
  const r = ref.trim().replace(/^#/, '')
  const idx = Number(r)
  if (Number.isInteger(idx) && idx >= 1 && idx <= ids.length) return ids[idx - 1]
  return ids.find((x) => terminalName(x).toLowerCase() === r.toLowerCase()) ?? null
}

/**
 * restart_agent (MCP, orchestrateur-only) : tue puis recrée le PTY d'UN worker — SEULE façon de relancer un
 * serveur MCP mort (enfant du `claude`). Reconstruit le spawn comme terminals:create (chokepoint) : shell dans
 * le worktree, config MCP ancrée sur le projet PRINCIPAL, identité worker durable. Sérialisé/sûr : ne touche
 * QUE le terminal ciblé. L'indirection file-de-commandes empêche de renvoyer une erreur au caller MCP → on
 * réveille l'orchestrateur (succès comme échec), comme la porte-à-preuves de assign_task.
 */
export function agentRestartAgent(workspaceId: string, terminalRef: string): void {
  const orchE = orchestratorTerminalId(workspaceId)
  const tellOrch = (msg: string): void => {
    if (orchE && hasLiveTerminal(orchE)) pasteLine(orchE, oneLinePrompt(msg))
  }
  const id = resolveWorkerIdAllowDead(workspaceId, terminalRef)
  if (!id) {
    tellOrch(`[oryon] ⚠ restart_agent : terminal « ${terminalRef} » introuvable.`)
    return
  }
  const row = getDb()
    .prepare('SELECT id, name, role, cwd, worktree_path, autostart_cmd FROM terminals WHERE id = ?')
    .get(id) as
    | { id: string; name: string; role: string | null; cwd: string; worktree_path: string | null; autostart_cmd: string | null }
    | undefined
  if (!row) {
    tellOrch(`[oryon] ⚠ restart_agent : terminal introuvable en DB.`)
    return
  }

  // Tue le PTY s'il est encore vivant (claude figé / MCP tombé dans un shell ouvert) ; s'il est déjà sorti, on
  // recrée directement. terminalBusy est remis à null par l'exit-observer sur kill ; on l'assure ici aussi.
  if (hasLiveTerminal(id)) killTerminal(id)
  terminalBusy.set(id, null)
  stallNotified.delete(id)

  // R5 : ré-établit le worktree de l'agent + ses junctions (node_modules/.claude/skills) AVANT de recréer le PTY.
  // ensureWorktree LÈVE désormais si le worktree est irrécupérable (plan 011) → on REFUSE de relancer (jamais de
  // claude WORKER dans le tronc, bug 1234317c) : on alerte l'orchestrateur et on s'arrête. shellCwd = LE retour
  // d'ensureWorktree (worktree fraîchement vérifié/recréé), pas la valeur DB possiblement périmée. (La task
  // in-progress a été remise en todo par l'exit-observer au kill ci-dessus — R7.)
  let shellCwd = row.cwd
  if (row.role !== 'orchestrator' && isGitRepo(row.cwd)) {
    try {
      shellCwd = ensureWorktree(row.cwd, row.name)
      provisionWorktreeDeps(row.cwd, shellCwd)
    } catch (e) {
      tellOrch(`[oryon] ⚠ restart_agent : worktree irrécupérable pour ${row.name} — relance ANNULÉE (${(e as Error).message}). Inspecte/recrée le worktree avant de réessayer.`)
      return
    }
  }

  // Reconstruit l'autostart EXACTEMENT comme terminals.ipc.ts (sinon le claude relancé n'aurait pas le serveur
  // oryon — soit tout le but du restart). Shell dans le worktree (shellCwd résolu ci-dessus) ; ancre MCP =
  // projet principal (colonne cwd).
  let autostart = row.autostart_cmd || null
  if (autostart && /^claude(\s|$)/.test(autostart.trim())) {
    ensureClaudeReady(shellCwd)
    autostart = normalizeClaudeAutostart(autostart)
    const mcpFile = buildProjectMcpConfigForPath(row.cwd)
    // --strict-mcp-config : ne charger QUE le fichier injecté (ignore tout .mcp.json auto-découvert) — aligné
    // sur terminals.ipc.ts pour qu'un agent RELANCÉ ait exactement le même état MCP qu'au spawn initial.
    if (mcpFile && !/--mcp-config/.test(autostart)) autostart += ` --strict-mcp-config --mcp-config '${mcpFile.replace(/'/g, "''")}'`
    autostart = enforceAgentSpawn(autostart)
  }
  const env: Record<string, string> = { ORYON_AGENT_NAME: row.name, ORYON_WORKSPACE_ID: workspaceId, ORYON_TERMINAL_ID: id }
  if (row.role) env.ORYON_AGENT_ROLE = row.role

  // Recâble le flux PTY vers le renderer sur les MÊMES canaux que terminals:create (le composant Terminal de ce
  // id garde ses listeners onData/onExit). Taille par défaut : le renderer re-fit au prochain resize/clic.
  const sender = makeCoalescedSender((data) => sendToAllWindows(`terminal:data:${id}`, data))
  createTerminal({
    id,
    cwd: shellCwd,
    autostart,
    cols: 80,
    rows: 24,
    env,
    onData: (data) => sender.push(data),
    onExit: (code) => {
      sender.flushNow() // flush le buffer AVANT de signaler l'exit → ordre data→exit garanti côté renderer
      sendToAllWindows(`terminal:exit:${id}`, code)
    },
  })
  tellOrch(`[oryon] ↻ ${row.name} relancé (kill+recreate du PTY). Attends qu'il soit prêt avant de le re-piloter.`)
}

/**
 * add_connector (MCP, orchestrateur-only) : ajoute un connecteur MCP demandé par l'orchestrateur (flux
 * « installer via l'agent »). Persiste via settings.ipc.addConnector (valide la forme + régénère les configs
 * de tous les projets), puis notifie l'orchestrateur du résultat. scope 'project' → projectPath = cwd du
 * terminal orchestrateur (= projet principal du workspace).
 */
export function agentAddConnector(
  workspaceId: string,
  c: {
    name: string
    transport: 'stdio' | 'http' | 'sse'
    scope?: 'app' | 'project'
    command?: string | null
    args?: string[] | null
    url?: string | null
    env?: Record<string, string> | null
    headers?: Record<string, string> | null
  },
): void {
  const orchE = orchestratorTerminalId(workspaceId)
  const tell = (m: string): void => {
    if (orchE && hasLiveTerminal(orchE)) pasteLine(orchE, oneLinePrompt(m))
  }
  if (!c || !c.name) {
    tell('[oryon] ⚠ add_connector : payload invalide (nom manquant).')
    return
  }
  try {
    const scope: 'app' | 'project' = c.scope === 'project' ? 'project' : 'app'
    const projectPath =
      scope === 'project' && orchE
        ? ((getDb().prepare('SELECT cwd FROM terminals WHERE id = ?').pluck().get(orchE) as string | undefined) ?? null)
        : null
    const saved = addConnector({
      name: c.name,
      scope,
      projectPath,
      transport: c.transport,
      command: c.command ?? undefined,
      args: c.args ?? undefined,
      url: c.url ?? undefined,
      env: c.env ?? undefined,
      headers: c.headers ?? undefined,
    })
    tell(
      `[oryon] ✓ Connecteur MCP « ${saved.name} » ajouté (${saved.scope}) — visible dans Réglages → Connecteurs, effectif au prochain spawn d'agent.`,
    )
  } catch (e) {
    tell(`[oryon] ⚠ add_connector « ${c.name} » a échoué : ${(e as Error).message}`)
  }
}
