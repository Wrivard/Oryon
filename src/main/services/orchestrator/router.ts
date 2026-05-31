import { BrowserWindow } from 'electron'
import { basename } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import { getDb } from '../../db'
import { addDataObserver, addExitObserver, writeTerminal, hasLiveTerminal } from '../pty-manager'
import { decompose, localDecompose, prewarmDecomposer, classifyIntent } from './decomposer'
import { extractDirectives } from './directives'
import { buildAgentPrompt, buildReviewPrompt } from './roles'
import { stripAnsi, recordMailbox, listMailbox } from './mailbox'
import {
  initRun,
  tasksDir,
  writeTaskFile,
  taskFileName,
  resultFileName,
  reviewFileName,
  taskFilePath,
  resultFilePath,
  reviewFilePath,
  parseOutputFileName,
  parseOutputFile,
} from './run-files'
import { getOrCreateProjectId, createTask, listTasks, getTask, updateTask } from './task-store'
import { isGitRepo, worktreeDir, branchFor, refreshWorktreeToHead } from '../worktrees'
import { enqueueMergeBack } from './merge-back'
import type { OrchestratorEvent, PlanTask, SubmitMode, Task, TaskStatus, Workspace } from '../../../shared/types'

interface SwarmState {
  workspaceId: string
  projectId: string
  projectPath: string
  goal: string
  /** Méta-directives Claude extraites du goal (cf. directives.ts) appliquées aux agents. */
  effort?: string
  think?: boolean
}

const INJECT_ENTER_DELAY = 200 // ms : laisser claude consommer le paste avant l'Entrée séparée
// 10 min : un builder Opus « ultracode » fait souvent des pauses > 4 min entre deux flushs stdout →
// 4 min orphelinait des agents bien vivants (faux positif). 10 min reste un garde-fou utile.
const SILENCE_TIMEOUT = 600000 // ms : terminal assigné silencieux > 10min → task probablement bloquée
const MAX_REVIEW_ROUNDS = 3 // builder↔reviewer : au-delà → 'blocked' (stop le ping-pong qui épingle 2 terminaux)
const WATCHDOG_INTERVAL = 20000 // ms

let swarm: SwarmState | null = null
let submitting = false
const swarmTerminals = new Set<string>()
const numberToTaskId = new Map<number, string>()
const taskIdToNumber = new Map<string, number>()
const numberToTaskFile = new Map<number, string>() // numéro de task → nom du fichier d'instructions
const reviewRounds = new Map<number, number>() // numéro de task → nb d'allers-retours builder↔reviewer
const builderTerminal = new Map<number, string>() // numéro de task → terminal du BUILDER (≠ reviewer)
let nextNumber = 1

const terminalReady = new Map<string, boolean>()
const terminalBusy = new Map<string, string | null>() // terminalId -> taskId | null
const terminalLastData = new Map<string, number>() // terminalId -> dernier flux (ts)
const interrupting = new Set<string>() // terminaux en cours d'interruption (ESC) → non réutilisables
const buffers = new Map<string, string>() // tampon de readiness (jeté dès que prêt)
let rr = 0
let observerInstalled = false

// Détection d'avancement par FICHIERS (cf. run-files.ts) : on surveille l'apparition des
// tasks/NN.result.md (sortie builder/scout) et NN.review.md (verdict reviewer). Plus de parsing
// de la sortie terminal → plus d'écho de prompt reparsé, plus de spam.
let watcher: FSWatcher | null = null
const processedOutputs = new Map<string, string>() // nom de fichier → dernier statut déjà traité

