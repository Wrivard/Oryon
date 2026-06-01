// Source unique de vérité pour les types partagés main <-> preload <-> renderer.

export interface Workspace {
  id: string
  name: string
  project_path: string
  color: string | null
  layout: string
  created_at: number | null
  last_opened: number | null
  /** Commande de dev pour le panneau Browser (défaut "npm run dev"). Migration 002. */
  dev_command: string | null
}

/** Noeud d'arbre de fichiers (children chargés à la demande). */
export interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
}

export interface FileContent {
  content: string
  language: string
  /** mtime (ms) + taille au moment de la lecture — base d'une écriture optimiste (détection de divergence). */
  mtimeMs: number
  size: number
}

/** Résultat d'une écriture éditeur : ok, ou divergence (le fichier a changé sur disque depuis l'ouverture). */
export type WriteFileResult =
  | { ok: true; mtimeMs: number; size: number }
  | { ok: false; reason: 'diverged'; mtimeMs: number; size: number }

export interface FsEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
}

export interface DevServerResult {
  port: number | null
  running: boolean
}

// ---- Orchestrateur (Phase 3) ----

export type AgentRole = 'builder' | 'reviewer' | 'scout' | 'coordinator'
export type TaskStatus = 'proposed' | 'todo' | 'in-progress' | 'in-review' | 'complete' | 'cancelled' | 'blocked'

/** Mode de soumission de l'orchestrateur : Direct (local), AI (LLM + routage), Plan (propose, à approuver). */
export type SubmitMode = 'direct' | 'ai' | 'plan'

/** Ligne de la table `tasks` (colonnes title/role/workspace_id/depends_on ajoutées en migration 003). */
export interface Task {
  id: string
  project_id: string
  workspace_id: string | null
  title: string | null
  role: string | null
  instructions: string
  knowledge: string | null
  depends_on: string | null // JSON array d'ids de tasks
  status: TaskStatus
  assigned_terminal_id: string | null
  created_at: number | null
  updated_at: number | null
}

/** Tâche produite par le decomposer (avant persistance ; dependsOn = index dans le plan). */
export interface PlanTask {
  title: string
  instructions: string
  role: 'builder' | 'scout'
  dependsOn: number[]
}

/** Résultat de l'étage de compréhension d'intention (router AVANT décomposition). */
export interface IntentResult {
  restatement: string
  intent: 'code' | 'broadcast' | 'question'
  broadcastPrompt: string
}

// ---- Source (diffs / git / versions) ----
export type SourceFileStatus = 'M' | 'A' | 'D' | 'R' | '?'
export interface SourceFileChange {
  path: string // relatif à la racine du projet (séparateurs '/')
  oldPath?: string // chemin source pour un renommage (status 'R')
  status: SourceFileStatus
  additions: number
  deletions: number
  staged: boolean
}
export interface SourceStatus {
  isGit: boolean
  files: SourceFileChange[]
}
export interface SourceDiff {
  path: string
  original: string // contenu à HEAD (vide si nouveau)
  modified: string // contenu courant du working tree (vide si supprimé)
  language: string
  status: SourceFileStatus
}
export interface GitCommit {
  hash: string
  shortHash: string
  author: string
  date: string
  subject: string
}
/** Branche/worktree d'un agent (vue Source quand les éditions sont committées par agent, pas dans MAIN). */
export interface AgentBranch {
  agent: string
  branch: string
  path: string
  /** Nb de commits d'avance sur HEAD du tronc principal (≥1 = intégrable). */
  ahead: number
}
/** Résultat d'une intégration (merge-back) d'une branche d'agent dans le tronc principal. */
export interface MergeResult {
  ok: boolean
  message: string
}

