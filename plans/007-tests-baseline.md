# Plan 007 : Socle de tests vitest + tests de caractérisation des invariants critiques

> **Instructions exécuteur** : suis ce plan étape par étape ; chaque vérification doit
> donner le résultat attendu. Condition STOP → arrête et rapporte. Le reviewer tient
> `plans/README.md`.
>
> **Drift check** : `git diff --stat 29c8ae5..HEAD -- package.json .github/workflows/ci.yml src/main/services/claude-launcher.ts src/shared/system-feedback-core.mjs src/main/ipc/settings.ipc.ts`
> ATTENDU : ci.yml a été CRÉÉ par le plan 001 (dépendance) et claude-launcher modifié
> par 29c8ae5 lui-même. Si ci.yml N'EXISTE PAS → STOP (001 pas mergé). Pour le reste,
> compare les extraits ci-dessous au code réel ; écart → STOP.

## Statut

- **Priorité** : P1 — **Effort** : M — **Risque** : LOW (additif)
- **Dépend de** : plan 001 (ci.yml doit exister)
- **Catégorie** : tests — **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Zéro test automatisé dans le repo : les invariants les plus dangereux ne sont vérifiés
par rien. (1) Le quoting PowerShell de `claude-launcher` a déjà causé le bug du
« prompt fantôme » (corruption d'argv) — une régression serait silencieuse jusqu'en
production. (2) La sérialisation `enqueue` de system-feedback-core corrige une race
lost-write — vérifiée une fois à la main, plus jamais depuis. (3) Le chiffrement
`enc:v1` échoue en SILENCE (`catch { return {} }`) — un round-trip cassé = secrets
perdus sans erreur. (4) Le clamp `enforceAgentSpawn` garantit le modèle/effort/rôle de
TOUS les agents. vitest s'intègre nativement à l'écosystème electron-vite.

## État actuel

- `package.json` : AUCUN framework de test ; scripts = dev/build/typecheck/rebuild/
  pack/dist*/publish/release*. `"postinstall": "electron-rebuild -f -o better-sqlite3"`.
- Deux smoke-scripts manuels existent et montrent le style maison : `scripts/test-docs-core.mjs`,
  `scripts/test-docs-import-command.mjs` (lis-les avant d'écrire les tests — assertions
  simples, tmpdir, zéro magie). Ils ne sont PAS câblés dans npm scripts (laisse-les).
- `src/main/services/claude-launcher.ts` — cibles de test (extraits au commit 29c8ae5) :
  - `shellQuote` (l.36-38) : `return `'${s.replace(/'/g, "''")}'``
  - `appendSystemPromptFlag` (l.57-74) : écrit le prompt dans un fichier
    `oryon-roleprompt-<sha1-16>.txt` sous `app.getPath('userData')` (tmp + renameSync)
    et retourne `--append-system-prompt-file '<chemin>'` ; repli inline sur échec I/O.
  - `enforceAgentSpawn` (l.92-101) : ne touche que les commandes `^claude\b` ; réécrit
    `--model (haiku|sonnet|opus)` → `--model fable` ; ajoute `--model fable` si absent ;
    ajoute `--effort max` si absent ; ajoute `--append-system-prompt-file …` si absent.
    Idempotent.
  - ⚠ le module importe `{ app } from 'electron'` au top-level → les tests DOIVENT
    mocker `electron` (vi.mock) avec `app.getPath: () => <tmpdir>`.
- `src/shared/system-feedback-core.mjs` — `enqueue` (chaîne de promesses sérialisant
  TOUTES les écritures), `appendReport`, `updateReportStatus`, `listReports` ; le
  chemin du store est `~/.oryon/system-feedback/` codé en dur via `homedir()` → pour
  tester sur tmpdir, mocke `node:os.homedir` (vi.mock) AVANT l'import du module.
- `src/main/ipc/settings.ipc.ts` l.52-70 — `ENC_PREFIX = 'enc:v1:'`,
  `encryptSecrets(obj)` → `enc:v1:`+base64 si `safeStorage.isEncryptionAvailable()`,
  sinon JSON clair ; `decryptSecrets(stored)` lit les deux formes, `catch { return {} }`.
  Ces deux fonctions ne sont PAS exportées → exporte-les (export nommé, aucun autre
  changement dans ce fichier).
- `.github/workflows/ci.yml` : créé par le plan 001 (job `verify` : npm ci --ignore-scripts,
  typecheck, build). Tu y AJOUTES un step test.
- ⚠ ARCHITECTURE WORKTREE : ton `node_modules` est une JUNCTION vers celui du tronc.
  `npm install` ici installe DANS le tronc (toléré pour vitest : additif et le tronc en
  aura besoin de toute façon) — utilise EXACTEMENT `npm install -D vitest --no-audit --no-fund`,
  rien d'autre.

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Installer vitest | `npm install -D vitest --no-audit --no-fund` | exit 0 ; package.json + package-lock modifiés |
| Tests | `npm test` | exit 0, tous les tests passent |
| Typecheck | `npm run typecheck` | exit 0 |

## Périmètre

