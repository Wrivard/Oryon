# BridgeForge — Plan de construction (Master Overview)

> **But du projet** : Répliquer et regrouper l'écosystème BridgeMind (BridgeSpace IDE + BridgeMCP + BridgeVoice + orchestrateur multi-agent) en **une seule app desktop Electron** qui pilote **Claude Code CLI** en arrière-plan pour coder d'autres applications. Construit avec **Claude Code desktop**.

Nom de code interne : **BridgeForge** (renomme librement). Tout le reste de ce document utilise ce nom.

---

## 1. Ce qu'on réplique (deep-dive de l'écosystème BridgeMind)

BridgeMind est un toolkit de "vibe coding" composé de 4 produits + 1 couche mémoire + 1 orchestrateur. Voici la cartographie exacte, vérifiée sur leur doc (`docs.bridgemind.ai`) et leurs pages produits.

| Produit BridgeMind | Rôle | Ce qu'on réplique chez nous |
| --- | --- | --- |
| **BridgeSpace** | IDE desktop natif (Electron). Workspaces à onglets, grille de 1–16 terminaux, éditeur de code intégré, file browser, Kanban, command-blocks façon Warp, 25+ thèmes. | **Cœur de l'app.** C'est l'essentiel de notre clone. |
| **BridgeMCP** | Serveur MCP qui expose projets / tâches / agents à n'importe quel client MCP (Cursor, Claude Code, Windsurf, Codex). Lifecycle `todo → in-progress → in-review → complete`. | On réplique le **modèle de données** (projets/tâches/agents) localement + un serveur MCP local optionnel. |
| **BridgeVoice** | Dictée vocale privacy-first, Whisper on-device, injection de texte universelle, widget flottant always-on-top, push-to-talk / toggle. | **Module Voice** intégré (widget flottant + injection dans le terminal/chat actif). |
| **BridgeCode** | (Pré-lancement) IDE agent-first, workspace multi-panneaux : **Chat · Terminal · Browser preview · File Explorer · Plan · Source**. Plan-based execution, "Safe by default" (accept/reject des diffs). | On réplique le **panneau droit toggleable** (Editor / Browser / Plan / Source / Tasks). |
| **BridgeSwarm** | Orchestrateur multi-agent DANS BridgeSpace. On définit un but, on assigne des rôles (**builder, reviewer, scout, coordinator**), les agents se partagent le travail via une **shared mailbox** et shippent en parallèle. | **Notre orchestrateur** : on lui parle, il pousse des tasks vers les différents terminaux. |
| **BridgeMemory** | Knowledge graph persistant local-first dans `.bridgememory/`, fichiers markdown, `[[wikilinks]]`, vue graphe force-directed, 12 outils MCP (`create_memory`, `search_memories`, `find_backlinks`, `suggest_connections`). | **Module mémoire** optionnel (phase 2). |

