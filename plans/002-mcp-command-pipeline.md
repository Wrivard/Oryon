# Plan 002 : Pipeline de commandes MCP→main — écritures atomiques, zéro latence artificielle, dispatch sérialisé

> **Instructions exécuteur** : suis ce plan étape par étape. Lance chaque commande de
> vérification et confirme le résultat attendu avant de continuer. Si une condition
> STOP survient, arrête et rapporte — n'improvise pas. Le reviewer tient l'index
> `plans/README.md`.
>
> **Drift check (à lancer d'abord)** :
> `git diff --stat 29c8ae5..HEAD -- src/mcp/server.mjs src/main/services/mcp-export.ts src/shared/`
> Sur écart avec les extraits « État actuel », condition STOP.

## Statut

- **Priorité** : P1
- **Effort** : S–M
- **Risque** : LOW (le code modifié ne tourne que dans le BUILD suivant, pas dans l'app en cours)
- **Dépend de** : aucun
- **Catégorie** : perf + bug
- **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

TOUTES les commandes des agents (assign_task, approve_task, report_task, mailbox,
update_task_status, broadcast, etc.) transitent par des fichiers JSON déposés dans
`mcp-state/commands/`, surveillés par chokidar côté main. Le watcher est configuré
`awaitWriteFinish: true`, dont le défaut chokidar est **stabilityThreshold = 2000 ms** :
chaque commande de chaque orchestrateur paie un plancher d'environ 2 secondes avant
d'être traitée. Cette option n'existe que parce que l'écriture côté serveur MCP est un
`writeFileSync` NON atomique (risque de lecture partielle). En écrivant tmp+rename
(atomique), on peut supprimer `awaitWriteFinish` et rendre la flotte réactive.
Au passage on corrige deux défauts du même fichier : les commandes sont traitées en
CONCURRENCE (le handler `on('add', processCommand)` n'attend pas la précédente — ordre
non garanti), et un `cmd.type` inconnu est silencieusement supprimé sans le moindre log.

## État actuel

- `src/mcp/server.mjs` — serveur MCP stdio en JS pur, spawné par terminal agent.
  **RÈGLE ABSOLUE : ne JAMAIS écrire sur stdout dans ce fichier (stdout = protocole
  MCP) ; les logs passent par `console.error`.**
  - lignes 634-640 (écrivain central) :
    ```js
    function queueCommand(cmd) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      const full = { id, ...cmd }
      mkdirSync(join(STATE_DIR, 'commands'), { recursive: true })
      writeFileSync(join(STATE_DIR, 'commands', `${id}.json`), JSON.stringify(full, null, 2))
      return id
    }
    ```
  - lignes ~590-601 (outil `send_mailbox`) et ~605-622 (outil `update_task_status`) :
    deux écrivains INLINE dupliqués qui construisent `const cmd = { id, type: 'mailbox', … }`
    puis font leur propre `writeFileSync(join(STATE_DIR, 'commands', `${id}.json`), …)`
    dans un try/catch retournant `{ queued: true, id, … }` / `{ queued: false, error }`.
  - Inventaire COMPLET des 15 types émis (vérifié au commit 29c8ae5) : `docs-import`,
    `report-system-issue`, `resolve-system-issue`, `mailbox`, `update-task-status`,
    `browser-open`, `browser-screenshot`, `assign-task`, `approve-task`, `report-task`,
    `broadcast-command`, `restart-agent`, `flush-archive`, `reset-orchestrator`,
    `add-connector`.
- `src/main/services/mcp-export.ts` — pont commandes→main :
  - lignes 142-213 : `async function processCommand(path)` — `JSON.parse(readFileSync(path))`
    puis une chaîne `if/else if` couvrant EXACTEMENT les 15 types ci-dessus ; à la fin
    `unlinkSync(path)` ; catch global → `console.error('[mcp-export] commande échouée :', path, e)`.
    AUCUNE branche `else` finale (type inconnu = silencieux).
  - lignes 263-269 : sweep de boot qui supprime les `*.json` résiduels du dossier.
  - lignes 270-271 :
    ```ts
    commandWatcher = chokidar.watch(join(commandsDir, '*.json'), { awaitWriteFinish: true, ignoreInitial: true })
    commandWatcher.on('add', processCommand)
    ```
- Convention twin-file du repo : un module partagé `.mjs` (importable par server.mjs,
  JS pur) reçoit un jumeau `.d.mts` pour l'import TypeScript côté main — exemplaire :
  `src/shared/memory-core.mjs` + `src/shared/memory-core.d.mts`.

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Installer (1× si node_modules absent) | `npm ci --ignore-scripts` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Smoke import du module partagé | `node -e "import('./src/shared/command-types.mjs').then(m => console.log(m.COMMAND_TYPES.length))"` | affiche `15` |

## Périmètre

**In scope** :
- `src/shared/command-types.mjs` (créer)
- `src/shared/command-types.d.mts` (créer)
- `src/mcp/server.mjs`
- `src/main/services/mcp-export.ts`

**Out of scope** :
- `scripts/before-pack.cjs` (le bundle esbuild inline déjà les imports relatifs de
  server.mjs — aucun changement requis ; si tu crois le contraire → STOP).
- Les handlers métier appelés par processCommand (agentAssignTask, etc.).
- Tout fichier renderer/preload.

## Workflow git

- Branche `oryon/agent-<ton-nom>` dans ton worktree. Commits conventionnels, ex.
  `fix(mcp): écritures de commandes atomiques + dispatch sérialisé`.
- Ne push pas (merge via approve_task).

## Étapes

### Étape 1 : créer `src/shared/command-types.mjs` + son jumeau `.d.mts`

`command-types.mjs` :
```js
// Types des commandes MCP→main (fichiers JSON sous mcp-state/commands/). SOURCE DE VÉRITÉ
// partagée : server.mjs les ÉMET (queueCommand), mcp-export.ts les TRAITE (processCommand).
// Tout NOUVEAU type doit être ajouté ICI + recevoir un handler dans processCommand —
// un type absent de cette liste est loggé en erreur côté main (jamais silencieux).
export const COMMAND_TYPES = Object.freeze([
  'mailbox', 'update-task-status', 'assign-task', 'report-task', 'approve-task',
  'broadcast-command', 'restart-agent', 'add-connector', 'browser-open',
  'browser-screenshot', 'docs-import', 'flush-archive', 'reset-orchestrator',
  'report-system-issue', 'resolve-system-issue',
])
```
`command-types.d.mts` (modèle : `src/shared/memory-core.d.mts`) :
```ts
export declare const COMMAND_TYPES: readonly string[]
```

**Vérifier** : la commande smoke du tableau affiche `15`.

### Étape 2 : rendre l'écriture atomique dans `queueCommand` (server.mjs)

Remplace le corps de `queueCommand` (lignes 634-640) par tmp + rename, avec un retry
court sur EPERM/EBUSY (Windows) — même esprit que `renameRetry` de memory-core :

```js
function queueCommand(cmd) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const full = { id, ...cmd }
  const dir = join(STATE_DIR, 'commands')
  mkdirSync(dir, { recursive: true })
  // Écriture ATOMIQUE (tmp → rename) : le watcher main ne voit JAMAIS un JSON partiel,
  // ce qui permet de surveiller sans awaitWriteFinish (latence ~0 au lieu de ~2 s).
  const tmp = join(dir, `${id}.json.tmp`)
  writeFileSync(tmp, JSON.stringify(full, null, 2))
  let lastErr
  for (let i = 0; i < 5; i++) {
    try { renameSync(tmp, join(dir, `${id}.json`)); return id } catch (e) { lastErr = e }
  }
  throw lastErr
}
```
`renameSync` est déjà importé ? NON — vérifie la ligne d'import `node:fs` en tête de
server.mjs (ligne 14 : `readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, unlinkSync`) et ajoutes-y `renameSync`.

**Vérifier** : `node --check src/mcp/server.mjs` → exit 0.

### Étape 3 : dédupliquer les deux écrivains inline (send_mailbox, update_task_status)

Dans les outils `send_mailbox` (~590) et `update_task_status` (~605), remplace la
construction manuelle `const cmd = { id, type: …, … }` + `writeFileSync(…)` par un appel
à `queueCommand({ type: 'mailbox', workspaceId, fromAgent: from, body })` (resp.
`{ type: 'update-task-status', taskId, status }`), en conservant EXACTEMENT les formes
de réponse actuelles (`{ queued: true, id, workspaceId }` / `{ queued: true, id, taskId, status }`,
et le catch → `{ queued: false, error: String(e) }`).

**Vérifier** : `node --check src/mcp/server.mjs` exit 0 ; `grep -n "writeFileSync(join(STATE_DIR, 'commands'" src/mcp/server.mjs` ne matche plus QUE l'intérieur de queueCommand (1 occurrence).

### Étape 4 : watcher sans awaitWriteFinish + dispatch sérialisé + type inconnu loggé (mcp-export.ts)

a) Import en tête : `import { COMMAND_TYPES } from '../../shared/command-types.mjs'`.

b) Le sweep de boot (lignes 263-269) supprime aussi les `.json.tmp` résiduels :
étends le filtre à `f.endsWith('.json') || f.endsWith('.json.tmp')`.