**In scope** : `package.json` (devDep vitest + script test), `package-lock.json`,
`vitest.config.ts` (créer), `tests/**` (créer), `.github/workflows/ci.yml` (ajout d'UN step),
`src/main/ipc/settings.ipc.ts` (UNIQUEMENT exporter encryptSecrets/decryptSecrets).

**Out of scope** : tout autre fichier src ; les scripts/test-*.mjs existants ;
tsconfig* (mets les tests hors des deux projets tsc : ils ne doivent PAS casser
`npm run typecheck` — vitest transpile lui-même).

## Workflow git

Branche `oryon/agent-<ton-nom>` ; commits conventionnels (`test(core): …`,
`ci(workflows): step npm test`). Ne push pas.

## Étapes

### Étape 1 : vitest + config

`npm install -D vitest --no-audit --no-fund`. Crée `vitest.config.ts` à la racine :
environment 'node', `include: ['tests/**/*.test.{ts,mjs}']`. Ajoute
`"test": "vitest run"` aux scripts. Vérifie que `tests/` n'est couvert par AUCUN des
deux tsconfig (sinon exclude).

**Vérifier** : `npm test` → « no test files found » accepté à ce stade OU exit 0.

### Étape 2 : tests claude-launcher (`tests/claude-launcher.test.ts`)

`vi.mock('electron', () => ({ app: { getPath: () => <tmpdir du test> } }))` AVANT
l'import. Cas : (a) shellQuote double les apostrophes (`a'b` → `'a''b'`) ; (b)
appendSystemPromptFlag : prompt piégé (guillemets doubles, `$()`, backticks, accents,
multilignes) → le FICHIER créé contient le prompt OCTET-IDENTIQUE, le flag retourné est
`--append-system-prompt-file '<chemin>'`, le chemin ne contient AUCUN `"` ; même prompt
deux fois → même fichier (hash stable) ; (c) enforceAgentSpawn : `claude` nu reçoit
`--model fable` + `--effort max` + `--append-system-prompt-file` ; `claude --model opus`
ET `--model sonnet` ET `--model haiku` sont réécrits `--model fable` ; `claude --model fable`
inchangé ; commande non-claude (`npm run dev`) STRICTEMENT inchangée ; double application
= idempotente.

**Vérifier** : `npm test` → ces tests passent.

### Étape 3 : tests system-feedback-core (`tests/system-feedback-core.test.mjs`)

Mocke `node:os` (homedir → tmpdir unique) avant l'import dynamique du module. Cas :
(a) appendReport pose id/ts/status par défaut ; (b) CONCURRENCE : `Promise.all` de 3
appendReport + 1 updateReportStatus (sur un id inséré avant) → le fichier final contient
les 4 enregistrements, le statut est appliqué (c'est l'invariant enqueue anti lost-write) ;
(c) listReports filtre status/category et ignore une ligne malformée injectée à la main.

**Vérifier** : `npm test` → passent.

### Étape 4 : test chiffrement (`tests/secrets-roundtrip.test.ts`)

Exporte `encryptSecrets`/`decryptSecrets` depuis settings.ipc.ts (export nommé, zéro
autre changement). `vi.mock('electron', …)` avec safeStorage factice symétrique
(encryptString → Buffer base64 inversible, isEncryptionAvailable → true) + variante
`isEncryptionAvailable → false` (repli JSON clair). Cas : round-trip objet non vide
(les deux modes), objet vide → null, déchiffrement d'une chaîne corrompue → `{}` (pas
de throw). NOTE : settings.ipc importe getDb/uuid/etc. — si l'import du module entier
échoue sous vitest à cause de better-sqlite3, mocke aussi `../db` (`vi.mock`) ; si ça
reste infaisable proprement → condition STOP (rapporte, n'extrais PAS les fonctions
dans un autre fichier : c'est le plan 010 qui le fera).

**Vérifier** : `npm test` → passent ; `npm run typecheck` exit 0.

### Étape 5 : step CI

Dans `.github/workflows/ci.yml`, après le step typecheck, ajoute `- run: npm test`.
⚠ la CI fait `npm ci --ignore-scripts` : vitest s'installe sans scripts, OK.

**Vérifier** : lecture du YAML (indentation conforme) ; `git diff .github/workflows/ci.yml`
= 1 ligne ajoutée.

## Plan de test

Ce plan EST le plan de test. Modèle structurel : assertions simples façon
`scripts/test-docs-core.mjs`, pas de snapshots.

## Critères de done

- [ ] `npm test` exit 0 ; ≥ 10 cas répartis sur les 3 fichiers de tests
- [ ] `npm run typecheck` exit 0 (tests hors périmètre tsc)
- [ ] ci.yml : step `npm test` présent
- [ ] settings.ipc.ts : seul changement = `export` sur les 2 fonctions
- [ ] `git status` : rien hors in-scope

## Conditions STOP

- ci.yml absent (001 pas mergé).
- L'import de settings.ipc.ts sous vitest est infaisable même avec les mocks db/electron.
- Tu envisages `npm install` autre que la commande exacte de l'étape 1 (junction tronc !).
- Les extraits claude-launcher ne matchent pas le code.

## Notes de maintenance

- Candidats de suivi (rapporte-les, ne les écris pas) : test de parité
  COMMAND_TYPES↔processCommand (post-plan 002), test claims-lock concurrent
  (post-plan 003 — le script node du plan 003 est prêt à convertir).
- Reviewer : lire les assertions (un test qui n'affirme rien passe aussi).
