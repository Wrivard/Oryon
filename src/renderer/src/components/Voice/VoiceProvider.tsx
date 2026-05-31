import { useCallback, useEffect, useRef, useState, createContext, useContext } from 'react'
import { useVoice } from '../../hooks/useVoice'
import { useVoiceCommand, type CommandTarget } from '../../hooks/useVoiceCommand'
import { warmModel } from '../../lib/voice'
import { useAppStore } from '../../store'
import { toast } from '../../store/toasts'

interface VoiceProviderProps {
  children: React.ReactNode
}

let voiceProviderMounted = false

interface VoiceContextValue {
  registerOrchestratorTarget: (target: CommandTarget | null) => void
}

const VoiceContext = createContext<VoiceContextValue>({
  registerOrchestratorTarget: () => {},
})

export function VoiceProvider({ children }: VoiceProviderProps) {
  const [orchestratorTarget, setOrchestratorTarget] = useState<CommandTarget | null>(null)
  const [voiceTarget, setVoiceTarget] = useState<'orchestrator' | 'terminal'>('orchestrator')
  const orchestratorTargetRef = useRef<CommandTarget | null>(null)
  const voiceTargetRef = useRef<'orchestrator' | 'terminal'>('orchestrator')
  orchestratorTargetRef.current = orchestratorTarget
  voiceTargetRef.current = voiceTarget

  const registerOrchestratorTarget = useCallback((target: CommandTarget | null) => {
    setOrchestratorTarget(target)
  }, [])

  useEffect(() => {
    window.bridge.settings.getApp().then((settings) => {
      const target = (settings['voice.target'] ?? 'orchestrator') as 'orchestrator' | 'terminal'
      setVoiceTarget(target)
    })
  }, [])

  const handleVoiceText = useCallback(
    (text: string) => {
      const target = voiceTargetRef.current
      if (target === 'orchestrator' && orchestratorTargetRef.current) {
        const sel = orchestratorTargetRef.current.getSelection()
        if (sel) {
          orchestratorTargetRef.current.applyResult(text, sel)
        }
      } else if (target === 'terminal') {
        const focusedTermId = useAppStore.getState().focusedTerminalId
        if (focusedTermId) {
          window.bridge.terminals.write(focusedTermId, text)
        }
      }
    },
    [],
  )

  useVoice(handleVoiceText, voiceTarget)
  useVoiceCommand(voiceTarget === 'orchestrator' ? (orchestratorTargetRef.current ?? { getSelection: () => null, applyResult: () => {} }) : { getSelection: () => null, applyResult: () => {} })

  useEffect(() => {
    if (voiceProviderMounted) {
      console.warn('VoiceProvider already mounted — mount only once at top level')
      return
    }
    voiceProviderMounted = true
    warmModel('Xenova/whisper-small', 'q8', (p: { status: string; progress?: number; file?: string }) => {
      if (p.status === 'loading model') toast.info('Chargement modèle vocal…', { title: 'Dictée' })
    }).catch(() => {
      /* error is logged elsewhere */
    })
  }, [])

  return (
    <VoiceContext.Provider value={{ registerOrchestratorTarget }}>
      {children}
    </VoiceContext.Provider>
  )
}

export function useVoiceContext() {
  return useContext(VoiceContext)
}
