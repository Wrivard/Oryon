import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { getDb } from '../../db'
import { resolveClaudeBin, emptyMcpConfigPath, subscriptionEnv } from './cli'
import { ORCHESTRATOR_SYSTEM } from './roles'
import { recordMailbox } from './mailbox'
import {
  getSwarmSnapshot,
  agentDispatchPipeline,
  agentInject,
  agentBroadcast,
  type SwarmSnapshot,
} from './router'
import type { ChatMessage, PlanTask } from '../../../shared/types'

// Orchestrateur conversationnel : un process `claude` chaud PERSISTANT par workspace (stream-json),
// qui GARDE l'historique de session entre les tours (≠ decomposer qui recycle). Modèle capable pour
// une vraie conversation. Subscription $0 (subscriptionEnv efface ANTHROPIC_API_KEY). Il PARLE et AGIT
// via un bloc d'actions ```oryon parsé ici (cf. ORCHESTRATOR_SYSTEM).
const ORCHESTRATOR_MODEL = 'sonnet'
const TURN_TIMEOUT_MS = 120_000
const IDLE_KILL_MS = 15 * 60_000 // libère le process après 15 min sans message

interface Conv {
  proc: ChildProcessWithoutNullStreams
  buf: string
  alive: boolean
  busy: boolean
  resolveTurn: ((text: string) => void) | null
  rejectTurn: ((e: Error) => void) | null
  idleTimer: ReturnType<typeof setTimeout> | null
}
const convs = new Map<string, Conv>()

function projectPathOf(workspaceId: string): string {
  const row = getDb()
    .prepare('SELECT project_path FROM workspaces WHERE id = ?')
    .pluck()
    .get(workspaceId) as string | undefined
  return row ?? process.cwd()
}

function spawnConv(workspaceId: string): Conv {
  const proc = spawn(
    resolveClaudeBin(),
    [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose', // requis : sans lui, stream-json n'émet aucun événement
      '--model', ORCHESTRATOR_MODEL,
      '--tools', '', // l'orchestrateur raisonne et délègue ; il ne touche pas aux fichiers lui-même
      '--strict-mcp-config', '--mcp-config', emptyMcpConfigPath(),
      '--disable-slash-commands', // « /effort … » doit devenir une action broadcast, pas une commande locale
      '--system-prompt', ORCHESTRATOR_SYSTEM,
    ],
    { cwd: projectPathOf(workspaceId), env: subscriptionEnv() },
  )
  const c: Conv = {
    proc, buf: '', alive: true, busy: false, resolveTurn: null, rejectTurn: null, idleTimer: null,
  }
  proc.stdout.on('data', (d) => onConvData(c, d.toString()))
  proc.stderr.on('data', () => { /* bruit CLI ignoré */ })
  proc.on('error', () => killConv(workspaceId, c))
  proc.on('close', () => {
    c.alive = false
    const rej = c.rejectTurn
    c.resolveTurn = null
    c.rejectTurn = null
    if (rej) rej(new Error('process orchestrateur terminé'))
    if (convs.get(workspaceId) === c) convs.delete(workspaceId)
  })
  return c
}

/** Parse le flux stream-json ligne par ligne ; résout le tour courant sur l'événement `result`. */
function onConvData(c: Conv, chunk: string): void {
  c.buf += chunk
  let nl: number
  while ((nl = c.buf.indexOf('\n')) >= 0) {
    const line = c.buf.slice(0, nl).trim()
    c.buf = c.buf.slice(nl + 1)
    if (!line) continue
    let ev: { type?: string; result?: unknown }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev?.type === 'result' && c.resolveTurn) {
      const text = typeof ev.result === 'string' ? ev.result : ''
      const res = c.resolveTurn
      c.resolveTurn = null
      c.rejectTurn = null
      res(text)
    }
  }
}

function killConv(workspaceId: string, c: Conv): void {
  c.alive = false
  if (c.idleTimer) {
    clearTimeout(c.idleTimer)
    c.idleTimer = null
  }
  try {
    c.proc.stdin.end()
  } catch {
    /* ignore */
  }
  try {
    c.proc.kill()
  } catch {
    /* ignore */
  }
  if (convs.get(workspaceId) === c) convs.delete(workspaceId)
}

/** Envoie un tour au process chaud du workspace et résout avec le texte modèle. Un seul tour à la fois. */
function sendTurn(workspaceId: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let c = convs.get(workspaceId)
    if (!c || !c.alive) {
      c = spawnConv(workspaceId)
      convs.set(workspaceId, c)
    }
    if (c.busy) {
      reject(new Error('un tour est déjà en cours — patiente'))
      return
    }
    c.busy = true
    if (c.idleTimer) {
      clearTimeout(c.idleTimer)
      c.idleTimer = null
    }
    let settled = false
    const conv = c
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killConv(workspaceId, conv) // tour expiré → process douteux, on recycle
      reject(new Error('réponse expirée (120s)'))
    }, TURN_TIMEOUT_MS)

    conv.resolveTurn = (out) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conv.busy = false
      conv.idleTimer = setTimeout(() => killConv(workspaceId, conv), IDLE_KILL_MS)
      resolve(out)
    }
    conv.rejectTurn = (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    }

    try {
      conv.proc.stdin.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n',
      )
    } catch (e) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killConv(workspaceId, conv)
      reject(e as Error)
    }
  })
}

