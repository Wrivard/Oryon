# Plan 013 : Intégrité du ledger — jeton taskId dans report_task, plus de recyclage de tâches, demote des morts-nés

> **Instructions exécuteur** : suis ce plan étape par étape ; chaque vérification doit
> donner le résultat attendu. Condition STOP → arrête et rapporte. Le reviewer tient
> `plans/README.md`.
>
> **Drift check** : `git diff --stat 29c8ae5..HEAD -- src/main/services/orchestrator/router.ts src/main/services/orchestrator/task-store.ts src/mcp/server.mjs src/main/services/mcp-export.ts src/main/services/orchestrator/roles.ts`
> ATTENDU : router.ts retouché par 003/008/009/011, server.mjs + mcp-export par 002.
> RELIS l'état réel des zones citées (numéros de lignes décalés) ; si une zone a changé
> de STRUCTURE, STOP.

## Statut

- **Priorité** : P1 — **Effort** : M–L — **Risque** : MED-HIGH (cœur du cycle de vie des tâches)
- **Dépend de** : plans 002 et 011 mergés
- **Catégorie** : bug — **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Preuves terrain (store system-feedback, kua-coiffure) : rapport `a99d20e5` (error) —
après des restart_agent, le **report_task d'un agent a FERMÉ la tâche d'un AUTRE agent**
(le résumé de Cole a clos la tâche de Roan) ; rapport `c0834efb` (warning) — assign_task
a **recyclé un vieux taskId** d'une tâche terminée (titres mensongers au board, outcomes
empilés sur le mauvais enregistrement, fausses alarmes du cap anti-boucle). Causes dans
le code : (1) l'attribution d'un report se fait par DÉDUCTION nom→terminal→« dernière
tâche in-progress » au lieu d'un identifiant explicite — alors que le contrat injecté
contient DÉJÀ `[task <id>]` ; (2) la réutilisation d'une tâche « ouverte » du terminal
garde son TITRE d'origine même quand l'assign porte un titre différent (= travail
DIFFÉRENT) ; (3) un worker mort-né laisse sa tâche in-progress pour toujours (le
watchdog signale mais ne rétrograde jamais — R3, admis en commentaire).

## État actuel (au commit 29c8ae5 — relocalise après les merges)

- `src/mcp/server.mjs`, outil `report_task` (~l.760-780) : schéma zod
  `{ status, summary, files_changed?, committed? }` — PAS de taskId ; émet
  `queueCommand({ type: 'report-task', workspaceId, fromAgent: from, status, summary, filesChanged, committed })`.
- `src/main/services/mcp-export.ts` (~l.162-166) : `agentReportTask(cmd.workspaceId,
  cmd.fromAgent ?? null, cmd.status, cmd.summary ?? '', { filesChanged, committed })`.
- `src/main/services/orchestrator/router.ts` :
  - `agentReportTask` (~l.455-470) : `termId` résolu par NOM (`fromAgent`), puis
    `task = [...listTasks(workspaceId)].reverse().find((t) => t.assigned_terminal_id === termId && t.status === 'in-progress')`.
  - `agentAssignTask`, réutilisation (~l.331-339) : `open = …find(assigned===id && (in-progress|in-review))` ;
    si open → `updateTask(open.id, { status:'in-progress', instructions, assigned_terminal_id })`
    — le TITRE n'est jamais mis à jour.
  - `tickWatchdog` (~l.604-632) : cas `deadOnArrival = last === undefined` (zéro octet
    depuis le dispatch) → notifie seulement.
  - Le prompt de dispatch commence par `[task ${task.id}]` (zone réécrite par le plan
    008 — le préfixe reste, en inline comme en mode fichier).
- `src/main/services/orchestrator/task-store.ts`, `updateTask` (l.64-78) : champs
  autorisés `Pick<Task, 'status' | 'assigned_terminal_id' | 'instructions'>`.
- `src/main/services/orchestrator/roles.ts`, prompt worker (l.43) : « …call report_task
  ONCE at the very end… ».

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Syntaxe serveur | `node --check src/mcp/server.mjs` | exit 0 |
| Tests | `npm test` | exit 0 |

## Périmètre

**In scope** : router.ts (agentReportTask, agentAssignTask-réutilisation, tickWatchdog),
task-store.ts (updateTask + title), server.mjs (schéma report_task), mcp-export.ts
(passage du taskId), roles.ts (une phrase du prompt worker).

**Out of scope** : la création de tâche elle-même (createTask), approve/merge-back,
les outils MCP autres que report_task, le rebinding PTY (couvert par 011).

## Workflow git

Branche `oryon/agent-<ton-nom>` ; commits conventionnels, ex.
`fix(orchestrator): attribution des reports par jeton taskId + titres honnêtes + demote morts-nés`. Ne push pas.

## Étapes

### Étape 1 : taskId de bout en bout

- server.mjs/report_task : ajoute `task_id: z.string().optional().describe('l\'id [task …] reçu dans ton contrat — fournis-le TOUJOURS si tu l\'as')`
  au schéma ; émets `taskId: task_id ?? null` dans la commande. (stdout interdit, comme toujours.)
