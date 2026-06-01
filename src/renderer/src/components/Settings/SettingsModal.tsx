import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { X, Plug, Sparkles, SlidersHorizontal, Trash2, Plus, Boxes, Mic, Download } from 'lucide-react'
import { IconButton } from '../ui/IconButton'
import { cn } from '../../lib/cn'
import { transitionFast } from '../../lib/motion'
import { VoiceSettings } from './Voice/VoiceSettings'
import { UpdatesSettings } from './UpdatesSettings'
import { ThemePicker } from '../Theme/ThemePicker'
import type { McpConnector, McpScope, McpTransport, SkillInfo } from '@shared/types'

// Tous les agents (orchestrateur + workers) sont CLAMPÉS sur Opus au spawn (enforceAgentSpawn) : un modèle
// faible est non-exprimable. Le contrôle reste pour rendre la politique « toujours le plus puissant » explicite.
const MODELS = [{ v: 'opus', label: 'Opus (max) — imposé à tous les agents' }]

type Tab = 'app' | 'project' | 'voice' | 'updates'

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
  const [connectors, setConnectors] = useState<McpConnector[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])

  // Formulaire d'ajout de connecteur.
  const [adding, setAdding] = useState(false)
  const [fName, setFName] = useState('')
  const [fScope, setFScope] = useState<McpScope>('app')
  const [fTransport, setFTransport] = useState<McpTransport>('stdio')
  const [fCommand, setFCommand] = useState('')
  const [fArgs, setFArgs] = useState('')
  const [fUrl, setFUrl] = useState('')

  const reload = async () => {
    setAppSettings(await window.bridge.settings.getApp())
    setConnectors(await window.bridge.settings.listConnectors(projectPath))
    setSkills(await window.bridge.settings.listSkills(projectPath))
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
  const toggleConnector = async (c: McpConnector) => {
    await window.bridge.settings.toggleConnector(c.id, !c.enabled)
    await reload()
  }
  const deleteConnector = async (id: string) => {
    await window.bridge.settings.deleteConnector(id)
    await reload()
  }
  const submitConnector = async () => {
    if (!fName.trim()) return
    await window.bridge.settings.addConnector({
      name: fName.trim(),
      scope: fScope,
      projectPath: fScope === 'project' ? projectPath : null,
      transport: fTransport,
      command: fTransport === 'stdio' ? fCommand.trim() : undefined,
      args: fTransport === 'stdio' && fArgs.trim() ? fArgs.split(/\s+/) : undefined,
      url: fTransport === 'http' ? fUrl.trim() : undefined,
    })
    setFName('')
    setFCommand('')
    setFArgs('')
    setFUrl('')
    setAdding(false)
    await reload()
  }

  const TABS: { id: Tab; label: string; icon: typeof Plug }[] = [
    { id: 'app', label: 'Application', icon: SlidersHorizontal },
    { id: 'project', label: 'Projet', icon: Boxes },
    { id: 'voice', label: 'Voice', icon: Mic },
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
                {projectName && tab === 'project' && (
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
                  ) : (
                    <div className="space-y-6">
                      {/* Connecteurs MCP */}
                      <section>
                        <div className="mb-2 flex items-center justify-between">
                          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                            <Plug size={12} /> Connecteurs MCP
                          </h3>
                          <button
                            onClick={() => setAdding((a) => !a)}
                            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent"
                          >
                            <Plus size={12} /> Ajouter
                          </button>
                        </div>

                        {connectors.length === 0 && !adding && (
                          <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-fg-subtle">
                            Aucun connecteur. « App » = toujours actif ; « Projet » = ce projet seulement.
                          </p>
                        )}

                        <div className="space-y-1">
                          {connectors.map((c) => (
                            <div key={c.id} className="flex items-center gap-2 rounded-lg border border-border bg-bg-inset px-2.5 py-1.5">
                              <button
                                onClick={() => toggleConnector(c)}
                                title={c.enabled ? 'Activé' : 'Désactivé'}
                                className={cn(
                                  'h-3.5 w-6 shrink-0 rounded-full p-0.5 transition-colors',
                                  c.enabled ? 'bg-accent' : 'bg-bg-elevated',
                                )}
                              >
                                <span
                                  className={cn(
                                    'block h-2.5 w-2.5 rounded-full bg-white transition-transform',
                                    c.enabled ? 'translate-x-2.5' : '',
                                  )}
                                />
                              </button>
                              <span className="truncate text-[12px] font-medium text-fg">{c.name}</span>
                              <span
                                className={cn(
                                  'shrink-0 rounded px-1.5 py-px text-[9px] uppercase tracking-wide',
                                  c.scope === 'app' ? 'bg-accent-soft text-accent' : 'bg-[#7aa2f7]/15 text-[#7aa2f7]',
                                )}
                              >
                                {c.scope}
                              </span>
                              <span className="truncate text-[10px] text-fg-subtle">
                                {c.transport === 'http' ? c.url : `${c.command ?? ''} ${c.args ? JSON.parse(c.args).join(' ') : ''}`}
                              </span>
                              <button
                                onClick={() => deleteConnector(c.id)}
                                title="Supprimer"
                                className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-danger"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ))}
                        </div>

                        {adding && (
                          <div className="mt-2 space-y-2 rounded-lg border border-border bg-bg-inset p-2.5">
                            <input
                              value={fName}
                              onChange={(e) => setFName(e.target.value)}
                              placeholder="Nom (ex. github, supabase)"
                              className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                            />
                            <div className="flex gap-2">
                              <select
                                value={fScope}
                                onChange={(e) => setFScope(e.target.value as McpScope)}
                                className="rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none"
                              >
                                <option value="app">App (toujours)</option>
                                <option value="project" disabled={!projectPath}>
                                  Projet
                                </option>
                              </select>
                              <select
                                value={fTransport}
                                onChange={(e) => setFTransport(e.target.value as McpTransport)}
                                className="rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none"
                              >
                                <option value="stdio">stdio</option>
                                <option value="http">http</option>
                              </select>
                            </div>
                            {fTransport === 'stdio' ? (
                              <div className="flex gap-2">
                                <input
                                  value={fCommand}
                                  onChange={(e) => setFCommand(e.target.value)}
                                  placeholder="commande (ex. npx)"
                                  className="w-1/3 rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                                />
                                <input
                                  value={fArgs}
                                  onChange={(e) => setFArgs(e.target.value)}
                                  placeholder="arguments (séparés par espace)"
                                  className="flex-1 rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                                />
                              </div>
                            ) : (
                              <input
                                value={fUrl}
                                onChange={(e) => setFUrl(e.target.value)}
                                placeholder="https://… (endpoint MCP http)"
                                className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                              />
                            )}
                            <div className="flex justify-end gap-2">
                              <button onClick={() => setAdding(false)} className="rounded px-2 py-1 text-[11px] text-fg-subtle hover:text-fg">
                                Annuler
                              </button>
                              <button
                                onClick={submitConnector}
                                disabled={!fName.trim()}
                                className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover disabled:opacity-40"
                              >
                                Ajouter
                              </button>
                            </div>
                          </div>
                        )}
                      </section>

                      {/* Skills (lecture seule) */}
                      <section>
                        <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                          <Sparkles size={12} /> Skills disponibles
                        </h3>
                        {skills.length === 0 ? (
                          <p className="text-[11px] text-fg-subtle">Aucun skill installé.</p>
                        ) : (
                          <div className="space-y-1">
                            {skills.map((s) => (
                              // clé préfixée par le scope : un skill global et un skill projet peuvent porter le même nom.
                              <div key={`${s.scope}:${s.name}`} className="rounded-lg border border-border bg-bg-inset px-2.5 py-1.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-[12px] font-medium text-fg">{s.name}</span>
                                  <span
                                    className={cn(
                                      'shrink-0 rounded px-1.5 py-px text-[9px] uppercase tracking-wide',
                                      s.scope === 'project' ? 'bg-accent text-on-accent' : 'bg-bg-panel text-fg-subtle',
                                    )}
                                  >
                                    {s.scope === 'project' ? 'projet' : 'global'}
                                  </span>
                                </div>
                                {s.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-fg-subtle">{s.description}</p>}
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="mt-2 text-[11px] text-fg-subtle">Templates de projet (boilerplate) — bientôt.</p>
                      </section>
                    </div>
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