// ---- contexte + parsing/exécution des actions ----

function buildContextHeader(s: SwarmSnapshot): string {
  const terms = s.terminals.length
    ? s.terminals.map((t) => `${t.name}(${t.state}${t.task ? ':#' + t.task : ''})`).join(', ')
    : 'aucun'
  const tasks = s.tasks.length
    ? s.tasks.map((t) => `#${t.number} ${t.status} "${t.title ?? ''}"`).join(' | ')
    : 'aucune'
  const mb = s.mailbox.length ? s.mailbox.map((m) => `${m.from}: ${m.body}`).join(' | ') : '—'
  return ['[ORYON CONTEXT]', `Terminaux: ${terms}`, `Tâches: ${tasks}`, `Activité récente: ${mb}`].join('\n')
}

interface OryonAction {
  type?: string
  tasks?: Array<{ title?: unknown; instructions?: unknown; role?: unknown; dependsOn?: unknown }>
  terminal?: unknown
  prompt?: unknown
}

/** Sépare la prose (montrée à l'utilisateur) du bloc d'actions ```oryon (exécuté côté main). */
function parseActions(text: string): { prose: string; actions: OryonAction[] } {
  const fence = /```oryon\s*([\s\S]*?)```/i
  const m = text.match(fence)
  if (!m) return { prose: text.trim(), actions: [] }
  const prose = text.replace(fence, '').trim()
  let actions: OryonAction[] = []
  try {
    const parsed = JSON.parse(m[1].trim())
    if (parsed && Array.isArray(parsed.actions)) actions = parsed.actions
  } catch {
    /* bloc mal formé : on ignore les actions, la prose reste affichée */
  }
  return { prose, actions }
}

function executeActions(workspaceId: string, actions: OryonAction[]): string[] {
  const notes: string[] = []
  for (const a of actions) {
    try {
      if (a.type === 'pipeline' && Array.isArray(a.tasks) && a.tasks.length) {
        const plan: PlanTask[] = a.tasks
          .filter((t) => t && typeof t.instructions === 'string')
          .map((t) => ({
            title: typeof t.title === 'string' && t.title.trim() ? t.title.slice(0, 80) : String(t.instructions).slice(0, 80),
            instructions: String(t.instructions),
            role: t.role === 'scout' ? 'scout' : 'builder',
            dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).filter((n): n is number => typeof n === 'number') : [],
          }))
        if (!plan.length) continue
        const r = agentDispatchPipeline(workspaceId, plan)
        notes.push(`${r.count} sous-tâche(s) dispatchée(s)${r.terminals.length ? ' → ' + r.terminals.join(', ') : ''}`)
      } else if (a.type === 'inject' && a.terminal && typeof a.prompt === 'string') {
        const r = agentInject(workspaceId, String(a.terminal), a.prompt)
        notes.push(`instruction envoyée à ${r.terminal}`)
      } else if (a.type === 'broadcast' && typeof a.prompt === 'string') {
        agentBroadcast(workspaceId, a.prompt)
        notes.push('diffusion à tous les terminaux libres')
      }
    } catch (e) {
      notes.push(`⚠ action ${a.type ?? '?'} échouée : ${(e as Error).message}`)
    }
  }
  return notes
}

function broadcastMailbox(workspaceId: string, from: string, body: string): void {
  const message = recordMailbox(workspaceId, from, body)
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed()) w.webContents.send('orchestrator:event', { type: 'mailbox', workspaceId, message })
}

/** Un tour de conversation : préfixe le contexte, interroge l'orchestrateur, exécute ses actions. */
export async function chatToOrchestrator(workspaceId: string, userText: string): Promise<ChatMessage> {
  const header = buildContextHeader(getSwarmSnapshot(workspaceId))
  let reply: string
  try {
    reply = await sendTurn(workspaceId, `${header}\n[USER]\n${userText}`)
  } catch (e) {
    return { id: randomUUID(), role: 'assistant', body: `⚠ Orchestrateur indisponible : ${(e as Error).message}`, created_at: Date.now() }
  }
  const { prose, actions } = parseActions(reply)
  let body = prose
  if (actions.length) {
    const notes = executeActions(workspaceId, actions)
    if (notes.length) {
      body = (prose ? prose + '\n\n' : '') + notes.map((n) => `→ ${n}`).join('\n')
      broadcastMailbox(workspaceId, 'orchestrateur', notes.join(' · '))
    }
  }
  return { id: randomUUID(), role: 'assistant', body: body || '(aucune réponse)', created_at: Date.now() }
}

/** Termine le process chaud d'un workspace (ex. fermeture du workspace). */
export function stopOrchestrator(workspaceId: string): void {
  const c = convs.get(workspaceId)
  if (c) killConv(workspaceId, c)
}
