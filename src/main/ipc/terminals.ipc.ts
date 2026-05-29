import { ipcMain } from 'electron'
import type { CreateTerminalInput } from '../../shared/types'
import { createTerminal, writeTerminal, resizeTerminal, killTerminal } from '../services/pty-manager'
import { ensureClaudeReady, normalizeClaudeAutostart } from '../services/claude-launcher'
import { buildProjectMcpConfigForPath, appSetting } from './settings.ipc'

export function registerTerminalsIpc() {
  // Spawn d'un PTY ; le flux d'octets est poussé sur des canaux dédiés par id.
  ipcMain.handle('terminals:create', (e, opts: CreateTerminalInput) => {
    const wc = e.sender
    // Agent claude : pré-arme la config (pas de wizard, abonnement) + force le mode autonome,
    // quelle que soit la commande stockée en DB (ancienne = "claude" nu).
    let autostart = opts.autostart ?? null
    if (autostart && /^claude(\s|$)/.test(autostart.trim())) {
      ensureClaudeReady(opts.cwd)
      autostart = normalizeClaudeAutostart(autostart)
      // Connecteurs MCP gérés par Oryon (app + projet) injectés à l'agent.
      const mcpFile = buildProjectMcpConfigForPath(opts.cwd)
      if (mcpFile && !/--mcp-config/.test(autostart)) autostart += ` --mcp-config '${mcpFile.replace(/'/g, "''")}'`
      // Modèle agent par défaut (réglage app-global), si défini et non déjà présent.
      const model = appSetting('agentModel')
      if (model && !/--model\b/.test(autostart)) autostart += ` --model ${model}`
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
