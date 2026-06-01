import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startRecording,
  transcribe,
  warmModel,
  resolveModelId,
  applySnippets,
  applyDictionary,
  fuzzyBoost,
  type Recorder,
} from '../lib/voice'
import { applyFileTags } from '../lib/project-vocab'
import { formatCodeSafe, formatLight } from '../lib/formatting'
import { tryAcquire, release } from '../lib/voice-lock'
import { toast } from '../store/toasts'
import { useAppStore } from '../store'
import type { VoiceState } from '@shared/types'

/** Snapshot des réglages figé au début de la capture (rel-6) : la transcription ne dérive pas si on change un réglage en cours. */
interface Snapshot {
  model: string
  source: string
  language: string
  autoStop: boolean
  silenceMs?: number
  threshold?: number
  formatting: string
  privacy: boolean
}

interface Dicts {
  reps: { spoken: string; replacement: string }[]
  vocab: { term: string; starred: boolean }[]
  snippets: { trigger: string; expansion: string }[]
}

/** parseFloat sûr : NaN (réglage corrompu) → undefined plutôt qu'un comparatif toujours faux (rel-8). */
function num(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}

function isDownloadStatus(s?: string): boolean {
  return !!s && /progress|download|initiate|loading/i.test(s)
}

/**
 * Dictée vocale on-device : toggle() démarre/arrête ; à l'arrêt, transcrit (Whisper WASM/WebGPU),
 * applique snippets → dictionnaire → boost → file-tags → formatting, puis passe le texte à `onText`.
 * Réagit à la hotkey globale / au widget (canal voice:toggle). `source` = cible d'injection résolue
 * ('orchestrator' = prose + formatting ; autre = terminal code-safe). Préchauffe le modèle à l'idle (speed-1).
 */
