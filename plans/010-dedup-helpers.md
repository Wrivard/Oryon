# Plan 010 : Dé-dupliquer les helpers triplés (secrets safeStorage, CRUD app_settings, atomic-fs)

> **Instructions exécuteur** : suis ce plan étape par étape ; chaque vérification doit
> donner le résultat attendu. Condition STOP → arrête et rapporte. Le reviewer tient
> `plans/README.md`.
>
> **Drift check** : `git diff --stat 29c8ae5..HEAD -- src/main/ipc/settings.ipc.ts src/main/services/google-calendar.ts src/main/services/vercel-rest.ts src/shared/`
> ATTENDU : memory-core.mjs modifié par le plan 003 (verrou claims) et
> system-feedback-core/command-types éventuellement par 002/007 — relis l'état RÉEL de
> ces fichiers avant d'extraire. Pour settings.ipc.ts : le plan 007 a pu exporter
> encryptSecrets/decryptSecrets — c'est compatible (tu déplaces l'implémentation, tu
> gardes les ré-exports).

## Statut

- **Priorité** : P2 — **Effort** : M — **Risque** : LOW-MED (code sensible mais refactor mécanique)
- **Dépend de** : plan 003 mergé (memory-core), plan 007 mergé si possible (tests = filet)
- **Catégorie** : tech-debt — **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Trois logiques sensibles existent en TROIS copies quasi identiques chacune : (1) le
chiffrement safeStorage `enc:v1:` (settings.ipc.ts en variante objet-JSON ;
google-calendar.ts et vercel-rest.ts en variante chaîne) ; (2) le CRUD clé/valeur
`app_settings` (get/set/del identiques dans google-calendar.ts, vercel-rest.ts +
appSetting dans settings.ipc.ts) ; (3) les helpers d'écriture atomique Windows
`renameRetry`/`writeAtomic` copiés dans docs-core.mjs, memory-core.mjs et
system-feedback-core.mjs. Un fix de sécurité ou un tuning Windows doit aujourd'hui être
appliqué 3 fois — la dérive est garantie (le backlog du lot Calendar le signalait déjà).

## État actuel

- `src/main/ipc/settings.ipc.ts` l.52-70 : `ENC_PREFIX = 'enc:v1:'` +
  `encryptSecrets(obj) : string | null` (JSON→enc:v1:base64 si dispo, sinon JSON clair ;
  null si objet vide) + `decryptSecrets(stored) : Record<string,string>` (lit les deux
  formes ; `catch { return {} }`). l.36-39 : `appSetting(key)` (SELECT pluck).
- `src/main/services/google-calendar.ts` l.41-68 : `get/set/del` (app_settings) +
  `enc(plain)/dec(stored)` (variante CHAÎNE : `''` si vide ; dec → `''` sur échec).
- `src/main/services/vercel-rest.ts` l.15-42 : copies idéntiques de get/set/del +
  enc/dec (mêmes corps que google-calendar).
- Les 3 cores .mjs : `renameRetry(from, to)` + `writeAtomic(path, content)` + compteur
  `tmpSeq` — copies quasi byte-identiques (docs-core.mjs l.24-44, memory-core.mjs
  l.74-95, system-feedback-core.mjs l.25-44). ⚠ memory-core a été modifié par le plan
  003 (verrou claims) : relis sa version COURANTE ; le verrou utilise ses propres
  écritures — n'extrais QUE renameRetry/writeAtomic, ne touche PAS au verrou.
- Convention twin-file : tout nouveau `.mjs` partagé importé par du TS reçoit un
  `.d.mts` (modèle : `src/shared/system-feedback-core.d.mts`).

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests (si plan 007 mergé) | `npm test` | exit 0 |
| Syntaxe cores | `node --check src/shared/<fichier>.mjs` (×4) | exit 0 |

## Périmètre

**In scope** :
- `src/main/services/secure-store.ts` (créer : chiffrement + CRUD app_settings)
- `src/main/ipc/settings.ipc.ts`, `src/main/services/google-calendar.ts`,
  `src/main/services/vercel-rest.ts` (consommer le nouveau module)
- `src/shared/atomic-fs.mjs` + `src/shared/atomic-fs.d.mts` (créer)
- `src/shared/docs-core.mjs`, `src/shared/memory-core.mjs`,
  `src/shared/system-feedback-core.mjs` (consommer atomic-fs)

