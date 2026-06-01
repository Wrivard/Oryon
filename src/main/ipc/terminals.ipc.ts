import { ipcMain } from 'electron'
import type { CreateTerminalInput } from '../../shared/types'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal } from '../services/pty-manager'
import { ensureClaudeReady, normalizeClaudeAutostart, enforceAgentSpawn } from '../services/claude-launcher'
import { hasClaudeSession } from '../services/claude-session'
import { buildProjectMcpConfigForPath } from './settings.ipc'

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
      // Reprise de session au redémarrage : si une conversation claude existe DÉJÀ pour ce worktree,
      // on rattache `--continue` pour reprendre au lieu de repartir à neuf. Worktree neuf (1er spawn /
      // nouveau workspace / split) → pas de session → pas de --continue → démarrage neuf. On n'ajoute
      // donc JAMAIS --continue sans session existante (pas d'erreur "no conversation"). Idempotent.
      if (hasClaudeSession(opts.cwd) && !/--continue\b/.test(autostart)) autostart += ' --continue'
    }
    createTerminal({
      id: opts.id,
      cwd: opts.cwd,
      autostart,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env,
      onData: (data) => {
        if (!wc.isDestroyed()) wc.send(`terminal:data:${opts.id}`, data)
      },
      onExit: (code) => {
        if (!wc.isDestroyed()) wc.send(`terminal:exit:${opts.id}`, code)
      },
    })
  })

  // Flux haute fréquence : one-way (send), pas d'invoke.
  ipcMain.on('terminals:write', (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.on('terminals:resize', (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ipcMain.on('terminals:kill', (_e, id: string) => killTerminal(id))
}