- mcp-export : passe `cmd.taskId ?? null` à agentReportTask (nouveau 6e paramètre ou
  dans l'objet claimed — choisis la signature la plus propre et type-la).
- router.agentReportTask : si `taskId` fourni → `const t = getTask(taskId)` ; VALIDE
  qu'il appartient au même workspace ET que son `assigned_terminal_id` correspond au
  terminal résolu par nom quand les deux existent — sur MISMATCH, logge
  `console.error('[router] report_task : jeton taskId ≠ déduction par nom', …)` et
  PRÉFÈRE le jeton (c'est l'identité explicite ; la déduction par nom est celle qui a
  fermé la tâche du voisin). Repli sans jeton = déduction actuelle, inchangée.
- roles.ts (prompt worker, l.43) : complète la phrase report_task par : « include the
  task_id from the [task …] tag of your contract ».

**Vérifier** : `node --check src/mcp/server.mjs` exit 0 ; `npm run typecheck` exit 0.

### Étape 2 : plus de recyclage silencieux à l'assign

Dans agentAssignTask, branche `open` : si un `title` est fourni ET qu'il diffère de
`open.title` (comparaison trim) → ce n'est PAS un re-dispatch de la même tâche :
`updateTask(open.id, { status: 'todo', assigned_terminal_id: null })` (la vieille
retourne au board, claims libérés par le flux existant) puis CRÉE une tâche fraîche
(chemin createTask existant). Sinon (même titre ou pas de titre) : réutilisation
actuelle MAIS ajoute la mise à jour du titre si fourni : étends updateTask
(task-store.ts) au champ `title` (`Pick<…|'title'>`) et passe-le.

**Vérifier** : `npm run typecheck` exit 0.

### Étape 3 : demote des morts-nés (tickWatchdog)

Dans le cas `deadOnArrival` : si `now - ref > DEADBORN_DEMOTE_MS` (nouvelle constante,
10 min, commentée : > STALL_MS pour laisser la notification précéder l'action) →
en PLUS de la notification : `updateTask(busy, { status: 'todo', assigned_terminal_id: null })`,
`terminalBusy.set(tid, null)`, libère les claims de l'agent
(`releaseClaimsByAgent(ws.project_path, name).catch(…)` — motif loggé du plan 003),
`recordOutcome({ event: 'abandoned', reason: 'dead-born-demote', … })` (aligne-toi sur
l'event 'abandoned' existant de l'exit-observer), et un message orchestrateur explicite
« task X rétrogradée todo (worker mort-né >10 min) — réassigne-la ». ⚠ UNIQUEMENT le
cas deadOnArrival (zéro octet depuis dispatch) — JAMAIS le cas « silencieux mais a déjà
émis » (un claude qui réfléchit longtemps est légitime).

**Vérifier** : `npm run typecheck` exit 0.

### Étape 4 : test de non-régression (suite 007)

Ajoute `tests/task-attribution.test.ts` si la mécanique est testable sans Electron
(getTask/updateTask mockés ou DB :memory: via better-sqlite3 directe) ; si le câblage
dépasse ~40 lignes de mocks, SAUTE et note-le (le typecheck + revue suffisent pour ce
lot ; le harnais task-store viendra plus tard).

**Vérifier** : `npm test` exit 0.

## Plan de test

typecheck + node --check + npm test. Runtime (reviewer, post-merge + rebuild) :
dispatch → report avec jeton visible dans outcomes ; assign d'un titre NEUF sur un
terminal portant une vieille tâche ouverte → 2 lignes distinctes au board.

## Critères de done

- [ ] report_task accepte task_id et la commande le transporte jusqu'au router
- [ ] Attribution : jeton prioritaire + log sur mismatch ; repli nom inchangé
- [ ] Assign titre-différent → vieille tâche demote + tâche fraîche (plus de recyclage)
- [ ] updateTask supporte title ; réutilisation légitime met le titre à jour
- [ ] deadOnArrival > 10 min → demote todo + claims libérés + outcome 'abandoned'
- [ ] `npm run typecheck`, `node --check server.mjs`, `npm test` : verts
- [ ] `git status` : seulement les 5 fichiers in-scope

## Conditions STOP

- agentReportTask/agentAssignTask ont été restructurés par les plans précédents au-delà
  des zones décrites — rapporte leur forme réelle.
- La signature d'agentReportTask est appelée ailleurs que mcp-export (grep) avec une
  forme incompatible.
- Le test de l'étape 4 exige > ~40 lignes de mocks (saute, note).

## Notes de maintenance

- Les rapports system-feedback `a99d20e5` + `c0834efb` passent en 'reviewed' au merge.
- Reviewer : scruter le mismatch-log (jeton ≠ nom) — c'est le détecteur du bug de
  rebinding PTY ; s'il apparaît en production, c'est 011 qu'il faut re-examiner.
- Le cap anti-boucle (attemptByTask) se réinitialise naturellement avec les tâches
  fraîches — vérifier en revue qu'aucun chemin ne ré-incrémente l'ancienne.
