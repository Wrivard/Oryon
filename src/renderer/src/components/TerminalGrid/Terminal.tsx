import { useEffect, useRef } from 'react'
import { Terminal as Xterm, type ITheme, type IMarker, type IDecoration } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../../store'
import { useTheme } from '../Theme/ThemeProvider'
import type { Theme } from '../Theme/themes'
import type { Terminal as TermRow } from '@shared/types'

/** Construit le thème xterm depuis le thème Oryon actif (fond/texte/curseur/sélection + couleurs sémantiques). */
function buildXtermTheme(t: Theme): ITheme {
  const v = t.vars
  return {
    background: v['bg-deep'],
    foreground: v.fg,
    cursor: v.accent,
    cursorAccent: v['bg-deep'],
    selectionBackground: v['accent-soft'],
    black: v.bg,
    red: v.danger,
    green: v.success,
    yellow: v.warning,
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#22d3ee',
    white: v['fg-muted'],
    brightBlack: v['fg-subtle'],
    brightRed: v.danger,
    brightGreen: v.success,
    brightYellow: v.warning,
    brightBlue: '#60a5fa',
    brightMagenta: '#c084fc',
    brightCyan: '#67e8f9',
    brightWhite: v.fg,
  }
}

// Command-block (Phase 5) : un marqueur par commande shell, décoré selon son exit-code (OSC 133).
interface CmdBlock {
  marker: IMarker
  el?: HTMLElement
  exit?: number
  ts: number
}

function styleBlock(el: HTMLElement, block: CmdBlock, onClick: () => void): void {
  const color = block.exit === undefined ? 'var(--fg-subtle)' : block.exit === 0 ? 'var(--success)' : 'var(--danger)'
  el.style.width = '3px'
  el.style.borderRadius = '2px'
  el.style.background = color
  el.style.cursor = 'pointer'
  el.title =
    (block.exit === undefined ? 'commande en cours…' : block.exit === 0 ? '✓ succès (exit 0)' : `✗ échec (exit ${block.exit})`) +
    ' · ' +
    new Date(block.ts).toLocaleTimeString()
  el.onclick = onClick
}

export function Terminal({ term, focused }: { term: TermRow; focused: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Xterm | null>(null)
  // Re-fit + resize PTY + scroll en bas : appelé au clic pour garantir que la ligne de saisie de claude
  // (en bas du TUI) soit dimensionnée correctement et visible, même si un fit initial a échoué.
  const refitRef = useRef<() => void>(() => {})
  const setStatus = useAppStore((s) => s.setStatus)
  const { theme } = useTheme()
  const themeRef = useRef(theme)
  themeRef.current = theme

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const xterm = new Xterm({
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      theme: buildXtermTheme(themeRef.current),
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

    // Garde fit/resize : le layout 8 panneaux ("eight") monte des cellules cachées / à 0px → fit.fit()
    // lève « Cannot read properties of undefined (reading 'dimensions') » et émet un resize PTY bidon.
    const canFit = (): boolean =>
      el.isConnected && el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0
    const safeFit = (): void => {
      if (!canFit()) return
      try {
        const dims = fit.proposeDimensions()
        if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 1) return
        fit.fit()
      } catch {
        /* pane caché/détaché : le ResizeObserver réessaiera une fois visible */
      }
    }

    // Command-blocks (OSC 133) : A = ligne de commande, D;<exit> = fin de la commande précédente.
    // Inoffensif si l'intégration shell est désactivée (aucun marqueur n'arrive). Pas actif pendant le TUI claude.
    const blocks: CmdBlock[] = []
    let current: CmdBlock | null = null
    xterm.parser.registerOscHandler(133, (data) => {
      const parts = data.split(';')
      if (parts[0] === 'A') {
        const marker = xterm.registerMarker(0)
        if (!marker) return true
        const block: CmdBlock = { marker, ts: Date.now() }
        const deco: IDecoration | undefined = xterm.registerDecoration({ marker })
        deco?.onRender((domEl) => {
          block.el = domEl
          styleBlock(domEl, block, () => xterm.scrollToLine(marker.line))
        })
        blocks.push(block)
        current = block
      } else if (parts[0] === 'D') {
        const code = parts[1] !== undefined ? parseInt(parts[1], 10) : NaN
        const b = current
        if (b && b.exit === undefined) {
          b.exit = Number.isNaN(code) ? undefined : code
          if (b.el) styleBlock(b.el, b, () => xterm.scrollToLine(b.marker.line))
        }
      }
      return true
    })

    // Listeners AVANT le spawn (ne pas rater les premiers octets).
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

    // Defer fit()+spawn au frame suivant : le conteneur doit être dimensionné AVANT fit().
    let created = false
    const raf = requestAnimationFrame(() => {
      safeFit()
      created = true
      window.bridge.terminals.create({
        id: term.id,
        // Le shell démarre dans le WORKTREE de l'agent (isolation des éditions + git diff) ; repli sur cwd
        // (= projet principal) pour les projets non-git.
        cwd: term.worktree_path ?? term.cwd,
        // Ancre de la mémoire partagée + du run d'orchestration = projet PRINCIPAL (cf. terminals.ipc).
        mainProjectPath: term.cwd,
        autostart: term.autostart_cmd,
        cols: xterm.cols,
        rows: xterm.rows,
        // Identité de l'agent + workspace → provenance auto (Oryon Memory) ET scope du serveur MCP au
        // SEUL workspace de ce terminal (le serveur lit ces env). ORYON_WORKSPACE_ID isole les workspaces.
        env: {
          ORYON_AGENT_NAME: term.name,
          ORYON_WORKSPACE_ID: term.workspace_id,
          ...(term.role ? { ORYON_AGENT_ROLE: term.role } : {}),
        },
      })
    })

    const ro = new ResizeObserver(() => {
      safeFit()
      if (created && canFit()) {
        window.bridge.terminals.resize(term.id, xterm.cols, xterm.rows)
        // Reste collé en bas : un redimensionnement (ex. plein écran) fait redessiner le TUI claude ;
        // sans ça le viewport ne suit pas et la ligne de saisie « ❯ » passe sous la zone visible.
        xterm.scrollToBottom()
        // claude redessine en ASYNCHRONE après le SIGWINCH → re-scroll au frame suivant pour le rattraper.
        requestAnimationFrame(() => xterm.scrollToBottom())
      }
    })
    ro.observe(el)

    // Au clic : re-fit (corrige un fit initial raté → ligne de saisie claude clippée), resync la taille
    // du PTY, et scrolle en bas pour révéler le prompt « ❯ ».
    refitRef.current = () => {
      safeFit()
      if (created && canFit()) window.bridge.terminals.resize(term.id, xterm.cols, xterm.rows)
      xterm.scrollToBottom()
    }

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

  // Applique le thème xterm quand le thème Oryon change (sans recréer le terminal).
  useEffect(() => {
    if (xtermRef.current) xtermRef.current.options.theme = buildXtermTheme(theme)
  }, [theme])

  // Donne le focus clavier à xterm quand la cellule devient active.
  useEffect(() => {
    if (focused) xtermRef.current?.focus()
  }, [focused])

  // Clic = focus clavier explicite sur xterm (les workers se tapent directement, sans passer par
  // l'orchestrateur). Garde-fou si le focus React/onglet n'a pas (re)donné le focus à ce terminal.
  return (
    <div
      ref={containerRef}
      onMouseDown={() => {
        refitRef.current()
        xtermRef.current?.focus()
      }}
      className="h-full w-full overflow-hidden px-2 py-1"
    />
  )
}
