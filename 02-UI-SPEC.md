# 02 — Spec UI (réplication du look BridgeSpace)

Basé sur le screenshot réel fourni + page produit BridgeSpace. L'objectif : un IDE dark-first, dense, "command center".

## 1. Layout global (3 colonnes + barres)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ Title bar (Electron, native macOS)  ·  "BridgeForge"  ·  nom du workspace   │
├──────┬──────────────────────────────────────────────────────┬──────────────┤
│      │  TERMINAL GRID (centre)                               │ RIGHT PANEL  │
│ RAIL │  ┌────────┬────────┬────────┬────────┐                │ ┌──────────┐ │
│ GCHE │  │ Nell   │ Cole   │ Lia    │ Roan   │  rangée haute  │ │ toggles: │ │
│      │  ├────────┼────────┼────────┼────────┤                │ │ Editor   │ │
│ WS1  │  │ Jude   │ Gus    │ Kai    │ Cruz   │  rangée basse  │ │ Browser  │ │
│ WS2  │  └────────┴────────┴────────┴────────┘                │ │ Plan     │ │
│      │                                                       │ │ Source   │ │
│  +   │                                                       │ │ Tasks    │ │
├──────┴──────────────────────────────────────────────────────┴──────────────┤
│ ORCHESTRATOR BAR (input pleine largeur, en bas) + flux de tasks            │
└───────────────────────────────────────────────────────────────────────────┘
        (Widget Voice flottant, always-on-top, positionnable)
```

Largeurs par défaut : rail gauche `220px` (collapsible), panneau droit `~38%` (resizable via splitter), centre = reste.

## 2. Rail gauche — Workspaces

- Titre "WORKSPACES" + bouton `+`.
- Chaque entrée : pastille de couleur + nom du workspace + **badge** avec nombre de terminaux actifs (comme `4` dans le screenshot).
- Workspace actif = surligné (fond légèrement plus clair, barre d'accent à gauche).
- Clic droit : renommer, changer couleur, fermer, révéler le dossier projet.
- En bas : bouton réglages (thèmes, API key).

## 3. Grille de terminaux (centre)

- Templates de layout : **1, 2, 4, 6, 8, 10, 12, 14, 16** (comme BridgeSpace). Par défaut 8 (2×4) selon ta spec.
- `gridTemplates.ts` mappe chaque template à un `grid-template-columns/rows`.
- **Onglet de chaque terminal** (header de la cellule) :
  - pastille de couleur + nom de l'agent (Nell, Cole, Lia, Roan, Jude, Gus, Kai, Cruz…),
  - icônes à droite : split-H, split-V, expand/maximize, restore, close (`×`).
  - Terminal "focus" = bordure d'accent (orange dans le screenshot, ex. `Kai`).
- Corps : `xterm.js`. Police mono (JetBrains Mono / SF Mono), ligatures off.
- En haut de session, on voit la commande lancée : `matthewmiller@Mac-Studio bridgemind %` puis `Claude Code v2.1.x · Opus 4.8 (1M context) with medium effort · Claude Max · ~/Desktop/bridgemind`.
- **Command blocks façon Warp** (phase 2) : chaque commande + sortie = bloc collapsible avec indicateur exit-code (vert/rouge) + timestamp.

### Actions terminal
- `Cmd+D` split, `Cmd+F` recherche dans la sortie, clic droit = menu (copy/paste/clear/split), drag-drop d'un fichier = colle le chemin.

## 4. Panneau droit toggleable

Barre d'onglets en haut du panneau. Un seul actif à la fois (ou split horizontal en phase 2). Onglets :

| Onglet | Contenu | Détail |
| --- | --- | --- |
| **Editor** | File tree + Monaco | Comme le screenshot : arbre (`agent-discord`, `bridge-battle`, `bridgemind-api`…), fichier ouvert (`index.html`) en syntax-highlight, numéros de ligne, onglets de fichiers. Quick Open `Cmd+P`. |
| **Browser** | `<webview>` localhost | Barre d'URL, reload, bouton "Inspect → code" (clic sur élément → ouvre le fichier source correspondant si mappable). |
| **Plan** | Plan-based execution | Liste d'étapes proposées par l'agent avant exécution (BridgeCode-like), accept/approve par étape. |
| **Source** | Diff / versions | Diffs proposés (`M src/app/page.tsx +12 -4`, `A …`), boutons Accept/Reject, accès aux versions plus anciennes (git log / snapshots). |
| **Tasks** | Kanban | Colonnes Todo · In Progress · In Review · Complete. Drag-drop. Lancer un agent depuis une carte. |

> Le "Safe by default" de BridgeCode = panneau **Source** : rien n'est appliqué sans ton accord (`Accept these changes? (Y/n)`).

## 5. Orchestrator bar (bas)

- Input large (placeholder : "Dis à l'orchestrateur ce qu'il faut construire…").
- Bouton micro (déclenche Voice).
- À l'envoi : affiche le **plan de décomposition** (tasks générées) avec, pour chacune, l'agent assigné et un bouton "dispatch / re-route".
- Flux live : chaque task change d'état (todo→in-progress→…) et on voit vers quel terminal elle a été poussée.

## 6. Thèmes (dark-first)

Répliquer l'esprit BridgeSpace : 25+ thèmes. Implémenter via **CSS variables** + un `ThemeProvider`.

Dark (au moins) : `Void, Ghost, Plasma, Carbon, Hex, Neon Tokyo, Obsidian, Nebula, Storm, Infrared, Nova, Stealth, Hologram, Dracula, BridgeMind, Synthwave, Cybernetics, Quantum, Mecha, Abyss`.
Light : `Paper, Chalk, Solar, Arctic, Ivory`.

Tokens minimaux par thème :
```ts
type Theme = {
  name: string;
  bg: string;          // fond app (ex #0a0a0f)
  bgPanel: string;     // panneaux
  bgTerminal: string;
  fg: string;          // texte
  fgMuted: string;
  accent: string;      // surlignages, focus (ex orange)
  success: string;     // exit-code ok
  danger: string;      // exit-code fail
  border: string;
  terminalTabColors: string[]; // palette pour nommer les agents
};
```
Thème par défaut = "BridgeMind" / "Void" (fond quasi noir `#0a0a0f`, accent orange).

## 7. Détails de polish
- Coins légèrement arrondis (`6px`), bordures fines `1px` à faible opacité.
- Titres de section en uppercase, letter-spacing léger (cf. ton design system Küa).
- Densité élevée, peu de padding (c'est un outil de pro, pas une landing).
- Indicateur "scroll to bottom" flottant dans les terminaux.
- Auto-update (electron-updater) en phase finale.

## 8. Police & icônes
- Mono : JetBrains Mono ou SF Mono.
- UI : Inter / Geist.
- Icônes : `lucide-react`.