export function useVoice(onText: (text: string, routedSource: string) => void, source: string) {
  const [state, setState] = useState<VoiceState>('idle')
  const recRef = useRef<Recorder | null>(null)
  const startingRef = useRef(false) // garde synchrone anti double-start pendant l'await
  const processingRef = useRef(false) // transcription en vol (stop()→finally) : signal fiable même quand l'affichage passe à 'downloading' — désambiguïse le 'downloading' de transcription du 'downloading' de préchauffage idle (H1 micro chaud)
  const startedAt = useRef(0)
  const snapRef = useRef<Snapshot | null>(null)
  const dictsRef = useRef<Dicts | null>(null) // dicos préfetchés pendant l'écoute (speed-7)
  const runIdRef = useRef(0) // token : invalide une transcription/format en vol après cancel (rel-7)
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const sourceRef = useRef(source) // cible d'injection figée à la capture (rel-6) : pas de dérive si voice.target change en cours
  sourceRef.current = source
  const warmedModelRef = useRef<string | null>(null) // dernier modèle préchauffé → re-warm au changement
  const stopRef = useRef<(() => void) | null>(null)

  // Préchauffe le modèle à l'idle (download + init session ORT hors du chemin critique) ET re-préchauffe si
  // l'utilisateur change de modèle dans les réglages (relu au retour de focus). État 'downloading' (speed-1/2).
  useEffect(() => {
    let cancelled = false
    const warm = (): void => {
      void window.bridge.settings.getApp().then((s) => {
        if (cancelled) return
        const model = resolveModelId(s['voice.model'] || 'small')
        if (model === warmedModelRef.current) return // déjà préchauffé ce modèle
        warmedModelRef.current = model
        warmModel(model, 'q8', (p) => {
          if (!cancelled && isDownloadStatus(p.status)) setState((cur) => (cur === 'idle' ? 'downloading' : cur))
        })
          .catch(() => {
            /* l'erreur de chargement remontera à la 1re vraie dictée avec un message FR */
          })
          .finally(() => {
            if (!cancelled) setState((cur) => (cur === 'downloading' ? 'idle' : cur))
          })
      })
    }
    warm()
    window.addEventListener('focus', warm)
    return () => {
      cancelled = true
      window.removeEventListener('focus', warm)
    }
  }, [])

  const start = useCallback(async () => {
    if (recRef.current || startingRef.current) return
    startingRef.current = true
    if (!tryAcquire('dictation')) {
      startingRef.current = false // micro tenu par le command mode : no-op gracieux
      return
    }
    try {
      const s = await window.bridge.settings.getApp()
      const snap: Snapshot = {
        model: resolveModelId(s['voice.model'] || 'small'),
        source: sourceRef.current,
        language: s['voice.language'] ?? 'french',
        autoStop: (s['voice.autoStopOnSilence'] ?? '1') !== '0',
        silenceMs: num(s['voice.silenceMs']),
        threshold: num(s['voice.boostThreshold']),
        formatting: s['voice.formatting'] ?? 'light',
        privacy: (s['voice.privacy'] ?? '0') === '1',
      }
      snapRef.current = snap
      // Préfetch des dicos pendant l'écoute → post-traitement local instantané au stop (speed-7).
      dictsRef.current = null
      void Promise.all([
        window.bridge.voice.listReplacements(),
        window.bridge.voice.listVocab(),
        window.bridge.voice.listSnippets(),
      ]).then(([reps, vocab, snippets]) => {
        dictsRef.current = {
          reps: reps.map((r) => ({ spoken: r.spoken, replacement: r.replacement })),
          vocab: vocab.map((v) => ({ term: v.term, starred: v.starred })),
          snippets: snippets.map((s2) => ({ trigger: s2.trigger, expansion: s2.expansion })),
        }
      })
      recRef.current = await startRecording(
        snap.autoStop ? { onSilence: () => stopRef.current?.(), silenceMs: snap.silenceMs } : {},
      )
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

  const loadDicts = async (): Promise<Dicts> => {
    if (dictsRef.current) return dictsRef.current
    const [reps, vocab, snippets] = await Promise.all([
      window.bridge.voice.listReplacements(),
      window.bridge.voice.listVocab(),
      window.bridge.voice.listSnippets(),
    ])
    return {
      reps: reps.map((r) => ({ spoken: r.spoken, replacement: r.replacement })),
      vocab: vocab.map((v) => ({ term: v.term, starred: v.starred })),
      snippets: snippets.map((s) => ({ trigger: s.trigger, expansion: s.expansion })),
    }
  }

  const stop = useCallback(async () => {
    const rec = recRef.current
    if (!rec) return
    recRef.current = null
    const runId = ++runIdRef.current // capture le token de ce run
    processingRef.current = true // transcription en vol, même si l'affichage bascule ensuite vers 'downloading'
    setState('processing')
    try {
      const pcm = await rec.stop()
      // Garde : ne transcris pas du silence. Si on a capté de l'audio mais aucune parole détectée → info (pas de drop muet, rel-3).
      if (!rec.hadSpeech() || pcm.length === 0) {
        if (pcm.length > 0) toast.info('Aucune parole détectée — rapproche le micro.', { title: 'Dictée' })
        return
      }
      const snap = snapRef.current ?? {
        model: resolveModelId('small'),
        source: sourceRef.current,
        language: 'french',
        autoStop: true,
        formatting: 'light',
        privacy: false,
      }
      const durationMs = Date.now() - startedAt.current
      let text = await transcribe(pcm, {
        model: snap.model,
        language: snap.language,
        onProgress: (p) => {
          if (isDownloadStatus(p.status)) setState((cur) => (cur === 'processing' ? 'downloading' : cur))
        },
      })
      if (runId !== runIdRef.current) return // annulé pendant la transcription (rel-7)
      setState('processing')
      const dicts = await loadDicts()
      const { projectVocab, projectFiles } = useAppStore.getState()
      const mergedVocab = [...dicts.vocab, ...projectVocab.map((t) => ({ term: t, starred: false }))]
      // Pipeline POST (07b) : snippets → remplacements → boost fuzzy → file-tags → formatting.
      text = applySnippets(text, dicts.snippets)
      text = applyDictionary(text, dicts.reps)
      text = fuzzyBoost(text, mergedVocab, { threshold: snap.threshold })
      const codeSafe = snap.source !== 'orchestrator'
      if (snap.source === 'orchestrator') text = applyFileTags(text, projectFiles)
      if (codeSafe) {
        text = formatCodeSafe(text)
      } else if (snap.formatting !== 'none' && text.trim()) {
        const french = snap.language === 'french'
        const light = formatLight(text, { french })
        if (snap.formatting === 'light' || snap.privacy) {
          text = light
        } else {
          const cli = await window.bridge.voice.format(text, snap.formatting === 'high' ? 'high' : 'medium')
          if (runId !== runIdRef.current) return
          text = cli || light
        }
      }
      if (text && runId === runIdRef.current) {
        onTextRef.current(text, snap.source)
        void window.bridge.voice.addHistory({
          text,
          durationMs,
          wordCount: text.split(/\s+/).filter(Boolean).length,
          source: snap.source,
        })
      }
    } catch (e) {
      toast.error((e as Error).message, { title: 'Transcription échouée' })
    } finally {
      if (runId === runIdRef.current) processingRef.current = false // seul le run courant efface son flag (un run annulé/dépassé ne stomp pas un run plus récent)
      release('dictation')
      setState('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cible figée via snap.source ; aucune dépendance réactive
  }, [])
  stopRef.current = stop

  /** Annule la dictée en cours : invalide le run (le résultat en vol ne sera pas injecté) et réinitialise (rel-7). */
  const cancel = useCallback(() => {
    runIdRef.current++ // toute transcription/format en vol devient stale → ignorée
    processingRef.current = false // plus de transcription en vol → un toggle suivant redémarre (au lieu de re-annuler)
    const rec = recRef.current
    recRef.current = null
    rec?.cancel()
    release('dictation')
    setState('idle')
  }, [])

  const toggle = useCallback(() => {
    if (processingRef.current) {
      // Transcription en vol → annulation (widget/hotkey n'ont pas le focus DOM pour Échap). processingRef couvre
      // 'processing' ET le sous-état 'downloading' (DL modèle en cours de transcription) : sinon toggle tomberait
      // dans start() et relancerait un micro zombie par-dessus la transcription en vol (H1 micro chaud).
      cancel()
      return
    }
    if (recRef.current) void stop()
    else void start()
  }, [start, stop, cancel])
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

  // Hotkey globale / widget flottant → toggle. Abonnement IPC stable (enregistré une seule fois) : le handler
  // appelle le toggle courant via ref, ce qui évite un removeAllListeners + ré-abonnement à CHAQUE changement d'état.
  useEffect(() => {
    window.bridge.voice.onToggle(() => toggleRef.current())
    return () => window.bridge.voice.offToggle()
  }, [])

  // ESC annule pendant l'écoute / la transcription (rel-7). En 'downloading', on n'attache ESC QUE si une
  // transcription est en vol (processingRef) : le simple préchauffage idle n'a rien à annuler (H1 micro chaud).
  useEffect(() => {
    if (state === 'idle' || (state === 'downloading' && !processingRef.current)) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, cancel])

  // Reflète l'état vers le widget flottant (via le main).
  useEffect(() => {
    window.bridge.voice.reportState(state)
  }, [state])

  // Démontage : libère le verrou micro et annule une capture en vol (sinon le verrou module-global resterait
  // tenu → dictée ET command mode muets ensuite, rel : lock-leak).
  useEffect(
    () => () => {
      runIdRef.current++ // L2 : invalide TOUTE op en vol (transcription/format), même en 'processing' où recRef est déjà null
      if (recRef.current) {
        recRef.current.cancel()
        recRef.current = null
      }
      release('dictation')
    },
    [],
  )

  return { state, toggle, cancel }
}
