import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { PanelLeft } from 'lucide-react'
import WorkspaceRail from './components/WorkspaceRail'
import TerminalGrid, { EmptyState } from './components/TerminalGrid'
import { CalendarView } from './components/Calendar'
import { SystemFeedbackView } from './components/SystemFeedback'
import RightPanel from './components/RightPanel'
import { IconButton } from './components/ui/IconButton'
import { SettingsModal } from './components/Settings/SettingsModal'
import { VoiceProvider } from './components/Voice/VoiceProvider'
import { Toaster } from './components/ui/Toaster'
import { UpdateToast } from './components/Update/UpdateToast'
import { useAppStore } from './store'
import { useUiStore } from './store/ui'
import { useUpdateStore } from './store/update'
import { fadeUp, staggerContainer } from './lib/motion'
import type { OrchestratorEvent, UpdateEvent } from '@shared/types'

function AppContent() {
  const [railCollapsed, setRailCollapsed] = useState(false)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const settingsTab = useUiStore((s) => s.settingsTab)
  const closeSettings = useUiStore((s) => s.closeSettings)
  const [rightWidth, setRightWidth] = useState(38)
  const dragging = useRef(false)
  const rightWidthRef = useRef(rightWidth)
  rightWidthRef.current = rightWidth
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const calendarMode = useAppStore((s) => s.calendarMode)
  const feedbackMode = useAppStore((s) => s.feedbackMode)
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

  // Sync orchestrateur : events live (tasks/mailbox). On met à jour la pastille d'activité de TOUS les
  // workspaces (un swarm de fond qui progresse fait clignoter le rail), mais on n'alimente le board affiché
  // (tasks/mailbox) que pour le workspace actif.
  useEffect(() => {
    const onEvent = (e: OrchestratorEvent) => {
      const st = useAppStore.getState()
      if (e.type === 'tasks') {
        st.setWorkspaceActivity(
          e.workspaceId,
          e.tasks.some((t) => t.status === 'in-progress' || t.status === 'in-review'),
        )
        if (e.workspaceId === st.activeWorkspaceId) st.setTasks(e.tasks)
      } else if (e.workspaceId === st.activeWorkspaceId) {
        st.addMailbox(e.message)
      }
    }
    window.bridge.orchestrator.onEvent(onEvent)
    return () => window.bridge.orchestrator.offEvent(onEvent)
  }, [])

  // open_browser (MCP) → ouvre l'URL dans le panneau Browser (ramène le workspace + bascule l'onglet).
  useEffect(() => {
    const onNavigate = ({ workspaceId, url }: { workspaceId: string; url: string }) => {
      useAppStore.getState().requestOpenBrowser(workspaceId, url)
    }
    window.bridge.browser.onNavigate(onNavigate)
    return () => window.bridge.browser.offNavigate(onNavigate)
  }, [])

  // Sync auto-update : état poussé par le main → store (toast + page Réglages).
  useEffect(() => {
    void window.bridge.update.getState().then((st) => useUpdateStore.getState().apply(st))
    const onEvent = (ev: UpdateEvent) => useUpdateStore.getState().apply(ev.state)
    window.bridge.update.onEvent(onEvent)
    return () => window.bridge.update.offEvent(onEvent)
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

  // On ne stoppe PLUS le swarm en quittant un workspace : les swarms tournent EN PARALLÈLE (orchestrateur +
  // workers restent vivants en arrière-plan, leurs grilles/panneaux restent montés). Le backend est partitionné
  // par workspace et le board se recharge au retour. Le seul arrêt subsiste au quit de l'app (killAllTerminals).

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
      {/* Corps : rail · centre · panneau droit (plus de top bar : le titre/logo vit dans la barre de titre OS) */}
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
          {/* Vue Calendar : remplace visuellement les grilles mais les laisse MONTÉES (active=false →
              display:none, donc PTY + scrollback vivants). EmptyState masqué tant que le calendrier est affiché. */}
          {mountedWorkspaceIds.length === 0 && !calendarMode && !feedbackMode ? (
            <EmptyState />
          ) : (
            mountedWorkspaceIds.map((wsId) => (
              <TerminalGrid
                key={wsId}
                workspaceId={wsId}
                active={!calendarMode && !feedbackMode && wsId === activeWorkspaceId}
              />
            ))
          )}
          {calendarMode && <CalendarView />}
          {feedbackMode && <SystemFeedbackView />}
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
