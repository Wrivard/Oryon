import { BrowserWindow, globalShortcut } from 'electron'
import { appSetting } from '../ipc/settings.ipc'
import { emitVoiceToggle, emitVoiceHold } from '../ipc/voice.ipc'
import type { UiohookKeyboardEvent, UiohookKey as UiohookKeyMap } from 'uiohook-napi'

// Hotkeys globales de dictée (toggle / hold) et de command mode, via uiohook-napi — un hook clavier BAS NIVEAU
// qui, contrairement à Electron globalShortcut, expose le KEYUP. C'est ce qui rend le push-to-talk (maintien =
// dictée, façon WisprFlow) possible : keydown de la combo complète → démarrage ; keyup de la touche PRINCIPALE →
// arrêt. uiohook est un écouteur PASSIF (il n'« attrape » pas la combinaison comme globalShortcut) : il n'entre
// donc pas en conflit OS avec une autre appli, mais la frappe continue d'atteindre l'app au premier plan.
// REPLI : si le binaire natif ne se charge pas (require throw) ou si uIOhook.start() échoue (machine verrouillée),
// on retombe sur globalShortcut — le mode hold dégrade alors en toggle (pas de keyup possible sans uiohook).

type Parsed = { keycode: number; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }
interface Combo {
  accel: string
  mode: 'toggle' | 'command'
  parsed: Parsed
  pressed: boolean // anti auto-répétition (le keydown se répète tant que la touche est maintenue) + suivi du relâchement
  downAt: number // horodatage du dernier front montant → auto-réparation si un keyup est raté (pressed resterait true)
  onDown: () => void
  onUp?: () => void
}

const isMac = process.platform === 'darwin'

// uiohook chargé PARESSEUSEMENT via require (jamais à l'import) : si le binaire natif est absent/illisible sur la
// machine, on bascule sur globalShortcut au lieu de crasher tout le main au chargement du module. Le main est
// bundlé en CJS → require est natif au runtime ; uiohook-napi est externalisé (dépendance), résolu depuis node_modules.
let uioApi: typeof import('uiohook-napi') | null | undefined
function getUio(): typeof import('uiohook-napi') | null {
  if (uioApi !== undefined) return uioApi
  try {
    uioApi = require('uiohook-napi') as typeof import('uiohook-napi')
  } catch (e) {
    console.error('[voice-hotkey] uiohook-napi indisponible — repli globalShortcut (pas de push-to-talk) :', (e as Error).message)
    uioApi = null
  }
  return uioApi
}

let combos: Combo[] = []
let lastConflicts: { accel: string; mode: string }[] = []
let listenersAttached = false
let hookStarted = false
let usingFallback = false
let fallbackAccels: string[] = [] // accélérateurs posés via globalShortcut (mode repli) — à libérer au ré-enregistrement

/**
 * Traduit un token de touche d'accélérateur Electron (ex. 'Space', '.', 'A', 'F2') en keycode uiohook. Couvre les
 * défauts (Space, '.') + lettres / chiffres / F1-F24 + ponctuation courante. null = non mappable → reporté comme
 * « conflit » (le renderer invite à choisir une autre touche).
 */
function keycodeForToken(token: string, K: typeof UiohookKeyMap): number | null {
  const u = token.trim().toUpperCase()
  if (!u) return null
  const map = K as unknown as Record<string, number>
  if (/^[A-Z]$/.test(u) || /^[0-9]$/.test(u) || /^F([1-9]|1[0-9]|2[0-4])$/.test(u)) return map[u] ?? null
  const NAMED: Record<string, number> = {
    SPACE: K.Space, TAB: K.Tab, ENTER: K.Enter, RETURN: K.Enter,
    ESC: K.Escape, ESCAPE: K.Escape, BACKSPACE: K.Backspace,
    DELETE: K.Delete, DEL: K.Delete, INSERT: K.Insert,
    HOME: K.Home, END: K.End, PAGEUP: K.PageUp, PAGEDOWN: K.PageDown,
    UP: K.ArrowUp, DOWN: K.ArrowDown, LEFT: K.ArrowLeft, RIGHT: K.ArrowRight,
    PLUS: K.Equal, '=': K.Equal, '-': K.Minus, ',': K.Comma, '.': K.Period, '/': K.Slash,
    ';': K.Semicolon, "'": K.Quote, '[': K.BracketLeft, ']': K.BracketRight, '\\': K.Backslash, '`': K.Backquote,
  }
  return NAMED[u] ?? null
}

