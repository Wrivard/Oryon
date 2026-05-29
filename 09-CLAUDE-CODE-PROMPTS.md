# 09 — Prompts prêts pour Claude Code desktop

Copy-paste, un prompt par phase. Donne-les à Claude Code desktop **dans l'ordre**, en gardant les fichiers `00`–`08` dans le repo comme contexte (`/docs`). Commence chaque session en pointant Claude Code vers ces docs.

> Avant tout : `claude --help` dans un terminal et note les vrais flags. Corrige `claude-launcher.ts` en conséquence.

---

## Bootstrap (à dire une fois)
```
Lis tous les fichiers dans ./docs (00-OVERVIEW.md à 08-BUILD-PHASES.md). C'est le plan complet de BridgeForge : un IDE desktop Electron qui regroupe l'écosystème BridgeMind (BridgeSpace + BridgeMCP + BridgeVoice + orchestrateur multi-agent) et pilote Claude Code CLI pour coder d'autres apps. Confirme que tu as compris l'architecture, puis attends mes instructions de phase. Ne code rien encore.
```

---

## Prompt Phase 0 — Squelette
```
Phase 0. Initialise le projet BridgeForge :
- electron-vite + React + TypeScript + Tailwind + Zustand.
- contextIsolation: true, nodeIntegration: false, preload exposant une API typée window.bridge.
- Layout 3 colonnes (rail gauche 220px collapsible, centre flex, panneau droit ~38% resizable) + orchestrator bar en bas. Tout vide pour l'instant, thème dark (#0a0a0f, accent orange).
- better-sqlite3 avec le schéma exact de docs/01-ARCHITECTURE.md (workspaces, terminals, projects, tasks, agents, mailbox) + migrations.
Structure les dossiers comme dans 01-ARCHITECTURE.md (src/main, src/renderer). Donne-moi une app qui démarre.
```

## Prompt Phase 1 — Terminaux + Claude Code
```
Phase 1 (cœur). Implémente la grille de terminaux et le lancement auto de Claude Code, selon docs/03-TERMINALS-AND-CLAUDE-CODE.md et docs/02-UI-SPEC.md :
- node-pty dans le main (pty-manager.ts) + xterm.js dans le renderer, reliés par IPC (data/write/resize/kill) avec les addons fit/search/web-links.
- Création de workspace : modal pour choisir un dossier projet existant, un layout (1/2/4/6/8/...), une couleur. Persiste dans SQLite et affiche dans le rail gauche avec badge du nombre de terminaux.
- À l'ouverture d'un workspace : monte la grille selon gridTemplates ; chaque terminal a cwd = project_path et autostart "claude" (lancement auto de Claude Code dans le dossier). Onglets nommés colorés (Nell, Cole, Lia...) avec icônes split/expand/close. Terminal focus = bordure accent.
- State machine par terminal (spawning→shell_ready→claude_ready→busy→idle) et détection "claude prêt".
- Restauration des workspaces et terminaux au redémarrage.
IMPORTANT : d'abord lance `claude --help` dans un terminal de test et adapte claude-launcher.ts aux vrais flags. Vérifie les critères de done de 03 §10.
```

## Prompt Phase 2 — Editor + Browser
```
Phase 2. Implémente le panneau droit Editor et Browser selon docs/05-RIGHT-PANEL.md :
- Editor : file tree du project_path (chokidar dans le main, IPC), Monaco avec onglets de fichiers, syntax-highlight, Quick Open (Cmd+P), file-watching. Lecture/écriture via editor.ipc.ts uniquement.
- Browser : dev-server.ts spawn la commande dev du workspace (configurable, défaut "npm run dev"), parse le port localhost depuis la sortie, charge l'URL dans un <webview> avec barre d'URL + reload.
- Barre d'onglets du panneau (Editor/Browser/Plan/Source/Tasks) avec toggle ; splitter resizable entre centre et panneau, largeur persistée par workspace.
Vérifie les critères de done de 05 §7 (Editor et Browser).
```

