import { useCallback, useEffect, useRef, useState } from 'react'
import { startRecording, transcribe, applySnippets, applyDictionary, fuzzyBoost, type Recorder } from '../lib/voice'
import { applyFileTags } from '../lib/project-vocab'
import { formatCodeSafe, formatLight } from '../lib/formatting'
import { tryAcquire, release } from '../lib/voice-lock'
import { toast } from '../store/toasts'
import { useAppStore } from '../store'
import type { VoiceState } from '@shared/types'

/**
 * Dictée vocale on-device : toggle() démarre/arrête l'enregistrement ; à l'arrêt, transcrit (Whisper WASM),
 * applique le dictionnaire, sauve l'historique, et passe le texte à `onText`. Réagit aussi à la hotkey
 * globale / au widget (canal voice:toggle). `source` = 'orchestrator' | 'terminal' (pour l'historique).
 */
export function useVoice(onText: (text: string) => void, source: string) {
  const [state, setState] = useState<VoiceState>('idle')
  const recRef = useRef<Recorder | null>(null)
  const startingRef = useRef(false) // garde synchrone : empêche un double-start pendant l'await (anti « capture déjà en cours »)
  const startedAt = useRef(0)
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const stopRef = useRef<(() => void) | null>(null) // évite le cycle start↔stop pour l'auto-stop VAD

  const start = useCallback(async () => {
    if (recRef.current || startingRef.current) return
    startingRef.current = true
    if (!tryAcquire('dictation')) {
      // Micro tenu par le command mode : no-op gracieux (pas d'alerte).
      startingRef.current = false
      return
    }
    try {
      // Auto-paste : auto-stop quand l'utilisateur arrête de parler (VAD), activable/réglable.
      const settings = await window.bridge.settings.getApp()
      const autoStop = (settings['voice.autoStopOnSilence'] ?? '1') !== '0'
      const silenceMs = settings['voice.silenceMs'] ? parseInt(settings['voice.silenceMs'], 10) : undefined
      recRef.current = await startRecording(autoStop ? { onSilence: () => stopRef.current?.(), silenceMs } : {})
      startedAt.current = Date.now()
      setState('listening')
    } catch (e) {
      release('dictation')
      setState('idle')
      toast.error((e as Error).message, { title: 'Dictée' })
    } finally {
      startingRef.current = false
    }
  }, [])

  const stop = useCallback(async () => {
    const rec = recRef.current
    if (!rec) return
    recRef.current = null
    setState('processing')
    try {
      const pcm = await rec.stop()
      // Garde : ne transcris pas du pur silence (auto-stop déclenché sans parole, ou capture vide).
      if (!rec.hadSpeech() || pcm.length === 0) return
      const durationMs = Date.now() - startedAt.current
      // Config Voice (défaut Québécois : whisper-small + français). Modifiable dans Settings › Application.
      const settings = await window.bridge.settings.getApp()
      const model = 'Xenova/whisper-' + (settings['voice.model'] || 'small')
      const language = settings['voice.language'] ?? 'french'
      let text = await transcribe(pcm, { model, language })
      const [reps, vocab, snippets] = await Promise.all([
        window.bridge.voice.listReplacements(),
        window.bridge.voice.listVocab(),
        window.bridge.voice.listSnippets(),
      ])
      // Pipeline POST (07b) : snippets → remplacements → boost fuzzy → file-tagging.
      // Boost = vocab perso + contexte projet (INC3, éphémère : identifiants des fichiers ouverts + noms de fichiers).
      const threshold = settings['voice.boostThreshold'] ? parseFloat(settings['voice.boostThreshold']) : undefined
      const { projectVocab, projectFiles } = useAppStore.getState()
      const mergedVocab = [
        ...vocab.map((v) => ({ term: v.term, starred: v.starred })),
        ...projectVocab.map((t) => ({ term: t, starred: false })),
      ]
      text = applySnippets(text, snippets.map((s) => ({ trigger: s.trigger, expansion: s.expansion })))
      text = applyDictionary(text, reps.map((r) => ({ spoken: r.spoken, replacement: r.replacement })))
      text = fuzzyBoost(text, mergedVocab, { threshold })
      // File-tagging : « tag X » → « @X » uniquement vers l'orchestrator bar (chat/prompt), jamais en terminal.
      if (source === 'orchestrator') text = applyFileTags(text, projectFiles)
      // Smart formatting (INC5/6) : terminal = code-safe (minimal) ; prose = Light local ou Medium/High via CLI $0.
      const codeSafe = source !== 'orchestrator'
      const level = settings['voice.formatting'] ?? 'light'
      if (codeSafe) {
        text = formatCodeSafe(text)
      } else if (level !== 'none' && text.trim()) {
        const french = (settings['voice.language'] ?? 'french') === 'french'
        if (level === 'light') {
          text = formatLight(text, { french })
        } else {
          const privacy = (settings['voice.privacy'] ?? '0') === '1'
          const cli = privacy ? '' : await window.bridge.voice.format(text, level === 'high' ? 'high' : 'medium')
          text = cli || formatLight(text, { french })
        }
      }
      if (text) {
        onTextRef.current(text)
        void window.bridge.voice.addHistory({
          text,
          durationMs,
          wordCount: text.split(/\s+/).filter(Boolean).length,
          source,
        })
      }
    } catch (e) {
      toast.error((e as Error).message, { title: 'Transcription échouée' })
    } finally {
      release('dictation')
      setState('idle')
    }
  }, [source])
  stopRef.current = stop // pour l'auto-stop VAD (onSilence → stop)

  const toggle = useCallback(() => {
    if (state === 'processing') return // ignore les toggles pendant la transcription
    if (recRef.current) void stop()
    else void start()
  }, [start, stop, state])

  // Hotkey globale / widget flottant → toggle.
  useEffect(() => {
    window.bridge.voice.onToggle(() => toggle())
    return () => window.bridge.voice.offToggle()
  }, [toggle])

  // Reflète l'état vers le widget flottant (via le main).
  useEffect(() => {
    window.bridge.voice.reportState(state)
  }, [state])

  return { state, toggle }
}
