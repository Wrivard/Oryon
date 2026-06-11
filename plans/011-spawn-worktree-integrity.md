# Plan 011 : Intégrité spawn/worktree — cwd toujours = worktree, health-check git, identité env complète

> **Instructions exécuteur** : suis ce plan étape par étape ; chaque vérification doit
> donner le résultat attendu. Condition STOP → arrête et rapporte. Le reviewer tient
> `plans/README.md`.
>
> **Drift check** : `git diff --stat 29c8ae5..HEAD -- src/main/ipc/terminals.ipc.ts src/main/services/worktrees.ts src/main/services/orchestrator/router.ts src/main/ipc/workspaces.ipc.ts`
> ATTENDU : router.ts/worktrees.ts modifiés par les plans 003/008/009 — relis l'état
> RÉEL des zones citées ; si une zone visée a fondamentalement changé, STOP.

## Statut

- **Priorité** : P1 — **Effort** : M — **Risque** : MED-HIGH (chemin de spawn de la flotte)
- **Dépend de** : plans 003 + 008 mergés (router.ts séquentiel)
- **Catégorie** : bug — **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Preuves terrain (store system-feedback, workspace kua-coiffure) : rapport `1975b0b1`
(error) — workers spawnés avec **cwd = ARBRE PRINCIPAL** quand le worktree manquait
(Cole y a exécuté sa tâche DANS le tronc = contamination réelle), worktrees corrompus
(refs remplies de 0x00) NON détectés, `ORYON_TERMINAL_ID` absent de l'env (« empty so
no task maps to me ») ; rapport `1234317c` (error) — `restart_agent` relance AUSSI avec
cwd = racine, reproduisant le bug au lieu de le corriger. Et CONFIRMÉ dans le workspace
Oryon le 2026-06-11 : Jude rapporte « ORYON_TERMINAL_ID vide ». Trois correctifs : (1)
un worker ne doit JAMAIS être lancé hors de son worktree — si le worktree est
irrécupérable, on REFUSE et on alerte au lieu de retomber sur le tronc ; (2)
health-check git du worktree (HEAD résoluble) avec auto-recréation sur corruption ;
(3) l'env d'identité complet (dont ORYON_TERMINAL_ID) injecté à TOUS les sites de spawn.

## État actuel

- `src/main/services/worktrees.ts` :
  - `ensureWorktree(main, agent)` (l.118-154) : fast-path « registered ET dir existe »
    → retourne SANS vérifier que le git du worktree est SAIN (refs 0x00 passent) ;
    en échec final → `console.error(…, 'repli sur le projet principal')` et
    **`return main`** ← C'EST le repli dangereux (worker dans le tronc).
  - `removeWorktree` (l.255-261) et `tryGit`/`git` helpers disponibles.
- `src/main/ipc/terminals.ipc.ts` (spawn nominal, « chokepoint ») : l.46-59
  `createTerminal({ id, cwd: opts.cwd, autostart, …, env: opts.env })` — le cwd et
  l'env VIENNENT DU RENDERER (opts). Lis les lignes 1-45 pour la forme exacte du
  handler et ce que le renderer envoie (Terminal.tsx construit opts depuis la ligne
  terminals en DB : cwd / worktree_path / env ?). C'est À CE chokepoint (côté MAIN)
  qu'on impose cwd + env — jamais en confiance du renderer.
- `src/main/services/orchestrator/router.ts`, `agentRestartAgent` (l.801-868) :
  fait DÉJÀ `ensureWorktree` (R5, l.830-837) et `shellCwd = row.worktree_path || row.cwd`
  (l.841) et env `{ ORYON_AGENT_NAME, ORYON_WORKSPACE_ID, ORYON_AGENT_ROLE? }` (l.852-853)
  — MAIS : pas de health-check, pas d'échec-refus si ensureWorktree retombe sur main,
  et PAS d'ORYON_TERMINAL_ID. ⚠ zone retouchée par le plan 009 (callbacks onData/onExit)
  — n'y touche pas.
- `src/main/ipc/workspaces.ipc.ts` : crée les LIGNES terminals (INSERT l.28-29,
  buildOrchestratorTerminal l.33-47). Lis comment les lignes WORKER sont construites
  (worktree_path posé où ?).
- `grep -rn "ORYON_TERMINAL_ID" src/` : à faire — câbler la variable où les rapports la
  disent attendue (server.mjs/outils get_task ?) ; si RIEN ne la lit aujourd'hui,
  l'injecter quand même (les workers la mentionnent → le CLI/outillage l'attend) et
  noter dans ton rapport ce qui la lit réellement.

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Health-check manuel | `git -C .oryon/agents/<x> rev-parse HEAD` | un SHA |

## Périmètre

