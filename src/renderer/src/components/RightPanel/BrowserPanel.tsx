import { useEffect, useRef, useState } from 'react'
import {
  RotateCw,
  Play,
  Square,
  ArrowLeft,
  ArrowRight,
  MousePointerSquareDashed,
  Bug,
  Copy,
  Star,
  Triangle,
  ExternalLink,
  Terminal,
  Trash2,
  X,
  Globe,
  AlertTriangle,
} from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { cn } from '../../lib/cn'
import { useAppStore } from '../../store'
import { INSPECT_INSTALL, INSPECT_SENTINEL } from '../../lib/browser-inspect'
import type { BrowserRecent, BrowserFavorite, VercelProject } from '@shared/types'

/** Une ligne de console captée depuis la webview (forward MCP + affichage in-panel). */
type ConsoleEntry = { level: string; message: string; ts: number }

const LEVEL_COLOR: Record<string, string> = {
  error: 'text-danger',
  warn: 'text-warning',
  info: 'text-accent',
  log: 'text-fg-subtle',
}

/** Normalise une saisie d'URL (préfixe http:// si schéma absent). */
function normalizeUrl(raw: string): string {
  const u = raw.trim()
  if (!u) return ''
  return /^https?:\/\//.test(u) ? u : `http://${u}`
}

