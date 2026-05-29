import * as pty from '@lydell/node-pty'
import os from 'os'
import { shellIntegrationArgs, baseShellArgs } from './shell-integration'
import { appSetting } from '../ipc/settings.ipc'

interface Term {
  id: string
  proc: pty.IPty
}

const terms = new Map<string, Term>()

// Observateurs globaux du flux PTY (l'orchestrateur tape ici pour parser les marqueurs MAILBOX
// et détecter l'état "claude prêt", en plus du forward vers le renderer).
type DataObserver = (terminalId: string, data: string) => void
const dataObservers = new Set<DataObserver>()
export function addDataObserver(o: DataObserver): () => void {
  dataObservers.add(o)
  return () => dataObservers.delete(o)
}

// Observateurs de fin de terminal (l'orchestrateur réinitialise l'état ready/busy d'un id qui meurt/respawn).
type ExitObserver = (terminalId: string) => void
const exitObservers = new Set<ExitObserver>()
export function addExitObserver(o: ExitObserver): () => void {
  exitObservers.add(o)
  return () => exitObservers.delete(o)
}
function notifyExit(id: string): void {
  for (const o of exitObservers) o(id)
}

export function listTerminalIds(): string[] {
  return [...terms.keys()]
}
export function hasLiveTerminal(id: string): boolean {
  return terms.has(id)
}

export interface CreateTerminalOpts {
  id: string
  cwd: string
  autostart?: string | null
  cols: number
  rows: number
  env?: Record<string, string> // env additionnel (ex. ORYON_AGENT_NAME) — fusionné par-dessus ptyEnv()
  onData: (data: string) => void
  onExit: (code: number) => void
}

/**
 * Env du PTY. On retire ANTHROPIC_API_KEY pour que `claude` lise l'OAuth
 * (~/.claude/.credentials.json) en mode subscription, jamais une clé API payante.
 */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  delete env.ANTHROPIC_API_KEY
  return env
}

const DEFAULT_SHELL = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'

export function createTerminal(opts: CreateTerminalOpts): string {
  // Double mount (StrictMode) / réouverture : on repart proprement.
  if (terms.has(opts.id)) killTerminal(opts.id)

  // Intégration shell (command-blocks, OSC 133) — activée par défaut, désactivable via réglage.
  // Dans les deux cas on garde -NoProfile pour PowerShell (garde-fou $0 : pas de ré-injection de clé API).
  const shellArgs =
    appSetting('terminal.shellIntegration') === '0' ? baseShellArgs(DEFAULT_SHELL) : shellIntegrationArgs(DEFAULT_SHELL)
  const proc = pty.spawn(DEFAULT_SHELL, shellArgs, {
    name: 'xterm-color',
    cwd: opts.cwd,
    cols: Math.max(2, opts.cols),
    rows: Math.max(1, opts.rows),
    env: { ...ptyEnv(), ...(opts.env ?? {}) }, // ptyEnv() retire ANTHROPIC_API_KEY ($0) ; opts.env n'ajoute que ORYON_*
  })

  // Gardes par identité de process : si ce pty a été remplacé (kill + recreate même id),
  // ses handlers asynchrones ne doivent ni écrire dans le nouveau, ni le supprimer de la map.
  proc.onData((data) => {
    if (terms.get(opts.id)?.proc !== proc) return
    opts.onData(data)
    for (const o of dataObservers) o(opts.id, data)
  })
  proc.onExit(({ exitCode }) => {
    if (terms.get(opts.id)?.proc === proc) {
      terms.delete(opts.id)
      opts.onExit(exitCode)
      notifyExit(opts.id)
    }
  })
  terms.set(opts.id, { id: opts.id, proc })

  if (opts.autostart) {
    // Laisser le shell s'initialiser avant d'injecter la commande (ex: "claude").
    // Garde par identité de process : si un remount (StrictMode) a remplacé le pty
    // entre-temps, on n'écrit pas dans l'ancien (évite un double-lancement de claude).
    setTimeout(() => {
      const t = terms.get(opts.id)
      if (t && t.proc === proc) t.proc.write(`${opts.autostart}\r`)
    }, 400)
  }

  return opts.id
}

export function writeTerminal(id: string, data: string): void {
  terms.get(id)?.proc.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const t = terms.get(id)
  if (!t) return
  try {
    t.proc.resize(Math.max(2, cols), Math.max(1, rows))
  } catch {
    /* resize peut lever si le pty vient de mourir */
  }
}

export function killTerminal(id: string): void {
  const t = terms.get(id)
  if (!t) return
  try {
    t.proc.kill()
  } catch {
    /* déjà mort */
  }
  terms.delete(id)
  // L'onExit ci-dessus est court-circuité par la suppression du map sur un kill explicite → notifier ici.
  notifyExit(id)
}

export function killAllTerminals(): void {
  for (const id of [...terms.keys()]) killTerminal(id)
}