// ---- Settings (app-global + project) ----
export type McpScope = 'app' | 'project'
export type McpTransport = 'stdio' | 'http' | 'sse'
export interface McpConnector {
  id: string
  name: string
  scope: McpScope
  project_id: string | null
  transport: McpTransport
  command: string | null
  args: string | null // JSON array (stdio)
  url: string | null // http/sse
  enabled: boolean
  created_at: number | null
  catalog_id?: string | null // id d'entrée du catalogue si installé via le wizard
  hasEnv?: boolean // présence de variables d'env (les VALEURS ne sont jamais renvoyées par la liste ; cf. connectorSecrets)
  hasHeaders?: boolean // présence d'en-têtes http/sse (idem, secrets non exposés en liste)
}
export interface McpConnectorInput {
  name: string
  scope: McpScope
  projectPath?: string | null // résolu en project_id côté main (scope 'project')
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string> // stdio : variables d'env (chiffrées au repos via safeStorage)
  headers?: Record<string, string> // http/sse : en-têtes (ex. Authorization), chiffrés au repos
  catalogId?: string
}
/** Édition d'un connecteur existant : champ absent = inchangé ; env/headers à null = vidés. */
export interface McpConnectorUpdate {
  id: string
  name?: string
  transport?: McpTransport
  command?: string | null
  args?: string[] | null
  url?: string | null
  env?: Record<string, string> | null
  headers?: Record<string, string> | null
}
/** Secrets DÉCHIFFRÉS d'un connecteur, demandés à la volée pour préremplir le formulaire d'édition. */
export interface McpConnectorSecrets {
  env: Record<string, string>
  headers: Record<string, string>
}
/** Outil exposé par un serveur MCP (depuis tools/list). */
export interface McpToolInfo {
  name: string
  description?: string
}
/** Résultat d'un test/sonde de connexion (handshake MCP initialize + tools/list). */
export interface McpTestResult {
  ok: boolean
  toolCount?: number
  tools?: McpToolInfo[] // liste des outils exposés (noms + descriptions) quand ok
  error?: string
}
/** Entrée du catalogue de serveurs MCP connus (wizard plug-and-play). */
export interface McpCatalogEntry {
  id: string
  name: string
  description: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  /** Secrets à demander à l'utilisateur (injectés en variables d'env stdio ou en en-têtes http/sse). */
  envFields?: { key: string; label: string; required: boolean }[]
  headerFields?: { key: string; label: string; required: boolean }[]
  docUrl?: string
}
/** Candidat d'import détecté dans une config MCP existante (~/.claude.json, Claude Desktop, .mcp.json). */
export interface McpImportCandidate {
  source: string // ex. '~/.claude.json' | 'claude-desktop' | '.mcp.json'
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}
export interface McpImportResult {
  installed: string[]
  skipped: string[]
}
/** Scope d'un skill : global (~/.claude/skills) ou propre au projet ouvert (<projet>/.claude/skills). */
export type SkillScope = 'user' | 'project'

/** Skill installé, tel qu'affiché ET géré dans Settings (créer / importer / éditer / supprimer). */
export interface SkillInfo {
  name: string
  description: string
  source: string // 'user' | 'plugin:<name>'
  scope: SkillScope
  /** Chemin absolu du DOSSIER du skill (<base>/<name>). Sert au confirm de suppression + repérage. Optionnel
   *  pour compat (le scanner backend le peuple toujours ; un ancien appelant peut l'ignorer). */
  path?: string
}

/** Référence stable d'un skill pour read/update/delete (le couple name+scope identifie le dossier). */
export interface SkillRef {
  name: string
  scope: SkillScope
  /** Requis pour scope 'project' : chemin du projet ouvert (résout <projet>/.claude/skills). */
  projectPath?: string | null
}

/** Contenu éditable d'un skill (frontmatter + corps), retourné par skills.read. */
export interface SkillDetail {
  name: string
  description: string
  body: string // markdown APRÈS le bloc frontmatter
  scope: SkillScope
  path: string // chemin absolu du SKILL.md
}

/** Création d'un skill depuis zéro → écrit <base>/<name>/SKILL.md. */
export interface SkillCreateInput {
  name: string
  description: string
  body: string
  scope: SkillScope
  projectPath?: string | null
}

/** Import d'un skill depuis un dossier local contenant un SKILL.md (copie récursive). */
export interface SkillImportFolderInput {
  sourcePath: string
  scope: SkillScope
  projectPath?: string | null
}

