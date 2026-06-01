import { useCallback, useEffect, useRef, useState } from 'react'
import { startRecording, transcribe, warmModel, resolveModelId, type Recorder } from '../lib/voice'
import { tryAcquire, release } from '../lib/voice-lock'
import { toast } from '../store/toasts'

export type CommandState = 'idle' | 'listening' | 'processing'

/** Cible d'application d'une commande vocale (ex. l'input de l'orchestrator bar, plus tard Monaco). */
export interface CommandTarget {
  /** Sélection courante (ou position du curseur si start === end). null si la cible n'est pas dispo. */
  getSelection: () => { value: string; start: number; end: number } | null
  /** Applique le résultat : remplace [start,end] dans `value` (ou insère au curseur). */
  applyResult: (result: string, sel: { value: string; start: number; end: number }) => void
}

/**
 * Command mode (INC9) : hotkey dédiée → enregistre une COMMANDE vocale → la transcrit → transforme la
 * sélection (ou insère inline) via le CLI $0. Toggle sur la hotkey ; Échap annule ; « plus long que
 * d'habitude » après 3 s. Réutilise la même capture micro que la dictée (garde-fou anti-collision).
 */
export function useVoiceCommand(target: CommandTarget) {
  const [state, setState] = useState<CommandState>('idle')
  const [slow, setSlow] = useState(false)
  const recRef = useRef<Recorder | null>(null)
  const startingRef = useRef(false) // garde synchrone anti double-start (cf. useVoice)
  const runIdRef = useRef(0) // token : invalide un résultat command en vol après ESC/cancel (rel-2)
  const selRef = useRef<{ value: string; start: number; end: number } | null>(null)
  const targetRef = useRef(target)
  targetRef.current = target

  const finish = useCallback(() => {
    setState('idle')
    setSlow(false)
  }, [])

  const start = useCallback(async () => {
    if (recRef.current || startingRef.current) return
    startingRef.current = true
    if (!tryAcquire('command')) {
      // Micro tenu par la dictée : no-op gracieux.
      startingRef.current = false
      return
    }
    selRef.current = targetRef.current.getSelection()
    try {
      recRef.current = await startRecording()
      setState('listening')
    } catch (e) {
      release('command')
      recRef.current = null
      setState('idle')
      toast.error((e as Error).message, { title: 'Command mode' })
    } finally {
      startingRef.current = false
    }
  }, [])

  const cancel = useCallback(() => {
    runIdRef.current++ // tout résultat en vol devient stale → non appliqué (rel-2)
    recRef.current?.cancel()
    recRef.current = null
    release('command')
    finish()
  }, [finish])

  const stop = useCallback(async () => {
    const rec = recRef.current
    if (!rec) return
    recRef.current = null
    const runId = ++runIdRef.current // token de ce run
    setState('processing')
    const slowTimer = setTimeout(() => setSlow(true), 3000)
    try {
      const pcm = await rec.stop()
      const settings = await window.bridge.settings.getApp()
      const model = resolveModelId(settings['voice.model'] || 'small')
      const language = settings['voice.language'] ?? 'french'
      const command = await transcribe(pcm, { model, language })
      if (runId !== runIdRef.current) return // annulé (ESC) pendant la transcription
      const sel = selRef.current
      if (command.trim() && sel) {
        const selText = sel.value.slice(sel.start, sel.end)
        const result = await window.bridge.voice.command(command, selText)
        if (runId !== runIdRef.current) return // annulé pendant l'appel command (ESC) → ne PAS écraser la sélection (rel-2)
        if (result) targetRef.current.applyResult(result, sel)
        else if ((settings['voice.privacy'] ?? '0') === '1') toast.info('Command mode désactivé en mode tout-local.')
      }
    } catch (e) {
      toast.error((e as Error).message, { title: 'Commande vocale échouée' })
    } finally {
      clearTimeout(slowTimer)
      release('command')
      finish()
    }
  }, [finish])

  const toggle = useCallback(() => {
    if (state === 'processing') return
    if (recRef.current) void stop()
    else void start()
  }, [start, stop, state])
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

  // Abonnement IPC stable (enregistré une seule fois) : le handler appelle le toggle courant via ref → plus de
  // removeAllListeners + ré-abonnement à chaque changement d'état.
  useEffect(() => {
    window.bridge.voice.onCommandKey(() => toggleRef.current())
    return () => window.bridge.voice.offCommandKey()
  }, [])

  // Échap annule pendant l'écoute / le traitement.
  useEffect(() => {
    if (state === 'idle') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, cancel])

  // Préchauffe le modèle à l'idle : une 1re commande vocale AVANT toute dictée ne paie pas un chargement à
  // froid sur le chemin critique. loadAsr dédoublonne avec le warm de useVoice (même clé modèle@dtype).
  useEffect(() => {
    let cancelled = false
    void window.bridge.settings.getApp().then((s) => {
      if (cancelled) return
      void warmModel(resolveModelId(s['voice.model'] || 'small')).catch(() => {
        /* l'erreur remontera à la 1re vraie commande avec un message FR */
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Démontage : libère le verrou micro et annule une capture en vol (sinon le verrou module-global resterait
  // tenu → dictée ET command mode muets ensuite, rel : lock-leak).
  useEffect(
    () => () => {
      if (recRef.current) {
        runIdRef.current++
        recRef.current.cancel()
        recRef.current = null
      }
      release('command')
    },
    [],
  )

  return { state, slow, cancel, toggle }
}
