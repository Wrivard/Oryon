# Plan 015 : Hygiène repo (exécuté par l'orchestrateur)

- **Priorité** : P3 · **Effort** : S · **Risque** : LOW · **Catégorie** : dx
- **Écrit à** : commit `29c8ae5`, 2026-06-11 · **Exécutant** : orchestrateur (trivial)

## Pourquoi

`.dev.log` traîne en untracked permanent (le .gitignore n'a que `dist-*.log`) ;
`scripts/dev.cmd` (lanceur dev documenté, utile) n'est pas tracké ; trois scripts
d'audit a11y one-shot (`audit_buttons.js`, `check_contrast.js`, `check_interactive.js`)
sont trackés à la racine et exclus à la main par electron-builder.yml:29.

## Actions

1. `.gitignore` : ajouter `.dev.log` (section logs).
2. `git add scripts/dev.cmd` (lanceur légitime, commentaires précieux).
3. `git rm audit_buttons.js check_contrast.js check_interactive.js` (artefacts one-shot ;
   l'historique git les conserve).
4. `electron-builder.yml` : retirer la ligne d'exclusion `'!{audit_buttons,check_contrast,check_interactive}.js'` (ligne 29) devenue sans objet.

## Done

- [ ] `git status` propre après commit (plus de `?? .dev.log` / `?? scripts/dev.cmd`)
- [ ] `npm run typecheck` exit 0 (inchangé)
