# Plan 014 : Remplacer uuid par crypto.randomUUID (dépendance supprimée, CVE éteinte)

> **Instructions exécuteur** : suis ce plan étape par étape. Condition STOP → arrête et
> rapporte. Le reviewer tient `plans/README.md`.
>
> **Drift check** : `git diff --stat 29c8ae5..HEAD -- package.json src/main/`
> task-store.ts/settings.ipc.ts/workspaces.ipc.ts ont été modifiés par des plans
> précédents — seuls les IMPORTS uuid t'intéressent ; re-grep avant d'éditer.

## Statut

- **Priorité** : P3 — **Effort** : S — **Risque** : LOW
- **Dépend de** : plans 012 et 013 mergés (package.json + task-store libres)
- **Catégorie** : deps — **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

`uuid@^10` traîne une CVE modérée (<11.1.1, bounds-check buffer v3/v5/v6 — non
exploitée ici : seuls des `v4()` sans buffer) et Node fournit `crypto.randomUUID()`
nativement (v4, plus rapide). 6 fichiers l'importent ; suppression = une dépendance et
ses @types en moins.

## État actuel

`grep -rn "from 'uuid'" src/` (au commit 29c8ae5 — RE-GREP, des plans ont bougé ces fichiers) :
- src/main/ipc/settings.ipc.ts:2, voice.ipc.ts:2, workspaces.ipc.ts:2
- src/main/services/orchestrator/learn.ts:1, mailbox.ts:1, task-store.ts:1
Tous : `import { v4 as uuid } from 'uuid'` + appels `uuid()`.
package.json : `"uuid": "^10.0.0"` (deps) + `"@types/uuid": "^10.0.0"` (devDeps).
⚠ WORKTREE : node_modules = junction tronc → lockfile UNIQUEMENT via
`npm install --package-lock-only --no-audit --no-fund` ; JAMAIS de npm install nu.

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Lockfile only | `npm install --package-lock-only --no-audit --no-fund` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0 |

## Périmètre

**In scope** : les 6 fichiers importeurs (imports + call-sites uniquement),
package.json, package-lock.json.
**Out of scope** : tout autre changement dans ces fichiers ; `src/mcp/` (n'utilise pas uuid).

## Workflow git

Branche `oryon/agent-<ton-nom>` ; commit `refactor(deps): uuid → crypto.randomUUID natif`. Ne push pas.

## Étapes

1. Dans chaque importeur (re-grep d'abord) : `import { v4 as uuid } from 'uuid'` →
   `import { randomUUID as uuid } from 'node:crypto'` (alias conservé = zéro autre diff).
   **Vérifier** : `npm run typecheck` exit 0.
2. package.json : retire `uuid` et `@types/uuid` ; lockfile via la commande dédiée.
   **Vérifier** : `grep -n "\"uuid\"\|@types/uuid" package.json package-lock.json` → 0 ;
   `npm run typecheck` + `npm test` exit 0.

## Critères de done

- [ ] `grep -rn "from 'uuid'" src/` → 0
- [ ] package.json/package-lock sans uuid ni @types/uuid
- [ ] typecheck + npm test verts
- [ ] `git status` : seulement les 8 fichiers in-scope

## Conditions STOP

- Le re-grep révèle un usage v3/v5 ou avec buffer (pas équivalent à randomUUID).
- Tu envisages npm install sans --package-lock-only.

## Notes de maintenance

Néant — substitution mécanique. Reviewer : vérifier l'alias (`randomUUID as uuid`)
pour un diff minimal.