// ---- helpers ----
function broadcast(e: OrchestratorEvent): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('orchestrator:event', e)
}
function emitTasks(workspaceId: string): void {
  broadcast({ type: 'tasks', workspaceId, tasks: listTasks(workspaceId) })
}
function notice(workspaceId: string, body: string): void {
  broadcast({ type: 'mailbox', workspaceId, message: recordMailbox(workspaceId, 'système', body) })
}
/** Poste l'interprétation de l'étage d'intention sous un auteur dédié ('intention'). */
function noticeIntent(workspaceId: string, body: string): void {
  broadcast({ type: 'mailbox', workspaceId, message: recordMailbox(workspaceId, 'intention', body) })
}
function getWorkspace(id: string): Workspace | undefined {
  return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace | undefined
}
function terminalIds(workspaceId: string): string[] {
  return (
    getDb()
      .prepare('SELECT id FROM terminals WHERE workspace_id = ? ORDER BY pane_index')
      .all(workspaceId) as Array<{ id: string }>
  ).map((r) => r.id)
}
function terminalName(id: string | null): string {
  if (!id) return '?'
  return (
    (getDb().prepare('SELECT name FROM terminals WHERE id = ?').pluck().get(id) as string | undefined) ??
    id.slice(0, 6)
  )
}
function pickFreeTerminal(workspaceId: string, exclude?: string): string | null {
  const ids = terminalIds(workspaceId).filter(
    (id) =>
      id !== exclude &&
      hasLiveTerminal(id) &&
      terminalReady.get(id) &&
      !terminalBusy.get(id) &&
      !interrupting.has(id), // un terminal encore en cours d'ESC n'est pas réutilisable (anti double-assignation)
  )
  if (ids.length === 0) return null
  const id = ids[rr % ids.length]
  rr++
  return id
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Interrompt un agent orphelin (double ESC : le TUI claude a parfois besoin de deux pour casser un tour
 * en cours), puis attend ~600 ms de silence (cap 3 s) avant de libérer le terminal. Gate via `interrupting`
 * pour qu'un PTY encore en train de répondre ne soit PAS réassigné (sinon 2 agents sur 1 task → worktrees +
 * merges dupliqués). Fire-and-forget : se gère lui-même.
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
function assignNumber(taskId: string): number {
  let n = taskIdToNumber.get(taskId)
  if (n === undefined) {
    n = nextNumber++
    taskIdToNumber.set(taskId, n)
    numberToTaskId.set(n, taskId)
  }
  return n
}
// swarm.projectPath = tronc PRINCIPAL TOUJOURS — le dossier de run, la surveillance chokidar et les
// chemins absolus injectés aux agents y vivent, JAMAIS dans un worktree. Les agents ont un cwd = worktree
// mais reçoivent ces chemins ABSOLUS pour écrire dans le seul .oryon/run surveillé.
function taskFileAbs(main: string, num: number, title: string | null): string {
  return taskFilePath(main, numberToTaskFile.get(num) ?? taskFileName(num, title ?? ''))
}
/** Worktree du builder d'une task (pour pointer le reviewer / cibler le merge-back). null si inconnu/non-git. */
function builderWorktree(main: string, num: number): string | null {
  if (!isGitRepo(main)) return null
  const term = builderTerminal.get(num)
  if (!term) return null
  return worktreeDir(main, terminalName(term))
}
function onTask(terminalId: string, taskId: string): boolean {
  return !!swarm && swarmTerminals.has(terminalId) && terminalBusy.get(terminalId) === taskId
}
function submitLine(terminalId: string, taskId: string, line: string): void {
  writeTerminal(terminalId, line)
  // claude TUI (bracketed paste) : Entrée comme événement SÉPARÉ. Garde : ne soumettre que si
  // ce terminal est TOUJOURS sur CE task (pas réassigné/tué/stoppé pendant le délai).
  setTimeout(() => {
    if (onTask(terminalId, taskId)) writeTerminal(terminalId, '\r')
  }, INJECT_ENTER_DELAY)
}
function inject(terminalId: string, taskId: string, prompt: string, preCommand?: string): void {
  terminalBusy.set(terminalId, taskId)
  if (preCommand) {
    // Méta-directive Claude (ex. /effort ultracode) appliquée AVANT le prompt, comme commande séparée.
    submitLine(terminalId, taskId, preCommand)
    setTimeout(() => {
      if (onTask(terminalId, taskId)) submitLine(terminalId, taskId, prompt)
    }, INJECT_ENTER_DELAY * 3)
  } else {
    submitLine(terminalId, taskId, prompt)
  }
}
/** Pré-commande Claude à émettre avant le prompt selon les directives du swarm (ex. /effort ultracode). */
function effortPreCommand(): string | undefined {
  return swarm?.effort ? `/effort ${swarm.effort}` : undefined
}
function freeTerminalForTask(taskId: string): void {
  for (const [tid, busy] of terminalBusy) if (busy === taskId) terminalBusy.set(tid, null)
}

