import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { tmpdir } from 'os'
import { resolveClaudeBin, emptyMcpConfigPath, subscriptionEnv } from './cli'
import { DECOMPOSER_SYSTEM, INTENT_SYSTEM } from './roles'
import type { PlanTask, IntentResult } from '../../../shared/types'

// Modèle du decomposer : Haiku = rapide + pool distinct des agents Opus (moins de contention
// quand le swarm tourne). Passer à 'sonnet' si la qualité de découpage déçoit.
const DECOMPOSER_MODEL = 'haiku'

// Process décomposeur CHAUD persistant. Mesuré : réutiliser un process déjà bootté (au lieu d'un
// spawn jetable par goal) coupe ~40% de la latence sur les décompositions répétées
// (6s→3.7s, TTFT 3.2s→1.9s). Le gain vient de la chaleur du process/session — PAS d'un cache API
// (cache_read reste à 0). Isolation indispensable : cwd=tmpdir + --tools "" → le modèle obéit au
// system prompt (sinon il charge CLAUDE.md/auto-memory et part en mode assistant conversationnel).
const MAX_GOALS_PER_PROCESS = 10 // recyclage : borne la croissance de l'historique (~500 tok/goal)
const IDLE_KILL_MS = 5 * 60_000 // libère le process chaud après 5 min sans goal
const TURN_TIMEOUT_MS = 90_000

// resolveClaudeBin / emptyMcpConfigPath / subscriptionEnv : extraits dans ./cli (partagés avec Voice).

/** Extraction défensive d'un {tasks:[...]} depuis du texte (potentiellement entouré de prose/markdown). */
function extractTasks(text: string): PlanTask[] | null {
  let s = text.replace(/```json|```/g, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  try {
    const parsed = JSON.parse(s)
    if (!parsed || !Array.isArray(parsed.tasks)) return null
    const tasks: PlanTask[] = parsed.tasks
      .filter((t: unknown): t is Record<string, unknown> => !!t && typeof t === 'object')
      .filter((t: Record<string, unknown>) => typeof t.instructions === 'string')
      .map((t: Record<string, unknown>) => ({
        title: typeof t.title === 'string' ? t.title : String(t.instructions).slice(0, 80),
        instructions: String(t.instructions),
        role: t.role === 'scout' ? 'scout' : 'builder',
        dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as number[]).filter((n) => typeof n === 'number') : [],
      }))
    return tasks.length ? tasks : null
  } catch {
    return null
  }
}

/** Dernier recours : le but devient une unique task builder (le swarm reste actionnable). */
function fallback(goal: string): PlanTask[] {
  return [{ title: goal.slice(0, 80), instructions: goal, role: 'builder', dependsOn: [] }]
}

/**
 * Décomposition LOCALE instantanée (zéro LLM, < 1ms) pour le mode "Direct".
 * Découpe conservatrice sur des séparateurs STRUCTURELS uniquement (lignes, listes numérotées,
 * puces, points-virgules) → 1 ligne/élément = 1 tâche builder parallèle. Sinon : 1 tâche unique.
 * (On ne découpe PAS une phrase sur " et " — trop risqué ; pour ça, utiliser le mode AI.)
 */
export function localDecompose(goal: string): PlanTask[] {
  const g = goal.trim()
  let parts: string[]
  if (/\r?\n/.test(g)) {
    parts = g.split(/\r?\n/)
  } else if (/(?:^|\s)\d+[.)]\s+/.test(g)) {
    parts = g.split(/(?:^|\s)\d+[.)]\s+/)
  } else if (g.includes(';')) {
    parts = g.split(';')
  } else {
    parts = [g]
  }
  // Retire UNIQUEMENT un vrai marqueur de liste en tête (puce ou "N." / "N)") — pas un chiffre nu
  // (sinon "3 boutons à ajouter" perdrait le "3").
  parts = parts.map((p) => p.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim()).filter((p) => p.length > 0)
  if (parts.length === 0) parts = [g]
  return parts.map((p) => ({ title: p.slice(0, 80), instructions: p, role: 'builder' as const, dependsOn: [] }))
}

// ---- process décomposeur chaud (singleton) ----
interface Warm {
  proc: ChildProcessWithoutNullStreams
  buf: string
  goalsServed: number
  busy: boolean
  alive: boolean
  resolveTurn: ((text: string) => void) | null
  rejectTurn: ((e: Error) => void) | null
  idleTimer: ReturnType<typeof setTimeout> | null
}
let warm: Warm | null = null

