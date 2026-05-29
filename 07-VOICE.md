# 07 — Module Voice (réplique BridgeVoice)

Optionnel mais fait partie de l'écosystème à répliquer. Objectif : dictée vocale on-device qui injecte le texte dans le terminal actif ou l'orchestrator bar.

## 1. Specs BridgeVoice à répliquer
- **Transcription on-device** via Whisper (rien n'est envoyé au cloud par défaut).
- **Injection universelle** : le texte transcrit est collé dans l'app/champ focus (clipboard + simulation `Cmd+V`).
- **Push-to-Talk** (maintenir une touche) et **Toggle** (presser pour démarrer/arrêter).
- **Widget flottant** always-on-top : Idle (pilule) / Listening (visualisation audio) / Processing (loader). Double-clic = toggle, draggable.
- **Custom dictionary** : remplacements ("next js" → "Next.js", "bridge mind" → "BridgeMind").
- **Historique** des transcriptions (texte, timestamp, durée, word count).
- Modèles : Tiny/Base/Small/Medium/Large/Distil-Large. Accélération GPU (Metal) sur Apple Silicon.

## 2. Implémentation recommandée
- **Whisper local** : `whisper.cpp` (binaire) appelé depuis le main, ou `nodejs-whisper` / `whisper-node`. Sur Apple Silicon, build avec Metal pour la vitesse.
- **Capture audio** : dans le renderer (Web Audio / MediaRecorder) → envoyer le buffer au main pour transcription, OU capter directement via le binaire whisper.cpp avec son entrée micro.
- **Hotkey global** : `globalShortcut` d'Electron (ex. Right Option / une combinaison) pour push-to-talk.
- **Injection** :
  - Cas simple (texte va dans NOTRE app) : injecter directement dans le champ React focus (orchestrator bar) ou écrire dans le PTY du terminal actif (`writeTerminal(activeId, text)`). **Plus fiable que la simulation clavier** puisqu'on contrôle l'app.
  - Cas universel (autres apps) : clipboard + `robotjs`/`nut.js` pour simuler `Cmd+V`. (Optionnel, phase ultérieure.)

## 3. Widget flottant
- Fenêtre Electron séparée : `frame:false`, `transparent:true`, `alwaysOnTop:true`, `resizable:false`, petite.
- 3 états visuels (Idle / Listening avec ~7 barres de fréquence / Processing).
- Draggable (`-webkit-app-region: drag`).
- Double-clic = start/stop.
- Dans le screenshot, le widget "BridgeVoice" flotte au centre-gauche → on positionne le nôtre librement, persistant.

## 4. Custom dictionary & historique
- Table SQLite `voice_replacements (spoken, replacement)` appliquée en post-traitement de la transcription.
- Table `voice_history (text, ts, duration_ms, word_count, source)`.

## 5. Intégration avec l'orchestrateur
- Bouton micro dans l'orchestrator bar → active le Voice → la transcription remplit l'input → tu valides → décomposition en tasks.
- Ou dictée directe dans un terminal focus.

## 6. Réglages
- Choix du modèle Whisper, langue, hotkey, mode (PTT/Toggle), cible d'injection (orchestrator / terminal actif / app focus).

## 7. Critère de "done" (MVP voice)
- [ ] Maintenir la hotkey enregistre, relâcher transcrit on-device.
- [ ] Le texte transcrit apparaît dans l'orchestrator bar.
- [ ] Le widget flottant montre Idle/Listening/Processing.
- [ ] Le dictionnaire applique au moins un remplacement.

> Note : Voice est **phase 4**. Ne pas bloquer le reste du projet dessus.