// ---- dispatch ----
function dispatchReady(): void {
  if (!swarm) return
  const tasks = listTasks(swarm.workspaceId)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const assigned = new Set<string>()
  for (const v of terminalBusy.values()) if (v) assigned.add(v)

  // 1) tasks 'todo' dont les dépendances sont 'complete' → builder/scout
  for (const t of tasks) {
    if (t.status !== 'todo') continue
    const deps: string[] = t.depends_on ? JSON.parse(t.depends_on) : []
    if (!deps.every((d) => byId.get(d)?.status === 'complete')) continue
    const term = pickFreeTerminal(swarm.workspaceId)
    if (!term) continue
    const num = assignNumber(t.id)
    const role = t.role === 'scout' ? 'scout' : 'builder'
    ensureTaskFileFor(num, t) // recovery : si la map a été vidée (swarm ré-établi), réécrire le fichier
    updateTask(t.id, { status: 'in-progress', assigned_terminal_id: term })
    builderTerminal.set(num, term) // worktree porteur des éditions (≠ le terminal du reviewer ensuite)
    if (!reviewRounds.has(num)) reviewRounds.set(num, 0)
    assigned.add(t.id)
    // re-run (après changes/blocked/timeout) : on autorise un nouveau result.md à re-déclencher
    processedOutputs.delete(resultFileName(num))
    // Phase 2 (anti stale-fork) : amène le worktree à MAIN-HEAD pour inclure les dépendances déjà mergées.
    // No-op si déjà à jour ; sauté si le worktree a du travail non commité (re-dispatch après 'changes').
    const refresh = refreshWorktreeToHead(swarm.projectPath, terminalName(term))
    if (refresh === 'conflict') {
      notice(swarm.workspaceId, `#${num} : le worktree de ${terminalName(term)} diverge de MAIN — démarré sans rafraîchir (l'intégration finale gérera le conflit en conservant la branche).`)
    }
    inject(
      term,
      t.id,
      buildAgentPrompt({
        number: num,
        role,
        taskFile: taskFileAbs(swarm.projectPath, num, t.title),
        resultFile: resultFilePath(swarm.projectPath, num),
        reviewFile: reviewFilePath(swarm.projectPath, num),
        think: swarm.think,
      }),
      effortPreCommand(),
    )
  }
  // 2) tasks 'in-review' SANS reviewer actif → (ré)assigner un reviewer (retry quand un terminal se libère)
  for (const t of tasks) {
    if (t.status !== 'in-review' || assigned.has(t.id)) continue
    const term = pickFreeTerminal(swarm.workspaceId)
    if (!term) continue
    const num = assignNumber(t.id)
    updateTask(t.id, { assigned_terminal_id: term })
    assigned.add(t.id)
    processedOutputs.delete(reviewFileName(num))
    inject(
      term,
      t.id,
      buildReviewPrompt({
        number: num,
        taskFile: taskFileAbs(swarm.projectPath, num, t.title),
        resultFile: resultFilePath(swarm.projectPath, num),
        reviewFile: reviewFilePath(swarm.projectPath, num),
        // Le reviewer tourne dans SON worktree : on le pointe vers celui du builder (éditions non commitées).
        targetWorktree: builderWorktree(swarm.projectPath, num) ?? undefined,
      }),
      effortPreCommand(),
    )
  }
  emitTasks(swarm.workspaceId)
}

// ---- traitement des fichiers de sortie (result / review) ----
function handleOutputFile(fullPath: string): void {
  if (!swarm) return
  const name = basename(fullPath)
  const parsed = parseOutputFileName(name)
  if (!parsed) return
  const out = parseOutputFile(fullPath)
  if (!out) return // STATUS pas encore lisible (fichier en cours d'écriture)
  if (processedOutputs.get(name) === out.status) return // dédup : ce statut déjà traité
  processedOutputs.set(name, out.status)

  const taskId = numberToTaskId.get(parsed.n)
  if (!taskId) return
  const task = getTask(taskId)
  if (!task) return

  if (parsed.kind === 'result') {
    if (task.status !== 'in-progress') return // garde anti-rejeu
    const term = task.assigned_terminal_id
    if (term) builderTerminal.set(parsed.n, term) // robustesse : capter le builder même après un restart
    broadcast({
      type: 'mailbox',
      workspaceId: swarm.workspaceId,
      message: recordMailbox(
        swarm.workspaceId,
        terminalName(term),
        `${out.status} #${parsed.n}${out.summary ? ' — ' + out.summary : ''}`,
      ),
    })
    freeTerminalForTask(taskId)
    if (out.status === 'blocked') {
      updateTask(taskId, { status: 'todo', assigned_terminal_id: null })
    } else if (task.role === 'scout') {
      updateTask(taskId, { status: 'complete' }) // un scout ne produit pas de diff à reviewer
    } else {
      updateTask(taskId, { status: 'in-review' }) // le reviewer est dispatché par dispatchReady
    }
  } else {
    // review
    if (task.status !== 'in-review') return
    const term = task.assigned_terminal_id
    broadcast({
      type: 'mailbox',
      workspaceId: swarm.workspaceId,
      message: recordMailbox(
        swarm.workspaceId,
        terminalName(term),
        `${out.status} #${parsed.n}${out.summary ? ' — ' + out.summary : ''}`,
      ),
    })
    freeTerminalForTask(taskId)
    const wsId = swarm.workspaceId
    const main = swarm.projectPath
    if (out.status === 'approved') {
      // Intègre la branche du BUILDER (pas du reviewer) dans le tronc principal : sérialisé + conflict-safe.
      const builderTerm = builderTerminal.get(parsed.n)
      if (isGitRepo(main) && builderTerm) {
        const agent = terminalName(builderTerm)
        void enqueueMergeBack({
          mainPath: main,
          worktree: worktreeDir(main, agent),
          branch: branchFor(agent),
          agent,
          task: String(parsed.n),
          onDone: (m) => notice(wsId, m),
          onConflict: (m) => notice(wsId, m),
        })
      }
      updateTask(taskId, { status: 'complete' })
      reviewRounds.delete(parsed.n)
      builderTerminal.delete(parsed.n)
    } else if (out.status === 'changes') {
      const round = (reviewRounds.get(parsed.n) ?? 0) + 1
      reviewRounds.set(parsed.n, round)
      if (round >= MAX_REVIEW_ROUNDS) {
        // Stoppe le ping-pong builder↔reviewer qui épinglerait 2 terminaux indéfiniment.
        notice(wsId, `#${parsed.n} bloquée après ${round} tours de revue — intervention requise (statut : blocked).`)
        updateTask(taskId, { status: 'blocked', assigned_terminal_id: null })
      } else {
        // le builder reprend la task et lira le review.md pour les corrections.
        processedOutputs.delete(resultFileName(parsed.n)) // un nouveau result.md doit re-déclencher
        updateTask(taskId, { status: 'todo', assigned_terminal_id: null })
      }
    } else {
      // Verdict inconnu (parseOutputFile est permissif : tout mot après STATUS passe) → ne PAS boucler à
      // l'infini sur un « STATUS: needs-work » mal orthographié ; on bloque pour intervention humaine.
      notice(wsId, `#${parsed.n} : verdict de revue non reconnu (« ${out.status} ») — statut : blocked.`)
      updateTask(taskId, { status: 'blocked', assigned_terminal_id: null })
    }
  }
  dispatchReady()
}

