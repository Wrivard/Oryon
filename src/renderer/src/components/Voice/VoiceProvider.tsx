import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVoice } from '../../hooks/useVoice'
import { useVoiceCommand, type CommandTarget } from '../../hooks/useVoiceCommand'
import { useAppStore } from '../../store'
import { toast } from '../../store/toasts'
import { playStartCue, playEndCue } from '../../lib/voice-cues'
import type { VoiceState } from '@shared/types'

// Monte le pipeline Voice UNE SEULE fois au niveau racine (le preload utilise removeAllListeners → un seul
// abonné, sinon double-toggle). Route la dictée vers la cible réglée (voice.target) : 'orchestrator' = barre
// de dictée (review + apprentissage ✨) ; 'terminal' = PTY du terminal focus. Expose toggle/state + la mic.

type VoiceTarget = 'orchestrator' | 'terminal' | 'system'

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
  const commandBarRef = useRef<OrchestratorBarApi | null>(null) // barre ÉPINGLÉE à l'ouverture d'une commande vocale
  const [target, setTarget] = useState<VoiceTarget>('orchestrator')

  // Cible d'injection (réglage voice.target). Chargée une fois, puis maintenue LIVE via settings:appChanged :
  // un changement fait dans la modale in-window n'émet AUCUN event 'focus', donc sans ça la dictée router­ait
  // vers l'ancienne cible jusqu'au prochain focus fenêtre (misroute). Figée par capture côté useVoice.
  useEffect(() => {
    void window.bridge.settings.getApp().then((s) => setTarget((s['voice.target'] as VoiceTarget) ?? 'orchestrator'))
    const onAppChanged = (p: { key: string; value: string }) => {
      if (p.key === 'voice.target') setTarget((p.value as VoiceTarget) || 'orchestrator')
    }
    window.bridge.settings.onAppChanged(onAppChanged)
    return () => window.bridge.settings.offAppChanged(onAppChanged)
  }, [])

  const registerOrchestratorBar = useCallback((api: OrchestratorBarApi | null) => {
    barRef.current = api
  }, [])

  // Routage de la dictée selon la cible FIGÉE au début de la capture (routedSource, fourni par useVoice) — pas
  // l'état `target` live, sinon un changement de voice.target en cours de dictée re-router­ait à tort.
  // orchestrator → barre (l'utilisateur relit/édite puis envoie) ; terminal → PTY focus.
  const handleText = useCallback((text: string, routedSource: string) => {
    // Cible orchestrateur : va TOUJOURS à la barre — JAMAIS de repli terminal. Si la barre n'est pas montée
    // (onglet orchestrateur non visible → bar désenregistrée), écrire de la prose dans le PTY focus
    // l'exécuterait comme commande : on prévient l'utilisateur plutôt que de misrouter.
    if (routedSource === 'orchestrator') {
      if (barRef.current) barRef.current.setText(text)
      else toast.error('Ouvre le panneau Orchestrateur pour recevoir la dictée.', { title: 'Dictée' })
      return
    }
    // Cible système (façon WisprFlow) : colle au curseur de l'app au premier plan via le presse-papier (main).
    // Pas de repli barre/terminal — l'utilisateur dicte dans une AUTRE app ; un échec (OS non supporté, paste
    // refusé) remonte en { ok:false, reason } → toast plutôt qu'une perte silencieuse.
    if (routedSource === 'system') {
      // Dans un TERMINAL Oryon (xterm), Ctrl+V ne colle PAS (xterm envoie ^V au shell) → on écrit DIRECTEMENT dans
      // le PTY du terminal RÉELLEMENT focus. On lit l'id sur le conteneur <Terminal> qui contient le focus DOM
      // (data-oryon-term) — PAS focusedTerminalId, qui est le DERNIER terminal CLIQUÉ (périmé → collait dans le
      // mauvais terminal, ex. un worker au lieu de l'orchestrateur sélectionné). Workers ET orchestrateur sont
      // taggés (même composant <Terminal>). Hors d'un terminal (barre orchestrateur, champ normal, autre app) → Ctrl+V.
      // Router vers le PTY UNIQUEMENT si Oryon a le focus OS (document.hasFocus). Sinon document.activeElement
      // reflète le dernier élément focus DANS Oryon (souvent un terminal) même quand l'utilisateur est dans une
      // AUTRE app → on écrirait dans le terminal Oryon au lieu de Ctrl+V dans l'app externe (« ça marche juste sur Oryon »).
      const fid = document.hasFocus()
        ? document.activeElement?.closest('[data-oryon-term]')?.getAttribute('data-oryon-term')
        : null
      if (fid && useAppStore.getState().statuses[fid] !== 'exited') {
        console.log('[voice] cible système → écriture PTY terminal focus DOM ' + fid)
        window.bridge.terminals.write(fid, text)
        return
      }
      void window.bridge.voice.injectText(text).then((r) => {
        if (!r.ok)
          toast.error(
            r.reason === 'unsupported-os'
              ? 'Le collage système n’est disponible que sur Windows.'
              : 'Le collage dans l’app au premier plan a échoué — garde le champ cible au premier plan et réessaie.',
            { title: 'Dictée' },
          )
      })
      return
    }
    // Cible terminal. focusedTerminalId est un singleton GLOBAL et les PTY survivent au switch de workspace :
    // on n'écrit donc que si le terminal focus est vivant — PTY non exité (sinon write = no-op muet, C-2) — ET
    // appartient au workspace ACTIF (sinon la dictée partirait dans un AUTRE projet, C-3). Repli barre + toast.
    const st = useAppStore.getState()
    const fid = st.focusedTerminalId
    const ws = st.activeWorkspaceId
    const live =
      fid != null &&
      ws != null &&
      st.statuses[fid] !== 'exited' &&
      (st.terminalsByWorkspace[ws] ?? []).some((t) => t.id === fid)
    if (fid && live) window.bridge.terminals.write(fid, text)
    else if (barRef.current) barRef.current.setText(text) // repli : terminal absent/mort/autre workspace → barre
    else toast.error('Aucun terminal actif pour recevoir la dictée.', { title: 'Dictée' })
  }, [])

  const { state, toggle, cancel } = useVoice(handleText, target)

  // Sons de repère (réglage voice.cueSounds) : bip à l'ouverture (→ écoute) et au relâchement (écoute → traitement).
  // Joués sur les transitions d'état → indépendant du déclencheur (toggle, hotkey, hold PTT, widget).
  const prevStateRef = useRef<VoiceState>('idle')
  const cueSoundsRef = useRef(true)
  useEffect(() => {
    const load = (): void => {
      void window.bridge.settings.getApp().then((s) => {
        cueSoundsRef.current = (s['voice.cueSounds'] ?? '1') !== '0'
      })
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])
  useEffect(() => {
    const prev = prevStateRef.current
    prevStateRef.current = state
    if (!cueSoundsRef.current) return
    if (prev !== 'listening' && state === 'listening') playStartCue()
    else if (prev === 'listening' && state === 'processing') playEndCue()
  }, [state])

  // Conflit de raccourci global : la hotkey demandée est déjà prise par une autre appli → échec silencieux
  // côté OS. On le signale. Les conflits du BOOT sont émis AVANT que cet abonnement n'existe (registerVoiceHotkey
  // court avant que ce renderer ne soit prêt) → on les récupère explicitement au montage, en plus du live.
  useEffect(() => {
    const notify = (info: { accel: string; mode: string }): void => {
      const which = info.mode === 'command' ? 'mode commande' : 'dictée'
      toast.error(
        `Raccourci « ${info.accel} » déjà pris par une autre application — choisissez-en un autre dans Réglages › Voix (${which}).`,
        { title: 'Raccourci vocal' },
      )
    }
    window.bridge.voice.onHotkeyConflict(notify)
    void window.bridge.voice.getHotkeyConflicts().then((list) => list.forEach(notify))
    return () => window.bridge.voice.offHotkeyConflict(notify)
  }, [])

  // Command mode : la cible est la barre orchestrateur (sélection/insertion). Même classe de bug que la dictée
  // (cf. handleText) : on FIGE l'identité de la barre à la capture et on VALIDE à l'application. barRef.current
  // est live et change au switch de workspace — sans épinglage, le résultat transformé atterrirait dans la barre
  // d'un AUTRE workspace.
  const commandTarget = useMemo<CommandTarget>(
    () => ({
      getSelection: () => {
        // getSelection n'est appelé qu'à l'OUVERTURE de la commande (useVoiceCommand.start) : on épingle ici la
        // barre cible courante, comme routedSource fige la cible de dictée. no-op gracieux si absente.
        const bar = barRef.current
        commandBarRef.current = bar
        return bar?.commandTarget.getSelection() ?? null
      },
      applyResult: (result, sel) => {
        // VALIDE que la barre épinglée est TOUJOURS la barre active (pas de switch de workspace ni de démontage
        // entre-temps). Sinon : pas d'application + toast, plutôt qu'une perte silencieuse dans un autre workspace.
        const bar = commandBarRef.current
        if (!bar || bar !== barRef.current) {
          toast.error('Tu as changé de cible pendant la commande — résultat non appliqué.', { title: 'Command mode' })
          return
        }
        bar.commandTarget.applyResult(result, sel)
      },
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