/** Spawn d'un process claude persistant en mode stream-json (flags identiques au one-shot + I/O streaming). */
function spawnWarm(): Warm {
  const proc = spawn(
    resolveClaudeBin(),
    [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose', // requis : sans lui, le mode stream-json n'émet aucun événement
      '--model', DECOMPOSER_MODEL,
      '--effort', 'low',
      '--tools', '', // aucun outil → réponse directe, et le modèle obéit au system prompt
      '--strict-mcp-config', '--mcp-config', emptyMcpConfigPath(),
      '--disable-slash-commands',
      '--system-prompt', DECOMPOSER_SYSTEM,
    ],
    { cwd: tmpdir(), env: subscriptionEnv() },
  )
  const w: Warm = {
    proc, buf: '', goalsServed: 0, busy: false, alive: true,
    resolveTurn: null, rejectTurn: null, idleTimer: null,
  }
  proc.stdout.on('data', (d) => onWarmData(w, d.toString()))
  proc.stderr.on('data', () => { /* bruit CLI ignoré */ })
  proc.on('error', () => killWarm(w))
  proc.on('close', () => {
    w.alive = false
    const rej = w.rejectTurn
    w.resolveTurn = null
    w.rejectTurn = null
    if (rej) rej(new Error('warm decomposer exited'))
    if (warm === w) warm = null
  })
  return w
}

/** Parse le flux stream-json ligne par ligne ; résout le tour courant sur l'événement `result`. */
function onWarmData(w: Warm, chunk: string): void {
  w.buf += chunk
  let nl: number
  while ((nl = w.buf.indexOf('\n')) >= 0) {
    const line = w.buf.slice(0, nl).trim()
    w.buf = w.buf.slice(nl + 1)
    if (!line) continue
    let ev: { type?: string; result?: unknown }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev?.type === 'result' && w.resolveTurn) {
      const text = typeof ev.result === 'string' ? ev.result : ''
      const res = w.resolveTurn
      w.resolveTurn = null
      w.rejectTurn = null
      res(text)
    }
  }
}

function killWarm(w: Warm): void {
  w.alive = false
  if (w.idleTimer) {
    clearTimeout(w.idleTimer)
    w.idleTimer = null
  }
  try {
    w.proc.stdin.end()
  } catch {
    /* ignore */
  }
  try {
    w.proc.kill()
  } catch {
    /* ignore */
  }
  if (warm === w) warm = null
}

/** Envoie un goal au process chaud et résout avec le texte modèle. Rejette si busy/timeout/process mort. */
function decomposeViaWarm(goal: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!warm || !warm.alive) warm = spawnWarm()
    const w = warm
    if (w.busy) {
      reject(new Error('warm decomposer busy'))
      return
    }
    w.busy = true
    if (w.idleTimer) {
      clearTimeout(w.idleTimer)
      w.idleTimer = null
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killWarm(w) // un tour expiré laisse le process dans un état douteux → on le recycle
      reject(new Error('warm decompose timeout'))
    }, TURN_TIMEOUT_MS)

    w.resolveTurn = (text) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      w.busy = false
      w.goalsServed++
      if (w.goalsServed >= MAX_GOALS_PER_PROCESS) {
        killWarm(w) // borne la croissance de l'historique : on repart frais au prochain goal
      } else {
        w.idleTimer = setTimeout(() => killWarm(w), IDLE_KILL_MS)
      }
      resolve(text)
    }
    w.rejectTurn = (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    }

    try {
      w.proc.stdin.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: goal }] } }) + '\n',
      )
    } catch (e) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killWarm(w)
      reject(e as Error)
    }
  })
}

/** Pré-chauffe le process décomposeur (boot + handshake) pour que le 1er goal réel ne paie pas le cold start. */
export function prewarmDecomposer(): void {
  if (warm && warm.alive) return
  warm = spawnWarm()
  warm.idleTimer = setTimeout(() => {
    if (warm) killWarm(warm)
  }, IDLE_KILL_MS)
}

/**
 * One-shot : un spawn `claude -p` jetable par goal. Robuste (parsing défensif + fallback), sert de
 * REPLI quand le process chaud échoue (busy/timeout/mort). cwd neutre + system prompt via argv.
 */
