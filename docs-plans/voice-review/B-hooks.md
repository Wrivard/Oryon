# Audit Voice — Zone B : hooks runtime (dictée + command-mode)

**Périmètre (lecture seule)** : `src/renderer/src/hooks/useVoice.ts`, `src/renderer/src/hooks/useVoiceCommand.ts`.
**Contexte vérifié hors-zone (lecture seule, pour lever les faux positifs)** : `lib/voice.ts` (Recorder / startRecording / transcribe), `lib/voice-lock.ts` (verrou micro), `preload/index.ts` (bridge IPC voice), `components/Voice/VoiceProvider.tsx` (seul consommateur), `components/RightPanel/OrchestratorPanel.tsx` (cible réelle command-mode), `main/index.ts` + `main/ipc/voice.ipc.ts` (émission `voice:toggle`).

**Verdict $0** : ✅ **AUCUN risque de coût Claude API dans la zone B.** Les deux hooks n'importent ni `@anthropic-ai/sdk` ni `anthropic`, n'utilisent jamais `ANTHROPIC_API_KEY`. La transcription est on-device (Transformers.js / ORT-WASM, `lib/voice.ts`). Le seul Claude appelé l'est via IPC (`window.bridge.voice.format` / `window.bridge.voice.command`) vers le main — la garantie subscription/CLI se situe dans le main (zone hors-B). Du point de vue des hooks : pas de chemin payant. **Aucun CRITICAL $0.**

**Compte par sévérité** : HIGH 1 · MEDIUM 1 · LOW 3 · INFO 5.

---

## HIGH

