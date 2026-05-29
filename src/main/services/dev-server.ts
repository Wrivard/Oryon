import { spawn, spawnSync, type ChildProcess } from 'child_process'

interface DevProc {
  proc: ChildProcess
  port: number | null
}

const servers = new Map<string, DevProc>()
// Exige le schéma http(s):// pour éviter les faux positifs (ex. "could not connect to localhost:5173"
// dans un log d'erreur). Les dev servers impriment leur URL complète ("Local: http://localhost:5173/").
const PORT_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i

export interface StartDevOpts {
  workspaceId: string
  cwd: string
  command: string
  onLog: (line: string) => void
  onPort: (port: number) => void
}

export function startDevServer(opts: StartDevOpts): void {
  stopDevServer(opts.workspaceId)
  // shell:true → "npm run dev" résolu par le shell de la plateforme (powershell/cmd/sh).
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  const proc = spawn(opts.command, { cwd: opts.cwd, shell: true, env })
  const entry: DevProc = { proc, port: null }
  servers.set(opts.workspaceId, entry)

  const handle = (buf: Buffer) => {
    const s = buf.toString()
    opts.onLog(s)
    if (entry.port == null) {
      const m = s.match(PORT_RE)
      if (m) {
        entry.port = parseInt(m[1], 10)
        opts.onPort(entry.port)
      }
    }
  }
  proc.stdout?.on('data', handle)
  proc.stderr?.on('data', handle)
  proc.on('exit', () => {
    if (servers.get(opts.workspaceId) === entry) servers.delete(opts.workspaceId)
  })
}

export function stopDevServer(workspaceId: string): void {
  const s = servers.get(workspaceId)
  if (!s) return
  try {
    if (process.platform === 'win32' && s.proc.pid) {
      // npm spawne des enfants : tuer tout l'arbre. spawnSync = kill terminé avant de rendre la main
      // (pas de taskkill orphelin, pas de race delete-map, cleanup fiable au quit).
      spawnSync('taskkill', ['/pid', String(s.proc.pid), '/t', '/f'])
    } else {
      s.proc.kill()
    }
  } catch {
    /* déjà mort */
  }
  servers.delete(workspaceId)
}

export function getDevPort(workspaceId: string): number | null {
  return servers.get(workspaceId)?.port ?? null
}

export function stopAllDevServers(): void {
  for (const id of [...servers.keys()]) stopDevServer(id)
}
