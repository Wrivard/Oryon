// Boîte noire « post-mortem » du process MAIN. Contexte (2026-06-12) : l'app meurt par rafales en
// travaillant sur certains workspaces (séquence open_browser → browser_screenshot), SANS aucun signal —
// pas de dump WER, pas d'événement Windows, aucun child-process-gone, filets uncaughtException muets.
// On instrumente donc la VIE du process : un battement de cœur écrit toutes les 5 s sur disque ; au boot
// suivant, s'il n'y a pas eu d'arrêt PROPRE (will-quit), l'instance précédente est morte BRUTALEMENT et on
// sait QUAND (± un battement) — verdict loggé dans le ring (read_app_log) + journal cumulatif
// mcp-state/deaths.ndjson. Croisé avec crashReporter.start (index.ts) et le filet process.on('exit') :
//   • dump Crashpad présent  → crash NATIF (module identifiable dans le dump) ;
//   • exit-code.txt écrit    → sortie INTERNE (app.exit/LOG(FATAL) passé par l'exit JS) ;
//   • ni l'un ni l'autre     → kill EXTERNE du process (TerminateProcess : antivirus, injecteur…).
// Tout est SYNCHRONE : une promesse ne survit ni à un crash ni à will-quit.

import { app } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { appendAppConsole } from '../ipc/browser.ipc'

const HEARTBEAT_MS = 5_000

interface Heartbeat {
  pid: number
  startedAt: string
  lastBeat: string
  version?: string
  clean?: boolean
}

function stateDir(): string {
  return join(app.getPath('userData'), 'mcp-state')
}
function hbPath(): string {
  return join(stateDir(), 'heartbeat.json')
}
function exitCodePath(): string {
  return join(stateDir(), 'exit-code.txt')
}

let timer: ReturnType<typeof setInterval> | null = null
let started = false // garde : une 2e instance (single-instance lock) ne doit pas toucher au heartbeat de la 1re
const startedAt = new Date().toISOString()

function writeBeat(extra?: Partial<Heartbeat>): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    const hb: Heartbeat = {
      pid: process.pid,
      startedAt,
      lastBeat: new Date().toISOString(),
      version: app.getVersion(),
      ...extra,
    }
    writeFileSync(hbPath(), JSON.stringify(hb))
  } catch {
    /* best-effort */
  }
}

/** À appeler AU BOOT, AVANT startHeartbeat (sinon le battement frais écrase la preuve de la mort). */
export function reportLastDeath(): void {
  // exit-code.txt de la session précédente : lu PUIS effacé dans tous les cas (sinon il deviendrait périmé
  // et accuserait une sortie interne sur une mort ultérieure qui n'en est pas une).
  let exitInfo: { code?: number; at?: string } | null = null
  try {
    exitInfo = JSON.parse(readFileSync(exitCodePath(), 'utf8'))
  } catch {
    /* absent = pas de sortie interne */
  }
  try {
    rmSync(exitCodePath(), { force: true })
  } catch {
    /* ignore */
  }
  try {
    const prev = JSON.parse(readFileSync(hbPath(), 'utf8')) as Heartbeat
    if (prev.clean) return // arrêt propre : rien à signaler
    const uptimeS = Math.round((Date.parse(prev.lastBeat) - Date.parse(prev.startedAt)) / 1000)
    const exitNote = exitInfo
      ? `sortie interne code=${exitInfo.code}`
      : 'AUCUN exit interne (crash natif → voir Crashpad/reports ; sinon kill EXTERNE du process)'
    const line = `[mortem] instance précédente (pid ${prev.pid}, v${prev.version ?? '?'}) morte BRUTALEMENT vers ${prev.lastBeat} (±${HEARTBEAT_MS / 1000} s, uptime ${uptimeS} s) — ${exitNote}`
    console.error(line)
    appendAppConsole('error', line, 'main')
    appendFileSync(
      join(stateDir(), 'deaths.ndjson'),
      JSON.stringify({ detectedAt: new Date().toISOString(), ...prev, uptimeS, exit: exitInfo }) + '\n',
    )
  } catch {
    /* pas de heartbeat précédent (1er boot post-update) ou illisible : rien à dire */
  }
}

/** Battement périodique + filet process.on('exit') (sorties internes : app.exit, FATAL passé par l'exit JS). */
export function startHeartbeat(): void {
  if (started) return
  started = true
  writeBeat()
  timer = setInterval(writeBeat, HEARTBEAT_MS)
  process.on('exit', (code) => {
    // Un crash natif ou un TerminateProcess externe ne passe JAMAIS ici — c'est le discriminant voulu.
    try {
      writeFileSync(exitCodePath(), JSON.stringify({ code, at: new Date().toISOString(), pid: process.pid }))
    } catch {
      /* ignore */
    }
  })
}

/** À appeler dans will-quit (EN PREMIER) : marque l'arrêt PROPRE — le boot suivant ne criera pas au mort. */
export function markCleanShutdown(): void {
  if (!started) return
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  writeBeat({ clean: true })
}
