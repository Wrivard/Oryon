import { useEffect, useRef, useState } from 'react'
import { RotateCw, Play, Square, ArrowLeft, ArrowRight } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import { useAppStore } from '../../store'

export function BrowserPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<'idle' | 'starting' | 'running'>('idle')
  const [logs, setLogs] = useState<string>('')
  const [devCommand, setDevCommand] = useState(workspace?.dev_command ?? 'npm run dev')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webviewRef = useRef<any>(null)

  const statusRef = useRef(status)
  statusRef.current = status

  useEffect(() => {
    window.bridge.browser.onDevLog((line) => setLogs((l) => (l + line).slice(-8000)))
    return () => window.bridge.browser.offDevLog()
  }, [])

  // Arrêt du dev server à l'unmount (changement de workspace) → pas de process orphelin.
  useEffect(() => {
    return () => {
      if (statusRef.current === 'running') void window.bridge.browser.stopDevServer(workspaceId)
    }
  }, [workspaceId])

  const persistDevCommand = () => {
    void window.bridge.workspaces.update(workspaceId, { devCommand })
  }

  const start = async () => {
    setStatus('starting')
    setLogs('')
    const { port } = await window.bridge.browser.startDevServer(workspaceId)
    if (port) {
      setUrl(`http://localhost:${port}`)
      setStatus('running')
    } else {
      setStatus('idle')
    }
  }

  const stop = async () => {
    await window.bridge.browser.stopDevServer(workspaceId)
    setStatus('idle')
  }

  const navigate = (raw: string) => {
    const u = raw.trim()
    if (!u) return
    setUrl(/^https?:\/\//.test(u) ? u : `http://${u}`)
  }

  const wv = () => webviewRef.current

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton label="Précédent" size="sm" onClick={() => wv()?.goBack?.()} disabled={!url}>
          <ArrowLeft size={13} />
        </IconButton>
        <IconButton label="Suivant" size="sm" onClick={() => wv()?.goForward?.()} disabled={!url}>
          <ArrowRight size={13} />
        </IconButton>
        <IconButton label="Recharger" size="sm" onClick={() => wv()?.reload?.()} disabled={!url}>
          <RotateCw size={13} />
        </IconButton>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(url)
          }}
          aria-label="URL de la preview"
          placeholder="localhost:5173"
          className="mx-1 h-6 flex-1 rounded-sm border border-border bg-bg-inset px-2 text-[12px] text-fg outline-none transition-colors focus:border-accent"
        />
        {status === 'running' ? (
          <Button size="sm" variant="secondary" onClick={stop}>
            <Square size={11} />
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={start} disabled={status === 'starting'}>
            {status === 'starting' ? (
              'Démarrage…'
            ) : (
              <>
                <Play size={11} />
                Dev
              </>
            )}
          </Button>
        )}
      </div>

      {/* Contenu */}
      <div className="relative min-h-0 flex-1 bg-bg-deep">
        {url ? (
          <webview
            ref={webviewRef}
            src={url}
            partition="persist:oryon-preview"
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
            <div className="text-center">
              <p className="text-[13px] text-fg-muted">Preview localhost</p>
              <p className="mt-1 text-[11px] text-fg-subtle">
                Lance le dev server du projet, le port est détecté automatiquement.
              </p>
            </div>
            <div className="w-full max-w-sm">
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                Commande dev
              </label>
              <input
                value={devCommand}
                onChange={(e) => setDevCommand(e.target.value)}
                onBlur={persistDevCommand}
                aria-label="Commande de dev"
                className="w-full rounded border border-border bg-bg-inset px-2.5 py-1.5 font-mono text-[12px] text-fg outline-none focus:border-accent"
              />
            </div>
            {logs && (
              <pre className="max-h-40 w-full max-w-sm overflow-auto rounded border border-border bg-bg-inset p-2 font-mono text-[10px] leading-relaxed text-fg-subtle">
                {logs}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
