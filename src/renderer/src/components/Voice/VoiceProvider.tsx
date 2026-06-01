import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVoice } from '../../hooks/useVoice'
import { useVoiceCommand, type CommandTarget } from '../../hooks/useVoiceCommand'
import { useAppStore } from '../../store'
import { toast } from '../../store/toasts'
import type { VoiceState } from '@shared/types'

// Monte le pipeline Voice UNE SEULE fois au niveau racine (le preload utilise removeAllListeners → un seul
// abonné, sinon double-toggle). Route la dictée vers la cible réglée (voice.target) : 'orchestrator' = barre
// de dictée (review + apprentissage ✨) ; 'terminal' = PTY du terminal focus. Expose toggle/state + la mic.

type VoiceTarget = 'orchestrator' | 'terminal'

/** API qu'enregistre la barre de dictée orchestrateur pour recevoir le texte et servir de cible command-mode. */
export interface OrchestratorBarApi {
  setText: (text: string) => void
  commandTarget: CommandTarget
}

interface VoiceContextValue {
  registerOrchestratorBar: (api: OrchestratorBarApi | null) => void
  toggle: () => void
  cancel: () => void
  voiceState: VoiceState
}

const VoiceContext = createContext<VoiceContextValue>({
  registerOrchestratorBar: () => {},
  toggle: () => {},
  cancel: () => {},
  voiceState: 'idle',
})

export const useVoiceContext = (): VoiceContextValue => useContext(VoiceContext)

export function VoiceProvider({ children }: { children: ReactNode }): JSX.Element {
  const barRef = useRef<OrchestratorBarApi | null>(null)
  const [target, setTarget] = useState<VoiceTarget>('orchestrator')
  const targetRef = useRef<VoiceTarget>(target)
  targetRef.current = target

  // Cible d'injection (réglage), relue à chaque ouverture de réglages via l'event focus de la fenêtre.
  useEffect(() => {
    const load = () =>
      void window.bridge.settings.getApp().then((s) => setTarget((s['voice.target'] as VoiceTarget) ?? 'orchestrator'))
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  const registerOrchestratorBar = useCallback((api: OrchestratorBarApi | null) => {
    barRef.current = api
  }, [])

  // Routage de la dictée selon la cible FIGÉE au début de la capture (routedSource, fourni par useVoice) — pas
  // targetRef.current (live), sinon un changement de voice.target en cours de dictée re-router­ait à tort.
  // orchestrator → barre (l'utilisateur relit/édite puis envoie) ; terminal → PTY focus.
  const handleText = useCallback((text: string, routedSource: string) => {
    if (routedSource === 'orchestrator' && barRef.current) {
      barRef.current.setText(text)
      return
    }
    const fid = useAppStore.getState().focusedTerminalId
    if (fid) window.bridge.terminals.write(fid, text)
    else if (barRef.current) barRef.current.setText(text) // repli : aucun terminal focus → barre orchestrateur
  }, [])

  const { state, toggle, cancel } = useVoice(handleText, target)

  // Conflit de raccourci global (main → renderer) : la hotkey demandée est déjà prise par une autre appli →
  // échec silencieux côté OS. On le signale (cf. registerVoiceHotkey dans main/index.ts).
  useEffect(() => {
    window.bridge.voice.onHotkeyConflict((info) => {
      const which = info.mode === 'command' ? 'mode commande' : 'dictée'
      toast.error(
        `Raccourci « ${info.accel} » déjà pris par une autre application — choisissez-en un autre dans Réglages › Voix (${which}).`,
        { title: 'Raccourci vocal' },
      )
    })
    return () => window.bridge.voice.offHotkeyConflict()
  }, [])

  // Command mode : la cible est la barre orchestrateur (sélection/insertion) ; no-op gracieux si absente.
  const commandTarget = useMemo<CommandTarget>(
    () => ({
      getSelection: () => barRef.current?.commandTarget.getSelection() ?? null,
      applyResult: (result, sel) => barRef.current?.commandTarget.applyResult(result, sel),
    }),
    [],
  )
  useVoiceCommand(commandTarget)

  const value = useMemo<VoiceContextValue>(
    () => ({ registerOrchestratorBar, toggle, cancel, voiceState: state }),
    [registerOrchestratorBar, toggle, cancel, state],
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
