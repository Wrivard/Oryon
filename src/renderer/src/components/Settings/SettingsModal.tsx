import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { X, Sparkles, SlidersHorizontal, Trash2, Plus, Pencil, Plug, Mic, Download, CalendarDays, Globe } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { cn } from '../../lib/cn'
import { transitionFast } from '../../lib/motion'
import { VoiceSettings } from './Voice/VoiceSettings'
import { UpdatesSettings } from './UpdatesSettings'
import { ConnectorsSection } from './ConnectorsSection'
import { CalendarSection } from './CalendarSection'
import { BrowserSection } from './BrowserSection'
import { ThemePicker } from '../Theme/ThemePicker'
import type { SkillInfo, SkillScope, SkillImportResult } from '@shared/types'

// Tous les agents (orchestrateur + workers) sont CLAMPÉS sur Opus au spawn (enforceAgentSpawn) : un modèle
// faible est non-exprimable. Le contrôle reste pour rendre la politique « toujours le plus puissant » explicite.
const MODELS = [{ v: 'opus', label: 'Opus (max) — imposé à tous les agents' }]

type Tab = 'app' | 'mcp' | 'skills' | 'voice' | 'calendar' | 'browser' | 'updates'

export function SettingsModal({
  open,
  onClose,
  projectPath,
  projectName,
  initialTab,
}: {
  open: boolean
  onClose: () => void
  projectPath: string | null
  projectName: string | null
  initialTab?: string
}) {
  const [tab, setTab] = useState<Tab>('app')
  // Ouverture ciblée (ex. toast d'update → onglet « Mises à jour »).
  useEffect(() => {
    if (open && initialTab) setTab(initialTab as Tab)
  }, [open, initialTab])
  const [appSettings, setAppSettings] = useState<Record<string, string>>({})
  const [skills, setSkills] = useState<SkillInfo[]>([])

  // Formulaire d'ajout de skill : 3 modes (créer / importer un dossier / importer depuis git).
  const [skAdding, setSkAdding] = useState(false)
  const [skMode, setSkMode] = useState<'create' | 'folder' | 'git'>('create')
  const [skScope, setSkScope] = useState<SkillScope>('user')
  const [skName, setSkName] = useState('')
  const [skDesc, setSkDesc] = useState('')
  const [skBody, setSkBody] = useState('')
  const [skFolder, setSkFolder] = useState<string | null>(null)
  const [skUrl, setSkUrl] = useState('')
  const [skPending, setSkPending] = useState(false) // import en cours (clone git / copie de dossier)
  const [skError, setSkError] = useState('')
  const [skResult, setSkResult] = useState('') // résumé d'import (« n installé(s)… »)

  // Édition inline d'un skill (panneau sous la ligne ; clé `${scope}:${name}`).
  const [skEditing, setSkEditing] = useState<string | null>(null)
  const [skEditDesc, setSkEditDesc] = useState('')
  const [skEditBody, setSkEditBody] = useState('')
  const [skEditError, setSkEditError] = useState('')

  // Confirmation de suppression inline (en deux temps, sans window.confirm natif).
  const [skDeleting, setSkDeleting] = useState<string | null>(null)
  const [skDeleteError, setSkDeleteError] = useState('')

  const reload = async () => {
    setAppSettings(await window.bridge.settings.getApp())
    setSkills(await window.bridge.skills.list(projectPath))
  }

  useEffect(() => {
    if (open) void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const setModel = async (v: string) => {
    await window.bridge.settings.setApp('agentModel', v)
    setAppSettings((s) => ({ ...s, agentModel: v }))
  }

  // --- Skills : projectPath n'est pertinent que pour le scope 'project' (sinon null → base globale). ---
  const skPath = (scope: SkillScope) => (scope === 'project' ? projectPath : null)
  const summarizeImport = (r: SkillImportResult) =>
    `${r.installed.length} installé(s)` + (r.skipped.length > 0 ? `, ${r.skipped.length} ignoré(s)` : '')

  const resetSkForm = () => {
    setSkName('')
    setSkDesc('')
    setSkBody('')
    setSkFolder(null)
    setSkUrl('')
    setSkError('')
  }
  const toggleSkAdd = () => {
    setSkAdding((a) => !a)
    resetSkForm()
    setSkResult('')
  }
  const pickSkFolder = async () => {
    const p = await window.bridge.dialog.pickFolder()
    if (p) setSkFolder(p)
  }
  const submitSkill = async () => {
    setSkError('')
    setSkResult('')
    try {
      if (skMode === 'create') {
        if (!skName.trim()) return
        await window.bridge.skills.create({
          name: skName.trim(),
          description: skDesc.trim(),
          body: skBody,
          scope: skScope,
          projectPath: skPath(skScope),
        })
        resetSkForm()
        setSkAdding(false)
      } else if (skMode === 'folder') {
        if (!skFolder) return
        setSkPending(true)
        const r = await window.bridge.skills.importFolder({ sourcePath: skFolder, scope: skScope, projectPath: skPath(skScope) })
        setSkResult(summarizeImport(r))
        setSkFolder(null)
      } else {
        if (!skUrl.trim()) return
        setSkPending(true)
        const r = await window.bridge.skills.importGit({ url: skUrl.trim(), scope: skScope, projectPath: skPath(skScope) })
        setSkResult(summarizeImport(r))
        setSkUrl('')
      }
      await reload()
    } catch (e) {
      setSkError(e instanceof Error ? e.message : String(e))
    } finally {
      setSkPending(false)
    }
  }
  const startSkEdit = async (s: SkillInfo) => {
    const key = `${s.scope}:${s.name}`
    setSkDeleting(null)
    setSkEditError('')
    setSkEditDesc(s.description) // prérempli depuis la liste, puis complété par read()
    setSkEditBody('')
    setSkEditing(key)
    try {
      const d = await window.bridge.skills.read({ name: s.name, scope: s.scope, projectPath: skPath(s.scope) })
      setSkEditDesc(d.description)
      setSkEditBody(d.body)
    } catch (e) {
      setSkEditError(e instanceof Error ? e.message : String(e))
    }
  }
  const saveSkEdit = async (s: SkillInfo) => {
    setSkEditError('')
    try {
      await window.bridge.skills.update({
        ref: { name: s.name, scope: s.scope, projectPath: skPath(s.scope) },
        description: skEditDesc.trim(),
        body: skEditBody,
      })
      setSkEditing(null)
      await reload()
    } catch (e) {
      setSkEditError(e instanceof Error ? e.message : String(e))
    }
  }
  const deleteSkill = async (s: SkillInfo) => {
    setSkDeleteError('')
    try {
      await window.bridge.skills.delete({ name: s.name, scope: s.scope, projectPath: skPath(s.scope) })
      setSkDeleting(null)
      await reload()
    } catch (e) {
      setSkDeleteError(e instanceof Error ? e.message : String(e))
    }
  }

  const TABS: { id: Tab; label: string; icon: typeof SlidersHorizontal }[] = [
    { id: 'app', label: 'Application', icon: SlidersHorizontal },
    { id: 'mcp', label: 'MCP', icon: Plug },
    { id: 'skills', label: 'Skills', icon: Sparkles },
    { id: 'voice', label: 'Voice', icon: Mic },
    { id: 'calendar', label: 'Calendar', icon: CalendarDays },
    { id: 'browser', label: 'Browser', icon: Globe },
    { id: 'updates', label: 'Mises à jour', icon: Download },
  ]

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transitionFast}
          onMouseDown={onClose}
        >
          <motion.div
            role="dialog"
            aria-label="Réglages"
            className="flex h-[40rem] max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-2xl"
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={transitionFast}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
              <h2 className="text-[14px] font-semibold tracking-tight">Réglages</h2>
              <IconButton label="Fermer" size="sm" onClick={onClose}>
                <X size={16} />
              </IconButton>
            </div>

            <div className="flex min-h-0 flex-1">
              {/* Rail de catégories */}
              <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-border p-2">
                {TABS.map((t) => {
                  const Icon = t.icon
                  const active = tab === t.id
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      className={cn(
                        'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-fast',
                        active ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg',
                      )}
                    >
                      <Icon size={14} />
                      {t.label}
                    </button>
                  )
                })}
                {projectName && (tab === 'mcp' || tab === 'skills') && (
                  <span className="mt-auto truncate px-2.5 py-1 text-[10px] text-fg-subtle">{projectName}</span>
                )}
              </nav>

              {/* Contenu : Voice possède sa propre mise en page pleine hauteur (sous-rail + scroll). */}
              {tab === 'voice' ? (
                <VoiceSettings />
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  {tab === 'updates' ? (
                    <UpdatesSettings />
                  ) : tab === 'app' ? (
                    <div className="space-y-6">
                      <section>
                        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                          Thème
                        </h3>
                        <ThemePicker />
                      </section>
                      <section>
                        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                          Modèle des agents
                        </h3>
                        <div className="flex flex-wrap gap-1.5">
                          {MODELS.map((m) => {
                            const active = (appSettings.agentModel || 'opus') === m.v
                            return (
                              <button
                                key={m.v}
                                onClick={() => setModel(m.v)}
                                className={cn(
                                  'rounded-md border px-2.5 py-1 text-[12px] transition-colors duration-fast',
                                  active
                                    ? 'border-accent bg-accent-soft text-accent'
                                    : 'border-border text-fg-muted hover:text-fg',
                                )}
                              >
                                {m.label}
                              </button>
                            )
                          })}
                        </div>
                        <p className="mt-1.5 text-[11px] text-fg-subtle">
                          Appliqué au lancement de chaque agent (prochains terminaux).
                        </p>
                      </section>
                    </div>
                  ) : tab === 'mcp' ? (
                    <ConnectorsSection projectPath={projectPath} />
                  ) : tab === 'calendar' ? (
                    <CalendarSection />
                  ) : tab === 'browser' ? (
                    <BrowserSection />
                  ) : (
                      <section>
                        <div className="mb-2 flex items-center justify-between">
                          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                            <Sparkles size={12} /> Skills disponibles
                          </h3>
                          <button
                            onClick={toggleSkAdd}
                            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent"
                          >
                            <Plus size={12} /> Ajouter
                          </button>
                        </div>

                        {skills.length === 0 && !skAdding && (
                          <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-fg-subtle">
                            Aucun skill installé.
                          </p>
                        )}

                        <div className="space-y-1">
                          {skills.map((s) => {
                            // clé préfixée par le scope : un skill global et un skill projet peuvent porter le même nom.
                            const key = `${s.scope}:${s.name}`
                            const editing = skEditing === key
                            const deleting = skDeleting === key
                            return (
                              <div key={key} className="rounded-lg border border-border bg-bg-inset">
                                <div className="flex items-center gap-2 px-2.5 py-1.5">
                                  <span className="truncate text-[12px] font-medium text-fg">{s.name}</span>
                                  <span
                                    className={cn(
                                      'shrink-0 rounded px-1.5 py-px text-[9px] uppercase tracking-wide',
                                      s.scope === 'project' ? 'bg-accent text-on-accent' : 'bg-bg-panel text-fg-subtle',
                                    )}
                                  >
                                    {s.scope === 'project' ? 'projet' : 'global'}
                                  </span>
                                  {s.description && (
                                    <span className="truncate text-[10px] text-fg-subtle">{s.description}</span>
                                  )}
                                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                                    <button
                                      onClick={() => startSkEdit(s)}
                                      title="Éditer"
                                      className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-accent"
                                    >
                                      <Pencil size={12} />
                                    </button>
                                    <button
                                      onClick={() => {
                                        setSkDeleting(key)
                                        setSkEditing(null)
                                        setSkDeleteError('')
                                      }}
                                      title="Supprimer"
                                      className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-danger"
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                </div>

                                {/* Confirmation de suppression inline (deux temps). */}
                                {deleting && (
                                  <div className="border-t border-border px-2.5 py-1.5">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[11px] text-fg-muted">Supprimer ?</span>
                                      <div className="ml-auto flex gap-2">
                                        <button
                                          onClick={() => setSkDeleting(null)}
                                          className="rounded px-2 py-0.5 text-[11px] text-fg-subtle hover:text-fg"
                                        >
                                          Annuler
                                        </button>
                                        <button
                                          onClick={() => deleteSkill(s)}
                                          className="rounded-md bg-danger px-2 py-0.5 text-[11px] font-medium text-white transition hover:opacity-90"
                                        >
                                          Confirmer
                                        </button>
                                      </div>
                                    </div>
                                    {skDeleteError && <p className="mt-1 text-[11px] text-danger">{skDeleteError}</p>}
                                  </div>
                                )}

                                {/* Édition inline (description + corps préremplis depuis read()). */}
                                {editing && (
                                  <div className="space-y-2 border-t border-border px-2.5 py-2">
                                    <input
                                      value={skEditDesc}
                                      onChange={(e) => setSkEditDesc(e.target.value)}
                                      placeholder="Description"
                                      className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                                    />
                                    <textarea
                                      value={skEditBody}
                                      onChange={(e) => setSkEditBody(e.target.value)}
                                      placeholder="Corps (markdown)"
                                      rows={6}
                                      className="w-full resize-y rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                                    />
                                    {skEditError && <p className="text-[11px] text-danger">{skEditError}</p>}
                                    <div className="flex justify-end gap-2">
                                      <button
                                        onClick={() => setSkEditing(null)}
                                        className="rounded px-2 py-1 text-[11px] text-fg-subtle hover:text-fg"
                                      >
                                        Annuler
                                      </button>
                                      <button
                                        onClick={() => saveSkEdit(s)}
                                        className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover"
                                      >
                                        Enregistrer
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>

                        {/* Panneau d'ajout (3 modes). */}
                        {skAdding && (
                          <div className="mt-2 space-y-2 rounded-lg border border-border bg-bg-inset p-2.5">
                            <div className="flex gap-1">
                              {(
                                [
                                  { v: 'create', label: 'Créer' },
                                  { v: 'folder', label: 'Dossier' },
                                  { v: 'git', label: 'Git' },
                                ] as const
                              ).map((m) => (
                                <button
                                  key={m.v}
                                  onClick={() => {
                                    setSkMode(m.v)
                                    setSkError('')
                                    setSkResult('')
                                  }}
                                  className={cn(
                                    'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                                    skMode === m.v
                                      ? 'border-accent bg-accent-soft text-accent'
                                      : 'border-border text-fg-muted hover:text-fg',
                                  )}
                                >
                                  {m.label}
                                </button>
                              ))}
                            </div>

                            <select
                              value={skScope}
                              onChange={(e) => setSkScope(e.target.value as SkillScope)}
                              className="rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none"
                            >
                              <option value="user">Global</option>
                              <option value="project" disabled={!projectPath}>
                                Projet
                              </option>
                            </select>

                            {skMode === 'create' && (
                              <>
                                <input
                                  value={skName}
                                  onChange={(e) => setSkName(e.target.value)}
                                  placeholder="mon-skill (kebab-case)"
                                  className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                                />
                                <input
                                  value={skDesc}
                                  onChange={(e) => setSkDesc(e.target.value)}
                                  placeholder="Description"
                                  className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                                />
                                <textarea
                                  value={skBody}
                                  onChange={(e) => setSkBody(e.target.value)}
                                  placeholder="Corps (markdown)"
                                  rows={6}
                                  className="w-full resize-y rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                                />
                              </>
                            )}

                            {skMode === 'folder' && (
                              <div className="space-y-1">
                                <button
                                  onClick={pickSkFolder}
                                  className="rounded-md border border-border px-2 py-1 text-[11px] text-fg-muted transition-colors hover:text-fg"
                                >
                                  Choisir un dossier…
                                </button>
                                {skFolder && <p className="truncate text-[11px] text-fg-subtle">{skFolder}</p>}
                              </div>
                            )}

                            {skMode === 'git' && (
                              <input
                                value={skUrl}
                                onChange={(e) => setSkUrl(e.target.value)}
                                placeholder="https://github.com/user/repo"
                                className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                              />
                            )}

                            {skError && <p className="text-[11px] text-danger">{skError}</p>}
                            {skResult && <p className="text-[11px] text-fg-subtle">{skResult}</p>}

                            <div className="flex justify-end gap-2">
                              <button
                                onClick={toggleSkAdd}
                                className="rounded px-2 py-1 text-[11px] text-fg-subtle hover:text-fg"
                              >
                                Annuler
                              </button>
                              <button
                                onClick={submitSkill}
                                disabled={
                                  skPending ||
                                  (skMode === 'create' && !skName.trim()) ||
                                  (skMode === 'folder' && !skFolder) ||
                                  (skMode === 'git' && !skUrl.trim())
                                }
                                className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover disabled:opacity-40"
                              >
                                {skPending
                                  ? skMode === 'git'
                                    ? 'Clonage…'
                                    : 'Import…'
                                  : skMode === 'create'
                                    ? 'Créer'
                                    : 'Importer'}
                              </button>
                            </div>
                          </div>
                        )}
                      </section>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