c) Remplace les lignes 270-271 par :
```ts
// Écritures côté serveur MCP désormais ATOMIQUES (tmp+rename, cf. command-types.mjs) →
// plus besoin d'awaitWriteFinish (qui coûtait ~2 s de stabilityThreshold PAR commande).
// File FIFO : une commande à la fois, dans l'ordre d'arrivée (processCommand est async ;
// sans chaîne, deux fichiers proches s'entrelacent et l'ordre des mutations n'est pas garanti).
commandWatcher = chokidar.watch(join(commandsDir, '*.json'), { ignoreInitial: true })
let cmdChain: Promise<void> = Promise.resolve()
commandWatcher.on('add', (p: string) => {
  cmdChain = cmdChain.then(() => processCommand(p)).catch(() => {})
})
```
(Déclare `cmdChain` au niveau module si l'inline dans initMcpExport ne convient pas — les deux sont acceptables, reste cohérent avec le style du fichier.)

d) Dans `processCommand`, ajoute la branche finale APRÈS le dernier `else if` :
```ts
} else {
  console.error('[mcp-export] type de commande inconnu (pas dans COMMAND_TYPES ou handler manquant) :', cmd.type, path)
}
```
et (défense en profondeur) si `!COMMAND_TYPES.includes(cmd.type)` au tout début, logge
la même erreur et continue vers l'unlink (pas de double traitement).

