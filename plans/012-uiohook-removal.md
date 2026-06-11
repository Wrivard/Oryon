# Plan 012 : Retirer uiohook-napi (fallback mort) + dé-pinner Python en CI

> **Instructions exécuteur** : suis ce plan étape par étape ; chaque vérification doit
> donner le résultat attendu. Condition STOP → arrête et rapporte. Le reviewer tient
> `plans/README.md`.
>
> **Drift check** : `git diff --stat 29c8ae5..HEAD -- src/main/services/voice-hotkey.ts package.json .github/workflows/release.yml`
> ATTENDU : package.json modifié par 007 (vitest) et release.yml par 001 (actions/runner).
> Si voice-hotkey.ts a changé, compare aux extraits ; écart → STOP.

## Statut

- **Priorité** : P2 — **Effort** : M — **Risque** : MED (hotkeys utilisateur)
- **Dépend de** : plans 001 (release.yml) et 007 (package.json) mergés
- **Catégorie** : tech-debt + deps — **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

`uiohook-napi` n'est plus qu'un FALLBACK DE FALLBACK : le chemin primaire des hotkeys
est le polling koffi `GetAsyncKeyState` (key-poller.ts), choisi PRÉCISÉMENT parce que
le hook clavier d'uiohook casse sous capture micro (electron#33976 — son hold était
inutilisable en dictée, le cas d'usage principal). Pourtant le paquet impose : un step
`setup-python 3.11` dédié en CI (node-gyp/distutils, SEULE dépendance compilée depuis
les sources), un rebuild natif à chaque release, du poids d'installeur, et ~150 lignes
de code de repli. Le repli restant (globalShortcut, hold dégradé en toggle) couvre le
cas « koffi indisponible » aussi bien qu'uiohook le faisait sous micro actif.

## État actuel

- `src/main/services/voice-hotkey.ts` (283 l.) — structure exacte :
  - l.6 : `import type { UiohookKeyboardEvent, UiohookKey as UiohookKeyMap } from 'uiohook-napi'`
  - l.29-42 : `getUio()` lazy-require avec repli null.
  - l.16-25 + l.44-49 : type `Combo`, états `combos/listenersAttached/hookStarted/usingFallback/fallbackAccels`.
  - l.56-101 : `keycodeForToken`/`parseAccel`/`matches` + `REPRESS_STUCK_MS` (uiohook only).
  - l.102-138 : `onKeyDown`/`onKeyUp` (uiohook only).
  - l.156-186 : `registerVoiceHotkeys()` — essaie `startKeyPoller(watches)` (koffi) ;
    `if (startKeyPoller(watches)) return` ; SINON l.183-185 :
    `const uio = getUio(); if (uio) registerViaUiohook(…); else registerViaGlobalShortcut(…)`.
  - l.188-241 : `registerViaUiohook` (tout le bloc).
  - l.244-264 : `registerViaGlobalShortcut` (CONSERVÉ tel quel).
  - l.272-283 : `stopVoiceHotkeys` — bloc uio (l.274-277) à retirer ; le reste reste.
- `package.json` : `"uiohook-napi": "^1.5.5"` en dependencies.
- `.github/workflows/release.yml` : step `actions/setup-python` avec commentaire
  explicite « node-gyp (rebuild natif d'uiohook-napi …) » — sa SEULE raison d'être.
- `grep -rn "uiohook" src/` au commit 29c8ae5 : voice-hotkey.ts UNIQUEMENT.
- ⚠ WORKTREE : `node_modules` est une JUNCTION vers le tronc. INTERDIT de lancer
  `npm install` nu. Pour mettre à jour le lockfile après l'édit de package.json :
  `npm install --package-lock-only --no-audit --no-fund` (ne touche PAS node_modules).

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Lockfile only | `npm install --package-lock-only --no-audit --no-fund` | exit 0 ; package-lock sans uiohook |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0 (suite du plan 007) |

## Périmètre

**In scope** : `src/main/services/voice-hotkey.ts`, `package.json`,
`package-lock.json`, `.github/workflows/release.yml` (retrait du step Python + de son
commentaire).

**Out of scope** : `key-poller.ts` (chemin primaire, intact), `voice.ipc.ts`,
`electron-builder.yml` (asarUnpack `**/*.node` générique : aucun changement requis),
tout autre step de release.yml.

## Workflow git

Branche `oryon/agent-<ton-nom>` ; commit
`refactor(voice): retrait du fallback uiohook-napi (koffi polling = chemin primaire)` ;
second commit `ci(release): dé-pin Python (plus de rebuild natif uiohook)`. Ne push pas.

## Étapes

### Étape 1 : purger le chemin uiohook (voice-hotkey.ts)

Supprime : l'import type (l.6), getUio/uioApi, Combo/combos/listenersAttached/
hookStarted/REPRESS_STUCK_MS, keycodeForToken/parseAccel/matches/onKeyDown/onKeyUp,
registerViaUiohook, le bloc uio de stopVoiceHotkeys. Le repli de registerVoiceHotkeys
devient : `registerViaGlobalShortcut(toggleAccel, commandAccel)` directement. Mets à
jour l'EN-TÊTE du fichier (l.8-14) : le repli documenté est désormais globalShortcut
(hold dégradé en toggle), uiohook retiré (pourquoi : hook cassé sous capture micro,
electron#33976 ; koffi polling immunisé). `usingFallback`/`fallbackAccels` restent
(utilisés par registerViaGlobalShortcut).

**Vérifier** : `npm run typecheck` exit 0 ; `grep -rn "uiohook" src/` → 0 résultat.

### Étape 2 : dépendance + lockfile

Retire `"uiohook-napi"` de package.json puis
`npm install --package-lock-only --no-audit --no-fund`.

**Vérifier** : `grep -n "uiohook" package.json package-lock.json` → 0 résultat ;
`npm run typecheck` exit 0 ; `npm test` exit 0.

### Étape 3 : release.yml

Supprime le step `actions/setup-python` ET son bloc de commentaire (qui ne parle que
d'uiohook). Ne touche à RIEN d'autre.

**Vérifier** : lecture du YAML ; `git diff .github/workflows/release.yml` = suppression
du seul step Python.

## Plan de test

typecheck + npm test + greps. Runtime (reviewer, post-merge + rebuild) : PTT
hold-to-talk fonctionne (koffi) ; débrancher koffi n'est pas testable simplement —
le repli globalShortcut est inchangé depuis des versions, risque accepté.

## Critères de done

- [ ] `grep -rn "uiohook" src/ package.json package-lock.json` → 0
- [ ] registerVoiceHotkeys : koffi → sinon globalShortcut (2 niveaux, plus 3)
- [ ] release.yml sans step Python
- [ ] `npm run typecheck` + `npm test` exit 0
- [ ] `git status` : seulement les 4 fichiers in-scope

## Conditions STOP

- `grep uiohook` révèle un AUTRE consommateur que voice-hotkey.ts.
- Tu envisages `npm install` sans `--package-lock-only` (junction tronc !).
- release.yml ne contient plus le step Python (déjà retiré par ailleurs) — vérifie et
  saute l'étape 3 en le notant.

## Notes de maintenance

- Si un jour le hold sans koffi redevient critique, la référence historique est ce
  commit (le code uiohook reste dans l'historique git).
- Reviewer : vérifier le runtime PTT après rebuild (smoke utilisateur) avant release.