**In scope** : `src/main/services/worktrees.ts` (health-check + politique d'échec),
`src/main/ipc/terminals.ipc.ts` (chokepoint spawn worker : cwd/env imposés côté main),
`src/main/services/orchestrator/router.ts` (agentRestartAgent : mêmes garanties),
`src/main/ipc/workspaces.ipc.ts` (UNIQUEMENT si la pose de worktree_path à la création
des lignes l'exige — minimal).

**Out of scope** : l'orchestrateur (role 'orchestrator' tourne dans le TRONC par
conception — ne touche pas son spawn) ; le contenu des contrats ; merge-back ; pty-manager.

## Workflow git

Branche `oryon/agent-<ton-nom>` ; commits conventionnels, ex.
`fix(worktrees): health-check git + plus jamais de repli silencieux sur le tronc` puis
`fix(spawn): cwd worker imposé au worktree + ORYON_TERMINAL_ID partout`. Ne push pas.

## Étapes

### Étape 1 : health-check + politique d'échec dans ensureWorktree (worktrees.ts)

- Ajoute `function isWorktreeHealthy(dir: string): boolean` : `tryGit(dir, ['rev-parse', 'HEAD'])`
  non-null ET `tryGit(dir, ['status', '--porcelain'])` non-null (index lisible).
- Dans le fast-path « registered ET existsSync » : si `!isWorktreeHealthy(dir)` →
  log erreur explicite (refs corrompues détectées), `removeWorktree(main, agent)`,
  `tryGit(main, ['worktree', 'prune'])`, suppression best-effort de la branche SEULEMENT
  si sa ref est corrompue (`tryGit(main, ['rev-parse', '--verify', branch])` null →
  `tryGit(main, ['update-ref', '-d', 'refs/heads/' + branch])`), puis continue vers la
  création normale (le code de création existe déjà en dessous).
- Change la SIGNATURE d'échec : remplace le `return main` final (l.147-149) par
  `throw new Error('worktree irrécupérable pour <agent> : <cause>')`. Adapte les
  appelants EXISTANTS d'ensureWorktree (grep) : chacun doit soit propager, soit
  catcher en ALERTANT (jamais avaler vers cwd=main pour un WORKER). Le repli `return main`
  pour « projet non-git » (l.119) RESTE (cas légitime documenté).

**Vérifier** : `npm run typecheck` exit 0.

### Étape 2 : chokepoint spawn (terminals.ipc.ts)

Dans le handler `terminals:create`, AVANT createTerminal, pour un terminal dont la
ligne DB (SELECT par opts.id) a `role` ≠ 'orchestrator' ET un projet git :
- appelle `ensureWorktree(projectPath, name)` (try/catch : sur throw → N'APPELLE PAS
  createTerminal avec cwd projet ; envoie l'erreur au renderer/au terminal (le handler
  peut écrire un message d'échec via le canal data ou throw — choisis le mécanisme
  d'erreur DÉJÀ utilisé par ce handler) et notifie l'orchestrateur si joignable) ;
- impose `cwd = <worktree retourné>` (ignore opts.cwd pour les workers) + persiste
  `worktree_path` en DB si différent ;
- construis l'env côté MAIN : `{ ...opts.env, ORYON_TERMINAL_ID: opts.id,
  ORYON_AGENT_NAME: name, ORYON_AGENT_ROLE: role, ORYON_WORKSPACE_ID: workspace_id }`
  (les valeurs DB priment sur opts.env).
L'orchestrateur (role 'orchestrator') garde son comportement actuel (cwd = tronc).

**Vérifier** : `npm run typecheck` exit 0.

### Étape 3 : agentRestartAgent (router.ts)

- Le bloc R5 (l.830-837) : sur throw d'ensureWorktree → `tellOrch` l'échec et **return**
  (ne JAMAIS recréer le PTY avec shellCwd=row.cwd pour un worker — c'était le bug
  1234317c). `shellCwd` devient LE retour d'ensureWorktree (pas `row.worktree_path || row.cwd`).
- Ajoute `ORYON_TERMINAL_ID: id` à l'env (l.852).

**Vérifier** : `npm run typecheck` exit 0 ; relis le diff : pour un worker, AUCUN chemin
de code ne peut plus aboutir à un claude lancé dans le tronc.

### Étape 4 : ORYON_TERMINAL_ID bout-en-bout

`grep -rn "ORYON_TERMINAL_ID" src/` — si server.mjs ou un outil le lit, vérifie la
cohérence ; sinon ajoute sa lecture là où l'identité par nom est fragile n'est PAS
demandé ici (c'est le plan 013) — contente-toi de l'INJECTER partout au spawn et de
documenter dans ton rapport qui le lit.

**Vérifier** : `grep -rn "ORYON_TERMINAL_ID" src/main/` → présent aux 2 sites de spawn.

## Plan de test

Typecheck + revue. Tests runtime (reviewer, post-merge + rebuild) : (a) corrompre
volontairement un ref de worktree de test (fichier ref → 0x00) → au spawn, recréation
propre ; (b) restart_agent → bannière claude affiche `…\.oryon\agents\<nom>` ; (c)
worker voit `$env:ORYON_TERMINAL_ID`.

## Critères de done

- [ ] ensureWorktree : health-check au fast-path + JAMAIS de `return main` pour un worker (throw)
- [ ] terminals:create : cwd worker imposé au worktree côté main + env identité complet
- [ ] agentRestartAgent : refus propre sur worktree irrécupérable + ORYON_TERMINAL_ID
- [ ] `npm run typecheck` exit 0
- [ ] `git status` : seulement les fichiers in-scope

## Conditions STOP

- Le handler terminals:create ne lit PAS la ligne DB (structure différente de
  l'hypothèse) — rapporte sa forme réelle avant d'imposer quoi que ce soit.
- Un appelant d'ensureWorktree dépend du repli `return main` pour un cas LÉGITIME
  autre que « projet non-git » — rapporte-le.
- La zone agentRestartAgent a été refondue par le plan 009 au-delà des callbacks.

## Notes de maintenance

- Le plan 013 s'appuiera sur ORYON_TERMINAL_ID pour l'attribution des report_task.
- Reviewer : scruter le chemin d'échec du chokepoint (un spawn refusé doit être VISIBLE
  — terminal avec message d'erreur ou alerte orchestrateur, jamais un terminal muet).
- Les rapports system-feedback 1975b0b1/1234317c passent en 'reviewed' quand ce plan
  est mergé (l'orchestrateur s'en charge via resolve_system_issue).
