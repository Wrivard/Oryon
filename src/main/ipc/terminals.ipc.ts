import { ipcMain } from 'electron'
import type { CreateTerminalInput } from '../../shared/types'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal } from '../services/pty-manager'
import { ensureClaudeReady, normalizeClaudeAutostart, enforceAgentSpawn } from '../services/claude-launcher'
import { hasClaudeSessionId } from '../services/claude-session'
import { buildProjectMcpConfigForPath } from './settings.ipc'

// Coalescing du flux PTY→renderer : un send par rafale (~8 ms) au lieu d'un par chunk.
// Un agent claude qui streame = des dizaines de chunks/s × N terminaux montés — l'IPC
// par chunk coûtait cher pour rien (xterm.write accepte les blocs). 8 ms < 1 frame
// (16 ms) → aucune latence perceptible. flushNow garantit l'ORDRE data→exit.
const FLUSH_MS = 8
const FLUSH_MAX_BYTES = 64 * 1024
export function makeCoalescedSender(send: (data: string) => void): {
  push: (data: string) => void
  flushNow: () => void
} {
  let buf = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flushNow = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!buf) return
    const out = buf
    buf = ''
    send(out)
  }
  return {
    push: (data: string): void => {
      buf += data
      if (buf.length >= FLUSH_MAX_BYTES) {
        flushNow()
        return
      }
      if (!timer) timer = setTimeout(flushNow, FLUSH_MS)
    },
    flushNow,
  }
}

export function registerTerminalsIpc() {
  // Spawn d'un PTY ; le flux d'octets est poussé sur des canaux dédiés par id.
  ipcMain.handle('terminals:create', (e, opts: CreateTerminalInput) => {
    const wc = e.sender
    // Agent claude : pré-arme la config (pas de wizard, abonnement) + force le mode autonome,
    // quelle que soit la commande stockée en DB (ancienne = "claude" nu).
    let autostart = opts.autostart ?? null
    if (autostart && /^claude(\s|$)/.test(autostart.trim())) {
      ensureClaudeReady(opts.cwd) // trust per-path : claude démarre dans le worktree (opts.cwd)
      autostart = normalizeClaudeAutostart(autostart)
      // ORYON_PROJECT_DIR + config MCP ancrés sur le projet PRINCIPAL (mémoire PARTAGÉE), jamais le worktree.
      // Le piège #1 : un chemin de worktree n'a pas de ligne `projects` → la config retomberait sur
      // oryon-mcp-app.json et SCINDERAIT la mémoire en 8 dossiers privés, sans aucune erreur. mainProjectPath
      // absent (projet non-git, cwd partagé) → repli sur cwd.
      const mcpAnchor = opts.mainProjectPath ?? opts.cwd
      const mcpFile = buildProjectMcpConfigForPath(mcpAnchor)
      // --strict-mcp-config : ne charge QUE ce fichier, ignore tout .mcp.json auto-découvert dans le
      // cwd/worktree → état MCP déterministe, un seul serveur `oryon` exposé. Aligné sur cli.ts:64.
      if (mcpFile && !/--mcp-config/.test(autostart)) autostart += ` --strict-mcp-config --mcp-config '${mcpFile.replace(/'/g, "''")}'`
      // Enforcement au spawn : modèle le plus puissant pour TOUS les agents (non-contournable, F1) +
      // identité worker durable injectée à tout claude sans --append-system-prompt (F2/F3/F5/F6).
      autostart = enforceAgentSpawn(autostart)
      // Reprise de session au redémarrage : SEUL l'orchestrateur reprend (les WORKERS repartent FRAIS — leur
      // session = une tâche jetable, ré-assignée au boot ; resumer une grosse session worker brûle de l'usage).
      // On ÉPINGLE l'orchestrateur sur SA session DÉDIÉE, identifiée par son terminal id (stable en DB) :
      //   • `--resume <id>` si <id>.jsonl existe déjà → reprise DÉTERMINISTE de SA conversation ;
      //   • `--session-id <id>` au 1er lancement → crée la session avec cet id.
      // Pourquoi PAS `--continue` : il reprend la session la PLUS RÉCENTE du dossier. Or l'orchestrateur PARTAGE
      // son cwd (repo principal) avec d'éventuelles sessions `claude` MANUELLES de l'utilisateur → --continue
      // pouvait reprendre la MAUVAISE et restaurer son input résiduel (« npm »/« run », fragment d'un `npm run
      // dev`) qui se faisait auto-soumettre au resume = le « prompt fantôme ». L'épinglage par id supprime la
      // collision (cf. claude-session.hasClaudeSessionId + clear du brouillon restauré dans Terminal.tsx).
      // NB : chokepoint touché qu'au DÉMARRAGE (ou nouveau terminal/split), JAMAIS au switch de workspace.
      const isOrchestrator = opts.env?.ORYON_AGENT_ROLE === 'orchestrator'
      if (isOrchestrator && !/--(session-id|resume|continue)\b/.test(autostart)) {
        autostart += hasClaudeSessionId(opts.cwd, opts.id) ? ` --resume ${opts.id}` : ` --session-id ${opts.id}`
      }
    }
    const sender = makeCoalescedSender((data) => {
      if (!wc.isDestroyed()) wc.send(`terminal:data:${opts.id}`, data)
    })
    createTerminal({
      id: opts.id,
      cwd: opts.cwd,
      autostart,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env,
      onData: (data) => sender.push(data),
      onExit: (code) => {
        sender.flushNow() // flush le buffer AVANT de signaler l'exit → ordre data→exit garanti côté renderer
        if (!wc.isDestroyed()) wc.send(`terminal:exit:${opts.id}`, code)
      },
    })
  })

  // Flux haute fréquence : one-way (send), pas d'invoke.
  ipcMain.on('terminals:write', (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.on('terminals:resize', (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ipcMain.on('terminals:kill', (_e, id: string) => killTerminal(id))
}
