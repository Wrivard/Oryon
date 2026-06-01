# Audit ZONE D — UI de réglages Voice + a11y (lecture seule, pré-prod)

**Périmètre** : toute l'UI de réglages Voice + accessibilité.
**Fichiers audités** (lecture seule, aucun modifié) :
- `src/renderer/src/components/Settings/Voice/VoiceSettings.tsx` (router sous-rail)
- `src/renderer/src/components/Settings/Voice/_parts.tsx` (primitives partagées)
- `src/renderer/src/components/Settings/Voice/VoiceGeneral.tsx`
- `src/renderer/src/components/Settings/Voice/VoiceDictionaries.tsx`
- `src/renderer/src/components/Settings/Voice/VoiceHotkeys.tsx`
- `src/renderer/src/components/Settings/Voice/VoiceStats.tsx`

**Méthode** : lecture intégrale des 6 fichiers + vérification adversariale du contrat avec les
consommateurs (`preload/index.ts`, `main/ipc/voice.ipc.ts`, `main/ipc/settings.ipc.ts`,
`main/index.ts`, `hooks/useVoice.ts`, `components/Voice/VoiceProvider.tsx`, `shared/types.ts`).

---

## Verdict

- **Coût Claude API / $0 : INTACT.** ✅ **Aucune** finding CRITICAL. Les 6 fichiers de ZONE D ne font
  **aucun** appel réseau / SDK / Claude : strictement `window.bridge.settings.*` et
  `window.bridge.voice.*` (SQLite local, `globalShortcut`, widget). Le toggle « Tout local » persiste
  bien `voice.privacy='1'`, et les deux chemins payants visibles (`voice:format`, `voice:command`,
  `voice.ipc.ts:165-173`) sont gatés sur `appSetting('voice.privacy') === '1'`. L'UI de réglages ne
  peut pas, par construction, déclencher de coût.
- **Pas de crash / pas de finding bloquante de sécurité.**
- **3 MEDIUM fonctionnelles** (régressions/incohérences réelles, à corriger avant prod, sans risque
  coût/donnée) + **un cluster a11y** + quelques LOW.

