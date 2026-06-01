import { useEffect, useState } from 'react'
import { Plug, Plus, Trash2, Pencil, Download, Check, X, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/cn'
import type {
  McpConnector,
  McpScope,
  McpTransport,
  McpConnectorInput,
  McpConnectorUpdate,
  McpCatalogEntry,
  McpImportCandidate,
  McpTestResult,
} from '@shared/types'

// Wizard de connecteurs MCP : ajout (manuel / catalogue / import depuis configs existantes), édition inline
// (secrets re-déchiffrés à la volée), test de connexion avant enregistrement, suppression en deux temps.
// Tout passe par window.bridge.settings.* ; les valeurs de secrets ne transitent que via connectorSecrets.

type KV = { key: string; value: string }
type AddMode = 'manual' | 'catalog' | 'import'

interface Form {
  name: string
  scope: McpScope
  transport: McpTransport
  command: string
  args: string // séparés par espace ; parsés en tableau à l'envoi
  url: string
  env: KV[]
  headers: KV[]
  catalogId?: string
}

const emptyForm = (): Form => ({
  name: '',
  scope: 'app',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: [],
  headers: [],
})

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// KV[] -> Record en ignorant les clés vides ; sert d'env (stdio) ou de headers (http/sse).
const kvRecord = (kv: KV[]): Record<string, string> => {
  const o: Record<string, string> = {}
  for (const { key, value } of kv) if (key.trim()) o[key.trim()] = value
  return o
}
const recordKv = (r: Record<string, string>): KV[] =>
  Object.entries(r).map(([key, value]) => ({ key, value }))

// Couleur de la pastille de statut d'un connecteur selon sa dernière sonde.
const statusDot = (p?: { loading?: boolean; result?: McpTestResult }): string =>
  p?.loading ? 'animate-pulse bg-amber-400' : p?.result ? (p.result.ok ? 'bg-green-500' : 'bg-danger') : 'bg-fg-subtle/40'

// args stockés en JSON ; tolère absence/malformation sans planter l'édition.
const parseArgs = (args: string | null): string => {
  if (!args) return ''
  try {
    const a = JSON.parse(args)
    return Array.isArray(a) ? a.join(' ') : ''
  } catch {
    return ''
  }
}

export function ConnectorsSection({ projectPath }: { projectPath: string | null }) {
  const [connectors, setConnectors] = useState<McpConnector[]>([])

  // Panneau d'ajout (3 modes) vs édition inline (editingId) : mutuellement exclusifs.
  const [addOpen, setAddOpen] = useState(false)
  const [mode, setMode] = useState<AddMode>('manual')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<Form>(emptyForm())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  // Révélation par champ secret (env/headers) : masqués (password) par défaut, œil pour afficher.
  const [showVals, setShowVals] = useState<Record<string, boolean>>({})

  // Sonde par connecteur (statut live + outils exposés + debug) : par id.
  const [probes, setProbes] = useState<Record<string, { loading?: boolean; result?: McpTestResult }>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  // Test de connexion (handshake initialize + tools/list) AVANT enregistrement.
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<McpTestResult | null>(null)

  // Suppression en deux temps (pas de window.confirm natif).
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')

  // Catalogue plug-and-play (chargé à la 1re ouverture du mode).
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')

  // Import depuis les configs MCP existantes (~/.claude.json, Claude Desktop, .mcp.json).
  const [candidates, setCandidates] = useState<McpImportCandidate[] | null>(null)
  const [selected, setSelected] = useState<boolean[]>([])
  const [importScope, setImportScope] = useState<McpScope>('app')
  const [detecting, setDetecting] = useState(false)
  const [importError, setImportError] = useState('')
  const [importSummary, setImportSummary] = useState('')

  const load = async () => {
    setConnectors(await window.bridge.settings.listConnectors(projectPath))
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))
  const setKv = (which: 'env' | 'headers', next: KV[]) => setForm((f) => ({ ...f, [which]: next }))

  const resetForm = () => {
    setAddOpen(false)
    setEditingId(null)
    setMode('manual')
    setForm(emptyForm())
    setError('')
    setTest(null)
    setCandidates(null)
    setImportSummary('')
    setImportError('')
  }

  const openAdd = () => {
    if (addOpen) {
      resetForm()
      return
    }
    resetForm()
    setAddOpen(true)
  }

  const startEdit = async (c: McpConnector) => {
    setDeletingId(null)
    setExpanded(null)
    setAddOpen(false)
    setError('')
    setTest(null)
    setEditingId(c.id)
    setForm({
      name: c.name,
      scope: c.scope,
      transport: c.transport,
      command: c.command ?? '',
      args: parseArgs(c.args),
      url: c.url ?? '',
      env: [],
      headers: [],
      catalogId: c.catalog_id ?? undefined,
    })
    // Secrets re-déchiffrés à la demande pour préremplir (jamais renvoyés par la liste).
    if (c.hasEnv || c.hasHeaders) {
      try {
        const s = await window.bridge.settings.connectorSecrets(c.id)
        setForm((f) => ({ ...f, env: recordKv(s.env), headers: recordKv(s.headers) }))
      } catch (e) {
        setError('Secrets indisponibles : ' + msg(e))
      }
    }
  }

  // McpConnectorInput pour addConnector ET testConnector : env (stdio) / headers (http|sse) selon le transport.
  const buildInput = (): McpConnectorInput => {
    const stdio = form.transport === 'stdio'
    const env = stdio ? kvRecord(form.env) : {}
    const headers = !stdio ? kvRecord(form.headers) : {}
    return {
      name: form.name.trim(),
      scope: form.scope,
      projectPath: form.scope === 'project' ? projectPath : null,
      transport: form.transport,
      command: stdio ? form.command.trim() || undefined : undefined,
      args: stdio && form.args.trim() ? form.args.split(/\s+/) : undefined,
      url: !stdio ? form.url.trim() || undefined : undefined,
      env: Object.keys(env).length ? env : undefined,
      headers: Object.keys(headers).length ? headers : undefined,
      catalogId: form.catalogId,
    }
  }

  // McpConnectorUpdate : null = vider (ex. champs inapplicables après changement de transport).
  const buildUpdate = (id: string): McpConnectorUpdate => {
    const stdio = form.transport === 'stdio'
    const env = stdio ? kvRecord(form.env) : {}
    const headers = !stdio ? kvRecord(form.headers) : {}
    return {
      id,
      name: form.name.trim(),
      transport: form.transport,
      command: stdio ? form.command.trim() || null : null,
      args: stdio ? (form.args.trim() ? form.args.split(/\s+/) : null) : null,
      url: !stdio ? form.url.trim() || null : null,
      env: stdio ? (Object.keys(env).length ? env : null) : null,
      headers: !stdio ? (Object.keys(headers).length ? headers : null) : null,
    }
  }

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    setError('')
    try {
      setTest(await window.bridge.settings.testConnector(buildInput()))
    } catch (e) {
      setTest({ ok: false, error: msg(e) })
    } finally {
      setTesting(false)
    }
  }

  const submit = async () => {
    if (!form.name.trim()) return
    setPending(true)
    setError('')
    try {
      if (editingId) await window.bridge.settings.updateConnector(buildUpdate(editingId))
      else await window.bridge.settings.addConnector(buildInput())
      resetForm()
      await load()
    } catch (e) {
      setError(msg(e))
    } finally {
      setPending(false)
    }
  }

  const toggle = async (c: McpConnector) => {
    await window.bridge.settings.toggleConnector(c.id, !c.enabled)
    await load()
  }
  const confirmDelete = async (id: string) => {
    setDeleteError('')
    try {
      await window.bridge.settings.deleteConnector(id)
      setDeletingId(null)
      await load()
    } catch (e) {
      setDeleteError(msg(e))
    }
  }

  // Sonde un connecteur enregistré (handshake MCP read-only) → statut + outils. Le serveur est lancé
  // transitoirement pour le test (comme à l'usage réel), pas de connexion persistante.
  const checkOne = async (id: string) => {
    setProbes((p) => ({ ...p, [id]: { loading: true } }))
    try {
      const result = await window.bridge.settings.probeConnector(id)
      setProbes((p) => ({ ...p, [id]: { result } }))
    } catch (e) {
      setProbes((p) => ({ ...p, [id]: { result: { ok: false, error: msg(e) } } }))
    }
  }
  // Séquentiel : évite de spawner tous les serveurs MCP d'un coup.
  const checkAll = async () => {
    for (const c of connectors) await checkOne(c.id)
  }
  const toggleExpand = (id: string) => {
    setEditingId(null)
    setDeletingId(null)
    setExpanded((cur) => (cur === id ? null : id))
    if (!probes[id]) void checkOne(id) // 1re ouverture → sonde
  }

  const openCatalog = async () => {
    setMode('catalog')
    set({ catalogId: undefined })
    if (catalog.length > 0 || catalogLoading) return
    setCatalogLoading(true)
    setCatalogError('')
    try {
      setCatalog(await window.bridge.settings.listMcpCatalog())
    } catch (e) {
      setCatalogError(msg(e))
    } finally {
      setCatalogLoading(false)
    }
  }
  const pickCatalog = (entry: McpCatalogEntry) => {
    setError('')
    setTest(null)
    setForm({
      name: entry.name,
      scope: form.scope,
      transport: entry.transport,
      command: entry.command ?? '',
      args: entry.args ? entry.args.join(' ') : '',
      url: entry.url ?? '',
      env: (entry.envFields ?? []).map((f) => ({ key: f.key, value: '' })),
      headers: (entry.headerFields ?? []).map((f) => ({ key: f.key, value: '' })),
      catalogId: entry.id,
    })
  }

  const detect = async () => {
    setDetecting(true)
    setImportError('')
    setImportSummary('')
    try {
      const c = await window.bridge.settings.importMcpCandidates()
      setCandidates(c)
      setSelected(c.map(() => true))
    } catch (e) {
      setImportError(msg(e))
    } finally {
      setDetecting(false)
    }
  }
  const runImport = async () => {
    if (!candidates) return
    const chosen = candidates.filter((_, i) => selected[i])
    if (chosen.length === 0) return
    setPending(true)
    setImportError('')
    try {
      const r = await window.bridge.settings.importConnectors(
        chosen,
        importScope,
        importScope === 'project' ? projectPath : null,
      )
      setImportSummary(
        `${r.installed.length} importé(s)` + (r.skipped.length ? `, ${r.skipped.length} ignoré(s)` : ''),
      )
      setCandidates(null)
      await load()
    } catch (e) {
      setImportError(msg(e))
    } finally {
      setPending(false)
    }
  }

  const kvEditor = (which: 'env' | 'headers', label: string) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</span>
        <button
          onClick={() => setKv(which, [...form[which], { key: '', value: '' }])}
          className="flex items-center gap-1 rounded px-1 text-[10px] text-fg-subtle transition-colors hover:text-accent"
        >
          <Plus size={10} /> Ajouter
        </button>
      </div>
      {form[which].map((row, i) => (
        <div key={i} className="flex gap-1">
          <input
            value={row.key}
            onChange={(e) => setKv(which, form[which].map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
            placeholder="CLÉ"
            className="w-1/3 rounded-md border border-border bg-bg-panel px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
          />
          <input
            value={row.value}
            onChange={(e) => setKv(which, form[which].map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
            placeholder="valeur"
            type={showVals[`${which}-${i}`] ? 'text' : 'password'}
            className="flex-1 rounded-md border border-border bg-bg-panel px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
          />
          <button
            onClick={() => setShowVals((s) => ({ ...s, [`${which}-${i}`]: !s[`${which}-${i}`] }))}
            title={showVals[`${which}-${i}`] ? 'Masquer' : 'Afficher'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:text-fg"
          >
            {showVals[`${which}-${i}`] ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
          <button
            onClick={() => setKv(which, form[which].filter((_, j) => j !== i))}
            title="Retirer"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:text-danger"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  )

  // Formulaire partagé add/édition/catalogue. showScope=false en édition (le scope d'un connecteur est figé).
  const renderForm = (showScope: boolean) => {
    const stdio = form.transport === 'stdio'
    return (
      <div className="space-y-2">
        <input
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Nom (ex. github, supabase)"
          className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
        />
        <div className="flex gap-2">
          {showScope && (
            <select
              value={form.scope}
              onChange={(e) => set({ scope: e.target.value as McpScope })}
              className="rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none"
            >
              <option value="app">App (toujours)</option>
              <option value="project" disabled={!projectPath}>
                Projet
              </option>
            </select>
          )}
          <select
            value={form.transport}
            onChange={(e) => set({ transport: e.target.value as McpTransport })}
            className="rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none"
          >
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
        </div>
        {stdio ? (
          <>
            <div className="flex gap-2">
              <input
                value={form.command}
                onChange={(e) => set({ command: e.target.value })}
                placeholder="commande (ex. npx)"
                className="w-1/3 rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
              />
              <input
                value={form.args}
                onChange={(e) => set({ args: e.target.value })}
                placeholder="arguments (séparés par espace)"
                className="flex-1 rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
              />
            </div>
            {kvEditor('env', "Variables d'environnement")}
          </>
        ) : (
          <>
            <input
              value={form.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://… (endpoint MCP)"
              className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
            />
            {kvEditor('headers', 'En-têtes HTTP')}
          </>
        )}

        {test && (
          <p className={cn('flex items-center gap-1 text-[11px]', test.ok ? 'text-accent' : 'text-danger')}>
            {test.ok ? <Check size={12} /> : <X size={12} />}
            {test.ok
              ? `Connexion OK${typeof test.toolCount === 'number' ? ` — ${test.toolCount} outil(s)` : ''}`
              : `Échec : ${test.error ?? 'inconnu'}`}
          </p>
        )}
        {error && <p className="text-[11px] text-danger">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={runTest}
            disabled={testing || !form.name.trim()}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
          >
            {testing ? 'Test…' : 'Tester'}
          </button>
          <button onClick={resetForm} className="rounded px-2 py-1 text-[11px] text-fg-subtle hover:text-fg">
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={pending || !form.name.trim()}
            className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover disabled:opacity-40"
          >
            {pending ? '…' : editingId ? 'Enregistrer' : form.catalogId ? 'Installer' : 'Ajouter'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          <Plug size={12} /> Connecteurs MCP
        </h3>
        <div className="flex items-center gap-1">
          {connectors.length > 0 && (
            <button
              onClick={() => void checkAll()}
              title="Vérifier la connexion de tous les connecteurs"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent"
            >
              <RefreshCw size={12} /> Tout vérifier
            </button>
          )}
          <button
            onClick={openAdd}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent"
          >
            <Plus size={12} /> Ajouter
          </button>
        </div>
      </div>

      {connectors.length === 0 && !addOpen && (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-fg-subtle">
          Aucun connecteur. « App » = toujours actif ; « Projet » = ce projet seulement.
        </p>
      )}

      <div className="space-y-1">
        {connectors.map((c) => {
          const editing = editingId === c.id
          const deleting = deletingId === c.id
          return (
            <div key={c.id} className="rounded-lg border border-border bg-bg-inset">
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <button
                  onClick={() => toggle(c)}
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
                  {c.scope === 'app' ? 'global' : 'projet'}
                </span>
                <span className="truncate text-[10px] text-fg-subtle">
                  {c.transport === 'stdio' ? `${c.command ?? ''} ${parseArgs(c.args)}`.trim() : c.url}
                </span>
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <button
                    onClick={() => toggleExpand(c.id)}
                    title="Vérifier la connexion / voir les outils"
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                  >
                    <span className={cn('h-2 w-2 rounded-full', statusDot(probes[c.id]))} />
                  </button>
                  <button
                    onClick={() => startEdit(c)}
                    title="Éditer"
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-accent"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => {
                      setDeletingId(c.id)
                      setEditingId(null)
                      setExpanded(null)
                      setDeleteError('')
                    }}
                    title="Supprimer"
                    className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-danger"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {expanded === c.id &&
                (() => {
                  const pr = probes[c.id]
                  return (
                    <div className="space-y-1 border-t border-border px-2.5 py-2 text-[11px]">
                      {pr?.loading && <p className="text-fg-subtle">Vérification… (handshake MCP)</p>}
                      {pr?.result?.ok && (
                        <>
                          <p className="flex items-center gap-1 text-accent">
                            <Check size={12} /> Connecté — {pr.result.toolCount ?? 0} outil(s)
                          </p>
                          {(pr.result.tools ?? []).map((t) => (
                            <div key={t.name} className="rounded bg-bg-panel px-1.5 py-1">
                              <span className="font-mono text-[10px] text-fg">{t.name}</span>
                              {t.description && <span className="ml-1 text-fg-subtle">— {t.description}</span>}
                            </div>
                          ))}
                          {(pr.result.tools ?? []).length === 0 && <p className="text-fg-subtle">(aucun outil exposé)</p>}
                        </>
                      )}
                      {pr?.result && !pr.result.ok && (
                        <>
                          <p className="flex items-center gap-1 text-danger">
                            <X size={12} /> Échec de connexion
                          </p>
                          <p className="break-words text-danger">{pr.result.error}</p>
                          <p className="break-all text-fg-subtle">
                            Config : {c.transport === 'stdio' ? `${c.command ?? ''} ${parseArgs(c.args)}`.trim() : c.url}
                            {(c.hasEnv || c.hasHeaders) && ' · secrets masqués'}
                          </p>
                        </>
                      )}
                      <button
                        onClick={() => void checkOne(c.id)}
                        className="flex items-center gap-1 text-fg-subtle transition-colors hover:text-accent"
                      >
                        <RefreshCw size={10} /> Re-vérifier
                      </button>
                    </div>
                  )
                })()}

              {deleting && (
                <div className="border-t border-border px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-fg-muted">Supprimer ?</span>
                    <div className="ml-auto flex gap-2">
                      <button
                        onClick={() => setDeletingId(null)}
                        className="rounded px-2 py-0.5 text-[11px] text-fg-subtle hover:text-fg"
                      >
                        Annuler
                      </button>
                      <button
                        onClick={() => confirmDelete(c.id)}
                        className="rounded-md bg-danger px-2 py-0.5 text-[11px] font-medium text-white transition hover:opacity-90"
                      >
                        Confirmer
                      </button>
                    </div>
                  </div>
                  {deleteError && <p className="mt-1 text-[11px] text-danger">{deleteError}</p>}
                </div>
              )}

              {editing && <div className="border-t border-border px-2.5 py-2">{renderForm(false)}</div>}
            </div>
          )
        })}
      </div>

      {/* Panneau d'ajout : 3 modes (manuel / catalogue / import). */}
      {addOpen && (
        <div className="mt-2 space-y-2 rounded-lg border border-border bg-bg-inset p-2.5">
          <div className="flex gap-1">
            {(
              [
                { v: 'manual', label: 'Manuel' },
                { v: 'catalog', label: 'Catalogue' },
                { v: 'import', label: 'Importer' },
              ] as const
            ).map((m) => (
              <button
                key={m.v}
                onClick={() => {
                  setError('')
                  setTest(null)
                  if (m.v === 'catalog') void openCatalog()
                  else setMode(m.v)
                }}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                  mode === m.v
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border text-fg-muted hover:text-fg',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'manual' && renderForm(true)}

          {mode === 'catalog' &&
            (form.catalogId ? (
              <div className="space-y-2">
                <button
                  onClick={() => set({ catalogId: undefined })}
                  className="text-[11px] text-fg-subtle transition-colors hover:text-fg"
                >
                  ← Catalogue
                </button>
                {renderForm(true)}
              </div>
            ) : (
              <div className="space-y-1">
                {catalogLoading && <p className="text-[11px] text-fg-subtle">Chargement…</p>}
                {catalogError && <p className="text-[11px] text-danger">{catalogError}</p>}
                {!catalogLoading && !catalogError && catalog.length === 0 && (
                  <p className="text-[11px] text-fg-subtle">Catalogue vide.</p>
                )}
                {catalog.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => pickCatalog(entry)}
                    className="flex w-full flex-col items-start gap-0.5 rounded-md border border-border bg-bg-panel px-2 py-1.5 text-left transition-colors hover:border-accent"
                  >
                    <span className="text-[12px] font-medium text-fg">{entry.name}</span>
                    {entry.description && (
                      <span className="truncate text-[10px] text-fg-subtle">{entry.description}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}

          {mode === 'import' && (
            <div className="space-y-2">
              {!candidates && (
                <button
                  onClick={detect}
                  disabled={detecting}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
                >
                  <Download size={12} /> {detecting ? 'Détection…' : 'Détecter les connecteurs existants'}
                </button>
              )}
              {importError && <p className="text-[11px] text-danger">{importError}</p>}
              {importSummary && <p className="text-[11px] text-fg-subtle">{importSummary}</p>}
              {candidates && candidates.length === 0 && (
                <p className="text-[11px] text-fg-subtle">Aucun connecteur importable détecté.</p>
              )}
              {candidates && candidates.length > 0 && (
                <>
                  <div className="space-y-1">
                    {candidates.map((cand, i) => (
                      <label
                        key={`${cand.source}:${cand.name}:${i}`}
                        className="flex items-center gap-2 rounded-md border border-border bg-bg-panel px-2 py-1.5"
                      >
                        <input
                          type="checkbox"
                          checked={selected[i] ?? false}
                          onChange={(e) => setSelected(selected.map((s, j) => (j === i ? e.target.checked : s)))}
                        />
                        <span className="truncate text-[12px] font-medium text-fg">{cand.name}</span>
                        <span className="shrink-0 rounded bg-bg-elevated px-1.5 py-px text-[9px] uppercase tracking-wide text-fg-subtle">
                          {cand.transport}
                        </span>
                        <span className="ml-auto truncate text-[10px] text-fg-subtle">{cand.source}</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <select
                      value={importScope}
                      onChange={(e) => setImportScope(e.target.value as McpScope)}
                      className="rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none"
                    >
                      <option value="app">App (toujours)</option>
                      <option value="project" disabled={!projectPath}>
                        Projet
                      </option>
                    </select>
                    <button
                      onClick={runImport}
                      disabled={pending || selected.every((s) => !s)}
                      className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover disabled:opacity-40"
                    >
                      {pending ? 'Import…' : `Importer (${selected.filter(Boolean).length})`}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Fermer global pour catalogue (liste) / import ; le mode manuel a son propre Annuler. */}
          {(mode === 'import' || (mode === 'catalog' && !form.catalogId)) && (
            <div className="flex justify-end">
              <button onClick={resetForm} className="rounded px-2 py-1 text-[11px] text-fg-subtle hover:text-fg">
                Fermer
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
