import { useEffect, useState } from 'react'
import { ChevronRight, File as FileIcon, Folder } from 'lucide-react'
import type { TreeNode } from '@shared/types'
import { cn } from '../../lib/cn'

export function FileTree({
  root,
  activePath,
  onOpenFile,
  refreshKey,
}: {
  root: string
  activePath: string | null
  onOpenFile: (path: string) => void
  refreshKey: number
}) {
  const [nodes, setNodes] = useState<TreeNode[] | null>(null)

  useEffect(() => {
    let cancelled = false
    window.bridge.editor.readDir(root).then((n) => {
      if (!cancelled) setNodes(n)
    })
    return () => {
      cancelled = true
    }
  }, [root, refreshKey])

  if (!nodes) return <div className="p-3 text-[11px] text-fg-subtle">Chargement…</div>

  return (
    <div className="py-1">
      {nodes.map((n) => (
        <Node key={n.path} node={n} depth={0} activePath={activePath} onOpenFile={onOpenFile} />
      ))}
    </div>
  )
}

function Node(props: {
  node: TreeNode
  depth: number
  activePath: string | null
  onOpenFile: (path: string) => void
}) {
  return props.node.type === 'dir' ? <DirRow {...props} /> : <FileRow {...props} />
}

function Row({
  depth,
  active,
  onClick,
  children,
}: {
  depth: number
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12px] outline-none',
        'transition-colors duration-fast',
        active ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg',
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      {children}
    </button>
  )
}

function DirRow({
  node,
  depth,
  activePath,
  onOpenFile,
}: {
  node: TreeNode
  depth: number
  activePath: string | null
  onOpenFile: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<TreeNode[] | null>(null)

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next && children === null) setChildren(await window.bridge.editor.readDir(node.path))
  }

  return (
    <>
      <Row depth={depth} onClick={toggle}>
        <ChevronRight
          size={12}
          className={cn('shrink-0 transition-transform duration-fast', open && 'rotate-90')}
        />
        <Folder size={13} className="shrink-0 text-fg-subtle" />
        <span className="truncate">{node.name}</span>
      </Row>
      {open &&
        children?.map((c) => (
          <Node key={c.path} node={c} depth={depth + 1} activePath={activePath} onOpenFile={onOpenFile} />
        ))}
    </>
  )
}

function FileRow({
  node,
  depth,
  activePath,
  onOpenFile,
}: {
  node: TreeNode
  depth: number
  activePath: string | null
  onOpenFile: (path: string) => void
}) {
  return (
    <Row depth={depth} active={activePath === node.path} onClick={() => onOpenFile(node.path)}>
      <span className="w-3 shrink-0" />
      <FileIcon size={13} className="shrink-0 opacity-70" />
      <span className="truncate">{node.name}</span>
    </Row>
  )
}
