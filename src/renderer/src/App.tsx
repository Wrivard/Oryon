import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { PanelLeft, Settings } from 'lucide-react'
import logoUrl from './assets/app-logo.png'
import WorkspaceRail from './components/WorkspaceRail'
import TerminalGrid, { EmptyState } from './components/TerminalGrid'
import RightPanel from './components/RightPanel'
import { IconButton } from './components/ui/IconButton'
import { SettingsModal } from './components/Settings/SettingsModal'
import { VoiceProvider } from './components/Voice/VoiceProvider'
import { Toaster } from './components/ui/Toaster'
import { UpdateToast } from './components/Update/UpdateToast'
import { useAppStore } from './store'
import { useUiStore } from './store/ui'
import { useUpdateStore } from './store/update'
import { fadeUp, staggerContainer, transition } from './lib/motion'

function AppContent() {
  const [railCollapsed, setRailCollapsed] = useState(false)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const settingsTab = useUiStore((s) => s.settingsTab)
  const openSettings = useUiStore((s) => s.openSettings)
  const closeSettings = useUiStore((s) => s.closeSettings)
  const updatePhase = useUpdateStore((s) => s.phase)
  const [rightWidth, setRightWidth] = useState(38)
  const dragging = useRef(false)
  const rightWidthRef = useRef(rightWidth)
  rightWidthRef.current = rightWidth
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeWorkspace = useAppStore((s) => s.workspaces.find((w) => w.id === activeWorkspaceId))
  const workspaces = useAppStore((s) => s.workspaces)
  const openWorkspaceIds = useAppStore((s) => s.openWorkspaceIds)
  const openWorkspace = useAppStore((s) => s.openWorkspace)

  // Largeur du panneau droit persistée par workspace (localStorage).
  useEffect(() => {
    if (!activeWorkspaceId) return
    const saved = localStorage.getItem(`bf:rightWidth:${activeWorkspaceId}`)
    if (saved) setRightWidth(Math.max(22, Math.min(58, parseFloat(saved))))
  }, [activeWorkspaceId])

  // Sync orchestrateur : événements live (tasks/mailbox) filtrés sur le workspace actif.
  useEffect(() => {
    window.bridge.orchestrator.onEvent((e) => {
      if (e.workspaceId !== useAppStore.getState().activeWorkspaceId) return
      if (e.type === 'tasks') useAppStore.getState().setTasks(e.tasks)
      else useAppStore.getState().addMailbox(e.message)
    })
    return () => window.bridge.orchestrator.offEvent()
  }, [])

  // Sync auto-update : état poussé par le main → store (toast + page Réglages).
  useEffect(() => {
    void window.bridge.update.getState().then((st) => useUpdateStore.getState().apply(st))
    window.bridge.update.onEvent((ev) => useUpdateStore.getState().apply(ev.state))
    return () => window.bridge.update.offEvent()
  }, [])

  // (Re)chargement des tasks/mailbox au changement de workspace.
  useEffect(() => {
    const { setTasks, setMailbox } = useAppStore.getState()
    if (!activeWorkspaceId) {
      setTasks([])
      setMailbox([])
      return
    }
    window.bridge.orchestrator.listTasks(activeWorkspaceId).then(setTasks)
    window.bridge.orchestrator.listMailbox(activeWorkspaceId).then(setMailbox)
  }, [activeWorkspaceId])

  // Tout workspace activé devient « ouvert » : sa grille reste montée en arrière-plan (PTY vivants) même
  // après un switch. Effet sur activeWorkspaceId → couvre TOUTES les voies d'activation (rail, création,
  // bootstrap qui pose activeWorkspaceId directement via setState).
  useEffect(() => {
    if (activeWorkspaceId) openWorkspace(activeWorkspaceId)
  }, [activeWorkspaceId, openWorkspace])

  // En quittant un workspace, on stoppe son swarm (sinon tasks in-progress orphelines + état global pointant ailleurs).
  useEffect(() => {
    const wid = activeWorkspaceId
    return () => {
      if (wid) void window.bridge.orchestrator.stop(wid)
    }
  }, [activeWorkspaceId])

  const onSplitterDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const dragWorkspaceId = activeWorkspaceId // figé au début du drag (au cas où on switch en cours)
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const pct = ((window.innerWidth - ev.clientX) / window.innerWidth) * 100
      setRightWidth(Math.max(22, Math.min(58, pct)))
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
      if (dragWorkspaceId) {
        localStorage.setItem(`bf:rightWidth:${dragWorkspaceId}`, String(rightWidthRef.current))
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Grilles à monter : tous les workspaces ouverts (+ l'actif même pas encore persisté → pas de frame
  // vide à la 1re activation), bornés aux workspaces existants (un workspace supprimé voit sa grille se
  // démonter → ses PTY tués, comportement inchangé).
  const mountedWorkspaceIds = (
    activeWorkspaceId && !openWorkspaceIds.includes(activeWorkspaceId)
      ? [...openWorkspaceIds, activeWorkspaceId]
      : openWorkspaceIds
  ).filter((id) => workspaces.some((w) => w.id === id))

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* Top bar */}
      <motion.header
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={transition}
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-bg-panel px-3"
      >
        <img src={logoUrl} alt="Oryon" className="h-[18px] w-[18px] rounded-[5px] object-contain" draggable={false} />
        <span className="text-[13px] font-semibold tracking-tight">Oryon</span>
        {activeWorkspace && (
          <>
            <span className="text-fg-subtle">/</span>
            <span className="text-[13px] text-fg-muted">{activeWorkspace.name}</span>
          </>
        )}
        <div className="relative ml-auto">
          <IconButton label="Réglages" size="sm" onClick={() => openSettings()}>
            <Settings size={14} />
          </IconButton>
          {(updatePhase === 'available' || updatePhase === 'downloaded') && (
            <span className="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
          )}
        </div>
      </motion.header>

      {/* Corps : rail · centre · panneau droit */}
      <motion.div
        variants={staggerContainer(0.05, 0.05)}
        initial="hidden"
        animate="show"
        className="flex flex-1 overflow-hidden"
      >
        {/* Rail gauche (collapsible) */}
        {/* width animée en CSS : reflow assumé — collapse ponctuel déclenché par l'utilisateur, pas un hot path. */}
        <motion.div
          variants={fadeUp}
          style={{ width: railCollapsed ? 0 : 220 }}
          className="shrink-0 overflow-hidden border-r border-border transition-[width] duration-[var(--dur)] ease-out"
        >
          <WorkspaceRail onCollapse={() => setRailCollapsed(true)} />
        </motion.div>

        {/* Poignée pour ré-ouvrir le rail */}
        {railCollapsed && (
          <div className="flex shrink-0 items-start border-r border-border bg-bg-panel py-2">
            <IconButton label="Afficher les workspaces" size="sm" onClick={() => setRailCollapsed(false)}>
              <PanelLeft size={14} />
            </IconButton>
          </div>
        )}

        {/* Centre — une grille par workspace ouvert ; seule l'active est visible, les autres restent
            MONTÉES mais cachées (display:none) → leurs PTY restent vivants. Le switch ne démonte donc rien. */}
        <motion.div variants={fadeUp} className="flex-1 overflow-hidden">
          {mountedWorkspaceIds.length === 0 ? (
            <EmptyState />
          ) : (
            mountedWorkspaceIds.map((wsId) => (
              <TerminalGrid key={wsId} workspaceId={wsId} active={wsId === activeWorkspaceId} />
            ))
          )}
        </motion.div>

        {/* Splitter */}
        <div
          onMouseDown={onSplitterDown}
          className="group relative w-px shrink-0 cursor-col-resize bg-border"
        >
          <div className="absolute inset-y-0 -left-1 -right-1 transition-colors duration-fast group-hover:bg-accent-soft" />
        </div>

        {/* Panneau droit (resizable) */}
        <motion.div
          variants={fadeUp}
          style={{ width: `${rightWidth}%` }} /* largeur pilotée par le splitter (runtime) */
          className="shrink-0 overflow-hidden border-l border-border"
        >
          <RightPanel />
        </motion.div>
      </motion.div>

      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        projectPath={activeWorkspace?.project_path ?? null}
        projectName={activeWorkspace?.name ?? null}
        initialTab={settingsTab}
      />
      <Toaster />
      <UpdateToast />
    </div>
  )
}

export default function App() {
  return (
    <VoiceProvider>
      <AppContent />
    </VoiceProvider>
  )
}