/** Import d'un (ou plusieurs) skill(s) depuis une URL git (clone + normalisation layout plugin). */
export interface SkillImportGitInput {
  url: string
  scope: SkillScope
  projectPath?: string | null
}

/** Édition d'un skill existant : description + corps (le nom/dossier ne change pas). */
export interface SkillUpdateInput {
  ref: SkillRef
  description: string
  body: string
}

/** Résultat d'un import : un dossier/repo peut contenir plusieurs skills (layout plugin). */
export interface SkillImportResult {
  installed: string[] // noms installés
  skipped: string[] // noms ignorés (déjà présents, ou dossier sans SKILL.md)
}

// ---- Voice (dictée on-device) ----
export interface VoiceReplacement {
  id: string
  spoken: string
  replacement: string
  source?: string // manual | auto | csv
  created_at: number | null
}
/** Snippet vocal : trigger parlé → bloc inséré (distinct du dictionnaire). */
export interface VoiceSnippet {
  id: string
  trigger: string
  expansion: string
  created_at: number | null
}
export interface VoiceHistoryItem {
  id: string
  text: string
  duration_ms: number | null
  word_count: number | null
  source: string | null
  created_at: number | null
}
export type VoiceState = 'idle' | 'listening' | 'processing' | 'downloading'

// ---- Oryon Memory (Phase 5) : knowledge graph local en markdown + [[wikilinks]] ----
export interface MemoryNote {
  name: string // nom de fichier sans .md (identifiant)
  title: string // 1er titre `# …` ou le nom
  excerpt: string
  links: string[] // cibles de [[wikilinks]] sortants
  updated: number // mtime ms
}
export interface MemoryGraphNode {
  id: string
  title: string
  exists: boolean // false = lien non résolu (note fantôme à créer)
}
export interface MemoryGraph {
  nodes: MemoryGraphNode[]
  edges: { from: string; to: string }[]
}
export interface MemorySearchHit {
  name: string
  title: string
  excerpt: string
  score: number
}

// ---- Auto-update (canaux stable/dev, UI brandée) ----
export type UpdateChannel = 'stable' | 'dev'
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported' // dev / non packagé
export interface UpdateInfo {
  version: string
  releaseNotes?: string
  releaseDate?: string
}
export interface UpdateProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}
export interface UpdaterState {
  phase: UpdatePhase
  channel: UpdateChannel
  currentVersion: string
  available?: UpdateInfo
  progress?: UpdateProgress
  error?: string
}
export interface UpdateEvent {
  type: 'state'
  state: UpdaterState
}
/** Statistique « mot le plus corrigé » (agrégée sur voice_corrections_log). */
export interface VoiceCorrectionStat {
  word: string
  count: number
}
/** Tableau de bord d'usage Voice (sous-page Stats). */
export interface VoiceStats {
  dictationCount: number
  totalWords: number
  avgWords: number
  timeSavedSec: number
  autoLearnedCount: number
  vocabCount: number
  mostCorrected: VoiceCorrectionStat[]
}
/** Terme de vocabulaire (boost de transcription). source: manual|auto|project|csv. */
export interface VoiceVocab {
  id: string
  term: string
  starred: boolean
  source: string
  created_at: number | null
}

export interface MailboxMessage {
  id: string
  workspace_id: string
  from_agent: string | null
  to_agent: string | null
  body: string
  created_at: number | null
}

// Message du fil de conversation avec l'orchestrateur (panneau de chat dédié). 'user' = toi, 'assistant' = l'orchestrateur.
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  body: string
  created_at: number
}

export type OrchestratorEvent =
  | { type: 'tasks'; workspaceId: string; tasks: Task[] }
  | { type: 'mailbox'; workspaceId: string; message: MailboxMessage }

export interface CreateWorkspaceInput {
  name: string
  projectPath: string
  layout?: string
  color?: string
}

export interface UpdateWorkspaceInput {
  name?: string
  layout?: string
  color?: string
  devCommand?: string
}

