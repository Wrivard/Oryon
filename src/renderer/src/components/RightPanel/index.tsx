import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Bot, FileCode, Globe, ListTree, GitCompareArrows, KanbanSquare, Network, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { transition } from '../../lib/motion'
import { useAppStore } from '../../store'
import { EditorPanel } from './EditorPanel'
import { BrowserPanel } from './BrowserPanel'
import { TasksPanel } from './TasksPanel'
import { PlanPanel } from './PlanPanel'
import { SourcePanel } from './SourcePanel'
import { MemoryPanel } from './MemoryPanel'
import { OrchestratorPanel } from './OrchestratorPanel'

interface TabDef {
  id: string
  label: string
  icon: LucideIcon
}

const TABS: TabDef[] = [
  { id: 'orchestrator', label: 'Orchestrator', icon: Bot },
  { id: 'editor', label: 'Editor', icon: FileCode },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'plan', label: 'Plan', icon: ListTree },
  { id: 'source', label: 'Source', icon: GitCompareArrows },
  { id: 'memory', label: 'Memory', icon: Network },
  { id: 'tasks', label: 'Tasks', icon: KanbanSquare },
]

export default function RightPanel() {
  const [active, setActive] = useState('orchestrator')
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === activeWorkspaceId))
  const openWorkspaceIds = useAppStore((s) => s.openWorkspaceIds)
  const openFileNonce = useAppStore((s) => s.openFileRequest?.nonce)

  // Inspect→code (ou toute demande d'ouverture) : bascule sur l'onglet Editor.
  useEffect(() => {
    if (openFileNonce != null) setActive('editor')
  }, [openFileNonce])

  return (
    <div className="flex h-full flex-col bg-bg-panel">
      {/* Barre d'onglets */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        {TABS.map((tab) => {
          const isActive = active === tab.id
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={cn(
                'relative flex h-full items-center gap-1.5 px-2.5 text-[12px] outline-none',
                'transition-colors duration-fast ease-out',
                isActive ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted',
              )}
            >
              <Icon size={13} />
              {tab.label}
              {isActive && (
                <motion.span
                  layoutId="right-panel-underline"
                  className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-accent"
                  transition={transition}
                />
              )}
            </button>
          )
        })}
      </div>

      {/* Contenu */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {!workspace ? (
          <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">
            Sélectionne un workspace
          </div>
        ) : (
          <>
            {/* Editor & Browser restent montés au TOGGLE d'onglets (état/dev server/webview préservés).
                Au changement de WORKSPACE, key={workspace.id} les remonte volontairement (projet différent). */}
            <div className={cn('absolute inset-0', active === 'editor' ? 'block' : 'hidden')}>
              <EditorPanel key={workspace.id} projectPath={workspace.project_path} active={active === 'editor'} />
            </div>
            <div className={cn('absolute inset-0', active === 'browser' ? 'block' : 'hidden')}>
              <BrowserPanel key={workspace.id} workspaceId={workspace.id} />
            </div>
            {/* Source reste monté (Monaco DiffEditor coûteux à remonter) ; il refetch quand actif. */}
            <div className={cn('absolute inset-0', active === 'source' ? 'block' : 'hidden')}>
              <SourcePanel key={workspace.id} projectPath={workspace.project_path} active={active === 'source'} />
            </div>

            {/* Orchestrateurs : UN panneau par workspace OUVERT, tous MONTÉS (même cachés) → chaque swarm de
                fond garde son terminal orchestrateur vivant et continue de piloter. Seul l'orchestrateur du
                workspace actif (onglet Orchestrator sélectionné) est visible ; les autres en display:none.
                key={wsId} (PAS workspace.id) → ils ne remontent JAMAIS au switch (session claude préservée). */}
            {openWorkspaceIds.map((wsId) => {
              const visible = active === 'orchestrator' && wsId === activeWorkspaceId
              return (
                <div key={wsId} className={cn('absolute inset-0', visible ? 'block' : 'hidden')}>
                  <OrchestratorPanel workspaceId={wsId} active={visible} />
                </div>
              )
            })}

            {active === 'memory' && (
              <div className="absolute inset-0">
                <MemoryPanel key={workspace.id} projectPath={workspace.project_path} />
              </div>
            )}

            {active === 'plan' && (
              <div className="absolute inset-0">
                <PlanPanel />
              </div>
            )}

            {active === 'tasks' && (
              <div className="absolute inset-0">
                <TasksPanel />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
