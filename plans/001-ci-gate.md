# Plan 001 : Ajouter une CI sur push/PR (typecheck + build) et rafraîchir release.yml

> **Instructions exécuteur** : suis ce plan étape par étape. Lance chaque commande de
> vérification et confirme le résultat attendu avant de passer à la suite. Si une
> condition STOP survient, arrête et rapporte — n'improvise pas. Le reviewer tient
> l'index `plans/README.md` (ne le modifie pas).
>
> **Drift check (à lancer d'abord)** : `git diff --stat 29c8ae5..HEAD -- .github/workflows/`
> Si `release.yml` a changé depuis l'écriture du plan, compare l'« État actuel »
> ci-dessous au code réel ; sur écart, condition STOP.

## Statut

- **Priorité** : P1
- **Effort** : S
- **Risque** : LOW
- **Dépend de** : aucun
- **Catégorie** : dx
- **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Aujourd'hui, RIEN ne vérifie le repo automatiquement : le seul workflow
(`release.yml`) ne se déclenche que sur un tag `v*` et fait `npm ci` + build/publish,
sans jamais lancer `npm run typecheck`. Or `electron-vite build` utilise esbuild, qui
**strip les types sans les vérifier** : une erreur TypeScript committée sur main peut
shipper dans une release installée chez l'utilisateur (c'est déjà arrivé : tags morts
v0.1.12/v0.1.13). Un workflow CI sur push/PR ferme ce trou pour ~3 minutes de runner.
Au passage, `release.yml` utilise des actions Node 20 dépréciées (forcées en Node 24
le 16 juin 2026) et `windows-latest` est redirigé vers une nouvelle image le 15 juin
2026 — des avertissements déjà visibles dans les runs.

## État actuel

- `.github/workflows/release.yml` — UNIQUE workflow ; extraits exacts :
  - ligne 18 : `runs-on: windows-latest`
  - ligne 20 : `- uses: actions/checkout@v4`
  - lignes 22-25 : `- uses: actions/setup-node@v4` avec `node-version: '22'`, `cache: 'npm'`
  - lignes 31-33 : `- uses: actions/setup-python@v5` avec `python-version: '3.11'`
    (pin nécessaire à la recompile native d'uiohook-napi — NE PAS y toucher ici,
    c'est le périmètre du plan 012)
  - ligne 36 : `- run: npm ci`
  - lignes 40-43 : `run: npm run publish:win` avec `GH_TOKEN`
- `.github/workflows/ci.yml` — N'EXISTE PAS (à créer).
- `package.json` scripts utiles : `"typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"`, `"build": "electron-vite build"`, et un
  `"postinstall": "electron-rebuild -f -o better-sqlite3"` (d'où `--ignore-scripts`
  ci-dessous : la CI de typecheck n'a pas besoin des natifs).
- Convention du repo : commentaires en FRANÇAIS expliquant le pourquoi, en tête de
  fichier (vois l'en-tête de `release.yml` comme exemplaire — fais pareil dans `ci.yml`).

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Installer (sans natifs) | `npm ci --ignore-scripts` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0, aucune erreur |
| Build | `npm run build` | exit 0 |

## Périmètre

**In scope** (seuls fichiers modifiables) :
- `.github/workflows/ci.yml` (créer)
- `.github/workflows/release.yml` (rafraîchir actions/runner UNIQUEMENT)

**Out of scope** (n'y touche PAS) :
- Le step Python de `release.yml` (plan 012 s'en charge).
- `package.json` (aucun nouveau script requis).
- Tout le reste du repo.

## Workflow git

- Tu travailles dans TON worktree sur ta branche `oryon/agent-<ton-nom>` (déjà checked out).
- Commits conventionnels avec scope, ex. `ci(workflows): typecheck+build sur push/PR`.
- Ne push pas ; le merge passe par l'orchestrateur (approve_task).

## Étapes

### Étape 1 : vérifier les versions courantes des actions (WebSearch)

Cherche sur le web la version majeure COURANTE (compatible runner Node 24) de :
`actions/checkout`, `actions/setup-node`, `actions/setup-python`, et le label exact
du runner Windows qui remplace `windows-latest` après la redirection de juin 2026
(annonce GitHub « windows-latest requests are being redirected … »). Note les versions
trouvées avec leur source (page GitHub officielle du dépôt de l'action).

**Vérifier** : tu as une version majeure sourcée pour chacune des 3 actions + le label runner. Sinon → STOP condition 3.

### Étape 2 : créer `.github/workflows/ci.yml`

Contenu cible (adapte les `@vN` aux versions trouvées à l'étape 1) :

```yaml
name: CI

# Filet qualité : typecheck + build sur chaque push/PR vers main.
# `electron-vite build` (esbuild) ne vérifie PAS les types → tsc est le seul garde-fou.
# --ignore-scripts : saute electron-rebuild (natifs inutiles pour tsc/esbuild) → CI rapide.
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@vN
      - uses: actions/setup-node@vN
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci --ignore-scripts
      - run: npm run typecheck
      - run: npm run build
```

**Vérifier** : fichier créé ; YAML valide (`node -e "console.log('ok')"` ne valide pas le YAML — utilise une lecture attentive + indentation 2 espaces conforme à release.yml).

### Étape 3 : reproduire les commandes CI localement dans TON worktree

```
npm ci --ignore-scripts
npm run typecheck
npm run build
```

**Vérifier** : les trois sortent exit 0. Si `npm run build` échoue à cause de l'absence
du binaire Electron (message mentionnant le download Electron), remplace dans `ci.yml`
`npm ci --ignore-scripts` par `npm ci` et note la déviation dans ton rapport.

### Étape 4 : rafraîchir `release.yml`

- Remplace `runs-on: windows-latest` par le label explicite trouvé à l'étape 1.
- Monte `actions/checkout`, `actions/setup-node`, `actions/setup-python` aux majeures
  trouvées (garde `node-version: '22'` et `python-version: '3.11'` TELS QUELS).
- Ajoute un commentaire français d'une ligne expliquant le pin du runner (dates GitHub).

**Vérifier** : `git diff .github/workflows/release.yml` ne montre QUE les lignes
`runs-on:` et `uses:` (+ le commentaire) — aucune autre modification.

## Plan de test

Pas de tests unitaires (fichiers CI). La validation = étape 3 (reproduction locale) +
revue du diff. Le premier vrai run CI aura lieu au merge sur main.

## Critères de done

- [ ] `.github/workflows/ci.yml` existe avec jobs typecheck+build sur push/PR
- [ ] `npm run typecheck` exit 0 localement
- [ ] `npm run build` exit 0 localement
- [ ] `release.yml` : runner pinné + actions montées, AUCUN autre changement
- [ ] `git status` : seuls les 2 fichiers in-scope modifiés/créés

## Conditions STOP

- `release.yml` ne correspond plus aux extraits (drift).
- `npm run typecheck` échoue dans ton worktree AVANT toute modification (le tronc est cassé — rapporte, ne corrige pas toi-même).
- Impossible de sourcer les versions d'actions via le web → crée UNIQUEMENT `ci.yml` avec les versions actuelles de release.yml (`checkout@v4`, `setup-node@v4`) et signale dans ton rapport que le rafraîchissement n'a pas été fait.

## Notes de maintenance

- Quand le plan 007 (vitest) atterrit, il AJOUTERA un step `npm test` à ce `ci.yml`.
- Quand le plan 012 (retrait uiohook) atterrit, le step Python de `release.yml` saute.
- Reviewer : vérifier qu'aucun secret n'est référencé dans ci.yml (il n'en faut aucun).