### Détails UI confirmés par le screenshot fourni
- **Rail gauche** : liste des Workspaces (chaque workspace = un projet), badge coloré avec le nombre de terminaux.
- **Centre** : grille de terminaux (jusqu'à 8 visibles / 16 max). Chaque terminal a un **onglet nommé coloré** (ex. Nell, Cole, Lia, Roan…) + icônes (split, expand, maximize, close).
- Chaque terminal lance `Claude Code v2.1.x · Opus 4.8 · ~/Desktop/<projet>` → **déjà `cd` dans le dossier du projet du workspace**.
- **Panneau droit toggleable** : ici "Editor" (file tree + `index.html` en syntax-highlight). Toggles à répliquer : **Editor, Browser (localhost), Plan, Source/Diff, Tasks**.
- **Widget BridgeVoice** flottant.
- Barre de menu macOS native (Electron), titre de la fenêtre = nom du workspace.

---

## 2. Ce qu'on veut EN PLUS / DIFFÉREMMENT (tes specs)

Tes exigences précises (traduites en specs) :

1. **Rail gauche = Workspaces liés à des projets.** Créer un workspace = choisir/créer un dossier de projet.
2. **Jusqu'à 8 terminaux** par workspace, **déjà `cd` dans le projet** au moment de la création, lançant **Claude Code** automatiquement (`cd <project> && claude`).
3. **Panneau droit toggleable** :
   - Voir le **code** directement (éditeur).
   - Voir une **page web localhost** liée au projet (Browser preview).
   - Cliquer sur des éléments → voir le code correspondant.
   - Voir des versions plus anciennes (diff / historique).
4. **Orchestrateur** : une zone où tu lui parles / lui donnes des consignes ; il **décompose en tasks** et les **pousse aux différents terminaux** (chaque terminal = un agent Claude Code).
5. **Réplication fidèle** de l'écosystème (MCP + IDE + Voice) qui **fonctionne bien ensemble**.

---

## 3. Décision d'architecture clé

> **Chaque terminal de la grille = une instance `claude` (Claude Code CLI) headless/interactive lancée dans le dossier du projet.**
> L'orchestrateur n'est PAS un nouveau LLM : c'est un **routeur de tâches** qui (a) appelle un modèle pour décomposer ta demande en sous-tâches, puis (b) **injecte le prompt** de chaque sous-tâche dans le terminal/agent approprié via le PTY, en suivant le modèle BridgeSwarm (builder/reviewer/scout/coordinator + mailbox partagée).

Ça reprend exactement le pattern Manager→Editor→Verifier que tu connais déjà (ton app Electron Küa), généralisé en builder/reviewer/scout/coordinator.

---

## 4. Stack technique recommandé

| Couche | Choix | Pourquoi |
| --- | --- | --- |
| Shell desktop | **Electron** + **electron-vite** | C'est ce que BridgeCode/BridgeSpace utilisent ; tu maîtrises déjà (app Küa). |
| UI | **React + TypeScript** + **Tailwind** | Rapide, thèmes faciles, tu l'utilises partout. |
| Terminaux | **xterm.js** (renderer) + **node-pty** (main) | Standard de facto pour un terminal dans Electron. |
| Éditeur de code | **Monaco** (ou CodeMirror 6) | Syntax-highlight, file-watching, Quick Open. |
| Browser preview | **`<webview>`** Electron pointant sur `localhost:<port>` | Preview live du projet. |
| Persistance | **SQLite** (better-sqlite3) | Workspaces, projets, tasks, agents, historique. |
| Orchestrateur LLM | **Claude API** (Anthropic SDK) pour la décomposition | Découpe la demande en tasks. |
| Agents d'exécution | **Claude Code CLI** (`claude`) une instance par terminal | Exécute réellement le code. |
| MCP (option) | **@modelcontextprotocol/sdk** | Serveur MCP local exposant projets/tasks. |
| Voice (option) | **whisper.cpp** / `whisper-node` + injection clavier | Réplique BridgeVoice on-device. |
| State | **Zustand** | Léger, suffisant. |

---

## 5. Fichiers de ce plan (ordre de lecture / d'exécution)

1. `00-OVERVIEW.md` — ce fichier.
2. `01-ARCHITECTURE.md` — architecture technique détaillée, process model Electron, schéma de données.
3. `02-UI-SPEC.md` — spec UI complète pour répliquer le look BridgeSpace (layout, thèmes, composants).
4. `03-TERMINALS-AND-CLAUDE-CODE.md` — intégration node-pty + xterm + lancement auto de Claude Code par workspace.
5. `04-ORCHESTRATOR.md` — l'orchestrateur multi-agent (BridgeSwarm-like) : décomposition → routing → mailbox.
6. `05-RIGHT-PANEL.md` — panneau droit toggleable : Editor, Browser localhost, Plan, Source/Diff, Tasks.
7. `06-MCP-INTEGRATION.md` — couche MCP (modèle projets/tasks/agents + serveur local optionnel).
8. `07-VOICE.md` — module BridgeVoice (Whisper on-device + widget + injection).
9. `08-BUILD-PHASES.md` — roadmap par phases, ce qu'on construit dans quel ordre, critères de done.
10. `09-CLAUDE-CODE-PROMPTS.md` — prompts copy-paste prêts à donner à Claude Code desktop pour bâtir chaque phase.

---

## 6. Principe directeur

On construit **incrémentalement et vérifiablement**. Chaque phase produit quelque chose qui tourne. On ne câble l'orchestrateur multi-agent qu'une fois que 1 workspace + 1 terminal + 1 instance Claude Code fonctionnent end-to-end. Voir `08-BUILD-PHASES.md`.
