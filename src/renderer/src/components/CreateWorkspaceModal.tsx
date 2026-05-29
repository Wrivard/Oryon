import { useState, type ReactNode } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { useAppStore } from '../store'
import { useTheme } from './Theme/ThemeProvider'
import { LAYOUTS, LAYOUT_PANES } from '@shared/types'
import { cn } from '../lib/cn'

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export function CreateWorkspaceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { theme } = useTheme()
  const [path, setPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [layout, setLayout] = useState('eight')
  const [color, setColor] = useState(theme.terminalTabColors[0])
  const [busy, setBusy] = useState(false)

  const setWorkspaces = useAppStore((s) => s.setWorkspaces)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const setTerminalCounts = useAppStore((s) => s.setTerminalCounts)

  const reset = () => {
    setPath(null)
    setName('')
    setLayout('eight')
    setColor(theme.terminalTabColors[0])
  }
  const close = () => {
    reset()
    onClose()
  }

  const pick = async () => {
    const p = await window.bridge.dialog.pickFolder()
    if (p) {
      setPath(p)
      setName((n) => n || baseName(p))
    }
  }

  const create = async () => {
    if (!path || !name.trim()) return
    setBusy(true)
    try {
      const { workspace } = await window.bridge.workspaces.create({
        name: name.trim(),
        projectPath: path,
        layout,
        color,
      })
      const [list, counts] = await Promise.all([
        window.bridge.workspaces.list(),
        window.bridge.workspaces.terminalCounts(),
      ])
      setWorkspaces(list)
      setTerminalCounts(counts)
      setActiveWorkspace(workspace.id)
      reset()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={close} title="Nouveau workspace">
      <div className="space-y-4">
        <Field label="Dossier du projet">
          <button
            onClick={pick}
            className="flex w-full items-center gap-2 rounded border border-border bg-bg-inset px-2.5 py-2 text-left text-[12px] outline-none transition-colors duration-fast hover:border-border-strong"
          >
            {path ? (
              <FolderOpen size={14} className="shrink-0 text-accent" />
            ) : (
              <Folder size={14} className="shrink-0 text-fg-subtle" />
            )}
            <span className={cn('flex-1 truncate', path ? 'text-fg' : 'text-fg-subtle')}>
              {path ?? 'Choisir un dossier…'}
            </span>
          </button>
        </Field>

        <Field label="Nom">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Mon projet"
            aria-label="Nom du workspace"
            className="w-full rounded border border-border bg-bg-inset px-2.5 py-2 text-[12px] text-fg outline-none transition-colors duration-fast placeholder:text-fg-subtle focus:border-accent"
          />
        </Field>

        <Field label="Layout (nombre de terminaux)">
          <div className="flex flex-wrap gap-1.5">
            {LAYOUTS.map((l) => (
              <button
                key={l}
                onClick={() => setLayout(l)}
                className={cn(
                  'min-w-[34px] rounded-sm border px-2 py-1 text-[11px] tabular-nums outline-none transition-colors duration-fast',
                  layout === l
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border text-fg-muted hover:text-fg',
                )}
              >
                {LAYOUT_PANES[l]}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Couleur">
          <div className="flex flex-wrap gap-2.5">
            {theme.terminalTabColors.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                aria-label={`Couleur ${c}`}
                className="h-5 w-5 rounded-full outline-none transition-transform duration-fast hover:scale-110"
                style={{
                  background: c,
                  boxShadow: color === c ? `0 0 0 2px var(--bg-panel), 0 0 0 4px ${c}` : undefined,
                }}
              />
            ))}
          </div>
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={close}>
            Annuler
          </Button>
          <Button variant="primary" onClick={create} disabled={!path || !name.trim() || busy}>
            {busy ? 'Création…' : 'Créer'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
        {label}
      </label>
      {children}
    </div>
  )
}
