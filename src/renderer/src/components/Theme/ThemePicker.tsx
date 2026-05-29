import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useTheme } from './ThemeProvider'
import type { Theme } from './themes'

function Swatch({ theme, active, onPick }: { theme: Theme; active: boolean; onPick: () => void }) {
  const v = theme.vars
  return (
    <button
      onClick={onPick}
      title={theme.name}
      className={cn(
        'group flex flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors',
        active ? 'border-accent ring-1 ring-accent-ring' : 'border-border hover:border-border-strong',
      )}
    >
      {/* Aperçu miniature : fond + bandeau panneau + texte + pastille accent + pastilles terminaux */}
      <div className="relative h-12 w-full overflow-hidden rounded-md" style={{ background: v.bg }}>
        <div className="absolute inset-x-0 top-0 h-3 border-b" style={{ background: v['bg-panel'], borderColor: v.border }} />
        <span className="absolute left-1.5 top-3.5 text-[9px] font-semibold" style={{ color: v.fg }}>
          Aa
        </span>
        <span className="absolute bottom-1.5 left-1.5 h-3.5 w-3.5 rounded-full" style={{ background: v.accent }} />
        <div className="absolute bottom-2 right-1.5 flex gap-0.5">
          {theme.terminalTabColors.slice(0, 4).map((c, i) => (
            <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <span className="truncate text-[11px] text-fg">{theme.name}</span>
        {active && <Check size={11} className="ml-auto shrink-0 text-accent" />}
      </div>
    </button>
  )
}

export function ThemePicker() {
  const { theme, setThemeId, available } = useTheme()
  const dark = available.filter((t) => t.appearance === 'dark')
  const light = available.filter((t) => t.appearance === 'light')

  const Group = ({ label, list }: { label: string; list: Theme[] }) =>
    list.length === 0 ? null : (
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-wide text-fg-subtle">
          {label} · {list.length}
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {list.map((t) => (
            <Swatch key={t.id} theme={t} active={t.id === theme.id} onPick={() => setThemeId(t.id)} />
          ))}
        </div>
      </div>
    )

  return (
    <div className="space-y-4">
      <Group label="Sombre" list={dark} />
      <Group label="Clair" list={light} />
    </div>
  )
}
