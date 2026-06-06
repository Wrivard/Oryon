import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Plus, PanelLeftClose, Settings, CalendarDays, ClipboardList, Pencil, Trash2 } from 'lucide-react'
import { useAppStore } from '../../store'
import { useUiStore } from '../../store/ui'
import { useUpdateStore } from '../../store/update'
import { useTheme } from '../Theme/ThemeProvider'
import { IconButton } from '../ui/IconButton'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'
import { CreateWorkspaceModal } from '../CreateWorkspaceModal'
import { EditWorkspaceModal } from '../EditWorkspaceModal'
import { cn } from '../../lib/cn'
import { fadeUp, staggerContainer } from '../../lib/motion'
import type { Workspace } from '@shared/types'

interface Props {
  onCollapse: () => void
}

export default function WorkspaceRail({ onCollapse }: Props) {
  const { workspaces, activeWorkspaceId, terminalCounts, workspaceActivity, calendarMode, feedbackMode, setWorkspaces, setActiveWorkspace, setTerminalCounts, setCalendarMode, setFeedbackMode, removeWorkspace } =
    useAppStore()
  const { theme } = useTheme()
  const openSettings = useUiStore((s) => s.openSettings)
  const updatePhase = useUpdateStore((s) => s.phase)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingWs, setEditingWs] = useState<Workspace | null>(null)
  const [deletingWs, setDeletingWs] = useState<Workspace | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [appInfo, setAppInfo] = useState<{ version: string; isDev: boolean } | null>(null)

  const confirmDelete = async () => {
    if (!deletingWs) return
    setDeleteBusy(true)
    try {
      await window.bridge.workspaces.delete(deletingWs.id)
      removeWorkspace(deletingWs.id)
      setDeletingWs(null)
    } finally {
      setDeleteBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    window.bridge.app
      .info()
      .then((info) => {
        if (!cancelled) setAppInfo(info)
      })
      .catch(() => {
        /* info app indisponible → on n'affiche simplement pas la version */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.bridge.workspaces.list(),
      window.bridge.workspaces.terminalCounts(),
    ]).then(([list, counts]) => {
      if (cancelled) return
      setWorkspaces(list)
      setTerminalCounts(counts)
      // Restauration : auto-sélection du workspace le plus récemment ouvert (liste triée par last_opened).
      useAppStore.setState((s) => (s.activeWorkspaceId ? {} : { activeWorkspaceId: list[0]?.id ?? null }))
    })
    return () => {
      cancelled = true
    }
  }, [setWorkspaces, setTerminalCounts])

  return (
    <div className="flex h-full w-[220px] flex-col bg-bg-panel">
      {/* Navigation — liens du haut, SÉPARÉS des workspaces (section extensible : on en ajoutera d'autres). */}
      <nav className="shrink-0 space-y-0.5 border-b border-border p-1.5">
        <button
          onClick={() => setCalendarMode(true)}
          className={cn(
            'group relative flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left outline-none',
            'transition-colors duration-fast ease-out',
            calendarMode ? 'bg-active' : 'hover:bg-hover',
          )}
        >
          {calendarMode && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
          <CalendarDays size={14} className={cn('shrink-0', calendarMode ? 'text-fg' : 'text-fg-muted group-hover:text-fg')} />
          <span className={cn('flex-1 truncate text-[13px]', calendarMode ? 'text-fg' : 'text-fg-muted group-hover:text-fg')}>
            Calendar
          </span>
        </button>
        <button
          onClick={() => setFeedbackMode(true)}
          className={cn(
            'group relative flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left outline-none',
            'transition-colors duration-fast ease-out',
            feedbackMode ? 'bg-active' : 'hover:bg-hover',
          )}
        >
          {feedbackMode && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
          <ClipboardList
            size={14}
            className={cn('shrink-0', feedbackMode ? 'text-fg' : 'text-fg-muted group-hover:text-fg')}
          />
          <span className={cn('flex-1 truncate text-[13px]', feedbackMode ? 'text-fg' : 'text-fg-muted group-hover:text-fg')}>
            Feedback système
          </span>
        </button>
        {/* ↑ futurs liens de navigation ici */}
      </nav>

      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border pl-3 pr-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">Workspaces</span>
        <div className="flex items-center gap-0.5">
          <IconButton label="Réduire le rail" size="sm" onClick={onCollapse}>
            <PanelLeftClose size={14} />
          </IconButton>
          <IconButton label="Nouveau workspace" size="sm" onClick={() => setModalOpen(true)}>
            <Plus size={15} />
          </IconButton>
        </div>
      </div>

      {/* Liste des workspaces */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {workspaces.length === 0 ? (
          <div className="mt-8 px-3 text-center">
            <p className="text-xs text-fg-muted">Aucun workspace</p>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
              Crée-en un avec <span className="text-accent">+</span> pour lancer des agents Claude Code.
            </p>
          </div>
        ) : (
          <motion.div variants={staggerContainer(0.03)} initial="hidden" animate="show" className="space-y-0.5">
            {workspaces.map((ws, i) => {
              const active = activeWorkspaceId === ws.id
              const dot = ws.color ?? theme.terminalTabColors[i % theme.terminalTabColors.length]
              const count = terminalCounts[ws.id]
              const busy = !!workspaceActivity[ws.id] // swarm en cours (tâches in-progress/in-review) → halo pulsant
              return (
                <motion.div
                  key={ws.id}
                  variants={fadeUp}
                  className={cn(
                    'group relative flex items-center rounded outline-none',
                    'transition-colors duration-fast ease-out',
                    active ? 'bg-active' : 'hover:bg-hover',
                  )}
                >
                  {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
                  <button
                    onClick={() => setActiveWorkspace(ws.id)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left outline-none"
                  >
                    <span
                      className="relative flex h-2 w-2 shrink-0 items-center justify-center"
                      title={busy ? 'Swarm en cours' : undefined}
                    >
                      {busy && (
                        <span
                          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
                          style={{ background: dot }}
                        />
                      )}
                      <span className="relative h-2 w-2 rounded-full" style={{ background: dot }} />
                    </span>
                    <span
                      className={cn(
                        'flex-1 truncate text-[13px]',
                        active ? 'text-fg' : 'text-fg-muted group-hover:text-fg',
                      )}
                    >
                      {ws.name}
                    </span>
                  </button>
                  {count ? (
                    <span className="shrink-0 pr-2.5">
                      <Badge tone={active ? 'accent' : 'neutral'}>{count}</Badge>
                    </span>
                  ) : null}
                  {/* Actions au survol (éditer / supprimer). Fond identique à la ligne → masque proprement
                      le compteur et la fin du nom. Boutons SÉPARÉS du <button> de sélection (pas d'imbrication). */}
                  <div
                    className={cn(
                      'absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r pl-5 pr-1.5',
                      'opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100',
                      active ? 'bg-active' : 'bg-hover',
                    )}
                  >
                    <IconButton label="Modifier le workspace" size="sm" onClick={() => setEditingWs(ws)}>
                      <Pencil size={12} />
                    </IconButton>
                    <IconButton label="Supprimer le workspace" size="sm" onClick={() => setDeletingWs(ws)}>
                      <Trash2 size={12} />
                    </IconButton>
                  </div>
                </motion.div>
              )
            })}
          </motion.div>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border p-1.5">
        <button
          onClick={() => openSettings()}
          className="relative flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-[11px] text-fg-subtle outline-none transition-colors duration-fast hover:bg-hover hover:text-fg-muted"
        >
          <Settings size={13} />
          Réglages
          {(updatePhase === 'available' || updatePhase === 'downloaded') && (
            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" title="Mise à jour disponible" />
          )}
        </button>
        {appInfo && (
          <div className="px-2.5 pt-1 text-[10px] tabular-nums text-fg-subtle" title={appInfo.isDev ? 'Build de développement' : 'Build de production'}>
            v{appInfo.version}
            {appInfo.isDev && <span className="text-warning"> (dev)</span>}
          </div>
        )}
      </div>

      <CreateWorkspaceModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <EditWorkspaceModal workspace={editingWs} onClose={() => setEditingWs(null)} />

      {/* Confirmation de suppression (destructif : ferme les terminaux ; branches non mergées conservées). */}
      <Modal
        open={!!deletingWs}
        onClose={() => {
          if (!deleteBusy) setDeletingWs(null)
        }}
        title="Supprimer le workspace"
      >
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-fg-muted">
            Supprimer <span className="font-medium text-fg">«&nbsp;{deletingWs?.name}&nbsp;»</span> ? Ses terminaux
            seront fermés et le workspace retiré. Les branches git non mergées des agents sont conservées
            (récupérables).
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setDeletingWs(null)} disabled={deleteBusy}>
              Annuler
            </Button>
            <button
              onClick={confirmDelete}
              disabled={deleteBusy}
              className="inline-flex h-8 select-none items-center justify-center rounded bg-danger px-3 text-[13px] font-medium text-white outline-none transition duration-fast ease-out hover:opacity-90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            >
              {deleteBusy ? 'Suppression…' : 'Supprimer'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
