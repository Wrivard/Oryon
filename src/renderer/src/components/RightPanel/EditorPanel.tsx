import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { X } from 'lucide-react'
import { FileTree } from './FileTree'
import { QuickOpen } from './QuickOpen'
import { cn } from '../../lib/cn'
import { useAppStore } from '../../store'
import { buildProjectContext } from '../../lib/project-vocab'

interface OpenFile {
  path: string
  name: string
  content: string
  language: string
  dirty: boolean
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export function EditorPanel({ projectPath, active }: { projectPath: string; active: boolean }) {
  const [files, setFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [treeRefresh, setTreeRefresh] = useState(0)
  const [quickOpen, setQuickOpen] = useState(false)
  const [allFiles, setAllFiles] = useState<string[]>([])
  const filesRef = useRef(files)
  filesRef.current = files
  const activeRef = useRef(activePath)
  activeRef.current = activePath
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  // Paths qu'on vient d'écrire : on ignore l'événement chokidar d'écho pour ne pas réécraser la sauvegarde.
  const recentWrites = useRef<Map<string, number>>(new Map())

  const activeFile = files.find((f) => f.path === activePath) ?? null

  const onMount: OnMount = (ed) => {
    editorRef.current = ed
  }

  // Monaco ne se recalcule pas en display:none → relayout quand le panneau (re)devient actif.
  useEffect(() => {
    if (active) requestAnimationFrame(() => editorRef.current?.layout())
  }, [active, activePath])

  const openFile = useCallback(async (path: string) => {
    if (filesRef.current.some((f) => f.path === path)) {
      setActivePath(path)
      return
    }
    try {
      const { content, language } = await window.bridge.editor.readFile(path)
      setFiles((fs) =>
        fs.some((f) => f.path === path)
          ? fs
          : [...fs, { path, name: baseName(path), content, language, dirty: false }],
      )
      setActivePath(path)
    } catch (err) {
      console.error('[editor] readFile a échoué', path, err)
      window.alert(`Impossible d'ouvrir ${baseName(path)} : ${(err as Error).message}`)
    }
  }, [])

  const closeFile = (path: string) => {
    setFiles((fs) => fs.filter((f) => f.path !== path))
    setActivePath((p) => {
      if (p !== path) return p
      const remaining = filesRef.current.filter((f) => f.path !== path)
      return remaining[remaining.length - 1]?.path ?? null
    })
  }

  const onChange = (val: string | undefined) => {
    const ap = activeRef.current
    if (ap == null) return
    setFiles((fs) => fs.map((f) => (f.path === ap ? { ...f, content: val ?? '', dirty: true } : f)))
  }

  const save = useCallback(async () => {
    const f = filesRef.current.find((x) => x.path === activeRef.current)
    if (!f || !f.dirty) return
    try {
      await window.bridge.editor.writeFile(f.path, f.content)
      recentWrites.current.set(f.path, Date.now())
      setFiles((fs) => fs.map((x) => (x.path === f.path ? { ...x, dirty: false } : x)))
    } catch (err) {
      console.error('[editor] writeFile a échoué', f.path, err)
      window.alert(`Échec de la sauvegarde : ${(err as Error).message}`)
    }
  }, [])

  // Liste des fichiers du projet (Quick Open + boost vocal projet, INC3). Chargée au montage et à chaque
  // refresh de l'arbre (ajout/suppression de fichier ; pas sur simple édition).
  useEffect(() => {
    window.bridge.editor.listFiles(projectPath).then(setAllFiles).catch(() => {})
  }, [projectPath, treeRefresh])

  // Contexte projet (INC3) → store : termes de boost (stems + identifiants des fichiers OUVERTS) + basenames
  // pour le file-tagging. Recalculé au changement de la liste / de l'ensemble des fichiers ouverts (pas à
  // chaque frappe). Éphémère : jamais persisté dans le dictionnaire perso.
  const setProjectContext = useAppStore((s) => s.setProjectContext)
  const openPathsKey = files.map((f) => f.path).join('|')
  useEffect(() => {
    const { terms, files: projFiles } = buildProjectContext(
      allFiles,
      filesRef.current.map((f) => f.content),
    )
    setProjectContext(terms, projFiles)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFiles, openPathsKey, setProjectContext])

  // Raccourcis : Cmd/Ctrl+P (Quick Open), Cmd/Ctrl+S (save) — uniquement quand le panneau est actif.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setQuickOpen(true)
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, save])

  // File-watching : recharge le fichier ouvert s'il change sur disque (et non modifié) ; refresh l'arbre.
  useEffect(() => {
    window.bridge.editor.watch(projectPath)
    window.bridge.editor.onFsEvent((ev) => {
      if (ev.type === 'change') {
        const f = filesRef.current.find((x) => x.path === ev.path)
        const justWrote = (recentWrites.current.get(ev.path) ?? 0) > Date.now() - 1500
        if (f && !f.dirty && !justWrote) {
          window.bridge.editor
            .readFile(ev.path)
            .then(({ content }) => {
              setFiles((fs) => fs.map((x) => (x.path === ev.path ? { ...x, content } : x)))
            })
            .catch(() => {
              /* fichier supprimé/illisible : on ignore */
            })
        }
      } else {
        setTreeRefresh((n) => n + 1)
      }
    })
    return () => {
      window.bridge.editor.offFsEvent()
      window.bridge.editor.unwatch(projectPath)
    }
  }, [projectPath])

  return (
    <div className="flex h-full">
      <div className="w-[40%] min-w-[140px] max-w-[280px] shrink-0 overflow-y-auto border-r border-border bg-bg-panel">
        <FileTree root={projectPath} activePath={activePath} onOpenFile={openFile} refreshKey={treeRefresh} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Onglets de fichiers */}
        <div className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-bg-panel">
          {files.map((f) => (
            <div
              key={f.path}
              onClick={() => setActivePath(f.path)}
              className={cn(
                'group flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-2.5 text-[11px] transition-colors duration-fast',
                f.path === activePath ? 'bg-bg-deep text-fg' : 'text-fg-muted hover:text-fg',
              )}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: f.dirty ? 'var(--accent)' : 'transparent' }}
              />
              <span className="max-w-[140px] truncate">{f.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeFile(f.path)
                }}
                aria-label="Fermer le fichier"
                className="text-fg-subtle opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>

        {/* Monaco */}
        <div className="min-h-0 flex-1">
          {activeFile ? (
            <Editor
              theme="oryon-dark"
              path={activeFile.path}
              language={activeFile.language}
              value={activeFile.content}
              onChange={onChange}
              onMount={onMount}
              options={{
                fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
                fontSize: 12,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                renderWhitespace: 'selection',
                smoothScrolling: true,
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">
              Ouvre un fichier dans l'arbre — ou Cmd/Ctrl+P
            </div>
          )}
        </div>
      </div>

      <QuickOpen
        open={quickOpen}
        files={allFiles}
        rootPath={projectPath}
        onClose={() => setQuickOpen(false)}
        onOpenFile={openFile}
      />
    </div>
  )
}