function startWatcher(projectPath: string): void {
  // projectPath = tronc PRINCIPAL ALWAYS. UN seul point de surveillance, sur <principal>/.oryon/run/tasks ;
  // les agents (cwd = worktree) y écrivent via les chemins ABSOLUS injectés dans leurs prompts.
  stopWatcher()
  processedOutputs.clear()
  watcher = chokidar.watch(tasksDir(projectPath), {
    ignoreInitial: true,
    // awaitWriteFinish : ne lire le fichier qu'une fois l'écriture stabilisée (pas de STATUS tronqué).
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  })
  const onFile = (full: string): void => handleOutputFile(full)
  watcher.on('add', onFile)
  watcher.on('change', onFile)
}
function stopWatcher(): void {
  if (watcher) {
    void watcher.close()
    watcher = null
  }
}

// ---- observateur du flux PTY (readiness uniquement) ----
function onData(terminalId: string, data: string): void {
  terminalLastData.set(terminalId, Date.now())
  if (terminalReady.get(terminalId)) return
  const buf = ((buffers.get(terminalId) ?? '') + stripAnsi(data)).slice(-4000)
  buffers.set(terminalId, buf)
  if (/(Welcome to Claude|Welcome back|esc to interrupt|bypass permissions|⏵⏵)/i.test(buf)) {
    terminalReady.set(terminalId, true)
    buffers.delete(terminalId) // plus besoin du tampon une fois prêt
    if (swarm && swarmTerminals.has(terminalId)) dispatchReady()
  }
}

// Watchdog : timeout des tasks dont le terminal assigné est silencieux + ménage mémoire.
function watchdogTick(): void {
  if (!swarm) return
  const now = Date.now()
  let changed = false
  for (const t of listTasks(swarm.workspaceId)) {
    if (t.status !== 'in-progress' && t.status !== 'in-review') continue
    let term: string | null = null
    for (const [tid, busy] of terminalBusy) if (busy === t.id) { term = tid; break }
    if (!term) continue // in-review en attente d'un reviewer → géré par dispatchReady, pas un timeout
    if (now - (terminalLastData.get(term) ?? now) > SILENCE_TIMEOUT) {
      const num = taskIdToNumber.get(t.id)
      notice(swarm.workspaceId, `timeout #${num ?? '?'} — terminal silencieux > 10 min, agent interrompu (ESC) et task remise en todo`)
      void interruptTerminal(term) // ESC l'agent orphelin AVANT de libérer (sinon il continue + un 2e agent pile dessus)
      updateTask(t.id, { status: 'todo', assigned_terminal_id: null })
      terminalBusy.set(term, null)
      changed = true
    }
  }
  if (changed) dispatchReady()
}

export function initOrchestrator(): void {
  if (observerInstalled) return
  observerInstalled = true
  prewarmDecomposer() // boot le décomposeur chaud en avance → 1er goal sans cold start
  addDataObserver(onData)
  addExitObserver((id) => {
    terminalReady.delete(id)
    terminalBusy.delete(id)
    terminalLastData.delete(id)
    buffers.delete(id)
  })
  setInterval(watchdogTick, WATCHDOG_INTERVAL)
}

