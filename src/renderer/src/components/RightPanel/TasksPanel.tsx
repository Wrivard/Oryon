import { useAppStore } from '../../store'
import type { Task, TaskStatus } from '@shared/types'

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'todo', label: 'Todo' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'in-review', label: 'In Review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'complete', label: 'Complete' },
]

const ROLE_COLOR: Record<string, string> = {
  builder: '#3b82f6',
  reviewer: '#a855f7',
  scout: '#f5a623',
  coordinator: 'var(--accent)',
}

export function TasksPanel() {
  const tasks = useAppStore((s) => s.tasks)

  const onDrop = (status: TaskStatus, taskId: string) => {
    if (taskId) void window.bridge.orchestrator.updateTaskStatus(taskId, status)
  }

  return (
    <div className="grid h-full grid-cols-5 gap-px overflow-hidden bg-border">
      {COLUMNS.map((col) => {
        const colTasks = tasks.filter((t) => t.status === col.id)
        return (
          <div
            key={col.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => onDrop(col.id, e.dataTransfer.getData('text/plain'))}
            className="flex min-h-0 flex-col bg-bg-panel"
          >
            <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">{col.label}</span>
              <span className="tabular-nums text-[10px] text-fg-subtle">{colTasks.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5">
              {colTasks.map((t) => (
                <Card key={t.id} task={t} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Card({ task }: { task: Task }) {
  const role = task.role ?? 'builder'
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', task.id)}
      className="cursor-grab rounded-md border border-border bg-bg-elevated p-2 transition-colors hover:border-border-strong active:cursor-grabbing"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: ROLE_COLOR[role] ?? 'var(--fg-subtle)' }}
        />
        <span className="text-[9px] uppercase tracking-wide text-fg-subtle">{role}</span>
      </div>
      <p className="text-[11px] font-medium leading-snug text-fg">
        {task.title ?? task.instructions.slice(0, 60)}
      </p>
    </div>
  )
}
