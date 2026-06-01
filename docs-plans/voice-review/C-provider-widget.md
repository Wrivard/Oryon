# Audit Voice — ZONE C : provider, routage dictée, widget flottant

Audit **lecture seule** (avant push prod). Aucun fichier source modifié — ce rapport uniquement.

**Périmètre demandé** : `VoiceProvider.tsx`, `VoiceWidget.tsx`, `voice-widget.ts`. Les interactions
directes (handleText → store/PTY ; broadcast toggle ; conflit hotkey) sont auditées car la checklist les
couvre explicitement ; les findings hors des 3 fichiers sont tagués avec leur fichier réel.

## Verdict $0

**Aucun CRITICAL / aucun risque coût $0 dans la Zone C.** Aucun chemin de routage n'ajoute `\r` →
**aucun auto-submit**. La route terminal est code-safe (pas de CLI). La route orchestrateur passe par le
CLI subscription (formatting medium/high, gaté privacy) — $0 préservé. Le PTY strippe `ANTHROPIC_API_KEY`
(`pty-manager.ts:60`). Les misroutes ci-dessous restent des bugs de **correction/UX**, pas des fuites de coût.

## Compte par sévérité

| Sévérité | Count | IDs |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 5 | C-1, C-2, C-3, C-4, C-5 |
| LOW | 4 | C-6, C-7, C-8, C-9 |

Checklist couverte : 1 (routage) → C-1/C-2/C-3 ; 2 (registerOrchestratorBar) → RAS (voir §RAS) ;
3 (widget/broadcast/clamp/cleanup) → C-4/C-6/C-7 + RAS ; 4 (conflit hotkey) → C-5 ;
5 (sécurité webPreferences) → RAS ; 6 (races) → C-4/C-7/C-8.

---

## C-1 — [MEDIUM] Dictée « orchestrator » misroutée dans le terminal focus quand la barre n'est pas enregistrée

- **Fichiers** : `VoiceProvider.tsx:58-66` (handleText) ; `OrchestratorPanel.tsx:56-78` (enregistre la barre
  UNIQUEMENT si `active`) ; `RightPanel.tsx:105-112` (`visible = active === 'orchestrator' && wsId === activeWorkspaceId`).
- **Problème** : dans handleText, le test est
  `if (routedSource === 'orchestrator' && barRef.current) { … return }`. Si `routedSource === 'orchestrator'`
  MAIS `barRef.current === null`, la condition est fausse → on **tombe dans la branche terminal** et on écrit
  la **prose dictée** dans `useAppStore.getState().focusedTerminalId`. Or `barRef` est `null` dès que le panneau
  de droite n'est PAS sur l'onglet « Orchestrator » : `OrchestratorDictationBar` ne s'enregistre que tant que
  `active` (effet `if (!active) return` + cleanup `registerOrchestratorBar(null)`), et `active` n'est vrai que
  sur l'onglet orchestrateur du workspace actif.
- **Pourquoi** : la cible par défaut est `'orchestrator'` (`VoiceProvider.tsx:38` et `:45`). Un utilisateur qui
  dicte en regardant l'onglet Editor/Browser/Source/Plan/Memory/Tasks voit sa prose injectée dans la ligne de
  saisie d'un terminal worker. Pas de `\r` (donc pas d'auto-submit, pas de $0), mais misroute silencieuse ; s'il
  presse ensuite Entrée, de la prose destinée à l'orchestrateur part vers un worker.
- **Fix suggéré** : court-circuiter la route orchestrateur sans fallback terminal :
  ```ts
  if (routedSource === 'orchestrator') {
    if (barRef.current) barRef.current.setText(text)
    else toast.info('Ouvre l’onglet Orchestrateur pour recevoir la dictée.', { title: 'Dictée' })
    return
  }
  ```
  Réserver la branche `focusedTerminalId` à la seule route terminal.
- **Confiance** : HIGH (chemin de code non ambigu ; reachable avec la cible par défaut).

---

## C-2 — [MEDIUM] Dictée vers un terminal mort/exité : perte silencieuse, sans repli ni feedback

- **Fichiers** : `VoiceProvider.tsx:63-65` ; `pty-manager.ts:89-95` (`onExit` → `terms.delete(id)`) et
  `pty-manager.ts:111-113` (`writeTerminal` = `terms.get(id)?.proc.write` → no-op si id inconnu) ;
  `Terminal.tsx:157` (`onExit` ne fait que `setStatus(id,'exited')`, la row reste dans le store) ;
  `store/index.ts` (aucun reset de `focusedTerminalId` quand un PTY meurt seul).
