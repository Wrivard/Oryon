import { BrowserWindow, globalShortcut } from 'electron'
import { appSetting } from '../ipc/settings.ipc'
import { emitVoiceToggle, emitVoiceHold } from '../ipc/voice.ipc'
import { startKeyPoller, stopKeyPoller, parseAccelToVk, type PollWatch } from './key-poller'

// Hotkeys globales de dictée (toggle / hold) et de command mode. Chemin PRIMAIRE : polling koffi GetAsyncKeyState
// (key-poller.ts), seul moyen fiable de détecter le KEYUP en hold (push-to-talk façon WisprFlow) sous Windows : il
// ne pose AUCUN hook clavier, donc immunisé contre getUserMedia qui casse les hooks bas niveau (electron#33976).
// REPLI : si koffi est indisponible OU l'accélérateur n'est pas mappable en Virtual-Key, on retombe sur Electron
// globalShortcut — le mode hold dégrade alors en toggle (globalShortcut n'expose pas le keyup).
// (L'ancien fallback à hook clavier bas niveau a été RETIRÉ : son hook cessait de livrer les keyup sous capture
// micro — electron#33976 — le rendant inutilisable en dictée, le cas d'usage principal ; le polling koffi y est immunisé.)

let lastConflicts: { accel: string; mode: string }[] = []
let usingFallback = false
let fallbackAccels: string[] = [] // accélérateurs posés via globalShortcut (mode repli) — à libérer au ré-enregistrement

/** Command mode → renderer (toggle ; pas de keyup). Diffusé à toutes les fenêtres (le widget ne l'écoute pas). */
function broadcastCommandKey(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('voice:command-key')
}

function reportConflict(accel: string, mode: string): void {
  console.warn(`[voice-hotkey] accélérateur non mappable: ${accel} (${mode})`)
  lastConflicts.push({ accel, mode })
  BrowserWindow.getAllWindows()[0]?.webContents.send('voice:hotkeyConflict', { accel, mode })
}

/**
 * (Re)enregistre les hotkeys de dictée + command mode à partir des réglages COURANTS. Re-runnable à chaud (le
 * renderer appelle via 'voice:reregisterHotkeys' après un changement de raccourci ou de mode). Préfère le polling
 * koffi (key-poller.ts) ; repli globalShortcut si indisponible ou accélérateur non mappable.
 */
export function registerVoiceHotkeys(): void {
  lastConflicts = []
  const toggleAccel = appSetting('voice.hotkey.toggle') || appSetting('voice.hotkey') || 'CommandOrControl+Shift+Space'
  const commandAccel = appSetting('voice.hotkey.command') || 'CommandOrControl+Shift+.'
  const mode = appSetting('voice.mode')
  const holdMode = mode !== 'toggle' // défaut = HOLD (push-to-talk) ; 'toggle' seulement si explicitement choisi. 'ptt' = ancien alias hold.

  // PRÉFÉRENCE : polling GetAsyncKeyState (lit l'ÉTAT RÉEL des touches). C'est le SEUL moyen fiable de détecter le
  // RELÂCHEMENT en hold sous Windows : getUserMedia (capture micro) casse les hooks clavier bas niveau (electron#33976).
  // Le polling ne pose aucun hook → immunisé. Repli globalShortcut si koffi indisponible (hold dégradé en toggle).
  stopKeyPoller()
  const dictVk = parseAccelToVk(toggleAccel)
  if (dictVk) {
    const watches: PollWatch[] = [
      {
        ...dictVk,
        label: 'dictée',
        onDown: holdMode ? () => emitVoiceHold(true) : emitVoiceToggle,
        onUp: holdMode ? () => emitVoiceHold(false) : undefined,
      },
    ]
    const cmdVk = commandAccel && commandAccel !== toggleAccel ? parseAccelToVk(commandAccel) : null
    if (cmdVk) watches.push({ ...cmdVk, label: 'commande', onDown: broadcastCommandKey })
    if (startKeyPoller(watches)) return // polling actif → aucun hook clavier = aucun bug getUserMedia
  }

  // Repli : koffi indisponible OU accélérateur non mappable en Virtual-Key → globalShortcut (hold dégradé en toggle).
  registerViaGlobalShortcut(toggleAccel, commandAccel)
}

/** Repli sans keyup : reproduit l'ancien comportement globalShortcut (toggle + command, détection de conflit OS). */
function registerViaGlobalShortcut(toggleAccel: string, commandAccel: string): void {
  usingFallback = true
  for (const a of fallbackAccels) try { globalShortcut.unregister(a) } catch { /* ignore */ }
  fallbackAccels = []
  try {
    const ok = globalShortcut.register(toggleAccel, emitVoiceToggle)
    if (!ok || !globalShortcut.isRegistered(toggleAccel)) reportConflict(toggleAccel, 'toggle')
    else fallbackAccels.push(toggleAccel)
  } catch (e) {
    console.error('[voice-hotkey] enregistrement hotkey dictée (repli) échoué :', (e as Error).message)
  }
  try {
    if (commandAccel && commandAccel !== toggleAccel) {
      const ok = globalShortcut.register(commandAccel, broadcastCommandKey)
      if (!ok || !globalShortcut.isRegistered(commandAccel)) reportConflict(commandAccel, 'command')
      else fallbackAccels.push(commandAccel)
    }
  } catch (e) {
    console.error('[voice-hotkey] enregistrement hotkey command mode (repli) échoué :', (e as Error).message)
  }
}

/** Conflits du DERNIER enregistrement (le renderer les pull au montage : l'event boot part avant son abonnement). */
export function getVoiceHotkeyConflicts(): { accel: string; mode: string }[] {
  return lastConflicts
}

/** Arrêt propre (will-quit) : arrête le polling clavier et libère tous les globalShortcut. */
export function stopVoiceHotkeys(): void {
  stopKeyPoller()
  try { globalShortcut.unregisterAll() } catch { /* ignore */ }
  fallbackAccels = []
}