/** Ligne de la table `terminals`. */
export interface Terminal {
  id: string
  workspace_id: string
  name: string
  color: string | null
  role: string | null
  cwd: string
  autostart_cmd: string | null
  pane_index: number
  /** Worktree git dédié de l'agent (migration 008) — le shell y démarre. null = projet non-git → cwd. */
  worktree_path: string | null
}

/** State machine d'un terminal (renderer-side, heuristique). */
export type TerminalStatus =
  | 'spawning'
  | 'shell_ready'
  | 'claude_starting'
  | 'claude_ready'
  | 'busy'
  | 'idle'
  | 'exited'

export interface WorkspaceWithTerminals {
  workspace: Workspace
  terminals: Terminal[]
}

/** Layouts disponibles -> nombre de panneaux (terminaux). */
export const LAYOUT_PANES: Record<string, number> = {
  single: 1,
  split: 2,
  quad: 4,
  six: 6,
  eight: 8,
  ten: 10,
  twelve: 12,
  fourteen: 14,
  sixteen: 16,
}

export const LAYOUTS = Object.keys(LAYOUT_PANES)

/** Noms d'agents pour nommer les terminaux (alias lisibles, un par terminal). */
export const AGENT_NAMES = [
  'Nell', 'Cole', 'Lia', 'Roan', 'Jude', 'Gus', 'Kai', 'Cruz',
  'Wren', 'Bex', 'Tov', 'Ada', 'Fox', 'Ines', 'Otto', 'Vera',
]

/** Options de spawn d'un PTY (renderer -> main). */
export interface CreateTerminalInput {
  id: string
  /** Répertoire où le shell démarre — le WORKTREE de l'agent (isolation des éditions + git diff). */
  cwd: string
  /**
   * Arbre PRINCIPAL du projet, ancre de la mémoire partagée (ORYON_PROJECT_DIR) et du run d'orchestration.
   * Distinct de `cwd` : si omis, on retombe sur cwd (projet non-git / pas de worktree).
   */
  mainProjectPath?: string
  autostart?: string | null
  cols: number
  rows: number
  /** Env additionnel injecté dans le PTY (ex. ORYON_AGENT_NAME/ROLE → provenance des écritures mémoire). */
  env?: Record<string, string>
}