- **Problème** : quand un PTY se termine de lui-même (claude crash / shell exit), le main **supprime** l'id de
  `terms`, mais le renderer **garde** le terminal (statut `exited`) et `focusedTerminalId` continue de pointer
  dessus. Dans handleText, `fid` est truthy → on prend `if (fid) write(fid,text)` et on **n'atteint jamais** le
  repli `else if (barRef.current)`. `writeTerminal` fait un **no-op silencieux** (id absent de `terms`). La
  transcription est perdue sans aucun toast.
- **Pourquoi** : perte de donnée silencieuse, confuse pour l'utilisateur (il a dicté, rien n'apparaît).
- **Fix suggéré** : tracer la liveness — soit nettoyer `focusedTerminalId` (et/ou re-focaliser) quand un terminal
  passe `exited`, soit, dans handleText, vérifier que la cible est vivante avant d'écrire (pont
  `terminals.isLive(id)` / lecture du `statuses[id]`) et retomber sur la barre + toast sinon.
- **Confiance** : HIGH sur le drop silencieux ; MEDIUM sur la fréquence (dépend des crashs PTY).

---

## C-3 — [MEDIUM] Misroute inter-workspace : `focusedTerminalId` global non réconcilié au switch vers un workspace sans terminal (ou pas encore chargé)