**Out of scope** : tout changement de COMPORTEMENT (mêmes préfixes, mêmes replis, mêmes
formes de retour) ; le verrou claims de memory-core (plan 003) ; `scripts/before-pack.cjs`
(esbuild suit les imports relatifs — si le bundle MCP échoue, STOP) ; les appels DB hors
app_settings.

## Workflow git

Branche `oryon/agent-<ton-nom>` ; deux commits :
`refactor(main): secure-store partagé (enc:v1 + app_settings)` puis
`refactor(shared): atomic-fs partagé (renameRetry/writeAtomic)`. Ne push pas.

## Étapes

### Étape 1 : `src/main/services/secure-store.ts`

En-tête français (pourquoi : 3 copies → 1). Exporte :
`ENC_PREFIX`, `encryptString(plain: string): string` / `decryptString(stored: string | undefined): string`
(corps EXACTS de google-calendar enc/dec), `encryptJson(obj): string | null` /
`decryptJson(stored: unknown): Record<string, string>` (corps EXACTS de settings.ipc),
`getSetting(key): string | undefined` / `setSetting(key, value): void` / `delSetting(key): void`
(corps exacts du CRUD). Import `safeStorage` d'electron + `getDb` de `../db`.

**Vérifier** : `npm run typecheck` exit 0.

### Étape 2 : consommer dans les 3 fichiers main

- google-calendar.ts et vercel-rest.ts : supprime les helpers locaux, importe depuis
  `./secure-store` (alias locaux `const enc = encryptString` acceptés pour minimiser le
  diff). AUCUN autre changement.
- settings.ipc.ts : `encryptSecrets`/`decryptSecrets` deviennent des ré-exports/wrappers
  de encryptJson/decryptJson (si le plan 007 les a exportés pour ses tests, GARDE les
  exports — les tests doivent continuer de passer) ; `appSetting` délègue à getSetting.

**Vérifier** : `npm run typecheck` exit 0 ; si 007 mergé : `npm test` exit 0 ;
`grep -rn "enc:v1:" src/main/` → 1 seul fichier (secure-store.ts).

### Étape 3 : `src/shared/atomic-fs.mjs` + `.d.mts`

Copie la version de system-feedback-core (renameRetry + writeAtomic + tmpSeq interne),
en-tête français. d.mts : `export declare function renameRetry(from: string, to: string): Promise<void>` +
`export declare function writeAtomic(path: string, content: string): Promise<void>`
(ALIGNE sur les signatures réelles — relis-les). Puis dans les 3 cores : supprime les
copies locales, importe `{ renameRetry, writeAtomic }` depuis `./atomic-fs.mjs`.
⚠ Vérifie chaque usage interne (certains cores construisent le tmp eux-mêmes et
n'appellent que renameRetry — adapte l'extraction à ce que CHAQUE core utilise
réellement, sans changer son comportement).

**Vérifier** : `node --check` sur les 4 .mjs → exit 0 ; `npm run typecheck` exit 0 ;
`node scripts/test-docs-core.mjs` → passe (smoke existant du domaine docs) ;
si 007 mergé : `npm test` exit 0 (les tests system-feedback couvrent enqueue+écritures).

## Plan de test

Couvert par : tests 007 (system-feedback, chiffrement round-trip) + smoke
test-docs-core.mjs + typecheck. Si 007 N'EST PAS encore mergé au moment où tu exécutes,
note-le dans ton rapport (le reviewer re-lancera npm test après).

## Critères de done

- [ ] `grep -rn "enc:v1:" src/main/` → uniquement secure-store.ts
- [ ] `grep -rn "renameRetry" src/shared/` → définition uniquement dans atomic-fs.mjs (+ imports)
- [ ] Aucun changement de comportement (revue du diff : corps déplacés, pas réécrits)
- [ ] `npm run typecheck` exit 0 ; `node scripts/test-docs-core.mjs` passe
- [ ] `git status` : seulement les fichiers in-scope

## Conditions STOP

- Les corps des 3 copies ont DIVERGÉ de façon non triviale (pas juste des commentaires)
  — rapporte la divergence au lieu de choisir silencieusement.
- Le bundle MCP (before-pack) ne résout pas atomic-fs.mjs.
- memory-core post-plan-003 a une structure incompatible avec l'extraction propre.

## Notes de maintenance

- Tout NOUVEAU secret chiffré passe par secure-store ; tout nouveau core .mjs par
  atomic-fs. À documenter dans CLAUDE.md (le reviewer s'en charge).
- Reviewer : diff scruté sur dec/decryptJson (les replis d'échec diffèrent : '' vs {} —
  ils doivent rester DISTINCTS par variante).
