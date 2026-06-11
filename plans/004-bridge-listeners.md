# Plan 004 : Bridge preload — désabonnements ciblés (fin du removeAllListeners qui tue les abonnés voisins)

> **Instructions exécuteur** : suis ce plan étape par étape. Lance chaque commande de
> vérification et confirme le résultat attendu avant de continuer. Si une condition
> STOP survient, arrête et rapporte — n'improvise pas. Le reviewer tient l'index
> `plans/README.md`.
>
> **Drift check (à lancer d'abord)** :
> `git diff --stat 29c8ae5..HEAD -- src/preload/index.ts src/shared/types.ts src/renderer/`
> Sur écart avec les extraits « État actuel », condition STOP.

## Statut

- **Priorité** : P1
- **Effort** : M
- **Risque** : MED (mécanique mais 19 canaux × ~12 composants consommateurs)
- **Dépend de** : aucun
- **Catégorie** : bug
- **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Dans `src/preload/index.ts`, TOUS les `offX` du bridge (19 occurrences) sont implémentés
par `ipcRenderer.removeAllListeners(channel)`. Quand DEUX composants montés écoutent le
même canal et que l'un se démonte, son cleanup supprime AUSSI l'abonnement de l'autre,
qui cesse silencieusement de se rafraîchir. Cas réels confirmés dans le code : la vue
Calendar (`Calendar/index.tsx:156`) et la section Réglages Calendar
(`Settings/CalendarSection.tsx:57`) écoutent toutes deux `calendar:changed` ; les
RightPanels de TOUS les workspaces restent montés en permanence (architecture
display:none) et partagent `browser:navigate`/`browser:dev-log`/`browser:capture` ;
`editor:fs-event`, `memory:changed`, `docs:changed`, `settings:appChanged` sont
également multi-abonnés selon l'écran. Le correctif : chaque `onX(cb)` mémorise le
wrapper associé à `cb`, et `offX(cb)` ne retire QUE ce wrapper.

## État actuel

- `src/preload/index.ts` (245 lignes) — objet `bridge: BridgeApi` exposé via
  `contextBridge.exposeInMainWorld('bridge', bridge)`. Motif actuel, répété partout :
  ```ts
  onChanged: (cb) => {
    ipcRenderer.on('calendar:changed', () => cb())
  },
  offChanged: () => ipcRenderer.removeAllListeners('calendar:changed'),
  ```
  Inventaire COMPLET des 19 paires on/off (canal → namespace.méthode) :
  1. `terminal:data:${id}` → terminals.onData/offData (canal PAR id)
  2. `terminal:exit:${id}` → terminals.onExit/offExit (canal PAR id)
  3. `editor:fs-event` → editor.onFsEvent/offFsEvent
  4. `browser:dev-log` → browser.onDevLog/offDevLog
  5. `browser:navigate` → browser.onNavigate/offNavigate
  6. `browser:capture` → browser.onCapture/offCapture
  7. `orchestrator:event` → orchestrator.onEvent/offEvent
  8. `settings:appChanged` → settings.onAppChanged/offAppChanged
  9. `voice:command-key` → voice.onCommandKey/offCommandKey
  10. `voice:toggle` → voice.onToggle/offToggle
  11. `voice:hold` → voice.onHold/offHold
  12. `voice:state` → voice.onState/offState
  13. `voice:hotkeyConflict` → voice.onHotkeyConflict/offHotkeyConflict
  14. `update:event` → update.onEvent/offEvent
  15. `memory:changed` → memory.onChanged/offChanged
  16. `docs:changed` → docs.onChanged/offChanged
  17. `docs:import-progress` → docs.onProgress/offProgress
  18. `calendar:changed` → calendar.onChanged/offChanged
  19. `system-feedback:changed` → systemFeedback.onChanged/offChanged
- `src/shared/types.ts` — interface `BridgeApi` : chaque `offX` y est typé SANS
  paramètre (ex. `offChanged: () => void`).
- Consommateurs renderer (liste de DÉPART — fais un grep exhaustif, étape 3) :
  `App.tsx`, `components/TerminalGrid/Terminal.tsx`, `components/RightPanel/{BrowserPanel,DocsPanel,MemoryPanel,EditorPanel}.tsx`,
  `components/Calendar/index.tsx`, `components/Settings/{CalendarSection,SettingsModal}.tsx`,
  `components/Settings/Voice/*.tsx`, `components/SystemFeedback/index.tsx`,
  `components/Voice/{VoiceProvider,VoiceWidget}.tsx`, `components/Update/UpdateToast.tsx`,
  `hooks/useVoice.ts`, `hooks/useVoiceCommand.ts`, `store/update.ts`.
- Convention repo : commentaires français « pourquoi », TypeScript strict (le typecheck
  est le seul garde-fou — il DOIT passer).

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Installer (1× si besoin) | `npm ci --ignore-scripts` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Inventaire des off | `grep -rn "removeAllListeners" src/preload/index.ts` | voir étapes |

## Périmètre

**In scope** :
- `src/preload/index.ts`
- `src/shared/types.ts` (UNIQUEMENT les signatures `offX` de BridgeApi)
- Tout fichier de `src/renderer/src/**` qui APPELLE un `onX`/`offX` du bridge

**Out of scope** :
- `src/main/**` (les émetteurs ne changent pas).
- Toute logique métier des composants (tu ne changes QUE la mécanique d'abonnement).
- `webview.d.ts`, `bridge.d.ts` SAUF s'ils redéclarent les signatures off (vérifie).

## Workflow git

- Branche `oryon/agent-<ton-nom>` dans ton worktree. Commits conventionnels, ex.
  `fix(preload): désabonnements bridge ciblés par callback`.
- Ne push pas (merge via approve_task).

## Étapes

### Étape 1 : helpers de souscription dans preload/index.ts

En tête de fichier (après les imports), ajoute :

```ts
// Abonnements CIBLÉS : offX(cb) ne retire QUE le wrapper de ce cb. L'ancien
// removeAllListeners tuait les abonnés des AUTRES composants montés sur le même canal
// (ex. vue Calendar + section Réglages Calendar sur 'calendar:changed').
// offX() SANS argument garde l'ancien comportement (purge totale) en compat.
type AnyCb = (...args: never[]) => void
const subs = new Map<string, Map<AnyCb, (e: IpcRendererEvent, ...args: unknown[]) => void>>()
function sub(channel: string, cb: AnyCb, wrapped: (e: IpcRendererEvent, ...args: unknown[]) => void): void {
  let m = subs.get(channel)
  if (!m) { m = new Map(); subs.set(channel, m) }
  m.set(cb, wrapped)
  ipcRenderer.on(channel, wrapped)
}
function unsub(channel: string, cb?: AnyCb): void {
  const m = subs.get(channel)
  if (!cb) { ipcRenderer.removeAllListeners(channel); m?.clear(); return }
  const wrapped = m?.get(cb)
  if (wrapped) { ipcRenderer.off(channel, wrapped); m?.delete(cb) }
}
```

(Adapte le typage si le strict-mode râle — l'important : Map canal→(cb→wrapper),
`ipcRenderer.off` ciblé, fallback removeAllListeners sans cb.)

**Vérifier** : `npm run typecheck` — il VA échouer à ce stade (signatures pas encore
alignées) ; c'est attendu, continue.

### Étape 2 : convertir les 19 paires

Pour chaque paire de l'inventaire, transforme :

```ts
onChanged: (cb) => {
  sub('calendar:changed', cb, () => cb())
},
offChanged: (cb) => unsub('calendar:changed', cb),
```

- Le 3e argument de `sub` est l'ANCIEN wrapper inchangé (garde exactement les mêmes
  mappings d'arguments : `(_e, data) => cb(data)`, `() => cb()`, etc.).
- Canaux par id (terminals) : `onData: (id, cb) => sub(`terminal:data:${id}`, cb, (_e, data) => cb(data as string))`
  et `offData: (id, cb) => unsub(`terminal:data:${id}`, cb)`.

**Vérifier** : `grep -n "removeAllListeners" src/preload/index.ts` → 1 SEULE occurrence
(celle du fallback dans `unsub`).

### Étape 3 : aligner BridgeApi (types.ts)

Chaque signature `offX: () => void` devient `offX: (cb?: <type du cb de onX>) => void`
(et `offData/offExit: (id: string, cb?: …) => void`). Le paramètre est OPTIONNEL : les
appels existants sans argument restent valides pendant la migration.

**Vérifier** : `npm run typecheck` exit 0 (la compat optionnelle doit suffire).

### Étape 4 : migrer les consommateurs renderer

Inventaire exhaustif : `grep -rn "\.off[A-Z]" src/renderer/src/`. Pour CHAQUE site :

```ts
useEffect(() => {
  const handler = () => { void load() }
  window.bridge.calendar.onChanged(handler)
  return () => window.bridge.calendar.offChanged(handler)
}, [load])
```

- Le cb passé à on et off doit être LA MÊME référence (constante locale de l'effet).
- Si un composant appelait `onX` avec une closure inline et `offX()` nu, crée la
  constante. Ne change RIEN d'autre à la logique.
- Cas par id (Terminal.tsx) : même motif avec `(id, handler)`.

**Vérifier** : `grep -rn "\.off[A-Z][a-zA-Z]*()" src/renderer/src/` → 0 résultat
(plus aucun off sans argument dans le renderer). Puis `npm run typecheck` exit 0.

## Plan de test

Pas de framework (plan 007 plus tard). Validation = typecheck + les deux greps + revue
du diff. Scénario manuel pour le reviewer (post-merge, app dev) : ouvrir la vue
Calendar PUIS Réglages→Calendar, fermer les Réglages, déclencher un changement
calendar → la vue Calendar doit encore se rafraîchir.

## Critères de done

- [ ] `grep -n "removeAllListeners" src/preload/index.ts` → exactement 1 (fallback unsub)
- [ ] Les 19 paires passent par sub/unsub avec wrappers d'arguments inchangés
- [ ] BridgeApi : tous les offX acceptent un cb optionnel
- [ ] `grep -rn "\.off[A-Z][a-zA-Z]*()" src/renderer/src/` → 0 résultat
- [ ] `npm run typecheck` exit 0
- [ ] `git status` : uniquement preload/index.ts, shared/types.ts et des fichiers sous src/renderer/src/

## Conditions STOP

- L'inventaire réel des paires on/off diffère des 19 listées (canal en plus/en moins) —
  rapporte l'écart avant de continuer.
- Un consommateur dépend STRUCTURELLEMENT de la purge totale (ex. il compte sur off()
  pour retirer le listener d'un AUTRE composant) — n'invente pas de correctif, rapporte.
- Plus de 2 fichiers renderer hors de la liste de départ nécessitent des changements
  profonds (pas juste extraire une constante handler) — rapporte la liste d'abord.

## Notes de maintenance

- Tout NOUVEAU canal bridge doit suivre ce motif (sub/unsub + off à cb optionnel).
- Reviewer : scruter Terminal.tsx (canaux par id, cleanup au changement de term.id) et
  VoiceProvider (plusieurs canaux voice dans un même effet).
- Le fallback off() sans cb reste volontairement (compat + échappatoire debug) — ne pas
  le « nettoyer » plus tard sans vérifier qu'aucun appel nu ne subsiste.
