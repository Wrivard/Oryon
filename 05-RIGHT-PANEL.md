# 05 — Panneau droit toggleable

Réplique les panneaux de BridgeCode (**Chat · Terminal · Browser · File Explorer · Plan · Source**) adaptés à ton besoin. Onglets : **Editor, Browser, Plan, Source, Tasks**. (Le "Chat" et le "Terminal" sont déjà couverts par l'orchestrator bar et la grille centrale.)

## 1. Editor (file tree + Monaco)

Reproduit exactement le screenshot (arbre de dossiers à gauche du panneau, fichier ouvert en syntax-highlight).

- **File tree** : `chokidar` côté main watch `project_path`. Renderer reçoit l'arbre + events. Composant arbre virtualisé (react-arborist ou maison). Icônes par extension.
- **Monaco editor** : onglets de fichiers, numéros de ligne, syntax-highlight, détection de langage par extension.
- **Quick Open** `Cmd+P` : fuzzy search des fichiers du projet.
- **File watching** : si un agent modifie un fichier, l'éditeur reflète le changement (reload si non modifié localement, sinon prévenir).
- Lecture/écriture via IPC (`editor.ipc.ts`) — jamais d'accès FS direct dans le renderer.

```ts
// editor.ipc.ts (API)
readDir(path): TreeNode[]
readFile(path): { content: string; language: string }
writeFile(path, content): void
watch(path): // émet 'change'|'add'|'unlink'
```

## 2. Browser (preview localhost)

> Ta spec : « ouvre une page internet localhost liée au projet ; cliquer sur des trucs → voir le code. »

- **Lancer le dev server** : `dev-server.ts` spawn la commande du projet (`npm run dev` / `pnpm dev` / commande configurée par workspace) dans un PTY dédié, **parse le port** depuis la sortie (regex `localhost:(\d+)` ou `http://127.0.0.1:(\d+)`).
- **`<webview>`** Electron charge `http://localhost:<port>`. Barre d'URL + reload + back/forward.
- **Inspect → code (phase 2)** : injecter un script dans la webview qui, au clic sur un élément, renvoie un sélecteur / data-attribute. Si le projet expose une source-map ou des `data-source` (ex. plugins type "click-to-component"), mapper l'élément → fichier:ligne → ouvrir dans l'Editor. Sinon, fallback : copier le sélecteur et demander à un agent de localiser.
- Config par workspace : commande de dev, port attendu, racine web.

```ts
// browser.ipc.ts
startDevServer(workspaceId): { port: number, terminalId: string }
stopDevServer(workspaceId): void
```

## 3. Plan (plan-based execution)

Réplique le "Plan view" de BridgeCode : avant d'exécuter, l'agent propose un plan d'étapes.

- Quand l'orchestrateur (ou un agent) produit un plan, l'afficher en liste ordonnée d'étapes.
- Chaque étape : titre, fichiers concernés, statut (proposé / approuvé / fait).
- Boutons **Approve step** / **Approve all** / **Reject**.
- Une étape approuvée est dispatchée comme task (lien vers `04`).

## 4. Source (diff / versions)

Réplique le "Source" + "Safe by default" de BridgeCode.

- **Diffs proposés** par les agents : liste `M/A/D fichier (+x -y)`, diff Monaco côté-à-côté.
- Boutons **Accept** / **Reject** par fichier et global (`Accept these changes? (Y/n)`).
- **Versions plus anciennes** (« voir le code plus vieux ») :
  - Si le projet est un repo git : lister les commits (`git log`), montrer le diff d'un commit, restaurer un fichier à une version.
  - Sinon : snapshots locaux (copie horodatée avant chaque application de diff) dans `.bridgeforge/snapshots/`.
- IPC `source.ipc.ts` : `gitLog(path)`, `gitDiff(path, ref)`, `applyPatch(...)`, `revertFile(path, ref)`.

## 5. Tasks (Kanban)

Réplique le board BridgeSpace/BridgeMCP.

- Colonnes : **Todo · In Progress · In Review · Complete** (+ Cancelled masqué).
- Cartes = lignes de la table `tasks`. Drag-drop change le statut.
- Bouton sur une carte : **"Run with agent"** → dispatch vers un terminal (réutilise le router de `04`).
- Filtre par projet/workspace.
- Sync bidirectionnelle avec l'orchestrateur (un changement d'état d'agent met à jour la carte, et inversement).

## 6. Mécanique de toggle
- Barre d'onglets en haut du panneau ; clic = change le panneau actif (état dans le store renderer).
- Raccourcis : `Cmd+1..5` pour Editor/Browser/Plan/Source/Tasks (ou réserve `Cmd+1-9` aux workspaces et utilise `Alt+1..5`).
- Splitter draggable entre centre et panneau droit ; largeur persistée par workspace.
- Phase 2 : split horizontal du panneau (ex. Editor en haut, Browser en bas).

## 7. Critère de "done"
- [ ] Editor affiche l'arbre du projet + ouvre des fichiers en highlight.
- [ ] Browser lance le dev server et affiche localhost dans la webview.
- [ ] Source montre un diff et permet Accept/Reject.
- [ ] Tasks affiche le Kanban et le drag-drop change le statut.
- [ ] Toggle entre panneaux instantané, largeur conservée.