// (Ré)initialise l'état du swarm pour un nouveau run. À n'appeler QUE quand on va dispatcher
// (code/question/Direct) — surtout PAS pour un broadcast, qui ne doit pas perturber un swarm en cours.
function initSwarmState(workspaceId: string): void {
  swarmTerminals.clear()
  for (const id of terminalIds(workspaceId)) {
    swarmTerminals.add(id)
    terminalBusy.set(id, null)
  }
  numberToTaskId.clear()
  taskIdToNumber.clear()
  numberToTaskFile.clear()
  reviewRounds.clear()
  builderTerminal.clear()
  nextNumber = 1
}

/**
 * (Ré)établit le swarm pour un workspace s'il est absent/différent, SANS réinitialiser les maps/numéros
 * ni les fichiers de run. Permet d'approuver une étape Plan après une navigation qui a vidé `swarm`
 * (stopSwarm au changement de workspace). Renvoie false si le workspace est introuvable.
 */
function ensureSwarmForWorkspace(workspaceId: string): boolean {
  if (swarm?.workspaceId === workspaceId) return true
  const ws = getWorkspace(workspaceId)
  if (!ws) return false
  swarm = {
    workspaceId,
    projectId: getOrCreateProjectId(ws.name, ws.project_path),
    projectPath: ws.project_path,
    goal: ws.name,
  }
  swarmTerminals.clear()
  for (const id of terminalIds(workspaceId)) swarmTerminals.add(id)
  startWatcher(ws.project_path)
  return true
}

/** Garantit qu'un fichier d'instructions existe pour ce numéro de task (recovery si la map a été vidée). */
function ensureTaskFileFor(num: number, t: Task): void {
  if (numberToTaskFile.has(num) || !swarm) return
  const role = t.role === 'scout' ? 'scout' : 'builder'
  const fname = writeTaskFile(swarm.projectPath, {
    n: num,
    title: t.title ?? t.instructions.slice(0, 60),
    role,
    instructions: t.instructions,
    depNumbers: [],
  })
  numberToTaskFile.set(num, fname)
}

// Broadcast / test-de-connexion : envoie le MÊME message aux terminaux LIBRES (prêts et non occupés),
// en parallèle. N'utilise NI tasks, NI run-files, NI watcher. On SAUTE les terminaux occupés par un
// swarm en cours (terminalBusy) pour ne pas injecter par-dessus leur travail — ils sont vivants, donc
// rapportés comme tels dans le bilan. Un broadcast ne perturbe donc PAS un swarm actif.
function runBroadcast(workspaceId: string, prompt: string): void {
  // Correction (C) : aplatir sur UNE ligne quelle que soit la source (un \n du goal brut déclencherait
  // une soumission prématurée dans le PTY claude en bracketed-paste).
  const line = prompt.replace(/\s+/g, ' ').trim()
  const all = terminalIds(workspaceId)
  const free = all.filter((id) => hasLiveTerminal(id) && terminalReady.get(id) && !terminalBusy.get(id))
  const busy = all.filter((id) => hasLiveTerminal(id) && terminalReady.get(id) && terminalBusy.get(id))
  const offline = all.filter((id) => !free.includes(id) && !busy.includes(id)) // morts ou pas encore prêts
  if (free.length === 0) {
    notice(
      workspaceId,
      `broadcast : aucun terminal libre à pinger (0/${all.length}${busy.length ? ` — ${busy.length} occupé(s) par le swarm` : ''})`,
    )
    return
  }
  for (const id of free) {
    writeTerminal(id, line)
    // claude TUI (bracketed paste) : Entrée comme événement SÉPARÉ, gardée par la vivacité du PTY seul.
    setTimeout(() => {
      if (hasLiveTerminal(id)) writeTerminal(id, '\r')
    }, INJECT_ENTER_DELAY)
  }
  const what = line.startsWith('/') ? `commande \`${line}\`` : 'ping'
  const parts = [`${what} envoyé à ${free.length}/${all.length} terminaux libres`]
  if (busy.length) parts.push(`${busy.length} occupé(s) au travail (vivants) : ${busy.map(terminalName).join(', ')}`)
  if (offline.length) parts.push(`non prêts : ${offline.map(terminalName).join(', ')}`)
  noticeIntent(workspaceId, parts.join(' — '))
}

