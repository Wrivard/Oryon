# 03 — Terminaux & intégration Claude Code

C'est le cœur fonctionnel : chaque cellule de la grille est un vrai terminal qui lance **Claude Code CLI** déjà positionné dans le dossier du projet.

## 1. Stack terminal

- **Main** : `node-pty` spawn un pseudo-terminal par cellule.
- **Renderer** : `xterm.js` + addons `xterm-addon-fit`, `xterm-addon-search`, `xterm-addon-web-links`.
- Le flux d'octets PTY ↔ xterm passe par IPC (`onData` / `write`).

## 2. PTY Manager (main)

```ts
// src/main/services/pty-manager.ts
import * as pty from 'node-pty';
import os from 'os';

type Term = { id: string; proc: pty.IPty };
const terms = new Map<string, Term>();

export function createTerminal(opts: {
  id: string;
  cwd: string;            // = workspace.project_path
  autostart?: string;     // ex "claude"
  cols: number; rows: number;
  onData: (data: string) => void;
  onExit: () => void;
}) {
  const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
  const proc = pty.spawn(shell, [], {
    name: 'xterm-color',
    cwd: opts.cwd,                 // <-- déjà dans le dossier du projet
    cols: opts.cols, rows: opts.rows,
    env: process.env,
  });
  proc.onData(opts.onData);
  proc.onExit(opts.onExit);
  terms.set(opts.id, { id: opts.id, proc });

  // Lancement auto de Claude Code dans le projet
  if (opts.autostart) {
    // petit délai pour laisser le shell s'initialiser
    setTimeout(() => proc.write(`${opts.autostart}\r`), 300);
  }
  return opts.id;
}

export function writeTerminal(id: string, data: string) {
  terms.get(id)?.proc.write(data);
}
export function resizeTerminal(id: string, cols: number, rows: number) {
  terms.get(id)?.proc.resize(cols, rows);
}
export function killTerminal(id: string) {
  terms.get(id)?.proc.kill();
  terms.delete(id);
}
```

> Comme `cwd` = le dossier du projet, **le `cd` est déjà fait**. `autostart: 'claude'` lance Claude Code directement dans ce dossier. Exactement ta spec.

## 3. Lancement de Claude Code

Construire la commande dans `claude-launcher.ts`. Selon le rôle/agent du terminal, on peut varier le flag :

```ts
// src/main/services/claude-launcher.ts
export function buildClaudeCommand(opts: {
  role?: 'builder'|'reviewer'|'scout'|'coordinator'|'free';
  model?: string;            // ex "opus" / défaut
  appendSystemPrompt?: string;
  resume?: boolean;
}) {
  // Interactive : on lance `claude` et on injectera les prompts via le PTY.
  // Pour les sous-agents non-interactifs, on peut utiliser le mode "print" / headless.
  let cmd = 'claude';
  if (opts.model) cmd += ` --model ${opts.model}`;
  if (opts.appendSystemPrompt) {
    // échapper proprement (utiliser un fichier temp si long)
    cmd += ` --append-system-prompt ${shellQuote(opts.appendSystemPrompt)}`;
  }
  if (opts.resume) cmd += ' --continue';
  return cmd;
}
```

> ⚠️ **Les flags exacts de Claude Code CLI évoluent.** Avant de coder, demande à Claude Code (dans le terminal) `claude --help` et fixe les flags réellement disponibles dans ta version (`v2.1.x`). Le plan suppose : mode interactif par défaut + un mode non-interactif/headless pour l'orchestrateur (souvent `claude -p "<prompt>"` ou équivalent). **Vérifier et adapter.**

## 4. Deux modes d'usage de Claude Code

1. **Interactif (par défaut, ce que montre le screenshot)** : `claude` tourne, tu/l'orchestrateur écrivez des prompts dans le PTY. C'est conversationnel, l'agent garde le contexte.
2. **Headless / one-shot (pour l'orchestrateur en arrière-plan)** : exécuter une task précise sans session interactive, capter le résultat. Utile quand le coordinator pousse une task et veut un statut programmatique. À mapper sur le flag print/headless réel de ta version.

> Ton app Küa fait déjà tourner "Claude Code CLI headless en arrière-plan" — réutilise ce que tu as appris là (parsing de sortie, détection de fin de tâche).

## 5. Injection d'un prompt dans un terminal (depuis l'orchestrateur)

```ts
// src/main/ipc/orchestrator.ipc.ts (extrait)
function dispatchToTerminal(terminalId: string, prompt: string) {
  // 1. s'assurer que claude est prêt (cf. §6 detection)
  // 2. écrire le prompt + Enter
  writeTerminal(terminalId, prompt.replace(/\n/g, ' ') + '\r');
}
```

## 6. Détection "shell prêt" / "claude prêt"

BridgeSpace, dans son agent execution, **attend le prompt shell** avant d'envoyer la commande. À répliquer :
- Heuristique simple : attendre que la sortie contienne le marqueur de prompt (`% `, `$ `, ou la bannière Claude Code "Welcome to Claude Code").
- Plus robuste : écrire un sentinel (`echo __READY__`) et attendre de le voir réapparaître.
- Pour Claude Code interactif : détecter sa zone d'input (bannière + curseur). Garder une petite **state machine par terminal** : `spawning → shell_ready → claude_starting → claude_ready → busy → idle`.

## 7. Resize & fit
- À chaque resize de la cellule (ou de la fenêtre), `FitAddon.fit()` côté renderer → envoyer `cols/rows` au main → `resizeTerminal`.

## 8. Persistance & restauration
- À l'ouverture d'un workspace : recréer les N terminaux depuis la table `terminals` (mêmes noms/couleurs/cwd) et relancer `claude`.
- Option : sauvegarder le scrollback récent (phase 2).

## 9. Sécurité
- Confirmer avant d'exécuter des commandes destructrices proposées par l'orchestrateur (s'aligne sur "Safe by default").
- Ne jamais auto-`rm -rf`. L'orchestrateur propose, l'humain (ou une règle) approuve.

## 10. Critère de "done" pour cette couche
- [ ] Créer un workspace pointant sur un dossier réel.
- [ ] 8 terminaux apparaissent, chacun `cd` dans le projet, `claude` lancé automatiquement.
- [ ] Je peux taper dans chaque terminal et voir la sortie en temps réel.
- [ ] split / close / focus fonctionnent.
- [ ] Au redémarrage de l'app, le workspace se restaure.