/** API exposée au renderer via contextBridge (`window.bridge`). */
export interface BridgeApi {
  /** Infos de l'app : version (affichée en bas du rail) + marqueur dev. + copie fiable via le clipboard Electron. */
  app: {
    info: () => Promise<{ version: string; isDev: boolean }>
    copyText: (text: string) => Promise<void>
  }
  workspaces: {
    list: () => Promise<Workspace[]>
    create: (data: CreateWorkspaceInput) => Promise<WorkspaceWithTerminals>
    delete: (id: string) => Promise<void>
    update: (id: string, data: UpdateWorkspaceInput) => Promise<Workspace>
    open: (id: string) => Promise<WorkspaceWithTerminals>
    listTerminals: (workspaceId: string) => Promise<Terminal[]>
    /** Terminal orchestrateur dédié du workspace (9e terminal, hors grille) ; lazy-create si absent. */
    getOrchestrator: (workspaceId: string) => Promise<Terminal>
    /** Map workspaceId -> nombre de terminaux (pour les badges du rail). */
    terminalCounts: () => Promise<Record<string, number>>
    /** Ajoute un terminal au workspace (split). */
    addTerminal: (workspaceId: string) => Promise<Terminal>
    /** Retire définitivement un terminal (close). */
    removeTerminal: (id: string) => Promise<void>
  }
  terminals: {
    create: (opts: CreateTerminalInput) => Promise<void>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    // on*/off* par id : seules des données sérialisables traversent le contextBridge
    // (on ne dépend pas du proxy d'une fonction de retour).
    onData: (id: string, cb: (data: string) => void) => void
    offData: (id: string) => void
    onExit: (id: string, cb: (code: number) => void) => void
    offExit: (id: string) => void
  }
  dialog: {
    pickFolder: () => Promise<string | null>
  }
  editor: {
    readDir: (path: string) => Promise<TreeNode[]>
    readFile: (path: string) => Promise<FileContent>
    /** Écriture atomique avec garde de concurrence optimiste : `expect` = mtime/taille vus à l'ouverture. */
    writeFile: (path: string, content: string, expect?: { mtimeMs: number; size: number }) => Promise<WriteFileResult>
    /** Liste plate des fichiers (pour Quick Open), dossiers lourds ignorés. */
    listFiles: (rootPath: string) => Promise<string[]>
    watch: (rootPath: string) => void
    unwatch: (rootPath: string) => void
    onFsEvent: (cb: (e: FsEvent) => void) => void
    offFsEvent: () => void
  }
  browser: {
    /** Lance la commande dev du workspace, parse le port localhost. */
    startDevServer: (workspaceId: string) => Promise<DevServerResult>
    stopDevServer: (workspaceId: string) => Promise<void>
    onDevLog: (cb: (line: string) => void) => void
    offDevLog: () => void
    /** Demande de navigation du panneau Browser poussée par le main (commande MCP open_browser). */
    onNavigate: (cb: (data: { workspaceId: string; url: string }) => void) => void
    offNavigate: () => void
    /** Console de la webview → main (ring lu par l'outil MCP browser_console). */
    reportConsole: (data: { workspaceId: string; level: string; message: string; line?: number; source?: string }) => void
    /** Capture à la demande (outil MCP browser_screenshot) : main demande, le renderer capture + renvoie le PNG. */
    onCapture: (cb: (data: { workspaceId: string; reqId: string }) => void) => void
    offCapture: () => void
    sendCaptureResult: (reqId: string, png: Uint8Array, error?: string) => void
  }
  orchestrator: {
    listTasks: (workspaceId: string) => Promise<Task[]>
    listMailbox: (workspaceId: string) => Promise<MailboxMessage[]>
    /** Changement de statut manuel (drag-drop Kanban). */
    updateTaskStatus: (taskId: string, status: TaskStatus) => Promise<void>
    /** Stoppe le travail en cours du workspace (interrompt les workers, remet les in-progress en todo). */
    stop: (workspaceId: string) => Promise<void>
    onEvent: (cb: (e: OrchestratorEvent) => void) => void
    offEvent: () => void
  }
  source: {
    /** État des changements du working tree (git si repo, sinon isGit=false). */
    status: (projectPath: string) => Promise<SourceStatus>
    /** Diff côté-à-côté d'un fichier (HEAD vs working tree). */
    diff: (projectPath: string, file: string) => Promise<SourceDiff>
    /** Accepter = stager (git add). */
    accept: (projectPath: string, file: string) => Promise<void>
    /** Rejeter = restaurer le fichier à HEAD (ou supprimer si nouveau). */
    reject: (projectPath: string, file: string) => Promise<void>
    acceptAll: (projectPath: string) => Promise<void>
    rejectAll: (projectPath: string) => Promise<void>
    /** Historique des commits (optionnellement filtré sur un fichier). */
    log: (projectPath: string, file?: string) => Promise<GitCommit[]>
    /** Contenu d'un fichier à une révision donnée (voir une version plus ancienne). */
    fileAtRef: (projectPath: string, file: string, ref: string) => Promise<{ content: string; language: string }>
    /** Restaure un fichier à une révision (revert). */
    revertFile: (projectPath: string, file: string, ref: string) => Promise<void>
    /** Worktrees/branches d'agents enregistrés sous <projet>/.oryon/agents (run multi-agent). */
    branches: (projectPath: string) => Promise<AgentBranch[]>
    /** Diff par fichier d'une branche d'agent vs le tronc principal (range diff base...branch). */
    branchDiff: (projectPath: string, branch: string) => Promise<SourceDiff[]>
    /** Intègre (merge --no-ff, sérialisé + conflict-safe) une branche d'agent dans le tronc principal. */
    mergeAgent: (projectPath: string, branch: string) => Promise<MergeResult>
  }
  /** Auto-update (canaux stable/dev). */
  update: {
    check: () => Promise<UpdaterState>
    download: () => Promise<void>
    install: () => void
    setChannel: (channel: UpdateChannel) => Promise<UpdaterState>
    getState: () => Promise<UpdaterState>
    onEvent: (cb: (ev: UpdateEvent) => void) => void
    offEvent: () => void
  }
  /** Oryon Memory (Phase 5) : notes markdown locales (.oryon/memory) + graphe de [[wikilinks]], partagées avec les agents (MCP). */
  memory: {
    list: (projectPath: string) => Promise<MemoryNote[]>
    read: (projectPath: string, name: string) => Promise<string>
    write: (projectPath: string, name: string, content: string) => Promise<MemoryNote>
    delete: (projectPath: string, name: string) => Promise<{ deleted: boolean }>
    graph: (projectPath: string) => Promise<MemoryGraph>
    /** Recherche plein-texte (titre + corps), classée. */
    search: (projectPath: string, query: string, limit?: number) => Promise<MemorySearchHit[]>
    /** Append atomique (sans conflit) avec provenance optionnelle. */
    append: (projectPath: string, name: string, content: string, author?: string, role?: string) => Promise<{ name: string; updated: number; existed: boolean }>
    /** Renomme une note + réécrit les [[wikilinks]] qui la visent. */
    rename: (projectPath: string, oldName: string, newName: string) => Promise<{ name: string }>
    /** Watch le dossier mémoire du projet → 'memory:changed' (reflète les écritures des agents en direct). */
    watch: (projectPath: string) => void
    unwatch: () => void
    onChanged: (cb: () => void) => void
    offChanged: () => void
  }
  settings: {
    /** Réglages app-global (clé/valeur). */
    getApp: () => Promise<Record<string, string>>
    setApp: (key: string, value: string) => Promise<void>
    /** Réglage app-global modifié (main → renderer) : applique un changement live sans attendre un focus fenêtre. */
    onAppChanged: (cb: (p: { key: string; value: string }) => void) => void
    offAppChanged: () => void
    /** Connecteurs MCP visibles pour un projet (par chemin) : scope 'app' + scope 'project' de ce projet. */
    listConnectors: (projectPath?: string | null) => Promise<McpConnector[]>
    addConnector: (input: McpConnectorInput) => Promise<McpConnector>
    toggleConnector: (id: string, enabled: boolean) => Promise<void>
    deleteConnector: (id: string) => Promise<void>
    /** Édite un connecteur existant (corrige sans delete+recreate). */
    updateConnector: (input: McpConnectorUpdate) => Promise<McpConnector>
    /** Secrets déchiffrés d'un connecteur (préremplissage du formulaire d'édition). */
    connectorSecrets: (id: string) => Promise<McpConnectorSecrets>
    /** Teste un connecteur AVANT enregistrement (handshake MCP initialize + tools/list). */
    testConnector: (input: McpConnectorInput) => Promise<McpTestResult>
    /** Sonde un connecteur DÉJÀ enregistré (par id) : statut connecté/échec + liste des outils exposés. */
    probeConnector: (id: string) => Promise<McpTestResult>
    /** Catalogue de serveurs MCP connus (wizard plug-and-play). */
    listMcpCatalog: () => Promise<McpCatalogEntry[]>
    /** Détecte les connecteurs importables depuis les configs MCP existantes. */
    importMcpCandidates: () => Promise<McpImportCandidate[]>
    /** Importe les candidats choisis dans un scope donné. */
    importConnectors: (
      candidates: McpImportCandidate[],
      scope: McpScope,
      projectPath?: string | null,
    ) => Promise<McpImportResult>
  }
  /** Skills Claude Code : globaux (~/.claude/skills) + ceux du projet ouvert. Gérables de bout en bout
   *  (créer depuis zéro / importer un dossier / importer depuis git / éditer / supprimer). */
  skills: {
    /** Liste : globaux d'abord, puis ceux du projet si `projectPath` fourni. */
    list: (projectPath?: string | null) => Promise<SkillInfo[]>
    /** Contenu éditable (frontmatter + corps) d'un skill identifié par name+scope. */
    read: (ref: SkillRef) => Promise<SkillDetail>
    /** Crée un skill depuis zéro (écrit <base>/<name>/SKILL.md). */
    create: (input: SkillCreateInput) => Promise<SkillInfo>
    /** Importe un skill depuis un dossier local contenant un SKILL.md (copie récursive). */
    importFolder: (input: SkillImportFolderInput) => Promise<SkillImportResult>
    /** Importe depuis une URL git (gère le layout plugin `.claude-plugin` / `skills/` imbriqué). */
    importGit: (input: SkillImportGitInput) => Promise<SkillImportResult>
    /** Met à jour description + corps d'un skill existant. */
    update: (input: SkillUpdateInput) => Promise<SkillInfo>
    /** Supprime un skill. SÛR vis-à-vis des junctions/symlinks : ne recurse JAMAIS à travers un reparse-point. */
    delete: (ref: SkillRef) => Promise<void>
  }
  voice: {
    listReplacements: () => Promise<VoiceReplacement[]>
    addReplacement: (spoken: string, replacement: string) => Promise<VoiceReplacement>
    deleteReplacement: (id: string) => Promise<void>
    addHistory: (item: { text: string; durationMs: number; wordCount: number; source: string }) => Promise<void>
    listHistory: (limit?: number) => Promise<VoiceHistoryItem[]>
    /** Vocabulaire de boost (Voice++). */
    listVocab: () => Promise<VoiceVocab[]>
    addVocab: (term: string, starred?: boolean, source?: string) => Promise<VoiceVocab>
    toggleVocabStar: (id: string, starred: boolean) => Promise<void>
    deleteVocab: (id: string) => Promise<void>
    /** Snippets vocaux (trigger → expansion). */
    listSnippets: () => Promise<VoiceSnippet[]>
    addSnippet: (trigger: string, expansion: string) => Promise<VoiceSnippet>
    deleteSnippet: (id: string) => Promise<void>
    /** Auto-add ✨ (INC4) : apprend les noms propres/termes rares depuis une édition du texte dicté. */
    learnFromEdit: (injected: string, edited: string, context: string) => Promise<{ learned: string[] }>
    /** Tableau de bord d'usage Voice (sous-page Stats). */
    stats: () => Promise<VoiceStats>
    /** Smart formatting Medium/High (INC6) via CLI $0 ; '' si privacy/échec (repli Light côté renderer). */
    format: (text: string, level: 'medium' | 'high') => Promise<string>
    /** Command mode (INC9) : transforme la sélection / génère inline via CLI $0 ; '' si privacy/échec. */
    command: (command: string, selection: string) => Promise<string>
    /** Cible 'system' (voice.target, façon WisprFlow) : colle au curseur de l'app au premier plan (Windows, presse-papier + Ctrl+V). */
    injectText: (text: string) => Promise<{ ok: boolean; reason?: string }>

    /** Hotkey dédiée du command mode (main → renderer). */
    onCommandKey: (cb: () => void) => void
    offCommandKey: () => void
    /** Reçoit les démarrages/arrêts demandés par la hotkey globale ou le widget (main → renderer). */
    onToggle: (cb: () => void) => void
    offToggle: () => void
    /** Widget → main : demande un toggle (rediffusé à la fenêtre principale). */
    requestToggle: () => void
    /** Fenêtre principale → main → widget : pousse l'état courant de la dictée. */
    reportState: (state: VoiceState) => void
    onState: (cb: (state: VoiceState) => void) => void
    offState: () => void
    /** Affiche/cache le widget flottant (Settings). */
    setWidget: (visible: boolean) => Promise<void>
    /** Ré-enregistre les hotkeys globales depuis les réglages courants (sans redémarrage). */
    reregisterHotkeys: () => Promise<void>
    /** Conflits de hotkey détectés au DERNIER enregistrement (pull au montage : l'event boot est émis avant que le renderer ne soit abonné). */
    getHotkeyConflicts: () => Promise<{ accel: string; mode: string }[]>
    /** Conflit de raccourci global (accélérateur déjà pris par une autre appli) : main → renderer. */
    onHotkeyConflict: (cb: (info: { accel: string; mode: string }) => void) => void
    offHotkeyConflict: () => void
  }
}