// Crée les tasks d'un plan en DB, résout les dépendances (cassage de cycles), écrit les fichiers
// d'instructions, (re)démarre la surveillance puis dispatche — SAUF en mode propose (étapes à approuver).
// Suppose que `swarm` + initSwarmState ont déjà été établis par l'appelant.
function materializePlan(
  workspaceId: string,
  projectId: string,
  projectPath: string,
  goal: string,
  plan: PlanTask[],
  propose: boolean,
): void {
  // Dossier de run + GOAL.md (nettoie l'ancien run).
  initRun(projectPath, goal)

  // Créer les tasks en DB + assigner les numéros (ordre de création = numéro).
  const indexToId: string[] = []
  for (const pt of plan) {
    const t = createTask({
      workspaceId,
      projectId,
      title: pt.title,
      role: pt.role === 'scout' ? 'scout' : 'builder',
      instructions: pt.instructions,
      dependsOn: [],
    })
    if (propose) updateTask(t.id, { status: 'proposed' }) // étape en attente d'approbation (mode Plan)
    indexToId.push(t.id)
    assignNumber(t.id)
  }

  // dependsOn (indices bornés) + cassage de cycles : un index non "satisfiable" (dans/derrière un
  // cycle, ou self-dep) verrait ses deps jamais 'complete' → deadlock. On vide ses deps.
  const depIdx: number[][] = plan.map((pt) =>
    (pt.dependsOn ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d < plan.length),
  )
  const sat = new Array(plan.length).fill(false)
  let progress = true
  while (progress) {
    progress = false
    for (let i = 0; i < plan.length; i++) {
      if (!sat[i] && depIdx[i].every((d) => sat[d])) {
        sat[i] = true
        progress = true
      }
    }
  }
  let hadCycle = false
  for (let i = 0; i < plan.length; i++) {
    if (!sat[i]) {
      depIdx[i] = []
      hadCycle = true
    }
  }
  if (hadCycle) notice(workspaceId, '⚠ cycle de dépendances détecté — tâches concernées exécutées sans ordre')
  for (let i = 0; i < plan.length; i++) {
    const depIds = depIdx[i].map((d) => indexToId[d])
    if (depIds.length) {
      getDb().prepare('UPDATE tasks SET depends_on = ? WHERE id = ?').run(JSON.stringify(depIds), indexToId[i])
    }
  }

  // Écrire un fichier d'instructions par sub-task (avec les numéros de dépendances pour le contexte).
  for (let i = 0; i < plan.length; i++) {
    const num = taskIdToNumber.get(indexToId[i])!
    const depNums = depIdx[i].map((d) => taskIdToNumber.get(indexToId[d])!)
    const role = plan[i].role === 'scout' ? 'scout' : 'builder'
    const fname = writeTaskFile(projectPath, {
      n: num,
      title: plan[i].title,
      role,
      instructions: plan[i].instructions,
      depNumbers: depNums,
    })
    numberToTaskFile.set(num, fname)
  }

  startWatcher(projectPath)
  emitTasks(workspaceId)
  if (!propose) dispatchReady() // mode Plan : on attend l'approbation des étapes (cf. approvePlan / updateTaskStatus)
}

// ---- API ----
export async function submitGoal(workspaceId: string, goal: string, mode: SubmitMode): Promise<ReturnType<typeof listTasks>> {
  if (submitting) throw new Error('Une décomposition est déjà en cours — patiente quelques secondes.')
  const ws = getWorkspace(workspaceId)
  if (!ws) throw new Error(`Workspace ${workspaceId} introuvable`)

  submitting = true
  try {
    const projectId = getOrCreateProjectId(ws.name, ws.project_path)
    // Méta-directives Claude (effort/thinking) extraites du goal — utilisées par TOUS les chemins
    // (y compris broadcast : « mets tous les terminaux en ultracode » → /effort ultracode envoyé à tous).
    const directives = extractDirectives(goal)

    // 3 modes : 'direct' (local, $0) · 'ai' (étage d'intention LLM + routage) · 'plan' (propose, à approuver).
    let plan: PlanTask[]
    let propose = false // mode Plan : créer les étapes en 'proposed' et NE PAS dispatcher (attente d'approbation).
    if (mode === 'direct') {
      // Décomposition locale instantanée (zéro LLM), auto-dispatch.
      swarm = { workspaceId, projectId, projectPath: ws.project_path, goal }
      initSwarmState(workspaceId)
      plan = localDecompose(goal)
    } else if (mode === 'plan') {
      // Décompose en étapes mais ne dispatche pas : l'utilisateur approuve dans le panneau Plan.
      swarm = { workspaceId, projectId, projectPath: ws.project_path, goal }
      initSwarmState(workspaceId)
      const res = await decompose(goal)
      plan = res.tasks
      if (res.usedFallback) notice(workspaceId, '⚠ décomposition imparfaite : repli sur une tâche unique')
      propose = true
      noticeIntent(workspaceId, `[plan] ${plan.length} étape(s) proposée(s) — à approuver dans le panneau Plan`)
    } else {
      // 'ai' : étage de COMPRÉHENSION D'INTENTION. Comprend l'objectif, le poste, puis route. Fallback = code.
      const intent = await classifyIntent(goal)
      noticeIntent(workspaceId, `[${intent.intent}] ${intent.restatement}`)
      if (intent.intent === 'broadcast') {
        // Méta sur la flotte. Si c'est une directive d'effort (« mets tout le monde en ultracode »),
        // on envoie la VRAIE commande /effort à tous les terminaux au lieu d'un prompt en prose.
        const line = directives.effort ? `/effort ${directives.effort}` : intent.broadcastPrompt || goal
        runBroadcast(workspaceId, line)
        return listTasks(workspaceId)
      }
      // code ou question → on va dispatcher : (ré)initialise le swarm
      swarm = { workspaceId, projectId, projectPath: ws.project_path, goal }
      initSwarmState(workspaceId)
      if (intent.intent === 'question') {
        // Une question read-only = 1 scout (réutilise le pipeline run-files ; un scout passe direct à 'complete').
        plan = [
          {
            title: (intent.restatement || goal).slice(0, 80),
            instructions: intent.restatement || goal,
            role: 'scout',
            dependsOn: [],
          },
        ]
      } else {
        const res = await decompose(goal)
        plan = res.tasks
        if (res.usedFallback) notice(workspaceId, '⚠ décomposition imparfaite : repli sur une tâche unique')
      }
    }

    // Méta-directives Claude (effort/thinking) appliquées aux agents au dispatch (cf. directives en tête).
    if (swarm) {
      swarm.effort = directives.effort
      swarm.think = directives.think
    }

    materializePlan(workspaceId, projectId, ws.project_path, goal, plan, propose)
    return listTasks(workspaceId)
  } finally {
    submitting = false
  }
}

