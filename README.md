# Oryon

IDE Electron multi-agents (Windows d'abord) qui pilote des agents CLI Claude Code dans des terminaux PTY.

## Qu'est-ce qu'Oryon

Oryon orchestre plusieurs agents Claude Code en parallèle pour travailler sur un même
dépôt. Chaque workspace possède un **orchestrateur** qui décompose le travail et le délègue
à des **workers**. Chaque worker tourne dans son propre worktree git
(`.oryon/agents/<nom>`, sur la branche `oryon/agent-<nom>`), et le merge-back vers le tronc
est sérialisé pour éviter les conflits. La coordination entre agents passe par un serveur
MCP local (tasks, mailbox, claims de fichiers, mémoire partagée). Oryon intègre aussi un
panneau droit (Docs, Browser, Calendar), de la dictée vocale et un système de feedback.

## Installation

L'app installée se met à jour toute seule. Pour la première installation :

1. Télécharge `Oryon-<version>-Setup.exe` depuis les
   [Releases GitHub](https://github.com/Wrivard/Oryon/releases).
2. Lance l'installeur (NSIS par-utilisateur, sans UAC).
3. Les versions suivantes s'installent en arrière-plan, silencieusement (auto-update via
   electron-updater sur les Releases publiques `Wrivard/Oryon`).

## Développement

Prérequis : **Node 22+** et un dépôt Windows (modules natifs reconstruits pour Electron).

```sh
npm ci          # installe + reconstruit better-sqlite3 (postinstall electron-rebuild)
npm run dev     # lance l'app en dev (ou double-clic sur scripts/dev.cmd)
npm run typecheck   # SEUL garde-fou de types — à passer avant tout commit
```

`npm run typecheck` lance les deux projets TS (`tsconfig.node.json` + `tsconfig.web.json`).
Le build (electron-vite/esbuild) ne typecheck PAS — voir `CLAUDE.md`.

## Build & release

```sh
npm run build         # build electron-vite
npm run dist:win      # installeur NSIS local (release/<version>/)
npm run release:stable   # npm version patch + git push --follow-tags
```

`release:stable` bump la version, crée le tag et le pousse ; la CI
(`.github/workflows/release.yml`) construit l'installeur et publie la Release GitHub, d'où
les apps installées s'auto-updatent.

## Architecture

```
src/
  main/            processus principal Electron
    index.ts       point d'entrée
    db/            better-sqlite3 — schema.ts + migrations/ (DB sous userData)
    ipc/           handlers IPC, un fichier par domaine (*.ipc.ts)
    services/      logique métier (orchestrator/, pty-manager, claude-launcher,
                   mcp-export, groq-stt, updater, worktrees, …)
  preload/
    index.ts       contextBridge → window.bridge (surface exposée au renderer)
  renderer/src/    app React (App.tsx, components/, hooks/, lib/) — Zustand + Tailwind
  mcp/             serveur MCP stdio en JS pur : server.mjs + lecteurs *-read.mjs
  shared/          types.ts + modules « core » .mjs (avec jumeaux .d.mts)
scripts/           before-pack.cjs (bundle le serveur MCP), dev.cmd (lance le dev)
docs-plans/        rapports d'audit historiques
plans/             plans d'implémentation numérotés (voir plans/README.md)
```

Stack : Electron 41 + electron-vite 2, TypeScript 5.5, React 18 + Zustand 5 + Tailwind 3,
better-sqlite3, @lydell/node-pty, serveur MCP stdio (`@modelcontextprotocol/sdk`), koffi
(FFI Win32 : hotkeys / injection clavier), `@huggingface/transformers` (Whisper local) +
Groq STT, electron-updater.

## Conventions

Les conventions critiques pour modifier ce dépôt (invariant coût $0, jumeaux `.d.mts`,
stdout interdit dans le serveur MCP, format des commits, etc.) sont dans **`CLAUDE.md`** —
à lire avant toute contribution, humaine ou agent.

## Docs historiques

Les fichiers numérotés à la racine (`00-OVERVIEW.md` … `09-CLAUDE-CODE-PROMPTS.md`) et le
dossier `docs-plans/` sont les **plans de construction et audits historiques** : ils peuvent
diverger du code actuel. La source de vérité reste le code + `plans/` (état courant des
chantiers).
