import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
  /** Nom de la zone (affiché + loggé) pour situer le crash — ex. "Browser", "Oryon". */
  label?: string
  /** Repli personnalisé. Par défaut : message d'erreur + Réessayer / Recharger. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}
interface State {
  error: Error | null
}

/**
 * Filet anti-crash renderer : capture les erreurs de RENDER de l'arbre enfant et affiche un repli
 * récupérable AU LIEU de démonter toute l'UI (écran blanc = « Oryon a crashé »).
 *
 * Diagnostic : componentDidCatch logge la stack via console.error, mirrorée par le main
 * (webContents 'console-message' → appendAppConsole) donc VISIBLE via l'outil MCP read_app_log.
 * Une boundary ne capture QUE les erreurs de render React (pas les rejets async ni les crashs de
 * process) — pour ça, voir les handlers main (uncaughtException / render-process-gone).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const tag = this.props.label ? `:${this.props.label}` : ''
    console.error(`[ErrorBoundary${tag}]`, error?.stack || String(error), '\ncomponentStack:', info?.componentStack)
  }

  reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangle size={20} className="text-danger" />
        <div className="space-y-1">
          <p className="text-[13px] font-medium text-fg">
            Une erreur est survenue{this.props.label ? ` — ${this.props.label}` : ''}.
          </p>
          <p className="mx-auto max-w-md break-words font-mono text-[11px] text-fg-subtle">
            {error.message || String(error)}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={this.reset}
            className="inline-flex h-7 select-none items-center rounded-sm border border-border px-2.5 text-xs text-fg-muted outline-none transition hover:border-border-strong hover:text-fg"
          >
            Réessayer
          </button>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex h-7 select-none items-center rounded-sm bg-accent px-2.5 text-xs font-medium text-on-accent outline-none transition hover:bg-accent-hover"
          >
            Recharger Oryon
          </button>
        </div>
      </div>
    )
  }
}
