# Plan 017 : Upgrade Electron (32 EOL → majeure courante) + durcissement webview

- **Priorité** : P1 — **Effort** : L — **Risque** : HIGH (runtime entier)
- **Dépend de** : TOUS les autres plans mergés (007 fournit le filet de tests)
- **Catégorie** : security + migration — **Écrit à** : commit `29c8ae5`, 2026-06-11
- **Exécutant** : ORCHESTRATEUR (npm install réel + smoke runtime dans l'arbre principal — pas un worker)

## Pourquoi

Electron 32 est EOL depuis ~mars 2025 : plus AUCUN backport sécurité Chromium, alors
que le panneau Browser charge des URL internet arbitraires dans un `<webview>`. C'est
le finding sécurité #1 de l'audit. On monte vers la majeure stable courante et on
durcit le webview au passage (will-navigate, window-open handler).

## Points d'usage à vérifier contre les breaking changes (32 → N)

- `protocol.handle('app')` — src/main/index.ts (~l.258).
- Repli sandbox sur crash GPU — src/main/index.ts (~l.58-90).
- CSP injectée — src/main/index.ts (~l.289-295).
- `safeStorage` — settings.ipc/secure-store (post-plan 010).
- `<webview>` + `webviewTag: true` + partition `persist:oryon-preview` — BrowserPanel.tsx (~l.638) / index.ts (~l.152).
- `globalShortcut`, `BrowserWindow` options, `app.getPath`, `utilityProcess` (non utilisé).
- Natifs : better-sqlite3 / @lydell/node-pty / koffi — prébuilts ou N-API ;
  `postinstall` electron-rebuild gère better-sqlite3 ; vérifier la matrice ABI.

## Recherche faite (2026-06-11, sources : endoflife.date/electron + electronjs.org/breaking-changes)

- **Cible = Electron 42** (stable 42.4.0 du 2026-06-09 ; supportés : 40/41/42 ; 32 EOL depuis 2025-03-04).
- Breaking changes 33→42 sur NOTRE surface : LÉGERS. protocol.handle ✓ stable ;
  safeStorage / globalShortcut / app.getPath : aucun break ; contextBridge : seul
  l'exposage DIRECT d'ipcRenderer est interdit (E29) — on n'expose que des wrappers ✓ ;
  webview : E41 rend les PDFs dans le MÊME WebContents (iframe) — impact nul pour nous ;
  session.setPreloads déprécié E35 → `registerPreloadScript` (vérifier par grep si utilisé) ;
  E33 : C++20 requis pour les modules natifs → le rebuild better-sqlite3 (postinstall
  electron-rebuild) doit passer sur l'ABI 42 (prébuilt sinon toolchain) — POINT DE RISQUE №1.
- koffi + @lydell/node-pty : N-API → ABI-stable, pas de recompile attendue.

## Étapes (exécution orchestrateur)

1. ~~WebSearch~~ FAIT (bloc ci-dessus). Vérifier en plus par grep : `setPreloads` (0 attendu).
2. Branche de travail (`git switch -c chore/electron-upgrade`) dans l'arbre principal.
3. `npm install -D electron@<N> --no-audit --no-fund` (+ electron-builder si requis par N).
4. `npm run typecheck` → corriger les types d'API déplacées.
5. Durcissement webview (src/main/index.ts) : sur `did-attach-webview`, poser
   `will-navigate` (schémas http/https/localhost uniquement) + `setWindowOpenHandler`
   (deny + shell.openExternal pour http(s)).
6. `npm run build` puis `npm run dev` en arrière-plan : boot OK, fenêtre, terminaux
   spawnent, Browser panel navigue, dictée OK (.dev.log + console app).
7. `npm test` (suite 007) vert.
8. Smoke utilisateur (PTT, webview) puis merge sur main + release.

## STOP

- Une breaking change touche protocol.handle ou le webview sans équivalent simple →
  documenter, proposer la majeure intermédiaire la plus haute SANS la rupture.
- electron-rebuild échoue sur better-sqlite3 pour l'ABI N → vérifier la version
  better-sqlite3 requise avant d'insister.

## Notes

- L'app installée reste sur l'ancienne version jusqu'à la release suivante.
- Mettre à jour CLAUDE.md (version Electron citée) et le README au merge.