- **Fichiers** : `store/index.ts:89` (`setActiveWorkspace` ne touche pas au focus) ;
  `TerminalGrid/index.tsx:44-49` (réconciliation conditionnée à `terminals.length > 0`) ;
  `VoiceProvider.tsx:63-64` (lecture LIVE du focus à l'injection).
- **Problème** : `focusedTerminalId` est un **singleton global**. Au switch de workspace il n'est réconcilié que
  *paresseusement* par l'effet de la grille nouvellement active, et **seulement si** ce workspace a déjà ≥1
  terminal chargé. Si on bascule vers un workspace dont les terminaux ne sont pas encore chargés (`workspaces.open`
  async) ou qui a **zéro terminal**, `focusedTerminalId` reste pointé sur le terminal — **toujours vivant** — du
  workspace PRÉCÉDENT (les PTY survivent au switch, cf. persistance F1). Une dictée route terminal écrit alors
  dans le terminal d'un **autre projet**. De plus, comme le focus est lu LIVE à l'injection (`:63`) alors que la
  route est figée à la capture, switcher de workspace **pendant** une dictée redirige aussi l'injection.
- **Pourquoi** : misroute inter-workspace ; du texte/contexte atterrit dans le mauvais projet. Pas de `\r`
  (pas de $0), mais bug de correction réel + fuite de contexte.
- **Fix suggéré** : réconcilier le focus dans `setActiveWorkspace` (mettre à null ou au 1er terminal du nouveau
  workspace), et/ou scoper `focusedTerminalId` par workspace, et/ou figer l'id terminal cible au début de la
  capture comme l'est déjà la route.
- **Confiance** : MEDIUM-HIGH pour la fenêtre « 0 terminal / pas encore chargé » ; le régime établi est sain.

---

## C-4 — [MEDIUM] Race `destroyVoiceWidget`/`createVoiceWidget` : la référence du widget vivant peut être annulée → fenêtre orpheline

- **Fichier** : `voice-widget.ts:74-78` (handler `closed` fait `widget = null` inconditionnel) ;
  `voice-widget.ts:81-84` (`destroyVoiceWidget` fait `widget = null` **synchrone**, avant le `closed` async) ;
  `voice-widget.ts:32-36` (garde d'early-return de `createVoiceWidget`).
- **Problème** : `destroyVoiceWidget` appelle `widget.close()` (async) puis `widget = null`. Si
  `createVoiceWidget()` s'exécute **avant** que le `closed` de W1 ne fire, il crée W2 et fait `widget = W2`. Puis
  le handler `closed` de W1 exécute `widget = null` et **annule la référence vers W2 (vivant)**. W2 devient
  orphelin : `sendVoiceState` / `destroyVoiceWidget` / `isVoiceWidget` ne le voient plus → état figé, impossible à
  cacher, et `isVoiceWidget(W2) === false` (donc plus exclu du rebroadcast `voice:requestToggle` — bénin ici car
  le widget ne s'abonne pas à `voice:toggle`). Les listeners d'écran de W2 fuient aussi.
- **Déclencheur** : toggler rapidement le réglage du widget off→on (`voice:setWidget false` puis `true`) dans la
  latence de fermeture.
- **Fix suggéré** : capturer l'instance dans le closure et garder avant d'annuler :
  ```ts
  const w = widget
  w.on('closed', () => { screen.removeListener(...); if (widget === w) widget = null })
  ```
  et **ne pas** annuler synchroniquement dans `destroyVoiceWidget` (laisser `closed` le faire), ou n'annuler que
  si `widget` est encore la fenêtre fermée.
- **Confiance** : MEDIUM-HIGH (closure-over-module-var classique ; seule l'occurrence réelle du toggle rapide est incertaine).

---

## C-5 — [MEDIUM] Conflit de hotkey au démarrage non surfacé (toast émis avant l'abonnement du renderer)

- **Fichiers** : `main/index.ts:261` (`registerVoiceHotkey()` juste après `createWindow()`, avant fin de chargement
  renderer) ; `main/index.ts:333` et `:345` (envoi `voice:hotkeyConflict` à `getAllWindows()[0]`) ;
  `VoiceProvider.tsx:72-81` (abonnement `onHotkeyConflict` dans un `useEffect`, donc **après** le mount).
- **Problème** : au démarrage, l'IPC de conflit est émis pendant que le renderer charge encore, **avant** que le
  listener `onHotkeyConflict` de VoiceProvider n'existe. Un `webContents.send` main→renderer n'est pas mis en file
  pour un listener non encore enregistré → le toast de conflit du **boot est perdu**. C'est exactement l'échec
  silencieux que le design veut éviter (checklist #4), mais seulement au **1er lancement** ; le re-register à chaud
  (changement de réglage) fonctionne (renderer monté).
- **Pourquoi** : conflit de raccourci au boot jamais signalé → l'utilisateur croit la dictée fonctionnelle.
- **Fix suggéré** : le renderer tire l'état de conflit au mount (un `invoke` qui renvoie le dernier conflit), ou
  différer la 1re `registerVoiceHotkey()`/émission au `did-finish-load` de la fenêtre principale, ou ré-émettre
  sur un ping « renderer ready ».
- **Confiance** : MEDIUM (dépend du timing de chargement ; en pratique le renderer n'est jamais prêt au 1er tick → conflit boot fiablement perdu).

---

## C-6 — [LOW] Position du widget non persistée : retour systématique en bas-à-droite de l'écran principal

- **Fichier** : `voice-widget.ts:15-19` (`positionBottomRight`) ; `:60-61` (appelé inconditionnellement à la
  création) ; aucune sauvegarde/restauration de bounds nulle part (vérifié : `getBounds` n'est lu que par
  `clampToVisibleArea`, jamais persisté ; pas de listener `moved`, pas de clé settings de position).
- **Problème** : la fenêtre est `movable:true` + draggable, mais `createVoiceWidget` repositionne toujours en
  bas-à-droite ; aucune lecture d'une position sauvegardée ni listener `moved`. Le drag de l'utilisateur est donc
  perdu à chaque hide/show (`voice:setWidget`) et au redémarrage. Le brief d'audit attendait « position persistée »
  — non implémenté (régression vs attente, ou jamais implémenté ; je ne peux pas confirmer le comportement
  antérieur depuis cet arbre).
- **Pourquoi** : friction UX ; contredit l'intention déclarée.
- **Fix suggéré** : persister les bounds au `moved` (débouncé) dans les settings et les restaurer (clampés) dans
  `createVoiceWidget` au lieu du `positionBottomRight` inconditionnel.
- **Confiance** : HIGH que ce n'est pas persisté ; seule l'étiquette « régression vs manque » est incertaine.

---

## C-7 — [LOW] Le toggle via widget contourne la coalescence 250 ms

- **Fichiers** : `main/index.ts:321-328` (le debounce `sendToggle` ne s'applique qu'à la hotkey) ;
  `voice.ipc.ts:182-185` (`voice:requestToggle` rebroadcast `voice:toggle` **sans** debounce).
- **Problème** : le coalesceur leading-edge 250 ms (commenté comme couvrant « hotkey + widget ») ne garde que le
  callback hotkey. Un double-clic widget et une hotkey à <250 ms ne sont pas mutuellement débouncés → ils peuvent
  démarrer-puis-arrêter aussitôt une capture. Partiellement amorti par le garde `startingRef` de `useVoice`
  (`useVoice.ts:99`) — un toggle pendant le start async est avalé — mais une séquence start-complété-puis-stop reste
  possible.
- **Fix suggéré** : faire passer le `requestToggle` du widget par le même coalesceur (déplacer le debounce sur le
  broadcast de `voice:toggle`, ou faire appeler le même `sendToggle`).
- **Confiance** : MEDIUM.

---

## C-8 — [LOW] Widget ouvert en cours de capture : affiche `idle` périmé jusqu'au prochain changement d'état

- **Fichiers** : `voice-widget.ts:32-67` (`createVoiceWidget` ne pousse jamais l'état courant) ;
  `useVoice.ts:270-272` (`reportState` seulement au CHANGEMENT d'état) ; `VoiceWidget.tsx:18` (défaut `idle`).
- **Problème** : si le widget est créé via réglages alors que la fenêtre principale est déjà
  `listening`/`processing`, il s'initialise à `idle` et ne reflète l'état réel qu'au prochain changement.
- **Fix suggéré** : au `ready-to-show` (ou après création), demander au renderer son état vocal courant et le
  `sendVoiceState` ; ou faire re-reporter l'état par le renderer quand un widget apparaît.
- **Confiance** : MEDIUM. Cosmétique.

---

## C-9 — [LOW] Code mort : `targetRef` dans VoiceProvider écrit à chaque rendu, jamais lu

- **Fichier** : `VoiceProvider.tsx:39-40`.
- **Problème** : `targetRef` / `targetRef.current = target` est vestigial ; le routage utilise l'argument figé
  `routedSource` et l'état `target` passé à `useVoice`. Inoffensif mais trompeur (laisse croire à un routage
  sur cible live qui n'existe pas).
- **Fix suggéré** : supprimer `targetRef`.
- **Confiance** : HIGH.

---

## RAS (points vérifiés sans finding)

- **Checklist #1 — pas d'auto-submit** : route orchestrateur → `barRef.setText` (`VoiceProvider.tsx:60`, aucun
  envoi) ; route terminal → `terminals.write(fid, text)` **sans `\r`** (`:64`). L'envoi réel n'a lieu qu'au
  bouton/Entrée de l'orchestrateur (`OrchestratorPanel.tsx:86`, `text + '\r'`). ✓
- **Checklist #2 — registerOrchestratorBar** : un seul enregistré à la fois ; effet gardé par `active` +
  cleanup `registerOrchestratorBar(null)` (`OrchestratorPanel.tsx:56-78`) ; `registerOrchestratorBar` stable
  (`useCallback([])`, `VoiceProvider.tsx:51-53`). Au switch, React exécute **tous les cleanups avant tous les
  setups** dans un même commit → l'ancien `null` puis le nouveau `api` → `barRef` = nouvelle barre, **pas de
  stale**. (Le seul cas barRef=null légitime — onglet non-orchestrateur — est le déclencheur de C-1, pas un bug
  d'enregistrement en soi.) ✓
- **Checklist #3/#6 — exclusion du broadcast** : `voice:requestToggle` (widget) rediffuse `voice:toggle` à toutes
  les fenêtres SAUF le widget (`voice.ipc.ts:182-185`, `isVoiceWidget`). Pas de boucle : le widget ne monte que
  `<VoiceWidget/>` (`main.tsx:11-22`), n'abonne PAS `onToggle` → même s'il recevait `voice:toggle` (chemin hotkey
  `main/index.ts:316-318` qui diffuse à TOUS, widget inclus), il ne déclenche aucune capture. **Pas de
  double-capture.** Le cycle état est sain (toggle → state → `reportState` → `voice:stateChanged` → `sendVoiceState`
  → widget ; `state ≠ toggle`, pas de boucle). ✓
- **Checklist #3 — clamp multi-moniteur + cleanup listeners** : `clampToVisibleArea` (AABB correct,
  `voice-widget.ts:22-30`) appelé à la création et sur `display-removed`/`display-metrics-changed`
  (`:70-72`) ; listeners retirés au `closed` (`:74-78`). Correct (le seul angle mort est la race C-4 sur la
  ré-affectation de `widget`). ✓
- **Checklist #5 — sécurité webPreferences** : `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`,
  preload dédié (`voice-widget.ts:51-56`). Conforme. *Note informationnelle (non-finding)* : le widget reçoit tout
  `window.bridge` (toute l'API voice) alors qu'il n'utilise que `onState`/`requestToggle` — surface mineure, code
  same-origin de confiance, non exploitable.
- **Figeage de la route à la capture** : `routedSource` provient du snapshot `snap.source` figé au start
  (`useVoice.ts:64,117,213`) → changer `voice.target` en cours de dictée ne re-route pas. ✓ (Le terminal CIBLE,
  lui, n'est PAS figé — lu live — ce qui contribue à C-3.)