export function BrowserPanel({ workspaceId }: { workspaceId: string }) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  const requestOpenFile = useAppStore((s) => s.requestOpenFile)
  // `url` = src réelle de la webview (navigation) ; `address` = texte de la barre (suit la page en direct).
  const [url, setUrl] = useState('')
  const [address, setAddress] = useState('')
  const [status, setStatus] = useState<'idle' | 'starting' | 'running'>('idle')
  const [logs, setLogs] = useState<string>('')
  const [devCommand, setDevCommand] = useState(workspace?.dev_command ?? 'npm run dev')
  const [inspecting, setInspecting] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [loading, setLoading] = useState(false)

  // Récents / favoris (Migration 012 — persistés par workspace côté main).
  const [recents, setRecents] = useState<BrowserRecent[]>([])
  const [favorites, setFavorites] = useState<BrowserFavorite[]>([])
  const [omniOpen, setOmniOpen] = useState(false)

  // Vercel (REST) — token jamais exposé au renderer, on ne connaît que sa présence.
  const [vercelOpen, setVercelOpen] = useState(false)
  const [vercelHasToken, setVercelHasToken] = useState<boolean | null>(null)
  const [vercelProjects, setVercelProjects] = useState<VercelProject[]>([])
  const [vercelLoading, setVercelLoading] = useState(false)
  const [vercelError, setVercelError] = useState<string | null>(null)

  // Console in-panel (les messages sont aussi forwardés au ring MCP).
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webviewRef = useRef<any>(null)
  const inspectingRef = useRef(false)
  inspectingRef.current = inspecting

  const statusRef = useRef(status)
  statusRef.current = status

  const omniRef = useRef<HTMLDivElement>(null)
  const vercelRef = useRef<HTMLDivElement>(null)
  const consoleBodyRef = useRef<HTMLDivElement>(null)

  const currentUrl = address || url
  const isFavorited = !!currentUrl && favorites.some((f) => f.url === normalizeUrl(currentUrl))

  /** Navigation hôte (saisie, récent, favori, projet Vercel) : pousse la src et ferme le menu. */
  const openUrl = (raw: string) => {
    const u = normalizeUrl(raw)
    if (!u) return
    setUrl(u)
    setAddress(u)
    setOmniOpen(false)
  }

  // Inspect→code : injecte le script dans le webview, capte les clics via console-message → ouvre la source.
  useEffect(() => {
    const w = webviewRef.current
    if (!w || !url) return
    const projectRoot = workspace?.project_path?.replace(/\\/g, '/').replace(/\/$/, '') ?? ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onConsole = (e: any) => {
      const msg: string = e?.message ?? ''
      if (!msg.startsWith(INSPECT_SENTINEL)) {
        // Forward au ring console du workspace (outil MCP browser_console) + affichage in-panel.
        const lvl =
          typeof e?.level === 'number' ? (['log', 'info', 'warn', 'error'][e.level] ?? 'log') : e?.level || 'log'
        window.bridge.browser.reportConsole({ workspaceId, level: String(lvl), message: msg, line: e?.line, source: e?.sourceId })
        setConsoleLogs((prev) => [...prev, { level: String(lvl), message: msg, ts: Date.now() }].slice(-500))
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

  // Au mount : charge récents/favoris + restaure la dernière URL ouverte (si rien n'est déjà chargé).
  useEffect(() => {
    let alive = true
    void window.bridge.browser.getPrefs(workspaceId).then((p) => {
      if (!alive) return
      setRecents(p.recents ?? [])
      setFavorites(p.favorites ?? [])
      const last = p.lastUrl
      if (last) {
        setUrl((cur) => cur || last)
        setAddress((cur) => cur || last)
      }
    })
    return () => {
      alive = false
    }
  }, [workspaceId])

  // open_browser (MCP) : une demande pour CE workspace navigue le webview vers l'URL (normalisée http://).
  const browserOpenRequest = useAppStore((s) => s.browserOpenRequest)
  useEffect(() => {
    if (!browserOpenRequest || browserOpenRequest.workspaceId !== workspaceId) return
    openUrl(browserOpenRequest.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Suivi de navigation de la webview : barre d'adresse en direct + persistance récents/last-url + état back/forward.
  useEffect(() => {
    const w = webviewRef.current
    if (!w) return
    const syncNav = () => {
      try {
        setNav({ back: !!w.canGoBack?.(), forward: !!w.canGoForward?.() })
      } catch {
        /* webview pas prêt */
      }
    }
    const persist = () => {
      let u = ''
      try {
        u = w.getURL?.() ?? ''
      } catch {
        return
      }
      if (!u || u === 'about:blank') return
      let title = ''
      try {
        title = w.getTitle?.() ?? ''
      } catch {
        /* pas de titre */
      }
      void window.bridge.browser.addRecent(workspaceId, u, title || undefined)
      void window.bridge.browser.setLastUrl(workspaceId, u)
      setRecents((prev) => [{ url: u, title: title || undefined, ts: Date.now() }, ...prev.filter((r) => r.url !== u)].slice(0, 50))
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onNavigate = (e: any) => {
      if (e?.url) setAddress(e.url)
      syncNav()
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onInPage = (e: any) => {
      if (e?.isMainFrame && e?.url) setAddress(e.url)
      syncNav()
    }
    const onStart = () => setLoading(true)
    const onStop = () => {
      setLoading(false)
      syncNav()
      persist()
    }
    w.addEventListener('did-start-loading', onStart)
    w.addEventListener('did-navigate', onNavigate)
    w.addEventListener('did-navigate-in-page', onInPage)
    w.addEventListener('did-stop-loading', onStop)
    return () => {
      w.removeEventListener('did-start-loading', onStart)
      w.removeEventListener('did-navigate', onNavigate)
      w.removeEventListener('did-navigate-in-page', onInPage)
      w.removeEventListener('did-stop-loading', onStop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, !!url])

  // Fermeture des menus (omni / Vercel) au clic extérieur ou Échap.
  useEffect(() => {
    if (!omniOpen && !vercelOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (omniOpen && omniRef.current && !omniRef.current.contains(t)) setOmniOpen(false)
      if (vercelOpen && vercelRef.current && !vercelRef.current.contains(t)) setVercelOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOmniOpen(false)
        setVercelOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [omniOpen, vercelOpen])

  // Auto-scroll de la console vers le bas à chaque nouveau log.
  useEffect(() => {
    if (consoleOpen && consoleBodyRef.current) consoleBodyRef.current.scrollTop = consoleBodyRef.current.scrollHeight
  }, [consoleLogs, consoleOpen])

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
      const u = `http://localhost:${port}`
      setUrl(u)
      setAddress(u)
      setStatus('running')
    } else {
      setStatus('idle')
    }
  }

  const stop = async () => {
    await window.bridge.browser.stopDevServer(workspaceId)
    setStatus('idle')
  }

  const toggleFavorite = async (rawUrl: string, label?: string) => {
    const target = normalizeUrl(rawUrl)
    if (!target) return
    try {
      const { favorited } = await window.bridge.browser.toggleFavorite(workspaceId, target, label)
      setFavorites((prev) =>
        favorited
          ? prev.some((f) => f.url === target)
            ? prev
            : [...prev, { url: target, label }]
          : prev.filter((f) => f.url !== target),
      )
    } catch {
      /* ignore */
    }
  }

  /** (Re)charge le statut + projets Vercel. `recheckToken` force une revérification du token. */
  const loadVercel = async (recheckToken = false) => {
    setVercelError(null)
    let token = vercelHasToken
    if (recheckToken || token === null) {
      try {
        token = (await window.bridge.browser.vercelStatus()).hasToken
      } catch {
        token = false
      }
      setVercelHasToken(token)
    }
    if (!token) {
      setVercelProjects([])
      return
    }
    setVercelLoading(true)
    try {
      setVercelProjects(await window.bridge.browser.vercelProjects())
    } catch (e) {
      setVercelError(String((e as Error)?.message ?? e))
    } finally {
      setVercelLoading(false)
    }
  }

  const toggleVercel = () => {
    const next = !vercelOpen
    setVercelOpen(next)
    setOmniOpen(false)
    if (next) void loadVercel()
  }

  const clearConsole = () => {
    setConsoleLogs([])
    void window.bridge.browser.clearConsole(workspaceId)
  }

  const wv = () => webviewRef.current

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="relative flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton label="Précédent" size="sm" onClick={() => wv()?.goBack?.()} disabled={!nav.back}>
          <ArrowLeft size={13} />
        </IconButton>
        <IconButton label="Suivant" size="sm" onClick={() => wv()?.goForward?.()} disabled={!nav.forward}>
          <ArrowRight size={13} />
        </IconButton>
        <IconButton
          label={loading ? 'Arrêter le chargement' : 'Recharger'}
          size="sm"
          onClick={() => (loading ? wv()?.stop?.() : wv()?.reload?.())}
          disabled={!url}
        >
          {loading ? <Square size={12} /> : <RotateCw size={13} />}
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
        <IconButton
          label="Outils de développement"
          size="sm"
          onClick={() => {
            const w = wv()
            if (!w) return
            try {
              w.isDevToolsOpened?.() ? w.closeDevTools?.() : w.openDevTools?.()
            } catch {
              /* webview pas prête */
            }
          }}
          disabled={!url}
        >
          <Bug size={13} />
        </IconButton>

        {/* Barre d'adresse + dropdown favoris/récents */}
        <div ref={omniRef} className="relative mx-1 min-w-0 flex-1">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={() => setOmniOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') openUrl(address)
            }}
            aria-label="URL de la preview"
            placeholder="localhost:5173"
            className={cn(
              'h-6 w-full rounded-sm border border-border bg-bg-inset px-2 text-[12px] text-fg outline-none transition-colors focus:border-accent',
              loading && 'pr-7',
            )}
          />
          {loading && (
            <RotateCw
              size={11}
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-fg-subtle"
            />
          )}
          {omniOpen && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-bg-panel py-1 shadow-md">
              {favorites.length === 0 && recents.length === 0 ? (
                <p className="px-3 py-3 text-center text-[11px] text-fg-subtle">Aucun favori ni récent.</p>
              ) : (
                <>
                  {favorites.length > 0 && (
                    <>
                      <p className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Favoris</p>
                      {favorites.map((f) => (
                        <OmniRow
                          key={`fav-${f.url}`}
                          primary={f.label || f.url}
                          secondary={f.label ? f.url : undefined}
                          favorited
                          onOpen={() => openUrl(f.url)}
                          onToggleFav={() => toggleFavorite(f.url, f.label)}
                        />
                      ))}
                    </>
                  )}
                  {recents.length > 0 && (
                    <>
                      <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Récents</p>
                      {recents.slice(0, 12).map((r) => (
                        <OmniRow
                          key={`rec-${r.url}`}
                          primary={r.title || r.url}
                          secondary={r.title ? r.url : undefined}
                          favorited={favorites.some((f) => f.url === r.url)}
                          onOpen={() => openUrl(r.url)}
                          onToggleFav={() => toggleFavorite(r.url, r.title)}
                        />
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <IconButton
          label="Copier l'URL"
          size="sm"
          onClick={() => {
            if (currentUrl) void navigator.clipboard?.writeText(normalizeUrl(currentUrl)).catch(() => {})
          }}
          disabled={!currentUrl}
        >
          <Copy size={13} />
        </IconButton>
        <IconButton
          label={isFavorited ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          size="sm"
          active={isFavorited}
          onClick={() => toggleFavorite(currentUrl, wv()?.getTitle?.())}
          disabled={!url}
        >
          <Star size={13} className={cn(isFavorited && 'fill-current')} />
        </IconButton>

        {/* Vercel */}
        <div ref={vercelRef} className="relative">
          <IconButton label="Projets Vercel" size="sm" active={vercelOpen} onClick={toggleVercel}>
            <Triangle size={12} className={cn('fill-current', vercelOpen && 'text-accent')} />
          </IconButton>
          {vercelOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-md border border-border bg-bg-panel shadow-md">
              <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
                <span className="text-[11px] font-semibold text-fg-muted">Projets Vercel</span>
                <IconButton label="Rafraîchir" size="sm" onClick={() => loadVercel(true)} disabled={vercelLoading}>
                  <RotateCw size={12} className={cn(vercelLoading && 'animate-spin')} />
                </IconButton>
              </div>
              <div className="max-h-72 overflow-auto py-1">
                {vercelHasToken === false ? (
                  <div className="px-3 py-3 text-center">
                    <AlertTriangle size={16} className="mx-auto mb-1.5 text-warning" />
                    <p className="text-[11px] text-fg-muted">Aucun token Vercel.</p>
                    <p className="mt-0.5 text-[10px] text-fg-subtle">Ajoute un token dans les Réglages pour lister tes projets.</p>
                  </div>
                ) : vercelError ? (
                  <p className="m-2 rounded-md border border-danger/40 bg-danger/10 p-2 text-[11px] text-danger">{vercelError}</p>
                ) : vercelLoading && vercelProjects.length === 0 ? (
                  <div className="space-y-1 px-2 py-1">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-9 animate-pulse rounded-sm bg-bg-elevated" />
                    ))}
                  </div>
                ) : vercelProjects.length === 0 ? (
                  <p className="px-3 py-3 text-center text-[11px] text-fg-subtle">Aucun projet.</p>
                ) : (
                  vercelProjects.map((p) => (
                    <div
                      key={p.id}
                      className="group flex items-center gap-2 px-2 py-1.5 hover:bg-hover"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          openUrl(p.url)
                          setVercelOpen(false)
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                      >
                        <Triangle size={11} className="shrink-0 fill-current text-fg-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[12px] text-fg">{p.name}</span>
                            {p.framework && <Badge>{p.framework}</Badge>}
                          </span>
                          <span className="block truncate text-[10px] text-fg-subtle">{p.url.replace(/^https?:\/\//, '')}</span>
                        </span>
                      </button>
                      <IconButton
                        label="Ouvrir dans le navigateur système"
                        size="sm"
                        className="opacity-0 group-hover:opacity-100"
                        onClick={() => void window.bridge.browser.openExternal(p.url)}
                      >
                        <ExternalLink size={12} />
                      </IconButton>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <IconButton
          label="Ouvrir dans le navigateur système"
          size="sm"
          onClick={() => {
            if (currentUrl) void window.bridge.browser.openExternal(normalizeUrl(currentUrl))
          }}
          disabled={!url}
        >
          <ExternalLink size={13} />
        </IconButton>

        <div className="relative">
          <IconButton label="Console" size="sm" active={consoleOpen} onClick={() => setConsoleOpen((v) => !v)}>
            <Terminal size={13} />
          </IconButton>
          {!consoleOpen && consoleLogs.length > 0 && (
            <span
              className={cn(
                'pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full',
                consoleLogs.some((l) => l.level === 'error')
                  ? 'bg-danger'
                  : consoleLogs.some((l) => l.level === 'warn')
                    ? 'bg-warning'
                    : 'bg-accent',
              )}
            />
          )}
        </div>

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
      <div className="flex min-h-0 flex-1 flex-col bg-bg-deep">
        <div className="relative min-h-0 flex-1">
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

        {/* Console drawer */}
        {consoleOpen && (
          <div className="flex h-44 shrink-0 flex-col border-t border-border bg-bg-inset">
            <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-fg-muted">
                Console
                {consoleLogs.length > 0 && <Badge>{consoleLogs.length}</Badge>}
              </span>
              <div className="flex items-center gap-0.5">
                <IconButton label="Vider la console" size="sm" onClick={clearConsole} disabled={consoleLogs.length === 0}>
                  <Trash2 size={12} />
                </IconButton>
                <IconButton label="Fermer la console" size="sm" onClick={() => setConsoleOpen(false)}>
                  <X size={12} />
                </IconButton>
              </div>
            </div>
            <div ref={consoleBodyRef} className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
              {consoleLogs.length === 0 ? (
                <p className="flex h-full items-center justify-center text-[11px] text-fg-subtle">Aucun log.</p>
              ) : (
                consoleLogs.map((l, i) => (
                  <div key={i} className={cn('whitespace-pre-wrap break-words', LEVEL_COLOR[l.level] ?? 'text-fg-muted')}>
                    {l.level !== 'log' && <span className="mr-1 opacity-70">[{l.level}]</span>}
                    {l.message}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Ligne du dropdown favoris/récents : clic = navigue, étoile = (dé)favori. */
function OmniRow({
  primary,
  secondary,
  favorited,
  onOpen,
  onToggleFav,
}: {
  primary: string
  secondary?: string
  favorited: boolean
  onOpen: () => void
  onToggleFav: () => void
}) {
  return (
    <div className="group flex items-center gap-2 px-2 py-1.5 hover:bg-hover">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none">
        <Globe size={12} className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-fg">{primary}</span>
          {secondary && <span className="block truncate text-[10px] text-fg-subtle">{secondary.replace(/^https?:\/\//, '')}</span>}
        </span>
      </button>
      <IconButton
        label={favorited ? 'Retirer des favoris' : 'Ajouter aux favoris'}
        size="sm"
        active={favorited}
        className={cn(!favorited && 'opacity-0 group-hover:opacity-100')}
        onClick={(e) => {
          e.stopPropagation()
          onToggleFav()
        }}
      >
        <Star size={12} className={cn(favorited && 'fill-current')} />
      </IconButton>
    </div>
  )
}
