import { useEffect, useRef, useState } from 'react'
import { RotateCw, Play, Square, ArrowLeft, ArrowRight, MousePointerSquareDashed } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'
import { useAppStore } from '../../store'
import { INSPECT_INSTALL, INSPECT_SENTINEL } from '../../lib/browser-inspect'

export function BrowserPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const requestOpenFile = useAppStore((s) => s.requestOpenFile)
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<'idle' | 'starting' | 'running'>('idle')
  const [logs, setLogs] = useState<string>('')
  const [devCommand, setDevCommand] = useState(workspace?.dev_command ?? 'npm run dev')
  const [inspecting, setInspecting] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webviewRef = useRef<any>(null)
  const inspectingRef = useRef(false)
  inspectingRef.current = inspecting

  const statusRef = useRef(status)
  statusRef.current = status

  // Inspect→code : injecte le script dans le webview, capte les clics via console-message → ouvre la source.
  useEffect(() => {
    const w = webviewRef.current
    if (!w || !url) return
    const projectRoot = workspace?.project_path?.replace(/\\/g, '/').replace(/\/$/, '') ?? ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onConsole = (e: any) => {
      const msg: string = e?.message ?? ''
      if (!msg.startsWith(INSPECT_SENTINEL)) {
        // Forward au ring console du workspace (outil MCP browser_console, pour debug).
        const lvl =
          typeof e?.level === 'number' ? (['log', 'info', 'warn', 'error'][e.level] ?? 'log') : e?.level || 'log'
        window.bridge.browser.reportConsole({ workspaceId, level: String(lvl), message: msg, line: e?.line, source: e?.sourceId })
        return
      }
      let data: { fileName?: string; lineNumber?: number; none?: boolean }
      try {
        data = JSON.parse(msg.slice(INSPECT_SENTINEL.length))
      } catch {
        return
      }
      if (!data.fileName) return // élément non mappable : on ignore
      let p = data.fileName.replace(/\\/g, '/')
      const abs = /^[a-zA-Z]:\//.test(p) || p.startsWith('/')
      if (!abs && projectRoot) p = projectRoot + '/' + p.replace(/^\.?\//, '')
      requestOpenFile(p, data.lineNumber)
      setInspecting(false) // one-shot : un clic ouvre puis sort du mode inspect
      void w.executeJavaScript('window.__oryonInspect&&window.__oryonInspect.disable()').catch(() => {})
    }
    const onDomReady = () => {
      if (inspectingRef.current) {
        void w.executeJavaScript(INSPECT_INSTALL + '\nwindow.__oryonInspect&&window.__oryonInspect.enable()').catch(() => {})
      }
    }
    w.addEventListener('console-message', onConsole)
    w.addEventListener('dom-ready', onDomReady)
    return () => {
      w.removeEventListener('console-message', onConsole)
      w.removeEventListener('dom-ready', onDomReady)
    }
  }, [url, workspace?.project_path, requestOpenFile])

  // Échap sort du mode inspect (quand le focus est côté hôte).
  useEffect(() => {
    if (!inspecting) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setInspecting(false)
        void webviewRef.current?.executeJavaScript('window.__oryonInspect&&window.__oryonInspect.disable()').catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [inspecting])

  const toggleInspect = async () => {
    const w = webviewRef.current
    if (!w) return
    const next = !inspecting
    setInspecting(next)
    try {
      if (next) await w.executeJavaScript(INSPECT_INSTALL + '\nwindow.__oryonInspect&&window.__oryonInspect.enable()')
      else await w.executeJavaScript('window.__oryonInspect&&window.__oryonInspect.disable()')
    } catch {
      /* webview pas prêt */
    }
  }

  useEffect(() => {
    window.bridge.browser.onDevLog((line) => setLogs((l) => (l + line).slice(-8000)))
    return () => window.bridge.browser.offDevLog()
  }, [])

  // open_browser (MCP) : une demande pour CE workspace navigue le webview vers l'URL (normalisée http://).
  const browserOpenRequest = useAppStore((s) => s.browserOpenRequest)
  useEffect(() => {
    if (!browserOpenRequest || browserOpenRequest.workspaceId !== workspaceId) return
    const u = browserOpenRequest.url.trim()
    if (u) setUrl(/^https?:\/\//.test(u) ? u : `http://${u}`)
  }, [browserOpenRequest?.nonce, workspaceId])

  // browser_screenshot (MCP) : le main demande une capture → on capture la webview et renvoie le PNG.
  useEffect(() => {
    window.bridge.browser.onCapture(async ({ workspaceId: wsId, reqId }) => {
      if (wsId !== workspaceId) return
      const w = webviewRef.current
      try {
        if (!w || !url) {
          window.bridge.browser.sendCaptureResult(reqId, new Uint8Array(), 'aucun site ouvert')
          return
        }
        const image = await w.capturePage()
        window.bridge.browser.sendCaptureResult(reqId, image.toPNG())
      } catch (err) {
        window.bridge.browser.sendCaptureResult(reqId, new Uint8Array(), String(err))
      }
    })
    return () => window.bridge.browser.offCapture()
  }, [workspaceId, url])

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
        <IconButton
          label={inspecting ? 'Inspect actif — clique un élément (Échap pour sortir)' : 'Inspect → code'}
          size="sm"
          active={inspecting}
          onClick={toggleInspect}
          disabled={!url}
        >
          <MousePointerSquareDashed size={13} className={cn(inspecting && 'text-accent')} />
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
