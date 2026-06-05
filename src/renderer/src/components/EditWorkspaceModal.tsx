import { useEffect, useState, type ReactNode } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { useAppStore } from '../store'
import { useTheme } from './Theme/ThemeProvider'
import type { Workspace } from '@shared/types'

/**
 * Édition d'un workspace existant : nom + couleur uniquement.
 * Le LAYOUT n'est volontairement PAS éditable — `workspaces:update` met à jour le champ mais ne
 * recrée pas les terminaux ; l'exposer serait trompeur (cf. workspaces.ipc.ts).
 */
export function EditWorkspaceModal({
  workspace,
  onClose,
}: {
  workspace: Workspace | null
  onClose: () => void
}) {
  const { theme } = useTheme()
  const patchWorkspace = useAppStore((s) => s.patchWorkspace)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(theme.terminalTabColors[0])
  const [busy, setBusy] = useState(false)

  // Resynchronise les champs à chaque ouverture (workspace ciblé qui change).
  useEffect(() => {
    if (workspace) {
      setName(workspace.name)
      setColor(workspace.color ?? theme.terminalTabColors[0])
    }
  }, [workspace, theme.terminalTabColors])

  const save = async () => {
    if (!workspace || !name.trim()) return
    setBusy(true)
    try {
      const updated = await window.bridge.workspaces.update(workspace.id, { name: name.trim(), color })
      patchWorkspace(updated)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={!!workspace} onClose={onClose} title="Modifier le workspace">
      <div className="space-y-4">
        <Field label="Nom">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
            placeholder="Mon projet"
            aria-label="Nom du workspace"
            className="w-full rounded border border-border bg-bg-inset px-2.5 py-2 text-[12px] text-fg outline-none transition-colors duration-fast placeholder:text-fg-subtle focus:border-accent"
          />
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
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" onClick={save} disabled={!name.trim() || busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
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