/** Mode Plan : approuve TOUTES les étapes 'proposed' du workspace → les passe 'todo' et les dispatche. */
export function approvePlan(workspaceId: string): void {
  if (!listTasks(workspaceId).some((t) => t.status === 'proposed')) return
  // Ré-établit le swarm si on a navigué entre-temps (sinon dispatchReady ne ferait rien → étapes bloquées).
  if (!ensureSwarmForWorkspace(workspaceId)) {
    notice(workspaceId, '⚠ workspace introuvable — approbation impossible')
    return
  }
  for (const t of listTasks(workspaceId)) {
    if (t.status === 'proposed') updateTask(t.id, { status: 'todo' })
  }
  emitTasks(workspaceId)
  dispatchReady()
}

export function runTask(taskId: string): void {
  const t = getTask(taskId)
  if (!t || !t.workspace_id) return
  if (!ensureSwarmForWorkspace(t.workspace_id)) return
  const term = pickFreeTerminal(t.workspace_id)
  if (!term) throw new Error('Aucun terminal libre/prêt')
  const num = assignNumber(taskId)
  const role = t.role === 'scout' ? 'scout' : 'builder'
  ensureTaskFileFor(num, t) // le run manuel peut viser une task sans fichier d'instructions → on l'écrit
  processedOutputs.delete(resultFileName(num))
  updateTask(taskId, { status: 'in-progress', assigned_terminal_id: term })
  builderTerminal.set(num, term)
  if (!reviewRounds.has(num)) reviewRounds.set(num, 0)
  const main = swarm!.projectPath // ensureSwarmForWorkspace ci-dessus a garanti swarm
  inject(
    term,
    taskId,
    buildAgentPrompt({
      number: num,
      role,
      taskFile: taskFileAbs(main, num, t.title),
      resultFile: resultFilePath(main, num),
      reviewFile: reviewFilePath(main, num),
      think: swarm?.think,
    }),
    effortPreCommand(),
  )
  emitTasks(t.workspace_id)
}

export function setTaskStatus(taskId: string, status: TaskStatus): void {
  const t = getTask(taskId)
  if (!t) return
  updateTask(taskId, { status })
  if (status === 'complete' || status === 'cancelled' || status === 'todo') freeTerminalForTask(taskId)
  if (t.workspace_id) {
    // Approuver une étape Plan (proposed→todo) doit dispatcher même si le swarm a été perdu (navigation).
    if (status === 'todo') ensureSwarmForWorkspace(t.workspace_id)
    emitTasks(t.workspace_id)
    if (swarm?.workspaceId === t.workspace_id) dispatchReady()
  }
}