## Prompt Phase 3 — Orchestrateur + Tasks + MCP local
```
Phase 3 (valeur unique). Implémente l'orchestrateur multi-agent selon docs/04-ORCHESTRATOR.md et docs/06-MCP-INTEGRATION.md :
- decomposer.ts : appelle l'API Anthropic (clé via env dans le main) pour transformer un objectif en tasks JSON {title, instructions, role, dependsOn}.
- router.ts : persiste les tasks, respecte dependsOn, choisit un terminal libre du bon rôle, passe la task in-progress et injecte le prompt construit dans le PTY de l'agent (avec consigne d'émettre "MAILBOX: done #n" en fin).
- mailbox.ts + parsing de la sortie PTY : sur "MAILBOX: done" → task in-review + déclenche un reviewer ; sur "MAILBOX: approved" → complete ; sur "changes" → repart au builder.
- roles.ts : prompts système builder/reviewer/scout/coordinator.
- Orchestrator bar : input + affichage du plan (tasks + agent assigné + état) + flux mailbox live.
- Panneau Tasks : Kanban (Todo/In Progress/In Review/Complete), drag-drop change le statut, bouton "Run with agent".
- mcp-server.ts : serveur MCP local (@modelcontextprotocol/sdk) mappant la DB, outils compatibles BridgeMCP (list_projects, create_task, update_task, list_tasks, get_task, agents...). Génère un .mcp.json dans chaque projet pointant sur ce serveur pour que les terminaux Claude Code l'utilisent.
Vérifie les critères de done de 04 §10 et 06 §5.
```

## Prompt Phase 4 — Source/Diff + Plan + Voice
```
Phase 4. Implémente selon docs/05-RIGHT-PANEL.md (Source, Plan) et docs/07-VOICE.md :
- Source : panneau de diffs proposés par les agents (Accept/Reject par fichier et global), git log / git diff / revert si repo git, sinon snapshots locaux dans .bridgeforge/snapshots avant chaque application. Permet de voir une version plus ancienne d'un fichier.
- Plan : plan-based execution, liste d'étapes proposées avec Approve step / Approve all / Reject ; une étape approuvée devient une task dispatchée.
- Voice : Whisper on-device (whisper.cpp / nodejs-whisper, Metal sur Apple Silicon), hotkey globale push-to-talk + toggle, widget flottant always-on-top (Idle/Listening/Processing, draggable, double-clic = toggle), custom dictionary + historique en SQLite. Injection du texte dans l'orchestrator bar (et option terminal actif via writeTerminal).
Vérifie les critères de done de 05 et 07.
```

## Prompt Phase 5 — Polish & packaging
```
Phase 5. Finitions selon docs/02-UI-SPEC.md §6 et docs/08-BUILD-PHASES.md :
- 25+ thèmes via CSS variables + theme picker (au moins les dark listés : Void, Neon Tokyo, Synthwave, Dracula, BridgeMind...).
- Command-blocks façon Warp dans les terminaux (commande + sortie + exit-code vert/rouge + timestamp, collapsible).
- Inspect→code dans le Browser (clic sur un élément → ouvre le fichier source si mappable).
- (Option) BridgeMemory local : .bridgeforge-memory/ en markdown avec [[wikilinks]] + vue graphe.
- Packaging : electron-builder (macOS DMG ARM64+Intel, Windows, Linux AppImage/deb), auto-update (electron-updater).
```

---

## Conseils d'exécution avec Claude Code desktop
- **Une phase = une session focalisée.** Demande à valider les critères de "done" avant de continuer.
- Garde `./docs` dans le repo ; rappelle à Claude Code de les relire au début de chaque phase.
- Commits fréquents par sous-étape (tu pourras revenir en arrière via le panneau Source plus tard… méta).
- Teste sur **un vrai petit projet** (ex. un de tes démos Küa) comme `project_path` dès la Phase 1.
- Si un flag Claude Code n'existe pas comme supposé, dis-le à Claude Code : "adapte au vrai output de `claude --help`".