/** Décompose un accélérateur Electron en keycode uiohook + modificateurs requis. null si non mappable. */
function parseAccel(accel: string, K: typeof UiohookKeyMap): Parsed | null {
  let ctrl = false, shift = false, alt = false, meta = false
  let keyToken: string | null = null
  for (const raw of accel.split('+')) {
    const p = raw.trim()
    if (!p) continue
    const u = p.toUpperCase()
    if (u === 'COMMANDORCONTROL' || u === 'CMDORCTRL') { if (isMac) meta = true; else ctrl = true }
    else if (u === 'CONTROL' || u === 'CTRL') ctrl = true
    else if (u === 'SHIFT') shift = true
    else if (u === 'ALT' || u === 'OPTION') alt = true
    else if (u === 'SUPER' || u === 'META' || u === 'CMD' || u === 'COMMAND') meta = true
    else keyToken = p // dernier token non-modificateur = touche principale
  }
  if (keyToken == null) return null
  const keycode = keycodeForToken(keyToken, K)
  if (keycode == null) return null
  return { keycode, ctrl, shift, alt, meta }
}

/** Vrai si l'événement correspond EXACTEMENT à la combo (mêmes modificateurs, comme globalShortcut). */
function matches(e: UiohookKeyboardEvent, p: Parsed): boolean {
  return e.keycode === p.keycode && e.ctrlKey === p.ctrl && e.shiftKey === p.shift && e.altKey === p.alt && e.metaKey === p.meta
}

// Si un keyup est raté (pressed resterait true → toggle-off / re-départ bloqués pour toujours), un nouvel appui
// au-delà de ce délai re-déclenche quand même. > durée d'un appui/tap normal, < l'intervalle entre deux dictées.
const REPRESS_STUCK_MS = 2000
function onKeyDown(e: UiohookKeyboardEvent): void {
  try {
    const now = Date.now()
    for (const c of combos) {
      if (!matches(e, c.parsed)) continue
      // N'agir QUE sur le front montant : le keydown se RÉPÈTE tant que la touche est tenue (auto-répétition
      // clavier Windows ~250 ms). Sans ce garde, le toggle se ré-enclenchait au repeat et coupait la dictée à
      // ~256 ms. Auto-réparation : un keyup raté laisserait pressed=true à jamais → on ré-autorise après REPRESS_STUCK_MS.
      if (c.pressed && now - c.downAt <= REPRESS_STUCK_MS) continue
      c.pressed = true
      c.downAt = now
      c.onDown()
    }
  } catch (err) {
    console.error('[voice-hotkey] keydown:', (err as Error).message)
  }
}

function onKeyUp(e: UiohookKeyboardEvent): void {
  try {
    for (const c of combos) {
      // keyup de la TOUCHE PRINCIPALE (on ignore le relâchement des modificateurs) → fin du maintien.
      if (c.pressed && e.keycode === c.parsed.keycode) {
        c.pressed = false
        c.onUp?.()
      }
    }
  } catch (err) {
    console.error('[voice-hotkey] keyup:', (err as Error).message)
  }
}

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
 * renderer appelle via 'voice:reregisterHotkeys' après un changement de raccourci ou de mode). Choisit uiohook
 * si disponible, sinon globalShortcut.
 */