function decomposeOneShot(goal: string): Promise<{ tasks: PlanTask[]; usedFallback: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      resolveClaudeBin(),
      [
        '-p',
        '--model', DECOMPOSER_MODEL,
        '--effort', 'low',
        '--tools', '',
        '--strict-mcp-config', '--mcp-config', emptyMcpConfigPath(),
        '--disable-slash-commands',
        '--system-prompt', DECOMPOSER_SYSTEM,
        '--output-format', 'json',
      ],
      { cwd: tmpdir(), env: subscriptionEnv() },
    )

    let out = ''
    let err = ''
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error('Décomposition expirée (90s)')))
    }, TURN_TIMEOUT_MS)

    proc.stdout.on('data', (d) => (out += d.toString()))
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', (e) => finish(() => reject(e)))
    proc.on('close', () =>
      finish(() => {
        let modelText = out
        try {
          const envelope = JSON.parse(out)
          if (envelope && typeof envelope.result === 'string') modelText = envelope.result
          if (envelope && envelope.is_error) {
            console.error('[decomposer] claude a renvoyé une erreur :', envelope.result || err)
          }
        } catch {
          /* out n'est pas l'enveloppe attendue — on tente l'extraction sur le brut */
        }
        const tasks = extractTasks(modelText)
        if (!tasks) {
          console.warn('[decomposer] JSON non exploitable, fallback en une task. Sortie:', modelText.slice(0, 300))
        }
        resolve({ tasks: tasks ?? fallback(goal), usedFallback: !tasks })
      }),
    )

    proc.stdin.write(goal)
    proc.stdin.end()
  })
}

/**
 * Décompose un objectif en tasks via `claude` headless (subscription, $0).
 * Chemin rapide : process chaud persistant (stream-json) réutilisé entre les goals. Si ce chemin
 * échoue (busy/timeout/process mort), repli sur un spawn one-shot froid. Parsing défensif + fallback
 * partout (ne rejette jamais sur du JSON imparfait).
 */
export async function decompose(goal: string): Promise<{ tasks: PlanTask[]; usedFallback: boolean }> {
  try {
    const text = await decomposeViaWarm(goal)
    const tasks = extractTasks(text)
    return { tasks: tasks ?? fallback(goal), usedFallback: !tasks }
  } catch {
    // process chaud indisponible → retry froid one-shot (jamais de régression vs l'ancien comportement)
    return decomposeOneShot(goal)
  }
}

// ---- étage de compréhension d'intention (avant décomposition) ----

/** Extraction défensive d'un IntentResult depuis du texte (intent inconnu → 'code'). null si illisible. */
function extractIntent(text: string): IntentResult | null {
  let s = text.replace(/```json|```/g, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  try {
    const parsed = JSON.parse(s)
    if (!parsed || typeof parsed !== 'object') return null
    const intent: IntentResult['intent'] =
      parsed.intent === 'broadcast' || parsed.intent === 'question' ? parsed.intent : 'code'
    return {
      restatement: typeof parsed.restatement === 'string' ? parsed.restatement : '',
      intent,
      broadcastPrompt: typeof parsed.broadcastPrompt === 'string' ? parsed.broadcastPrompt : '',
    }
  } catch {
    return null
  }
}

/**
 * Comprend l'objectif global et le classe (code / broadcast / question) AVANT toute décomposition.
 * Spawn one-shot `claude` (mêmes flags subscription $0 que decomposeOneShot). Ne REJETTE jamais :
 * tout échec (JSON illisible, timeout, process mort) → fallback {intent:'code'} → flux code inchangé.
 */
export function classifyIntent(goal: string): Promise<IntentResult> {
  const fallback: IntentResult = { restatement: goal, intent: 'code', broadcastPrompt: '' }
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (r: IntentResult) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    // Garde load-bearing : la garantie « ne rejette jamais » doit être INCONDITIONNELLE. Un throw
    // SYNCHRONE dans l'exécuteur (spawn/argv invalides, tmpdir non inscriptible, stdin indisponible)
    // rejetterait la Promise sans passer par proc.on('error') → régression du flux code. On l'attrape.
    try {
      const proc = spawn(
        resolveClaudeBin(),
        [
          '-p',
          '--model', DECOMPOSER_MODEL,
          '--effort', 'low',
          '--tools', '',
          '--strict-mcp-config', '--mcp-config', emptyMcpConfigPath(),
          '--disable-slash-commands',
          '--system-prompt', INTENT_SYSTEM,
          '--output-format', 'json',
        ],
        { cwd: tmpdir(), env: subscriptionEnv() },
      )
      let out = ''
      timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        finish(fallback)
      }, TURN_TIMEOUT_MS)

      proc.stdout.on('data', (d) => (out += d.toString()))
      proc.stderr.on('data', () => {})
      proc.on('error', () => finish(fallback))
      proc.on('close', () => {
        let modelText = out
        try {
          const envelope = JSON.parse(out)
          if (envelope && typeof envelope.result === 'string') modelText = envelope.result
        } catch {
          /* brut */
        }
        const parsed = extractIntent(modelText)
        if (parsed) {
          if (!parsed.restatement) parsed.restatement = goal
          finish(parsed)
        } else {
          finish(fallback)
        }
      })

      proc.stdin.write(goal)
      proc.stdin.end()
    } catch {
      finish(fallback)
    }
  })
}