| # | Sév. | Fichier:ligne | Résumé |
|---|------|---------------|--------|
| 1 | MEDIUM | VoiceGeneral.tsx:133-153 | Mode **PTT** = réglage mort (aucun consommateur) |
| 2 | MEDIUM | VoiceHotkeys.tsx:147 | Texte « s'appliquent au redémarrage » contredit le ré-enregistrement à chaud |
| 3 | MEDIUM | VoiceGeneral.tsx:128 ↔ VoiceProvider.tsx:43-49 | `voice.target` non appliqué en direct (seulement au refocus fenêtre) |
| 4 | MEDIUM | _parts.tsx:44-98 ; VoiceGeneral.tsx:164,228,238 | Switches sans nom accessible |
| 5 | MEDIUM | VoiceDictionaries.tsx:239,298,359 | Boutons « + » icône-seule sans `aria-label` |
| 6 | LOW | VoiceDictionaries.tsx:146,233,289,350… | Inputs nommés uniquement par `placeholder` |
| 7 | LOW | VoiceSettings.tsx:32-44 | Onglet actif signalé par couleur seule (pas d'`aria-current`) |
| 8 | LOW | VoiceDictionaries.tsx:185,258,319 | Empty-state trompeur quand c'est « 0 résultat de recherche » |
| 9 | LOW | VoiceDictionaries.tsx:101-127 | Import CSV = jusqu'à 5000 allers-retours IPC séquentiels |
| 10 | LOW | VoiceDictionaries.tsx:36,138-139 | `csvTimeoutRef` non nettoyé au démontage |
| 11 | LOW | VoiceGeneral.tsx:96,108 | Valeur persistée inconnue → `<select>` vide (défensif) |

---

## Findings détaillées

### 1. [MEDIUM] Mode « PTT (maintien = dictée) » est un réglage mort
`VoiceGeneral.tsx:133-153` écrit `voice.mode` (`'toggle'` | `'ptt'`). **Aucun code ne lit `voice.mode`.**
Vérifié : un grep sur tout `src/` ne trouve `voice.mode` / `'ptt'` que dans `VoiceGeneral.tsx`
(écriture + surbrillance de l'état actif) ; **aucun handler `keyup`/`onKeyUp`** n'existe. Le raccourci
global (`main/index.ts:323-328`, `sendToggle`) ne se déclenche qu'à l'**appui** (key-down) et diffuse
`voice:toggle` (= bascule), avec en plus une coalescence de 250 ms qui casserait toute sémantique de
maintien. **Il n'y a aucune implémentation de push-to-talk.** Choisir « PTT (maintien = dictée) »
persiste mais ne change **rien** : le comportement reste toujours « toggle ». Contrôle non
fonctionnel + trompeur (« maintien = dictée » promet du hold-to-talk inexistant).
**Correctif (non appliqué)** : soit implémenter le PTT (nécessite une capture key-up — non faisable
via `globalShortcut` seul), soit retirer l'option PTT du sélecteur tant qu'elle n'est pas câblée.

### 2. [MEDIUM] Copie obsolète : « Les raccourcis s'appliquent au redémarrage »
`VoiceHotkeys.tsx:147` affiche en pied : « Les raccourcis s'appliquent au redémarrage. » Or `set()`
(`VoiceHotkeys.tsx:56-65`) appelle `window.bridge.voice.reregisterHotkeys()`, qui ré-enregistre les
`globalShortcut` **à chaud** (`main/index.ts:263` → `registerVoiceHotkey`, documenté « sans
redémarrage » à la fois dans le commentaire `main/index.ts:304` et le type bridge `shared/types.ts:701`,
et confirmé par le commentaire `VoiceHotkeys.tsx:60`). Le texte contredit donc directement le
comportement réel : il fait croire à l'utilisateur qu'un redémarrage est requis alors que le raccourci
est actif immédiatement. Copie périmée — vraisemblablement un reliquat du refactor.
**Correctif (non appliqué)** : remplacer par « Les raccourcis s'appliquent immédiatement. » (ou retirer
la ligne).

### 3. [MEDIUM] Changement de `voice.target` non appliqué en direct dans l'app
`VoiceGeneral.tsx:128` persiste `voice.target` (`orchestrator` | `terminal`). Le consommateur
`VoiceProvider.tsx:43-49` ne **relit** cette cible que sur l'événement `'focus'` de la fenêtre. Comme
les Réglages vivent dans **la même fenêtre renderer**, changer la « Destination » ne provoque pas de
blur/refocus de la fenêtre OS → la nouvelle cible n'est **pas** prise en compte tant que la fenêtre n'a
pas perdu puis regagné le focus (alt-tab) ou redémarré. À l'inverse, `model`/`language`/`autoStop`/
`silenceMs`/`boostThreshold`/`formatting`/`privacy` sont relus **frais** à chaque début de capture
(`useVoice.ts:106-116`), donc toujours à jour ; seul `target` est figé dans l'état de `VoiceProvider`.
Conséquence : basculer Destination → « Terminal » puis dicter aussitôt → le texte part quand même vers
la barre orchestrateur. (Côté consommateur, adjacent à ZONE D, mais c'est bien le changement de l'UI de
réglages qui ne prend pas effet.)
**Correctif (non appliqué)** : relire `voice.target` au moment de la capture (comme les autres réglages
hot-path), ou notifier `VoiceProvider` d'un changement de réglages sans dépendre du focus fenêtre.

### 4. [MEDIUM] Switches sans nom accessible
La primitive `Toggle` (`_parts.tsx:44-71`) pose `role="switch"` + `aria-checked`, mais son **nom
accessible** ne provient que du `title` (optionnel). Dans `VoiceGeneral.tsx`, les trois `Toggle` sont
rendus **sans** `title` : « Arrêt auto sur silence » (`:164`), « Widget always-on-top » (`:228`),
« Tout local » (`:238`). Et `SettingRow` (`_parts.tsx:73-98`) rend le libellé comme un `<div>` frère
**non associé** (pas d'`id`/`aria-labelledby`). Résultat : un lecteur d'écran annonce « interrupteur,
activé/désactivé » **sans intitulé**. Idem les boutons-étoile/suppression dans Dictionnaires sont
correctement étiquetés (`aria-label`, `aria-pressed`) — c'est le bon contre-exemple à suivre.
**Correctif (non appliqué)** : passer un `aria-label` (ou `title`) au `Toggle`, ou relier
`aria-labelledby` depuis le titre de `SettingRow`.

### 5. [MEDIUM] Boutons de validation « + » (icône seule) sans nom accessible
`VoiceDictionaries.tsx` — les boutons de confirmation d'ajout contiennent uniquement une icône `<Plus>`
et n'ont pas d'`aria-label` : vocabulaire (`:239`), règle (`:298`), snippet (`:359`). Annoncés
« bouton » sans intitulé. (Les déclencheurs d'en-tête « Ajouter » ont, eux, des `aria-label` corrects.)
**Correctif (non appliqué)** : `aria-label="Ajouter le terme/la règle/le snippet"`.

### 6. [LOW] Inputs nommés uniquement par `placeholder`
`VoiceDictionaries.tsx` : champ de recherche (`:146`) et les inputs des formulaires d'ajout (`:233`,
`:289`, `:291-296`, `:350`, `:352-357`) ont un `placeholder` mais **ni `<label>` ni `aria-label`**. Le
placeholder-comme-étiquette est une faiblesse WCAG connue (disparaît à la saisie, support AT
inconsistant). À noter : dans `VoiceGeneral.tsx`, les `<select>`/`<input range>` sont correctement
enveloppés dans un `<label>` (le `<span>` interne fournit le nom) — bon modèle à répliquer.

### 7. [LOW] Onglet actif du sous-rail signalé par la couleur seule
`VoiceSettings.tsx:32-44` : l'état actif des boutons de navigation n'est porté que par les classes
(`bg-accent-soft text-accent`) — pas d'`aria-current`/`aria-selected`. WCAG 1.4.1 (usage de la
couleur). À contextualiser : `aria-current` n'est utilisé **nulle part** dans le repo, donc c'est une
convention applicative existante, pas une régression propre à Voice.

### 8. [LOW] Empty-state trompeur en situation « 0 résultat de recherche »
`VoiceDictionaries.tsx:185/258/319` : quand `q` filtre tout, la branche `*View.length===0` affiche
« Aucun terme… / Aucune règle… / Aucun snippet… » avec un indice « Ajoute… », alors que des éléments
existent (le `CountChip` montre toujours le total réel). Lecture confuse pendant une recherche.

### 9. [LOW] Import CSV = jusqu'à 5000 allers-retours IPC séquentiels
`VoiceDictionaries.tsx:101-127` `await` `addReplacement`/`addVocab` ligne par ligne. Le bouton est bien
désactivé pendant l'import (`importing`), mais un gros fichier bloque avec seulement « Importation… ».
Pas un bug ; note perf/UX. (Aussi : le split sur `[;,\t]` découpe mal un champ contenant une virgule —
parseur volontairement simple, impact faible.)

### 10. [LOW] `csvTimeoutRef` non nettoyé au démontage
`VoiceDictionaries.tsx:36,138-139` : le timer de 4 s qui efface le message n'a pas de cleanup
`useEffect` ; démonter le composant dans les 4 s après un import déclenche un `setState` sur composant
démonté (inoffensif sous React 18, pas de fuite réelle). Trivial.

### 11. [LOW] Valeur persistée inconnue → `<select>` vide (défensif)
`VoiceGeneral.tsx:96` (modèle), `:108` (langue) : si une valeur héritée/étrangère avait été persistée
(ex. ancien `'fr'`/`'en'` pour la langue, ou un id de modèle complet), elle ne matcherait aucune
`<option>` → `<select>` vide/premier + warning React « controlled ». Aucune preuve que de telles
valeurs existent après le refactor ; simple note défensive. **Bien noté à l'inverse** : la langue
utilise `?? 'french'` (et **non** `|| 'french'`), ce qui **préserve** correctement le choix volontaire
« Auto-détection » (`value=""`) — ce point est juste.

---

## Vérifié CORRECT (anti-régression confirmée)

- **Garde `loaded` anti-clobber** : `VoiceGeneral.tsx:53-59` désactive tous les contrôles jusqu'à
  résolution de `getApp()`, empêchant un `onChange` d'écraser les vrais réglages par des défauts vides.
  Logique saine. `VoiceHotkeys` n'a pas cette garde mais n'écrit que sur action explicite
  d'enregistrement → pas de risque de clobber.
- **Précédence privacy cohérente** : l'UI désactive la section « Nettoyage du texte » quand privacy est
  ON (`VoiceGeneral.tsx:203-215`), et `useVoice.ts:204` force le formatage Light quand `privacy` est ON
  — les deux côtés concordent (le `voice.formatting` stocké n'est pas réinitialisé, juste ignoré).
- **Toggle widget** : `toggleWidget` (`VoiceGeneral.tsx:69-78`) persiste `voice.showWidget` **et**
  appelle `voice.setWidget(next)` (création/destruction live du widget) — logique de bascule correcte,
  affichage `on={… !== '0'}` cohérent avec le défaut ON.
- **Encodages hot-path** alignés UI ↔ `useVoice` : `autoStopOnSilence` (`!== '0'`, défaut on),
  `silenceMs` (ms brut), `boostThreshold` (flottant 0–1), `formatting` (`?? 'light'`),
  `privacy` (`=== '1'`) — tous concordants.
- **Contrats de types/null** UI ↔ `shared/types.ts` : `VoiceStats`, `VoiceHistoryItem` (champs
  nullables `duration_ms`/`word_count`/`source`/`created_at`) — accès null-safe vérifiés dans
  `VoiceStats.tsx` (`?? 0`, `!= null`, `&&`). `VoiceStats.tsx:75` `mostCorrected[0].count` est protégé
  par le garde `!s?.mostCorrected.length`. Échec partiel géré via `Promise.allSettled`
  (`VoiceStats.tsx:29-33`) + squelette `loaded`.
- **Collision de raccourci** (`VoiceHotkeys.tsx:98-103`) + nettoyage symétrique du listener clavier
  (`:77-116`, attache/détache à l'enregistrement et au démontage) — pas de fuite de listener global.

## Faux positifs écartés (pour épargner la revue adversariale)

- **`voice:reregisterHotkeys` a bien un handler** — enregistré en `main/index.ts:263` (et **non** dans
  `voice.ipc.ts`). Ce n'est PAS un handler manquant. (Suspicion initiale levée.)
- **Reduced-motion est respecté globalement** — `main.tsx:29` `<MotionConfig reducedMotion="user">` +
  règle CSS `index.css:126`. La transition `AnimatePresence` de `VoiceSettings` est donc conforme ;
  pas de finding a11y « motion ».
