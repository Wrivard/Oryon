# 08 — Phases de construction

Principe : chaque phase **tourne** et est vérifiable avant de passer à la suivante. On ne câble l'orchestrateur qu'après avoir 1 workspace + terminaux + Claude Code fonctionnels.

---

## Phase 0 — Squelette (½–1 jour)
- electron-vite + React + TS + Tailwind + Zustand.
- Fenêtre, barre de menu, layout 3 colonnes vide (rail / centre / panneau droit) + orchestrator bar.
- contextIsolation + preload + API `window.bridge` typée.
- SQLite (better-sqlite3) + migrations + schéma de `01`.
- **Done** : l'app s'ouvre, layout visible, DB créée.

## Phase 1 — Terminaux + Claude Code (cœur) (2–3 jours)
- node-pty + xterm.js, IPC data/resize/kill.
- Création de workspace (choisir dossier projet, layout, couleur) → rail gauche.
- Grille de terminaux selon le template ; chaque terminal `cwd = project_path`, autostart `claude`.
- Onglets nommés colorés + split/close/focus.
- Restauration des workspaces au démarrage.
- **Done** : critères de `03 §10`. ← *milestone le plus important.*

## Phase 2 — Panneau droit : Editor + Browser (2 jours)
- Editor : file tree (chokidar) + Monaco + Quick Open + file-watching.
- Browser : dev-server launcher + parse port + `<webview>` localhost.
- Toggle entre panneaux + splitter resizable persistant.
- **Done** : éditer un fichier et voir le projet en localhost depuis l'app.

## Phase 3 — Orchestrateur + Tasks + MCP local (3–4 jours)
- Decomposer (Claude API) : but → tasks JSON.
- Router : assignation par rôle + injection prompt dans les PTY.
- Mailbox : parsing de la sortie (`MAILBOX:`) → handoffs builder→reviewer.
- Panneau Tasks (Kanban) synchronisé.
- Serveur MCP local (mode B) : agents Claude Code lisent/écrivent les tasks.
- **Done** : critères de `04 §10` + `06 §5`. ← *milestone "tout fonctionne ensemble".*

## Phase 4 — Source/Diff + Plan + Voice (3–4 jours)
- Source : diffs Accept/Reject + git log / snapshots (« voir le code plus vieux »).
- Plan : plan-based execution avec approbation par étape.
- Voice : Whisper on-device + widget flottant + injection dans l'orchestrator bar.
- **Done** : critères de `05` + `07`.

## Phase 5 — Polish & écosystème (2–3 jours)
- 25+ thèmes (CSS vars) + theme picker.
- Command-blocks façon Warp dans les terminaux.
- Inspect→code dans le Browser (clic élément → fichier).
- BridgeMemory local (`.bridgeforge-memory/`, markdown + wikilinks) — optionnel.
- Auto-update (electron-updater), packaging macOS (DMG, ARM64+Intel), Windows, Linux.
- **Done** : app installable, thèmes, auto-update.

---

## Ordre de priorité si temps limité
1. **Phase 1** (terminaux + Claude Code auto) — sans ça, rien.
2. **Phase 3** (orchestrateur + tasks) — c'est ta valeur unique.
3. **Phase 2** (editor + browser) — confort indispensable.
4. Phase 4–5 — différenciation et polish.

## Risques / points à vérifier tôt
- **Flags réels de Claude Code CLI** (`claude --help`) : mode interactif vs headless, `--model`, `--append-system-prompt`, reprise de session. Le plan suppose certains flags — **valider sur ta version dès la Phase 1.**
- **Détection "claude prêt"** dans le PTY (state machine fiable).
- **node-pty** : build natif par plateforme (prévoir `electron-rebuild`).
- **Parsing mailbox** robuste (les agents doivent émettre le marqueur de façon fiable → l'imposer dans leur prompt système).
- Coût API du decomposer (compteur + cache).

## Réutilisation de ton existant (Küa)
Tu as déjà : une app Electron qui pilote Claude Code CLI **headless** en arrière-plan + une architecture multi-agent Manager→Editor→Verifier. Réutilise :
- Ton wrapper de lancement headless de Claude Code → base de `claude-launcher.ts` + mode headless de l'orchestrateur.
- Ton pattern Manager→Editor→Verifier → mappe sur coordinator→builder→reviewer.
