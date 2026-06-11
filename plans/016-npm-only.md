# Plan 016 : Lockfile unique npm (exécuté par l'orchestrateur)

- **Priorité** : P3 · **Effort** : S · **Risque** : LOW · **Catégorie** : deps
- **Écrit à** : commit `29c8ae5`, 2026-06-11 · **Exécutant** : orchestrateur (trivial)

## Pourquoi

`package-lock.json` (npm, utilisé par la CI `npm ci`) ET `pnpm-lock.yaml` coexistent à
la racine → résolutions potentiellement divergentes local/CI (split-brain). La CI est
la référence → npm gagne.

## Actions

1. `git rm pnpm-lock.yaml`.
2. electron-builder.yml ligne 34 exclut déjà pnpm-lock.yaml du package — laisser tel
   quel (inoffensif) OU retirer la mention au prochain passage.
3. La décision « npm only » est documentée par CLAUDE.md (plan 005).

## Done

- [ ] `pnpm-lock.yaml` absent du repo
- [ ] `npm ci` local fonctionne toujours (lockfile npm intact)
