// Registre des thèmes (CSS variables). Fondation pour le theme-picker (Phase 5).
// Le thème "vercel" est le défaut canonique — ses valeurs MIROITENT :root dans index.css.

export interface Theme {
  id: string
  name: string
  appearance: 'dark' | 'light'
  /** Map nom-de-variable-CSS (sans `--`) -> valeur. Appliquée sur :root par applyTheme(). */
  vars: Record<string, string>
  /** Palette pour distinguer les agents/terminaux (pastilles colorées). */
  terminalTabColors: string[]
}

export const vercelTheme: Theme = {
  id: 'vercel',
  name: 'Vercel',
  appearance: 'dark',
  vars: {
    bg: '#1b1b1b',
    'bg-deep': '#141414',
    'bg-panel': '#1f1f1f',
    'bg-elevated': '#242424',
    'bg-inset': '#161616',
    hover: 'rgba(255, 255, 255, 0.045)',
    active: 'rgba(255, 255, 255, 0.08)',
    fg: '#ededed',
    'fg-muted': '#a0a0a0',
    'fg-subtle': '#6e6e6e',
    border: '#2a2a2a',
    'border-strong': '#3a3a3a',
    accent: '#00e599',
    'accent-hover': '#2bf0ad',
    'accent-active': '#00c885',
    'accent-soft': 'rgba(0, 229, 153, 0.12)',
    'accent-ring': 'rgba(0, 229, 153, 0.45)',
    'on-accent': '#08120d',
    success: '#00e599',
    danger: '#ff5f56',
    warning: '#f5a623',
  },
  terminalTabColors: [
    '#00e599', // accent
    '#3b82f6', // blue
    '#a855f7', // violet
    '#ec4899', // pink
    '#f5a623', // amber
    '#22d3ee', // cyan
    '#f97316', // orange
    '#84cc16', // lime
  ],
}

export const themes: Record<string, Theme> = {
  vercel: vercelTheme,
}

export const DEFAULT_THEME_ID = 'vercel'

/** Applique les variables d'un thème sur l'élément racine (<html>). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(`--${key}`, value)
  }
  root.dataset.theme = theme.id
}