export function stopSwarm(workspaceId: string): void {
  for (const t of listTasks(workspaceId)) {
    if (t.status === 'in-progress' || t.status === 'in-review') {
      updateTask(t.id, { status: 'todo', assigned_terminal_id: null })
    }
  }
  // Interrompt (ESC) chaque terminal occupé AVANT de le libérer : sinon l'agent poursuit son tour en
  // arrière-plan et un run ultérieur pourrait piler dessus (worktrees + merges dupliqués).
  for (const id of terminalIds(workspaceId)) {
    if (terminalBusy.get(id)) void interruptTerminal(id)
    terminalBusy.set(id, null)
  }
  if (swarm?.workspaceId === workspaceId) {
    swarm = null
    swarmTerminals.clear()
    stopWatcher()
  }
  emitTasks(workspaceId)
}

// ---- API pour l'orchestrateur conversationnel (cf. agent.ts) ----

export interface SwarmSnapshot {
  terminals: { name: string; state: 'free' | 'busy' | 'offline'; task?: number }[]
  tasks: { number: number; title: string | null; status: TaskStatus; role: string | null }[]
  mailbox: { from: string; body: string }[]
}

/** Photo de l'état courant d'un workspace (terminaux + tâches + activité), pour le contexte de l'orchestrateur. */
export function getSwarmSnapshot(workspaceId: string): SwarmSnapshot {
  const terminals = terminalIds(workspaceId).map((id) => {
    const busy = terminalBusy.get(id)
    let state: 'free' | 'busy' | 'offline'
    if (!hasLiveTerminal(id)) state = 'offline'
    else if (busy) state = 'busy'
    else if (terminalReady.get(id)) state = 'free'
    else state = 'offline' // vivant mais pas encore prêt → inutilisable pour l'instant
    const num = busy ? taskIdToNumber.get(busy) : undefined
    return { name: terminalName(id), state, task: num }
  })
  const tasks = listTasks(workspaceId)
    .filter((t) => t.status !== 'proposed')
    .map((t) => ({ number: taskIdToNumber.get(t.id) ?? 0, title: t.title, status: t.status, role: t.role }))
  const mailbox = listMailbox(workspaceId)
    .slice(-8)
    .map((m) => ({ from: m.from_agent ?? '?', body: m.body }))
  return { terminals, tasks, mailbox }
}

/** Dispatch GOUVERNÉ d'un plan décidé par l'orchestrateur (worktrees + revue + merge-back). Reset le batch. */
export function agentDispatchPipeline(
  workspaceId: string,
  plan: PlanTask[],
  directives?: { effort?: string; think?: boolean },
): { count: number; terminals: string[] } {
  const ws = getWorkspace(workspaceId)
  if (!ws) throw new Error(`Workspace ${workspaceId} introuvable`)
  const projectId = getOrCreateProjectId(ws.name, ws.project_path)
  const goal = plan.map((t) => t.title).join(' ; ')
  swarm = { workspaceId, projectId, projectPath: ws.project_path, goal, effort: directives?.effort, think: directives?.think }
  initSwarmState(workspaceId)
  materializePlan(workspaceId, projectId, ws.project_path, goal, plan, false)
  const terminals: string[] = []
  for (const [tid, busy] of terminalBusy) if (busy) terminals.push(terminalName(tid))
  return { count: plan.length, terminals }
}

/** Injection DIRECTE d'une instruction dans un terminal (par nom ou position #N). Léger, hors pipeline. */
export function agentInject(workspaceId: string, terminalRef: string, prompt: string): { terminal: string } {
  const ids = terminalIds(workspaceId)
  const ref = terminalRef.trim().replace(/^#/, '')
  let id: string | undefined
  const idx = Number(ref)
  if (Number.isInteger(idx) && idx >= 1 && idx <= ids.length) id = ids[idx - 1]
  if (!id) id = ids.find((x) => terminalName(x).toLowerCase() === ref.toLowerCase())
  if (!id) throw new Error(`terminal « ${terminalRef} » introuvable`)
  if (!hasLiveTerminal(id)) throw new Error(`terminal « ${terminalName(id)} » hors-ligne`)
  const tid = id
  const line = prompt.replace(/\s+/g, ' ').trim()
  writeTerminal(tid, line)
  // claude TUI (bracketed paste) : Entrée comme événement SÉPARÉ, gardé par la vivacité du PTY.
  setTimeout(() => {
    if (hasLiveTerminal(tid)) writeTerminal(tid, '\r')
  }, INJECT_ENTER_DELAY)
  return { terminal: terminalName(tid) }
}

/** Diffuse une instruction unique à tous les terminaux libres (réutilise runBroadcast). */
export function agentBroadcast(workspaceId: string, prompt: string): void {
  runBroadcast(workspaceId, prompt)
}

/** Poste un message dans la mailbox de l'orchestrateur. Appelé par send_mailbox (MCP tool). */
export function agentMailbox(workspaceId: string, fromAgent: string | null, body: string): void {
  const msg = recordMailbox(workspaceId, fromAgent, body)
  broadcast({ type: 'mailbox', workspaceId, message: msg })
}
