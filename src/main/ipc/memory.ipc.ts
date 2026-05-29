import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { MemoryNote, MemoryGraph, MemoryGraphNode } from '../../shared/types'

// BridgeMemory (Phase 5) : knowledge graph local-first. Une note = un fichier markdown dans
// <projet>/.oryon/memory/. Les liens [[wikilink]] tissent le graphe. (.oryon est déjà ignoré par
// l'arbre de l'éditeur — les notes ne polluent pas le file-tree.)

const WIKILINK = /\[\[([^\]]+)\]\]/g

function memDir(projectPath: string): string {
  return join(projectPath, '.oryon', 'memory')
}

/** Nom de fichier sûr (pas de traversée de chemin, pas de séparateurs), borné. */
function safeName(name: string): string {
  return (
    name
      .replace(/\.md$/i, '')
      .replace(/[/\\:*?"<>|]+/g, '-')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 120) || 'note'
  )
}

function parseLinks(content: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  WIKILINK.lastIndex = 0
  while ((m = WIKILINK.exec(content))) {
    const t = m[1].split('|')[0].trim()
    if (t) out.add(t)
  }
  return [...out]
}

function titleOf(content: string, name: string): string {
  const h = content.match(/^#\s+(.+)$/m)
  return h ? h[1].trim() : name
}

function excerptOf(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  return (line ?? '').replace(WIKILINK, '$1').slice(0, 140)
}

async function listMemories(projectPath: string): Promise<MemoryNote[]> {
  const dir = memDir(projectPath)
  await fs.mkdir(dir, { recursive: true }).catch(() => {})
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.toLowerCase().endsWith('.md'))
  const notes: MemoryNote[] = []
  for (const f of files) {
    const p = join(dir, f)
    const content = await fs.readFile(p, 'utf8').catch(() => '')
    const st = await fs.stat(p).catch(() => null)
    const name = f.replace(/\.md$/i, '')
    notes.push({ name, title: titleOf(content, name), excerpt: excerptOf(content), links: parseLinks(content), updated: st ? st.mtimeMs : 0 })
  }
  return notes.sort((a, b) => b.updated - a.updated)
}

async function noteToReturn(projectPath: string, name: string): Promise<MemoryNote> {
  const p = join(memDir(projectPath), safeName(name) + '.md')
  const content = await fs.readFile(p, 'utf8').catch(() => '')
  const st = await fs.stat(p).catch(() => null)
  const n = safeName(name)
  return { name: n, title: titleOf(content, n), excerpt: excerptOf(content), links: parseLinks(content), updated: st ? st.mtimeMs : 0 }
}

async function buildGraph(projectPath: string): Promise<MemoryGraph> {
  const notes = await listMemories(projectPath)
  const byKey = new Map(notes.map((n) => [n.name.toLowerCase(), n.name]))
  const nodes: MemoryGraphNode[] = notes.map((n) => ({ id: n.name, title: n.title, exists: true }))
  const seen = new Set(nodes.map((n) => n.id.toLowerCase()))
  const edges: { from: string; to: string }[] = []
  for (const n of notes) {
    for (const link of n.links) {
      const resolved = byKey.get(link.toLowerCase())
      const toId = resolved ?? link
      if (!resolved && !seen.has(link.toLowerCase())) {
        nodes.push({ id: link, title: link, exists: false }) // note fantôme (lien non résolu)
        seen.add(link.toLowerCase())
      }
      edges.push({ from: n.name, to: toId })
    }
  }
  return { nodes, edges }
}

export function registerMemoryIpc(): void {
  ipcMain.handle('memory:list', (_e, projectPath: string): Promise<MemoryNote[]> => listMemories(projectPath))
  ipcMain.handle('memory:read', (_e, projectPath: string, name: string): Promise<string> =>
    fs.readFile(join(memDir(projectPath), safeName(name) + '.md'), 'utf8').catch(() => ''),
  )
  ipcMain.handle('memory:write', async (_e, projectPath: string, name: string, content: string): Promise<MemoryNote> => {
    const dir = memDir(projectPath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, safeName(name) + '.md'), content, 'utf8')
    return noteToReturn(projectPath, name)
  })
  ipcMain.handle('memory:delete', async (_e, projectPath: string, name: string): Promise<void> => {
    await fs.unlink(join(memDir(projectPath), safeName(name) + '.md')).catch(() => {})
  })
  ipcMain.handle('memory:graph', (_e, projectPath: string): Promise<MemoryGraph> => buildGraph(projectPath))
}