**Vérifier** : `npm run typecheck` exit 0.

### Étape 5 : commentaire de couplage dans server.mjs

Au-dessus de `queueCommand`, ajoute : `// Tout nouveau type émis ici DOIT être ajouté à src/shared/command-types.mjs + un handler dans mcp-export.processCommand.`

**Vérifier** : `git diff --stat` ne liste QUE les 4 fichiers in-scope.

## Plan de test

Pas de framework de test encore (le plan 007 l'apporte). Vérifications de ce plan :
`node --check` sur server.mjs, smoke import du module partagé, `npm run typecheck`.
Quand 007 sera mergé, un test « parité COMMAND_TYPES ↔ branches processCommand » est
un bon candidat de suivi (note-le dans ton rapport, ne l'implémente pas).

## Critères de done

- [ ] `node -e "import('./src/shared/command-types.mjs').then(m => console.log(m.COMMAND_TYPES.length))"` → 15
- [ ] `node --check src/mcp/server.mjs` → exit 0
- [ ] Une SEULE écriture `commands/` dans server.mjs (queueCommand), atomique tmp+rename
- [ ] `grep -n "awaitWriteFinish" src/main/services/mcp-export.ts` → 0 résultat
- [ ] Dispatch sérialisé (chaîne de promesses) + branche else « type inconnu » présente
- [ ] `npm run typecheck` exit 0
- [ ] `git status` : seuls les 4 fichiers in-scope touchés

## Conditions STOP

- Les extraits « État actuel » ne correspondent pas (drift).
- Tu découvres une ÉMISSION de type non listée dans les 15 (le plan est alors périmé).
- Tu crois devoir modifier `scripts/before-pack.cjs` pour que l'import de
  command-types.mjs soit bundlé — STOP et rapporte (le bundle esbuild suit les imports
  relatifs ; si ce n'est pas le cas, c'est au reviewer d'arbitrer).

## Notes de maintenance

- Le plan 013 (intégrité ledger) retouchera processCommand (report-task) — il hérite de
  la file FIFO posée ici.
- Reviewer : scruter l'étape 3 (les formes de réponse des deux outils doivent être
  byte-identiques à l'existant — les orchestrateurs en production les parsent).
- Suivi explicite hors périmètre : test de parité types↔handlers (après plan 007).
