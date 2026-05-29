# 07b — Voice++ : apprentissage continu (inspiré de Wispr Flow)

> Complément à `07-VOICE.md`. Objectif : faire passer notre module Voice d'une simple dictée Whisper → injection, à un **système de dictée qui apprend et s'améliore à l'usage** (vocabulaire, corrections, style, contexte du code), façon Wispr Flow.

Ce fichier contient : (1) une synthèse des mécaniques d'apprentissage de Wispr Flow, (2) ce qu'on adopte pour BridgeForge, (3) **le prompt copy-paste** à donner à Claude Code desktop.

---

## 1. Ce que fait Wispr Flow (les mécaniques qui "apprennent")

Décortiqué depuis leur doc. Les features clés qui font qu'il "s'améliore en l'utilisant" :

### A. Dictionnaire à deux étages
Deux mécanismes distincts, c'est le point central :
1. **Word boosting** (avant/pendant transcription) : une liste de mots de vocabulaire est envoyée au moteur comme *hints* pour mieux reconnaître les termes rares (jusqu'à 200 mots/session ; les mots "starred" = priorité plus haute).
2. **Replacement rules** (après transcription) : règles de remplacement `mauvaise orthographe → bonne orthographe`, appliquées en post-traitement, **cachées localement** pour s'appliquer instantanément.

### B. Auto-add to dictionary (LE cœur de ta demande)
Quand tu **corriges** un mot que Flow a mal transcrit, il **apprend** ce mot automatiquement. Détails importants :
- Une **IA classe** les corrections pour n'ajouter que les **noms propres / termes rares** (pas les mots courants comme "sprint", "feature").
- Les mots auto-appris sont marqués d'un ✨.
- Il **lit tes éditions** du texte dicté (même dans les terminaux, Slack, éditeurs) pour en déduire les nouveaux mots → c'est exactement le "qui apprend à force que tu réécris".

### C. Smart Formatting + Backtrack (nettoyage intelligent)
- Pipeline post-transcription : ponctuation, capitalisation, listes, sauts de ligne, retrait des disfluences.
- **Backtrack** : détecte les auto-corrections orales ("actually", "scratch that", ou reformulation naturelle) + une réduction de >3 mots → réécrit la phrase corrigée.
- Niveaux de nettoyage : None / Light / Medium / High.
- L'original n'est jamais perdu (**Undo AI edit**).

### D. Flow Styles + Writing Examples (apprend ton style)
- Ton préréglé par catégorie d'app (Formal / Casual / Very Casual / Excited).
- **Writing Examples** : tu fournis 1–5 échantillons (50–500 mots) de ton écriture → le polish imite ta voix. Les échantillons sont liés à un *prompt* précis.

### E. Snippets (expansions vocales)
- Trigger parlé → bloc de texte inséré ("my address" → adresse complète). Distinct du dictionnaire (qui corrige des mots).

### F. Command Mode (transformer du texte par la voix)
- Sélectionne du texte + parle une commande ("rends ça plus concis", "traduis en anglais") → remplace la sélection. Sans sélection → insère une réponse inline. **Très proche de ton orchestrateur.**

### G. Variable / File recognition (contexte du code) — ultra pertinent pour nous
- Flow lit le **contexte de l'éditeur** (noms de variables, fonctions, classes, fichiers ouverts) pour que la dictée matche le code. "set user ID to none" → `set userId to None`.
- File tagging : "tag main.py" → `@main.py`.
- Supporte JS/TS, Python, Java, Swift, C++, C, Rust, Go.

### H. Voice Profile (insights, engagement)
- Après 2 000 mots : profil personnalisé (superpower, peak time, catch phrase, **most corrected word**, persona). Construit **localement**. Surtout de l'engagement, mais le "most corrected word" alimente la boucle d'apprentissage.

### I. Multilingue (pertinent FR/EN pour toi)
- Détection de langue **par session** (pas par mot). Recommandé : sélectionner 2–3 langues plutôt qu'auto-detect sur 100+.
- Espacement typographique français automatique (espace fine avant `; : ? !`), **désactivé dans les éditeurs de code / terminaux**.

### Principes transverses à retenir
- **Local-first** : dictionnaire, historique, profil, échantillons restent sur l'appareil ; sync optionnelle.
- **Deux temps** : hints *avant* transcription + corrections *après*. Le cache local rend les corrections instantanées.
- **L'IA filtre l'apprentissage** : on n'apprend pas tout, seulement les noms propres / termes rares.
- **Rien n'est jamais perdu** : raw transcript conservé, Undo dispo.

---

## 2. Ce qu'on adopte pour BridgeForge (et pourquoi)

Notre Voice (`07-VOICE.md`) fait déjà : Whisper on-device + widget + injection + dictionnaire de remplacements basique + historique. On ajoute la **boucle d'apprentissage** :

| Mécanique Wispr | On l'adopte ? | Adaptation BridgeForge |
| --- | --- | --- |
| Dictionnaire 2 étages (boost + replace) | **Oui** | Whisper.cpp accepte un `initial_prompt` / liste de termes → on y injecte le vocabulaire (boost). Replacements appliqués en post sur le texte. |
| **Auto-add depuis tes corrections** | **Oui — priorité** | On détecte tes éditions du texte dicté (dans l'orchestrator bar surtout) et on apprend les nouveaux termes via un classifieur (Claude API) qui ne garde que noms propres / termes techniques. Marqueur ✨. |
| Smart Formatting + Backtrack | **Oui (Light par défaut)** | Pipeline post-transcription via Claude API. **Désactivé pour l'injection terminal** (le code ne veut pas de capitalisation auto), activé pour l'orchestrator bar / prose. |
| Flow Styles + Writing Examples | **Partiel** | Un "style" pour l'orchestrateur (concis, FR québécois) + échantillons optionnels. |
| Snippets vocaux | **Oui** | Triggers → blocs (ex. "prompt review" → un gabarit de prompt). |
| **Command Mode** | **Oui** | Brancher sur l'orchestrateur : voix + (sélection optionnelle) → transformation/insertion. |
| **Variable/file recognition** | **Oui — gros gain** | On a déjà le file-tree + l'éditeur Monaco du projet. On extrait identifiants & noms de fichiers du projet → vocabulaire de boost dynamique par workspace. "tag index.html" → `@index.html`. |
| Voice Profile | **Plus tard** | "Most corrected word" utile pour suggérer des ajouts au dictionnaire. |
| Multilingue FR/EN par session | **Oui** | Tu codes en FR/EN ; détection par session + pas d'espacement FR dans les terminaux/éditeur. |

**Décision clé** : le contexte cible de l'injection change le comportement.
- **Cible = terminal (Claude Code)** : pas de Smart Formatting agressif, pas d'espacement FR, mais **boost vocabulaire du projet** (noms de fichiers, variables) à fond + file tagging.
- **Cible = orchestrator bar / prose** : Smart Formatting + Backtrack + style.

---

## 3. Architecture de la boucle d'apprentissage

```
   Dictée ──► Whisper.cpp ──► texte brut
                 ▲                 │
   boost vocab ──┘                 ▼
 (dico perso +            [post-traitement]
  termes du projet)        replacements (cache local, instantané)
                              + Smart Formatting (si cible = prose)
                                   │
                                   ▼
                              injection (terminal / orchestrator bar)
                                   │
                       tu édites le texte inséré
                                   ▼
                    [diff édition vs texte injecté]
                                   ▼
                  classifieur (Claude API): nom propre/terme rare ?
                          oui │           non │
                              ▼               ▼ (ignoré)
                  ajout auto au dictionnaire (✨)  + règle de remplacement
                              │
                              └──► re-sync du vocab de boost (session suivante)
```

Tables SQLite à ajouter (sur la base de `07-VOICE.md`) :
```sql
CREATE TABLE voice_vocab (
  id TEXT PRIMARY KEY, term TEXT NOT NULL,
  starred INTEGER DEFAULT 0, source TEXT, -- manual|auto|project|csv
  created_at INTEGER, UNIQUE(term)
);
CREATE TABLE voice_replacements (
  id TEXT PRIMARY KEY, wrong TEXT NOT NULL, correct TEXT NOT NULL,
  UNIQUE(wrong)
);
CREATE TABLE voice_corrections_log ( -- pour "most corrected" + apprentissage
  id TEXT PRIMARY KEY, injected TEXT, edited TEXT,
  context TEXT, ts INTEGER
);
```

---

## 4. PROMPT à donner à Claude Code desktop

Copie-colle ce bloc. Il suppose que `./docs/07-VOICE.md` et ce fichier `./docs/07b-VOICE-LEARNING.md` sont dans le repo, et que le module Voice de base (Phase 4) existe déjà ou est en cours.

```
Améliore le module Voice de BridgeForge pour qu'il APPRENNE et s'améliore à l'usage, en s'inspirant des mécaniques de Wispr Flow décrites dans ./docs/07b-VOICE-LEARNING.md. Garde tout local-first. Implémente dans cet ordre :

1) DICTIONNAIRE À DEUX ÉTAGES
- Tables SQLite voice_vocab (terme, starred, source) et voice_replacements (wrong→correct) comme dans 07b §3.
- Boost: avant chaque transcription, construis un initial_prompt / liste de termes pour whisper.cpp à partir de voice_vocab (max ~200 termes, les "starred" en priorité). 
- Replacements: après transcription, applique voice_replacements en post-traitement, avec un cache en mémoire pour que ce soit instantané. Chaque "wrong" n'a qu'une seule règle.
- UI: une page "Voice Dictionary" (ajouter/éditer/supprimer/star/rechercher) + import CSV (1 colonne = vocab, 2 colonnes = wrong/correct).

2) AUTO-ADD DEPUIS MES CORRECTIONS (priorité)
- Après chaque injection, garde le texte injecté en référence. Détecte quand j'édite ce texte (dans l'orchestrator bar en priorité; pour le terminal, compare la dernière dictée injectée au contenu réellement validé).
- Log chaque paire (injected, edited, context) dans voice_corrections_log.
- Quand un mot diffère, appelle l'API Anthropic (clé dans le main, jamais le renderer) avec un prompt classifieur qui répond en JSON: {"learn": boolean, "term": string, "isProperNoun": boolean}. N'apprends QUE les noms propres / termes techniques rares; ignore les mots courants.
- Si learn=true: ajoute le terme à voice_vocab avec source="auto" et un flag pour l'afficher avec une icône ✨. Si c'est une correction d'orthographe récurrente, crée aussi une voice_replacements.
- UI: marqueur ✨ sur les mots auto-appris; possibilité de les confirmer/supprimer.

3) CONTEXTE DU PROJET (variable/file recognition)
- Pour le workspace actif, extrais les noms de fichiers (depuis le file-tree déjà dispo) et les identifiants de code (variables/fonctions/classes via une passe légère type tree-sitter ou regex) des fichiers ouverts dans Monaco.
- Ajoute-les comme vocabulaire de boost DYNAMIQUE (source="project"), recalculé au changement de workspace/fichier ouvert, sans polluer le dictionnaire perso permanent.
- File tagging: si la cible d'injection est un panneau de chat/prompt, "tag <fichier>" ou "arobase <fichier>" → insère "@<fichier>". Désactive le file tagging dans les terminaux.

4) SMART FORMATTING + BACKTRACK (sensible au contexte d'injection)
- Pipeline post-transcription via Claude API: ponctuation, capitalisation, listes, sauts de ligne ("nouvelle ligne", "nouveau paragraphe"), retrait des disfluences.
- Backtrack: détecte les auto-corrections ("en fait", "actually", "scratch that", "non plutôt") avec réduction nette de mots, et reformule.
- Niveaux: None / Light / Medium / High (défaut Light). Conserve TOUJOURS le texte brut + bouton "Undo AI edit".
- IMPORTANT: si la cible d'injection est un TERMINAL (Claude Code) ou l'éditeur de code, applique un mode "code-safe": pas de capitalisation auto, pas de ponctuation forcée, PAS d'espacement typographique français. Active le formatting complet uniquement pour l'orchestrator bar / prose.

5) MULTILINGUE FR/EN
- Détection de langue par session (pas par mot). Réglage: liste de langues sélectionnées (par défaut FR + EN) plutôt qu'auto-detect global.
- Espacement typographique français (espace fine avant ; : ? !) UNIQUEMENT en mode prose, jamais en mode code-safe.

6) COMMAND MODE (brancher sur l'orchestrateur)
- Hotkey dédié distinct du push-to-talk. Si du texte est sélectionné dans Monaco/orchestrator: voix = commande de transformation → remplace la sélection (avec undo). Sans sélection: insère la réponse inline. Réutilise l'API/orchestrateur existant. ESC annule; "Taking longer than usual" si > 3s.

7) SNIPPETS VOCAUX
- Table voice_snippets (trigger, expansion). Trigger parlé dans une dictée → remplacé par l'expansion. Distinct du dictionnaire. UI de gestion + import.

Contraintes transverses:
- Tout local-first; les seuls appels réseau sont l'API Anthropic pour le classifieur d'apprentissage, le Smart Formatting et Command Mode — tous déclenchables/désactivables dans les réglages (mode "privacy" qui garde tout 100% local et désactive ces appels).
- Réglages Voice: niveau de formatting, langues, mode code-safe auto selon la cible, activation auto-add, hotkeys (push-to-talk, toggle, command mode).
- Ne casse pas l'injection existante; ajoute par-dessus. Donne-moi une démo: je dicte "fonction get user data" dans un terminal Claude Code et ça matche les identifiants du projet; je corrige un nom propre dans l'orchestrator bar et il est appris avec ✨.
```

---

## 5. Notes d'implémentation
- **Whisper.cpp + boost** : whisper.cpp accepte un `initial_prompt`. Ce n'est pas un vrai "biasing" fort, mais ça aide ; pour un boost plus robuste, envisager un modèle qui supporte le *hotword/keyword boosting*. À tester sur ta version.
- **Détection d'édition en terminal** : difficile (le texte part dans le PTY). Le plus fiable = apprendre surtout depuis l'orchestrator bar et le Scratchpad/éditeur, où l'on contrôle le champ. C'est aussi ce que Wispr note comme cas délicat.
- **Coût API** : le classifieur d'apprentissage tourne seulement sur les mots qui *diffèrent* après édition → volume faible. Batcher et cacher.
- **Privacy** : un toggle "tout local" qui coupe les 3 appels réseau (classifieur, formatting, command mode) — utile pour du code client sensible.
