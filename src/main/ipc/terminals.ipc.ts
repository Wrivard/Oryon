import { app, ipcMain } from 'electron'
import { join } from 'path'
import type { CreateTerminalInput, Terminal } from '../../shared/types'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal } from '../services/pty-manager'
import { ensureClaudeReady, normalizeClaudeAutostart, enforceAgentSpawn } from '../services/claude-launcher'
import { hasClaudeSessionId, getOrchestratorResumeId } from '../services/claude-session'
import { buildProjectMcpConfigForPath } from './settings.ipc'
import { getDb } from '../db'
import { ensureWorktree, isGitRepo } from '../services/worktrees'

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
    // Identité AUTORITAIRE = la ligne DB (jamais le renderer) : rôle, nom, cwd (= tronc), workspace.
    const row = getDb().prepare('SELECT * FROM terminals WHERE id = ?').get(opts.id) as Terminal | undefined
    const isWorker = !!row && row.role !== 'orchestrator'
    // Chokepoint worktree (côté MAIN) : un WORKER démarre TOUJOURS dans SON worktree, jamais dans le tronc
    // (rapport 1975b0b1 : claude worker dans l'arbre principal = contamination réelle). On (re)garantit le
    // worktree ICI et on IMPOSE le cwd (opts.cwd du renderer n'est pas de confiance) ; worktree irrécupérable
    // → on REFUSE le spawn (message visible), jamais de repli sur le tronc. L'orchestrateur garde cwd = tronc.
    let cwd = opts.cwd
    if (isWorker && row && isGitRepo(row.cwd)) {
      try {
        cwd = ensureWorktree(row.cwd, row.name)
        if (cwd !== row.worktree_path) getDb().prepare('UPDATE terminals SET worktree_path = ? WHERE id = ?').run(cwd, opts.id)
      } catch (err) {
        // Spawn REFUSÉ et VISIBLE (canal data du terminal) → aucun claude lancé dans le tronc. Pas de notif
        // orchestrateur poussée ici : terminals.ipc↔router serait un import circulaire (router importe déjà
        // makeCoalescedSender d'ici) ; le message terminal suffit (option acceptée par le plan 011).
        const errMsg = `\r\n\x1b[31m[oryon] spawn refusé : worktree irrécupérable pour ${row.name} — ${(err as Error).message}\x1b[0m\r\n`
        if (!wc.isDestroyed()) wc.send(`terminal:data:${opts.id}`, errMsg)
        return
      }
    }
    // Env d'identité construit côté MAIN (valeurs DB prioritaires sur opts.env) + ORYON_TERMINAL_ID à TOUS les
    // spawns (attribution stable par id ; rapports « ORYON_TERMINAL_ID vide » côté workers).
    const env: Record<string, string> = {
      ...opts.env,
      ORYON_TERMINAL_ID: opts.id,
      ...(row ? { ORYON_AGENT_NAME: row.name, ORYON_WORKSPACE_ID: row.workspace_id } : {}),
      ...(row?.role ? { ORYON_AGENT_ROLE: row.role } : {}),
    }
    // Agent claude : pré-arme la config (pas de wizard, abonnement) + force le mode autonome,
    // quelle que soit la commande stockée en DB (ancienne = "claude" nu).
    let autostart = opts.autostart ?? null
    if (autostart && /^claude(\s|$)/.test(autostart.trim())) {
      ensureClaudeReady(cwd) // trust per-path : claude démarre dans le worktree (cwd imposé côté main)
      autostart = normalizeClaudeAutostart(autostart)
      // ORYON_PROJECT_DIR + config MCP ancrés sur le projet PRINCIPAL (mémoire PARTAGÉE), jamais le worktree.
      // Le piège #1 : un chemin de worktree n'a pas de ligne `projects` → la config retomberait sur
      // oryon-mcp-app.json et SCINDERAIT la mémoire en 8 dossiers privés, sans aucune erreur. mainProjectPath
      // absent (projet non-git, cwd partagé) → repli sur cwd.
      const mcpAnchor = opts.mainProjectPath ?? cwd
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
      const isOrchestrator = env.ORYON_AGENT_ROLE === 'orchestrator'
      if (isOrchestrator && !/--(session-id|resume|continue)\b/.test(autostart)) {
        // Id de reprise = <termId> par défaut, mais ROTÉ vers un uuid frais par reset_orchestrator (bug
        // 052e7397) : après un reset, on démarre une session NEUVE au lieu de ressusciter le pré-reset.
        const resumeId = getOrchestratorResumeId(join(app.getPath('userData'), 'mcp-state'), opts.id)
        autostart += hasClaudeSessionId(cwd, resumeId) ? ` --resume ${resumeId}` : ` --session-id ${resumeId}`
      }
    }
    const sender = makeCoalescedSender((data) => {
      if (!wc.isDestroyed()) wc.send(`terminal:data:${opts.id}`, data)
    })
    createTerminal({
      id: opts.id,
      cwd,
      autostart,
      cols: opts.cols,
      rows: opts.rows,
      env,
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
