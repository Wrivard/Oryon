# Plan 003 : Verrouiller claims.json contre les écritures multi-processus + libérations observables + TTL

> **Instructions exécuteur** : suis ce plan étape par étape. Lance chaque commande de
> vérification et confirme le résultat attendu avant de continuer. Si une condition
> STOP survient, arrête et rapporte — n'improvise pas. Le reviewer tient l'index
> `plans/README.md`.
>
> **Drift check (à lancer d'abord)** :
> `git diff --stat 29c8ae5..HEAD -- src/shared/memory-core.mjs src/shared/memory-core.d.mts src/main/services/orchestrator/router.ts`
> Sur écart avec les extraits « État actuel », condition STOP.

## Statut

- **Priorité** : P1
- **Effort** : M
- **Risque** : MED (coordination de flotte ; le code ne tourne que dans le build suivant)
- **Dépend de** : aucun
- **Catégorie** : bug
- **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

`claims.json` (réservations de fichiers par agent, garde-fou W6 contre deux workers
sur le même fichier) est écrit par PLUSIEURS PROCESSUS OS en concurrence : le process
main d'Oryon (router : claim à l'assign, release à l'exit/approve) ET le serveur MCP de
CHAQUE worker (outil `claim_files`, qui appelle `memory.claimFile` DIRECTEMENT dans le
process du worker — `src/mcp/server.mjs:569`). Chaque opération fait lire→modifier→
écrire sans aucun verrou : deux claims simultanés se clobbent (le dernier rename gagne,
le claim de l'autre disparaît silencieusement) — précisément le scénario que W6 doit
empêcher. Preuve terrain (store system-feedback, rapport 75f445e0, workspace
kua-coiffure) : des claims de tâches déjà APPROUVÉES/mergées ont continué de bloquer
les assigns suivants (« package.json réservé par Jude » alors que la tâche de Jude
était mergée depuis plusieurs minutes) ; en prime les trois libérations côté router
sont des `void release…()` qui avalent toute erreur. Ce plan ajoute : un verrou
inter-processus à acquisition par fichier-lock, un TTL sur les claims, et des
libérations loggées.

## État actuel

- `src/shared/memory-core.mjs` — module JS pur partagé (importé par server.mjs ET main).
  - ligne 340 : `claimsPath` = `join(memDir(projectDir), 'claims.json')`
  - lignes 344-352 : `readClaims` — lit+parse, `{}` sur ENOENT, RETHROW sinon.
  - lignes 356-380 : `claimFile(projectDir, filepath, agentName, opts)` — lit les claims,
    conflit si `existing.agent !== agentName` (retourne `{ conflict: true, owner, uuid }`),
    sinon pose `claims[filepath] = { agent, uuid, ts }` puis écrit ATOMIQUEMENT
    (tmp `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}` + `renameRetry`).
  - lignes 383-395 : `releaseClaim` — même motif lire→supprimer la clé→écrire.
  - lignes 398-414 : `releaseClaimsByAgent` — même motif, supprime toutes les entrées
    de l'agent, retourne `{ released }`.
  - Le fichier définit déjà `renameRetry` et un compteur `tmpSeq` (réutilise-les).
- `src/shared/memory-core.d.mts` — jumeau de déclarations TS (lignes 80-87 déclarent
  claimFile/releaseClaim/releaseClaimsByAgent). Toute NOUVELLE export .mjs utilisée par
  du TS doit y être déclarée.
- `src/main/services/orchestrator/router.ts` — trois libérations fire-and-forget :
  - ligne 182 (observer d'exit R7) : `if (ws && isGitRepo(ws.project_path)) void releaseClaimsByAgent(ws.project_path, terminalName(id))`
  - ligne 214 (setTaskStatus, W6(b)) : `if (ws && isGitRepo(ws.project_path)) void releaseClaimsByAgent(ws.project_path, terminalName(t.assigned_terminal_id))`
  - ligne 658 (approve_task onDone) : `void releaseClaimsByAgent(ws.project_path, agent) // W6(b) : la task est mergée → libère ses claims`
  - lignes 361-368 (assign) : boucle `await claimFile(ws.project_path, f, terminalName(id))` dans try/catch best-effort.
  - Le pré-check W6 de refus d'assign (message « réservé par ») vit aussi dans
    `agentAssignTask`, plus haut dans le fichier — localise-le avec
    `grep -n "réservé" src/main/services/orchestrator/router.ts`.
- Invariant v0.1.63 (NE PAS casser) : `isClean`/`mainDirty` de merge-back IGNORENT les
  fichiers `*.lock` sous `.claude/`/`.oryon/` — un fichier de verrou sous
  `<projet>/.oryon/memory/` ne salit donc PAS le tronc. C'est ce qui rend l'approche
  fichier-lock sûre ici.

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Installer (1× si besoin) | `npm ci --ignore-scripts` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Syntaxe module | `node --check src/shared/memory-core.mjs` | exit 0 |
| Test concurrence (étape 4) | voir script inline | `PASS` |

## Périmètre

**In scope** :
- `src/shared/memory-core.mjs`
- `src/shared/memory-core.d.mts` (uniquement si tu exportes de nouveaux symboles)
- `src/main/services/orchestrator/router.ts` (UNIQUEMENT les 3 sites `void release…` + le pré-check W6)

**Out of scope** :
- `src/mcp/server.mjs` (l'outil claim_files appelle déjà memory-core — il hérite du verrou sans changement).
- `merge-back.ts`, `worktrees.ts`, toute autre logique du router (assign/report/approve).
- Le format de `claims.json` (reste un mapping fichier → {agent, uuid, ts}).

## Workflow git

- Branche `oryon/agent-<ton-nom>` dans ton worktree. Commits conventionnels, ex.
  `fix(memory): verrou inter-processus sur claims.json + TTL`.
- Ne push pas (merge via approve_task).

## Étapes

### Étape 1 : verrou inter-processus dans memory-core.mjs

Ajoute (près des helpers claims) :

```js
// Verrou inter-processus du store de claims : claims.json est écrit par main ET par le
// serveur MCP de chaque worker (process distincts) — le read-modify-write sans verrou
// perdait des claims (dernier rename gagne). Fichier-lock à création exclusive (flag wx),
// contenu `pid ts` ; un lock plus vieux que LOCK_STALE_MS (porteur crashé) est volé.
// Au timeout, on procède SANS verrou avec un log d'erreur : le store est un garde-fou
// ADVISORY — l'indisponibilité serait pire que la course résiduelle.
const LOCK_STALE_MS = 5000
const LOCK_TIMEOUT_MS = 3000
const lockPath = (projectDir) => join(memDir(projectDir), 'claims.lock')

async function withClaimsLock(projectDir, fn) {
  const lp = lockPath(projectDir)
  await ensureDir(memDir(projectDir))
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let locked = false
  while (Date.now() < deadline) {
    try {
      await fs.writeFile(lp, `${process.pid} ${Date.now()}`, { flag: 'wx' })
      locked = true
      break
    } catch (e) {
      if (!e || e.code !== 'EEXIST') break // FS en vrac : on tente sans verrou
      try {
        const [, ts] = (await fs.readFile(lp, 'utf8')).split(' ')
        if (Date.now() - Number(ts || 0) > LOCK_STALE_MS) { await fs.unlink(lp).catch?.(() => {}); continue }
      } catch { /* lock illisible/disparu : re-essaie */ }
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  if (!locked) console.error('[memory-core] claims.lock indisponible après', LOCK_TIMEOUT_MS, 'ms — opération SANS verrou')
  try {
    return await fn()
  } finally {
    if (locked) { try { await fs.unlink(lp) } catch { /* déjà parti */ } }
  }
}
```

Note : si `fs.unlink(lp).catch?.(…)` te paraît fragile, utilise un try/catch classique —
reste dans le style du fichier (promesses `fs` de `node:fs/promises` y sont déjà
utilisées ; VÉRIFIE l'import exact en tête de fichier et réutilise-le).

**Vérifier** : `node --check src/shared/memory-core.mjs` exit 0.

### Étape 2 : envelopper les trois opérations + TTL des claims

- Renomme les implémentations actuelles en internes (`claimFileUnlocked`, etc.) OU
  enveloppe directement leur corps : chaque export `claimFile` / `releaseClaim` /
  `releaseClaimsByAgent` devient `return withClaimsLock(projectDir, async () => { …corps actuel… })`.
- TTL : ajoute `export const CLAIM_TTL_MS = 4 * 60 * 60 * 1000` (4 h) et, dans le test
  de conflit de `claimFile`, traite un claim EXPIRÉ comme inexistant :
  ```js
  const existing = claims[filepath]
  const expired = existing && Date.now() - Number(existing.ts || 0) > CLAIM_TTL_MS
  if (existing && !expired && existing.agent !== agentName) {
    return { conflict: true, owner: existing.agent, uuid: existing.uuid }
  }
  ```
- Déclare `CLAIM_TTL_MS` dans `memory-core.d.mts` : `export declare const CLAIM_TTL_MS: number`.

**Vérifier** : `node --check src/shared/memory-core.mjs` exit 0 ; `npm run typecheck` exit 0.

### Étape 3 : libérations observables + W6 ignore les claims expirés (router.ts)

- Aux lignes 182, 214 et 658, remplace `void releaseClaimsByAgent(X, Y)` par :
  `releaseClaimsByAgent(X, Y).catch((e) => console.error('[router] releaseClaimsByAgent', e))`
  (garde le fire-and-forget : on n'ajoute PAS d'await — seuls les échecs deviennent visibles).
- Localise le pré-check W6 (`grep -n "réservé" …/router.ts`) : là où il lit les claims
  pour refuser un assign, fais-lui ignorer les claims expirés — importe `CLAIM_TTL_MS`
  depuis memory-core et filtre `Date.now() - Number(c.ts || 0) <= CLAIM_TTL_MS`.

**Vérifier** : `npm run typecheck` exit 0 ; `grep -n "void releaseClaimsByAgent" src/main/services/orchestrator/router.ts` → 0 résultat.

### Étape 4 : test de concurrence (sans framework)

Lance ce script depuis la racine de TON worktree :

```
node -e "
import('./src/shared/memory-core.mjs').then(async (m) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'claims-'));
  await Promise.all([
    m.claimFile(dir, 'a.ts', 'nell'),
    m.claimFile(dir, 'b.ts', 'jude'),
    m.claimFile(dir, 'c.ts', 'gus'),
    m.releaseClaimsByAgent(dir, 'personne'),
  ]);
  const claims = await m.readClaims(dir);
  const ok = claims['a.ts']?.agent === 'nell' && claims['b.ts']?.agent === 'jude' && claims['c.ts']?.agent === 'gus';
  console.log(ok ? 'PASS' : 'FAIL ' + JSON.stringify(claims));
  const r = await m.claimFile(dir, 'a.ts', 'jude');
  console.log(r.conflict === true ? 'PASS conflit' : 'FAIL conflit');
})"
```

**Vérifier** : sortie `PASS` puis `PASS conflit`. (Avant ce plan, le premier assert
échouait par intermittence — claims perdus.)

## Plan de test

Le script de l'étape 4 est la vérification de ce plan. Quand le plan 007 (vitest) sera
mergé, ce script a vocation à devenir `tests/memory-core-claims.test.mjs` — note-le
dans ton rapport, ne crée pas le fichier de test ici.

## Critères de done

- [ ] `node --check src/shared/memory-core.mjs` exit 0
- [ ] Les 3 exports claims passent par `withClaimsLock` (lecture du diff)
- [ ] `CLAIM_TTL_MS` exporté + déclaré dans le d.mts + utilisé dans claimFile ET le pré-check W6
- [ ] Plus aucun `void releaseClaimsByAgent` dans router.ts (catch loggé partout)
- [ ] Script de concurrence → `PASS` + `PASS conflit`
- [ ] `npm run typecheck` exit 0
- [ ] `git status` : seuls les 3 fichiers in-scope touchés

## Conditions STOP

- Les extraits « État actuel » ne matchent pas (drift).
- Le pré-check W6 du router est introuvable ou structuré autrement que « lit claims et
  refuse l'assign » — rapporte sa forme réelle au lieu d'adapter.
- Tu constates que `claim_files` côté server.mjs passe par queueCommand (et non par un
  appel direct memory-core) — l'hypothèse du plan serait fausse, rapporte.
- L'import promesses de memory-core n'est pas `node:fs/promises` (adapter le verrou à
  l'API réellement importée, et si ce n'est pas trivial → STOP).

## Notes de maintenance

- Le verrou couvre TOUTES les écritures claims (main + N serveurs MCP) tant qu'elles
  passent par memory-core — tout futur écrivain DOIT utiliser ces fonctions.
- Le TTL (4 h) est un filet anti-claim-zombie, pas un mécanisme de fairness ; si des
  tâches légitimes dépassent 4 h, monter la constante.
- Reviewer : vérifier que le lock est bien RELÂCHÉ dans le finally (sinon 5 s de stale
  à chaque opération) et que `claims.lock` est couvert par l'ignore `*.lock` de
  merge-back (invariant v0.1.63).