export function registerVoiceHotkeys(): void {
  lastConflicts = []
  const toggleAccel = appSetting('voice.hotkey.toggle') || appSetting('voice.hotkey') || 'CommandOrControl+Shift+Space'
  const commandAccel = appSetting('voice.hotkey.command') || 'CommandOrControl+Shift+.'
  const mode = appSetting('voice.mode')
  const holdMode = mode !== 'toggle' // défaut = HOLD (push-to-talk) ; 'toggle' seulement si explicitement choisi. 'ptt' = ancien alias hold.

  // uiohook pour TOGGLE *et* HOLD : son flag `pressed` (front montant uniquement) neutralise l'auto-répétition du
  // keydown. globalShortcut ne l'expose pas → en toggle il se ré-déclenchait au repeat clavier Windows (~250 ms),
  // coupant la dictée à ~256 ms. Le bug « toggle-off bloqué si un keyup est raté » est traité par l'auto-réparation
  // REPRESS_STUCK_MS (onKeyDown). globalShortcut ne sert plus que de repli si uiohook est indisponible.
  const uio = getUio()
  if (uio) registerViaUiohook(uio, toggleAccel, commandAccel, holdMode)
  else registerViaGlobalShortcut(toggleAccel, commandAccel)
}

function registerViaUiohook(
  uio: typeof import('uiohook-napi'),
  toggleAccel: string,
  commandAccel: string,
  holdMode: boolean,
): void {
  // Si on tournait en repli globalShortcut (start uiohook avait échoué auparavant), libère-le avant de reprendre uiohook.
  if (usingFallback) {
    for (const a of fallbackAccels) try { globalShortcut.unregister(a) } catch { /* ignore */ }
    fallbackAccels = []
    usingFallback = false
  }
  const { uIOhook, UiohookKey } = uio
  const next: Combo[] = []
  const toggleParsed = parseAccel(toggleAccel, UiohookKey)
  if (toggleParsed) {
    next.push({
      accel: toggleAccel,
      mode: 'toggle',
      parsed: toggleParsed,
      pressed: false,
      downAt: 0,
      // toggle : bascule au keydown (coalescée 250 ms, partagée avec le widget). hold : démarre au keydown, arrête au keyup.
      onDown: holdMode ? () => emitVoiceHold(true) : emitVoiceToggle,
      onUp: holdMode ? () => emitVoiceHold(false) : undefined,
    })
  } else {
    reportConflict(toggleAccel, 'toggle')
  }
  if (commandAccel && commandAccel !== toggleAccel) {
    const commandParsed = parseAccel(commandAccel, UiohookKey)
    if (commandParsed) next.push({ accel: commandAccel, mode: 'command', parsed: commandParsed, pressed: false, downAt: 0, onDown: broadcastCommandKey })
    else reportConflict(commandAccel, 'command')
  }
  combos = next

  if (!listenersAttached) {
    uIOhook.on('keydown', onKeyDown)
    uIOhook.on('keyup', onKeyUp)
    listenersAttached = true
  }
  if (!hookStarted) {
    try {
      uIOhook.start()
      hookStarted = true
    } catch (e) {
      // Échec du hook clavier bas niveau (rare : machine verrouillée / sécurité) → repli globalShortcut.
      console.error('[voice-hotkey] uIOhook.start a échoué — repli globalShortcut :', (e as Error).message)
      uioApi = null // force le repli aux prochains ré-enregistrements
      combos = []
      registerViaGlobalShortcut(toggleAccel, commandAccel)
    }
  }
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

/** Arrêt propre (will-quit) : stoppe le hook uiohook et libère tous les globalShortcut. */
export function stopVoiceHotkeys(): void {
  if (uioApi) {
    try { if (hookStarted) uioApi.uIOhook.stop() } catch { /* ignore */ }
    try { if (listenersAttached) uioApi.uIOhook.removeAllListeners() } catch { /* ignore */ }
  }
  hookStarted = false
  listenersAttached = false
  try { globalShortcut.unregisterAll() } catch { /* ignore */ }
  combos = []
  fallbackAccels = []
}
