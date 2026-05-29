# 01 — Architecture technique

## 1. Modèle de processus Electron

```
┌─────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Node.js)                                        │
│  • Fenêtre(s) BrowserWindow                                   │
│  • node-pty : spawn/kill des PTY (1 par terminal)             │
│  • SQLite (better-sqlite3) : workspaces, projects, tasks…     │
│  • File watcher (chokidar) pour l'éditeur                     │
│  • Orchestrateur : appels Claude API + routing vers PTY       │
│  • Serveur MCP local (optionnel)                              │
│  • Dev-server launcher (npm run dev) + détection du port      │
│  IPC  ▲                                                        │
└───────┼───────────────────────────────────────────────────────┘
        │ ipcMain / ipcRenderer (contextBridge, preload)
┌───────┼───────────────────────────────────────────────────────┐
│ RENDERER (React + TS + Tailwind)                              │
│  • Rail gauche : Workspaces                                   │
│  • Grille de terminaux : xterm.js (reçoit data via IPC)       │
│  • Panneau droit toggleable : Monaco / webview / Plan / Diff  │
│  • Barre orchestrateur (chat → tasks)                         │
│  • Widget Voice flottant                                      │
└───────────────────────────────────────────────────────────────┘
```

**Règle de sécurité Electron** : `contextIsolation: true`, `nodeIntegration: false`, tout passe par un **preload** exposant une API typée (`window.bridge`). Jamais de `require` direct dans le renderer.

## 2. Découpage en modules (main process)

```
src/main/
  index.ts                # bootstrap app, fenêtre, menus
  ipc/
    terminals.ipc.ts       # create/write/resize/kill terminal
    workspaces.ipc.ts      # CRUD workspaces/projects
    orchestrator.ipc.ts    # submit goal → tasks → dispatch
    editor.ipc.ts          # read/write/watch files
    browser.ipc.ts         # start dev server, get localhost port
    voice.ipc.ts           # start/stop transcription, inject text
  services/
    pty-manager.ts         # Map<terminalId, IPty>, lifecycle
    project-registry.ts    # mapping workspace → dossier projet
    claude-launcher.ts     # construit la commande `cd … && claude …`
    orchestrator/
      decomposer.ts        # Claude API : goal → liste de tasks
      router.ts            # assigne tasks → agents/terminaux
      mailbox.ts           # shared mailbox inter-agents
      roles.ts             # builder/reviewer/scout/coordinator
    dev-server.ts          # spawn npm run dev, parse le port
    mcp-server.ts          # serveur MCP local (option)
    voice/
      whisper.ts           # transcription locale
      injector.ts          # clipboard + paste simulation
  db/
    schema.ts              # tables SQLite
    migrations/
```

```
src/renderer/
  App.tsx
  store/                   # Zustand stores
  components/
    WorkspaceRail/
    TerminalGrid/
      Terminal.tsx         # 1 xterm instance
      TerminalTab.tsx      # onglet nommé coloré
      gridTemplates.ts     # layouts 1,2,4,6,8,10,12,14,16
    RightPanel/
      EditorPanel.tsx      # Monaco + file tree
      BrowserPanel.tsx     # <webview> localhost
      PlanPanel.tsx        # plan-based execution view
      DiffPanel.tsx        # Source/diff/versions
      TasksPanel.tsx       # Kanban
    Orchestrator/
      OrchestratorBar.tsx  # input + flux de tasks
    Voice/
      VoiceWidget.tsx
    Theme/
      themes.ts            # 25+ thèmes
```

## 3. Schéma de données (SQLite)

```sql
-- Un workspace = un onglet = lié à UN projet (dossier)
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,         -- uuid
  name          TEXT NOT NULL,
  project_path  TEXT NOT NULL,            -- dossier absolu, ex /Users/x/Desktop/projet
  color         TEXT,                     -- badge du rail gauche
  layout        TEXT NOT NULL DEFAULT 'quad', -- single|split|quad|six|eight|…
  created_at    INTEGER,
  last_opened   INTEGER
);

-- Chaque terminal d'un workspace (jusqu'à 16)
CREATE TABLE terminals (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,            -- nom de l'agent (Nell, Cole…)
  color         TEXT,
  role          TEXT,                     -- builder|reviewer|scout|coordinator|free
  cwd           TEXT NOT NULL,            -- = project_path par défaut
  autostart_cmd TEXT,                     -- ex: "claude"
  pane_index    INTEGER NOT NULL
);

-- Modèle MCP-like : projets/tasks/agents
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  path          TEXT NOT NULL
);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instructions  TEXT NOT NULL,            -- 1..5000 chars
  knowledge     TEXT,                     -- 0..50000 chars
  status        TEXT NOT NULL DEFAULT 'todo', -- todo|in-progress|in-review|complete|cancelled
  assigned_terminal_id TEXT,              -- quel agent l'exécute
  created_at    INTEGER,
  updated_at    INTEGER
);

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  role          TEXT                       -- builder|reviewer|scout|coordinator
);

-- Mailbox partagée de l'orchestrateur (BridgeSwarm-like)
CREATE TABLE mailbox (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  from_agent    TEXT,
  to_agent      TEXT,                      -- null = broadcast
  body          TEXT NOT NULL,
  created_at    INTEGER
);
```

> Le schéma `tasks/agents/status` reprend **exactement** le lifecycle BridgeMCP (`todo → in-progress → in-review → complete → cancelled`) pour rester compatible avec leur écosystème si tu veux brancher leur vrai serveur MCP plus tard.

## 4. Flux principaux (séquences)

### A. Créer un workspace
1. User clique "+" dans le rail → choisit/crée un dossier projet + layout + couleur.
2. Main : insert `workspaces` + `projects`, crée N `terminals` (selon layout), `cwd = project_path`.
3. Renderer monte la grille ; pour chaque terminal, main `spawn` un PTY `cd <path> && claude` (voir `03`).

### B. Parler à l'orchestrateur
1. User tape/dicte un but dans l'OrchestratorBar.
2. `decomposer.ts` appelle Claude API → renvoie une liste de tasks structurées (JSON).
3. `router.ts` assigne chaque task à un terminal/agent selon son rôle.
4. Pour chaque task : insert dans `tasks`, status `todo→in-progress`, puis **écrit le prompt dans le PTY** de l'agent.
5. Agents postent des messages dans `mailbox` (handoff, review request) → router réagit.

### C. Preview localhost
1. User toggle "Browser" → main lance `npm run dev` (ou commande configurée) dans un PTY dédié, parse le port (`localhost:5173`…).
2. Renderer charge l'URL dans un `<webview>`.

## 5. Conventions
- TypeScript strict partout.
- IDs = uuid v4.
- Tous les chemins absolus, normalisés avec `path`.
- Pas de secret en clair dans le renderer ; la clé Claude API vit dans le main (variable d'env / keychain).