### H1 — `toggle()` et `ESC` ne peuvent PAS annuler pendant l'état `downloading`, alors que `stop()` bascule en `downloading` au milieu d'une transcription → démarre un enregistrement zombie (micro chaud / UI « idle »), réinjecte le texte « annulé » et désynchronise le verrou
- **Sévérité** : HIGH (corruption d'état + micro chaud sans indicateur + injection inattendue + désync du verrou). *Pas* un risque $0.
- **Fichier:ligne** :
  - `useVoice.ts:241-248` (`toggle` ne traite que `state === 'processing'` comme annulation)
  - `useVoice.ts:260-267` (le handler ESC fait `return` si `state === 'idle' || state === 'downloading'` → ESC inactif en `downloading`)
  - `useVoice.ts:184-186` (`stop()` fait `setState(cur => cur === 'processing' ? 'downloading' : cur)` quand la transcription télécharge/initialise un modèle)
  - `useVoice.ts:101` + `voice-lock.ts:9-14` (`tryAcquire` renvoie `true` si le même owner détient déjà le verrou)
- **Problème** : l'état `downloading` est **surchargé**. Il signifie à la fois (a) préchauffage à l'idle (bénin, `useVoice.ts:79-80`) et (b) « la transcription en cours télécharge un modèle » (`useVoice.ts:184-186`). `toggle()` et le handler `ESC` traitent `downloading` comme le cas bénin et **désactivent l'annulation**. Or seul `cancel()` incrémente `runIdRef` (`useVoice.ts:233`) pour invalider une transcription en vol — `start()` ne le fait jamais.
- **Scénario reproductible** (1re dictée à froid, modèle pas encore préchauffé — ou changement de modèle, ou chemin de repli `transcribe()` `lib/voice.ts:118-142`) :
  1. `start()` → enregistrement, `state='listening'`, verrou `dictation`.
  2. `stop()` → `recRef.current=null`, `runId=1`, `state='processing'`, `await rec.stop()` (libère `capturing` dans `lib/voice.ts`), puis `await transcribe(...)`. Le `progress_callback` du chargement du modèle émet `progress`/`download` → `setState('downloading')`. **État = `downloading`, `recRef` null, transcription en vol, verrou `dictation` encore tenu** (le `release` est dans le `finally`, pas encore exécuté).
  3. La hotkey globale / le widget émet `voice:toggle` (`main/index.ts:327`, `voice.ipc.ts:184`) → `onToggle` → `toggleRef.current()` → `toggle()` : `state==='downloading'` (≠ `processing`), `recRef.current` null → **`void start()`**.
  4. `start()` : gardes passées (`recRef`/`startingRef` faux) ; `tryAcquire('dictation')` renvoie **true** (même owner, `voice-lock.ts:10`) ; `capturing` est déjà `false` → un **nouvel enregistrement démarre** (`recRef`=nouveau, `state='listening'`).
  5. La transcription de l'étape 2 se résout : `runId(1) === runIdRef.current(1)` (jamais incrémenté) → la garde `useVoice.ts:188` **ne bloque pas**. La suite s'exécute : `setState('processing')` puis `onTextRef.current(text, snap.source)` (**injecte le texte que l'utilisateur croyait annulé**, `useVoice.ts:213`), `addHistory`, puis `finally` : `release('dictation')` (verrou libéré **alors qu'un enregistrement est actif**) + `setState('idle')` (`useVoice.ts:224-225`).
- **Conséquences** : micro réellement actif (`capturing=true`, `recRef` pointe le nouveau Recorder) mais UI + widget affichent `idle` (l'effet `reportState`, `useVoice.ts:270-272`, propage `idle`) → **micro chaud sans indicateur (problème de confidentialité)** ; injection du texte « annulé » ; verrou `dictation` à `null` pendant un enregistrement → un `tryAcquire('command')` réussirait côté verrou (la collision micro retombe alors sur le garde `capturing` de `lib/voice.ts:179` avec un toast d'erreur trompeur). Récupérable (un toggle suivant voit `recRef` set → `stop()`), et l'auto-stop VAD borne à ≤30 s **si** `autoStopOnSilence` est activé — mais **désactivé**, le micro reste chaud jusqu'à action manuelle.
- **Déclencheur précis (anti-faux-positif)** : se produit uniquement quand un (télé)chargement/init de modèle est concurrent d'un `stop()` — donc 1re dictée avant fin du warm, changement de modèle, ou chemin de repli `transcribe()`. Un modèle déjà préchauffé n'émet pas de `progress` à l'appel (`lib/voice.ts:100-101`) → `state` reste `processing` → `toggle` annule correctement. Le command-mode N'A PAS ce bug (`CommandState` n'a pas de `downloading`, et `toggle` fait `return` en `processing` — `useVoiceCommand.ts:98` — sans `start()`).
- **Fix suggéré** : découpler la décision d'annulation de l'état visible. Introduire `const transcribingRef = useRef(false)` mis à `true` en tête de `stop()` (avant `transcribe`) et à `false` dans le `finally` ; faire annuler `toggle()` ET le handler `ESC` dès que `transcribingRef.current` est vrai, **quel que soit** l'état visible. Variante plus simple : ne PAS exposer `downloading` depuis `stop()` (garder `processing` pendant un fetch de modèle en cours de transcription, via un sous-indicateur distinct) — alors `state==='processing'` couvre déjà le cas et `ESC` reste actif. Dans les deux cas, `start()` devrait aussi refuser de démarrer tant qu'une transcription est en vol.
- **Confiance** : Haute (mécanique vérifiée pas à pas ; le seul aléa est la fenêtre de déclenchement, restreinte au modèle en cours de téléchargement).

---

## MEDIUM

### M1 — Command-mode : sélection figée (valeur + bornes) à l'ouverture, appliquée à l'arrêt sans relecture → les éditions faites pendant l'enregistrement sont écrasées silencieusement (et peuvent atterrir dans une autre barre après un switch de workspace)
- **Sévérité** : MEDIUM (perte de données silencieuse dans une fonctionnalité de niche).
- **Fichier:ligne** :
  - `useVoiceCommand.ts:44` (`selRef.current = targetRef.current.getSelection()` — capturé au **début**)
  - `useVoiceCommand.ts:80-85` (à l'arrêt : `sel = selRef.current` ; `applyResult(result, sel)`)
  - `OrchestratorPanel.tsx:70-73` (l'`applyResult` réel reconstruit depuis `sel.value` **figé** : `sel.value.slice(0, sel.start) + result + sel.value.slice(sel.end)`)
  - `VoiceProvider.tsx:86-87` (la cible `barRef.current` est lue **live** à l'arrêt, pas épinglée à la capture)
- **Problème** : la sélection (`{value, start, end}`) est un **snapshot pris au démarrage** de la commande. `applyResult` réécrit **tout** le textarea à partir de `sel.value` figé. Si l'utilisateur tape / déplace le curseur pendant l'enregistrement+transcription (~1-3 s), ces éditions sont **perdues** (remplacées par `snapshot + result`). Aggravation : `VoiceProvider.commandTarget.applyResult` lit `barRef.current` **live** ; or plusieurs barres orchestrateur sont montées (une par workspace, `OrchestratorPanel.tsx:53-55`) et `barRef` change au switch → un switch de workspace pendant la commande applique la **valeur figée de l'ancienne barre dans la nouvelle barre**.
- **Pourquoi c'est réel** : les bornes elles-mêmes sont sûres (slice sur `sel.value` interne, jamais hors limites — pas de crash). Le risque est l'**écrasement à partir d'un snapshot périmé** : silencieux, sans confirmation ni garde de dérive.
- **Fix suggéré** : à l'application, relire la sélection vivante (`getSelection()` au moment du `stop`) pour la **destination** et ne se servir du snapshot de départ que pour le `selText` envoyé au CLI ; ou bien valider que `sel.value` correspond encore à la valeur courante de la cible (sinon abandonner avec un toast) ; et épingler l'identité de la barre cible à la capture pour éviter la dérive cross-workspace.
- **Confiance** : Moyenne-Haute (mécanique certaine ; reachability réelle surtout via switch de workspace pendant la commande, secondairement via édition pendant l'enregistrement).

---

## LOW

### L2 — Nettoyage au démontage : `runIdRef` n'est incrémenté que si `recRef.current` est set ; pendant `processing` (recRef déjà null) une transcription/commande en vol n'est PAS invalidée
- **Sévérité** : LOW (en pratique théorique : `VoiceProvider` est monté à la racine — `App.tsx:229` — et ne se démonte qu'au teardown de l'app).
- **Fichier:ligne** : `useVoice.ts:276-286` ; `useVoiceCommand.ts:139-149`.
- **Problème** : `stop()` met `recRef.current = null` **avant** les `await` (`useVoice.ts:162`, `useVoiceCommand.ts:69`). Si le démontage survient pendant `processing`, le cleanup voit `recRef.current` null → **n'incrémente pas `runIdRef`** → la transcription en vol n'est pas invalidée et exécute son `onTextRef.current(...)` / `applyResult(...)` post-démontage + le travail ORT est gaspillé. Pour le command-mode, l'effet de bord est neutralisé par l'optional-chaining (`VoiceProvider.tsx:87` `barRef.current?.`), donc no-op sûr ; pour la dictée, `handleText` écrit dans le terminal `focusedTerminalId` live (`VoiceProvider.tsx:63-64`) → injection possiblement mal routée.
- **Pourquoi** : garde asymétrique. `cancel()` (`useVoice.ts:233`) incrémente toujours `runIdRef` ; le cleanup démontage non.
- **Fix suggéré** : incrémenter `runIdRef.current` **inconditionnellement** dans le cleanup de démontage (avant le test `recRef.current`), pour invalider toute transcription en vol quelle que soit la phase.
- **Confiance** : Haute sur la mécanique ; impact réel faible vu le montage racine (mais bug latent si le hook est réutilisé dans un sous-arbre démontable).

### L3 — Command-mode : `cancel()` ne `clearTimeout` pas le `slowTimer` de `stop()` → le hint « plus long que d'habitude » peut s'allumer après annulation
- **Sévérité** : LOW (glitch visuel transitoire, auto-corrigé).
- **Fichier:ligne** : `useVoiceCommand.ts:72` (`slowTimer = setTimeout(() => setSlow(true), 3000)`), `useVoiceCommand.ts:58-64` (`cancel()` ne touche pas le timer), `useVoiceCommand.ts:91` (clear dans le `finally` de `stop`).
- **Problème** : `slowTimer` est une variable locale au closure de `stop()` ; `cancel()` ne peut pas l'effacer. Entre un `cancel()` (ESC) et le déroulé de `stop()` (qui attend encore `transcribe`/`command`), le timer 3 s peut tirer `setSlow(true)` alors que `finish()` vient de faire `setSlow(false)`. Auto-corrigé quand `stop()` se déroule (`clearTimeout` + `finish()` au `finally`), et l'affichage `slow` est généralement gardé par `state==='processing'` côté consommateur. Donc impact mineur.
- **Fix suggéré** : stocker le timer dans une ref et le `clearTimeout` aussi dans `cancel()` ; ou gater l'affichage du hint sur `state === 'processing'`.
- **Confiance** : Haute (mécanique simple) ; sévérité volontairement basse.

### L4 — La cible d'injection concrète (terminal focus / barre) est résolue **live** à l'arrêt, pas épinglée au début de capture
- **Sévérité** : LOW (en partie par design ; `routedSource` figé mais le « sink » concret live).
- **Fichier:ligne** : `useVoice.ts:213` (`onTextRef.current(text, snap.source)` — `snap.source` est figé, `useVoice.ts:108`/`64`) + `VoiceProvider.tsx:58-66` (`handleText` lit `focusedTerminalId` et `barRef.current` **live** au moment de l'injection).
- **Problème** : le hook gèle correctement la **classe** de routage (`snap.source` = `orchestrator`/`terminal`, conforme au commentaire rel-6 `useVoice.ts:64`), mais **quel** terminal / **quelle** barre reçoit le texte est résolu au moment du `stop` (côté `VoiceProvider`, hors zone B stricte). Si l'utilisateur change de terminal focus ou de workspace pendant la transcription, le texte atterrit dans le sink courant, pas celui actif au démarrage de la dictée. C'est précisément la question « la cible disparaît pendant la transcription ? » de la checklist : le hook lui-même ne tient pas de référence DOM (donc pas de fuite/cible morte côté hook), mais la résolution live peut dérouter.
- **Fix suggéré** (si jugé utile) : épingler aussi l'identité concrète du sink (terminalId) au snapshot de capture et la passer dans `onText`, pour que `VoiceProvider` route vers la cible d'origine. Décision produit — à arbitrer (frozen vs live).
- **Confiance** : Haute sur le constat ; sévérité basse (comportement partiellement intentionnel, résolution hors des 2 fichiers).

---

## INFO (vérifications passées — pas de correctif requis)

- **I1 — $0** : ✅ Voir verdict en tête. Aucun import payant ni `ANTHROPIC_API_KEY` dans les 2 hooks ; Claude uniquement via IPC vers le main. **PASS.**
- **I2 — Abonnements IPC hotkey stables** : ✅ `onToggle`/`onCommandKey` sont enregistrés **une seule fois** via un effet à deps `[]` avec un handler ref-stable (`() => toggleRef.current()`, `useVoice.ts:254-257`, `useVoiceCommand.ts:107-110`) — pas de `removeAllListeners` + ré-abonnement à chaque render (le commentaire le dit, vérifié exact). Le preload utilise bien `removeAllListeners` (`preload/index.ts:125,129`) mais `VoiceProvider` garantit **un seul abonné** (monté une fois à la racine, `App.tsx:229` ; commentaire `VoiceProvider.tsx:8-10`). Émission `voice:toggle` exclut le widget (`voice.ipc.ts:184`) → un seul récepteur. Coalescence leading-edge des toggles rapides faite dans le main (`main/index.ts:321`). **Correct en l'état.** ⚠️ *Footgun latent* (pas un bug actuel) : ajouter un 2e consommateur de `useVoice`/`useVoiceCommand` désabonnerait silencieusement le 1er via `removeAllListeners`. `onHotkeyConflict` est géré dans `VoiceProvider.tsx:72-81` (hors zone B), correctement abonné/désabonné.
- **I3 — `transcribe` non interruptible** : `cancel()` n'avorte pas l'inférence ORT en vol ; il invalide seulement le résultat via `runIdRef`. Le calcul tourne jusqu'au bout (borné à ≤30 s d'audio, `lib/voice.ts:181` `maxDurationMs`) puis est jeté. Gaspillage CPU borné, **pas une fuite** ; le MediaStream/AudioContext, eux, sont bien libérés par `rec.cancel()`→`cleanup()` (`lib/voice.ts:231-242`).
- **I4 — Préchauffe optimiste** : `warmedModelRef` est posé **avant** la résolution de `warmModel` (`useVoice.ts:77-78`) ; un warm en échec ne re-préchauffe pas au focus pour le même modèle — mais `loadAsr` a un cache auto-réparant (`lib/voice.ts:71-73`) qui réessaie à la 1re vraie dictée. Acceptable (documenté `useVoice.ts:83`).
- **I5 — Cancel / micro / réutilisable** : ✅ `cancel()` (`useVoice.ts:232-239`, `useVoiceCommand.ts:58-64`) appelle `rec.cancel()`→`cleanup()` (libère tracks micro + ferme AudioContext + `capturing=false`) et `release(...)` (libère le verrou) → réutilisable immédiatement. Gardes anti-double-start (`startingRef` synchrone) et anti-double-stop (`recRef` mis à null en tête) correctes. Démontage libère le verrou (`useVoice.ts:283`, `useVoiceCommand.ts:146`) — évite le lock-leak « dictée+command muets ». **OK** (sous réserve de L2).

---

*Audit lecture seule — aucun fichier source modifié. Vérification adversariale recommandée sur H1 (scénario à froid) et M1 (switch de workspace pendant command-mode).*
