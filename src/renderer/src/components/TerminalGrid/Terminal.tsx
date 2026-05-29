import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../../store'
import type { Terminal as TermRow } from '@shared/types'

// Thème terminal (Vercel dark). Phase 5 : dériver des tokens de thème.
const XTERM_THEME = {
  background: '#141414',
  foreground: '#ededed',
  cursor: '#00e599',
  cursorAccent: '#141414',
  selectionBackground: 'rgba(0,229,153,0.25)',
  black: '#1b1b1b',
  red: '#ff5f56',
  green: '#00e599',
  yellow: '#f5a623',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#22d3ee',
  white: '#ededed',
  brightBlack: '#6e6e6e',
  brightRed: '#ff8580',
  brightGreen: '#2bf0ad',
  brightYellow: '#ffc107',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
}

export function Terminal({ term, focused }: { term: TermRow; focused: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Xterm | null>(null)
  const setStatus = useAppStore((s) => s.setStatus)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const xterm = new Xterm({
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: XTERM_THEME,
      allowProposedApi: true,
      scrollback: 5000,
    })
    xtermRef.current = xterm
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.loadAddon(new SearchAddon())
    xterm.loadAddon(new WebLinksAddon())
    xterm.open(el)
    setStatus(term.id, 'spawning')

    // Listeners AVANT le spawn (ne pas rater les premiers octets).
    // State machine heuristique (cf. 03 §6) — best-effort.
    let buf = ''
    let sawShell = false
    let sawClaude = false
    window.bridge.terminals.onData(term.id, (data) => {
      xterm.write(data)
      buf = (buf + data).slice(-4000)
      if (!sawShell && /(PS .*>|[$%>]\s?$)/m.test(buf)) {
        sawShell = true
        setStatus(term.id, 'shell_ready')
      }
      if (!sawClaude && /(Welcome to Claude Code|Claude Code v|esc to interrupt|│\s*>)/i.test(buf)) {
        sawClaude = true
        setStatus(term.id, 'claude_ready')
      }
    })
    window.bridge.terminals.onExit(term.id, () => setStatus(term.id, 'exited'))
    const inputSub = xterm.onData((data) => window.bridge.terminals.write(term.id, data))

    // Defer fit()+spawn au frame suivant : le conteneur (cellule de grille) doit être
    // dimensionné AVANT fit(), sinon le PTY démarre en 2×1 et claude s'affiche cassé.
    let created = false
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      created = true
      window.bridge.terminals.create({
        id: term.id,
        cwd: term.cwd,
        autostart: term.autostart_cmd,
        cols: xterm.cols,
        rows: xterm.rows,
      })
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        if (created) window.bridge.terminals.resize(term.id, xterm.cols, xterm.rows)
      } catch {
        /* ignore */
      }
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.bridge.terminals.offData(term.id)
      window.bridge.terminals.offExit(term.id)
      inputSub.dispose()
      window.bridge.terminals.kill(term.id)
      xterm.dispose()
      xtermRef.current = null
    }
    // term.id only : on ne recrée pas le PTY au re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term.id])

  // Donne le focus clavier à xterm quand la cellule devient active.
  useEffect(() => {
    if (focused) xtermRef.current?.focus()
  }, [focused])

  return <div ref={containerRef} className="h-full w-full overflow-hidden px-2 py-1" />
}
