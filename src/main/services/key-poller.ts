// Détection de raccourcis globaux par POLLING de l'état clavier (Win32 GetAsyncKeyState), au lieu d'un hook d'événements.
//
// POURQUOI : sous Windows/Electron, `navigator.mediaDevices.getUserMedia()` (capture micro) CASSE le hook clavier
// bas niveau WH_KEYBOARD_LL → uiohook cesse de livrer keydown/keyup (cf. electron#33976, uiohook-napi#54). Comme la
// dictée capture le micro PILE au démarrage, le hook meurt à ce moment → le keyup du push-to-talk n'arrive jamais →
// la dictée ne s'arrête pas au relâchement. Le polling lit l'ÉTAT RÉEL de la touche (impossible de « rater » un
// relâchement) et ne pose AUCUN hook → totalement immunisé contre ce bug. C'est l'approche des apps PTT (Discord-like).
// koffi = FFI prébuildé (N-API, ABI-stable Node/Electron, AUCUN compilateur requis → OK sur machine sans MSVC).

import { appendAppConsole } from '../ipc/browser.ipc'

export interface PollWatch {
  vk: number // code Virtual-Key Win32 de la touche principale
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  onDown: () => void
  onUp?: () => void
  label?: string
}

const VK_CTRL = 0x11
const VK_SHIFT = 0x10
const VK_ALT = 0x12
const VK_LWIN = 0x5b
const VK_RWIN = 0x5c
const POLL_MS = 30 // ~33 Hz : latence imperceptible pour du PTT, coût CPU négligeable (qq appels FFI / tick)

type GksFn = (vk: number) => number
let gks: GksFn | null | undefined // undefined = pas encore tenté ; null = indisponible (→ repli appelant)
function loadGks(): GksFn | null {
  if (gks !== undefined) return gks
  if (process.platform !== 'win32') return (gks = null)
  try {
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    // SHORT GetAsyncKeyState(int vKey) — __stdcall ; bit de poids fort (0x8000) = touche actuellement enfoncée.
    gks = user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int']) as unknown as GksFn
  } catch (e) {
    console.error('[key-poller] koffi/GetAsyncKeyState indisponible — repli globalShortcut :', (e as Error).message)
    gks = null
  }
  return gks
}

/** Mappe un token de touche d'accélérateur Electron ('F2', 'Space', 'A', '.') vers un code Virtual-Key Win32. null = non mappable. */
export function vkForToken(token: string): number | null {
  const u = token.trim().toUpperCase()
  if (!u) return null
  if (/^[A-Z0-9]$/.test(u)) return u.charCodeAt(0) // A-Z = 0x41-0x5A ; 0-9 = 0x30-0x39
  const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(u)
  if (f) return 0x70 + (parseInt(f[1], 10) - 1) // F1 = 0x70 … F24 = 0x87
  const N: Record<string, number> = {
    SPACE: 0x20, TAB: 0x09, ENTER: 0x0d, RETURN: 0x0d, ESC: 0x1b, ESCAPE: 0x1b, BACKSPACE: 0x08,
    DELETE: 0x2e, DEL: 0x2e, INSERT: 0x2d, HOME: 0x24, END: 0x23, PAGEUP: 0x21, PAGEDOWN: 0x22,
    UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27,
    '=': 0xbb, PLUS: 0xbb, '-': 0xbd, ',': 0xbc, '.': 0xbe, '/': 0xbf, ';': 0xba, "'": 0xde,
    '[': 0xdb, ']': 0xdd, '\\': 0xdc, '`': 0xc0,
  }
  return N[u] ?? null
}

/** Décompose un accélérateur Electron en { vk, modificateurs } Win32. null si la touche principale n'est pas mappable. */
export function parseAccelToVk(accel: string): Pick<PollWatch, 'vk' | 'ctrl' | 'shift' | 'alt' | 'meta'> | null {
  let ctrl = false
  let shift = false
  let alt = false
  let meta = false
  let key: string | null = null
  for (const raw of accel.split('+')) {
    const p = raw.trim()
    if (!p) continue
    const u = p.toUpperCase()
    if (u === 'COMMANDORCONTROL' || u === 'CMDORCTRL' || u === 'CONTROL' || u === 'CTRL') ctrl = true
    else if (u === 'SHIFT') shift = true
    else if (u === 'ALT' || u === 'OPTION') alt = true
    else if (u === 'SUPER' || u === 'META' || u === 'CMD' || u === 'COMMAND') meta = true
    else key = p // dernier token non-modificateur = touche principale
  }
  if (key == null) return null
  const vk = vkForToken(key)
  if (vk == null) return null
  return { vk, ctrl, shift, alt, meta }
}

let timer: ReturnType<typeof setInterval> | null = null
let watches: (PollWatch & { active: boolean })[] = []

/**
 * (Re)démarre le polling avec ces watches. Renvoie false si koffi/GetAsyncKeyState est indisponible (→ l'appelant
 * fait son repli globalShortcut — uiohook retiré, plan 012). Lenient sur les modificateurs : on exige que les REQUIS
 * soient enfoncés, sans imposer que les autres soient relâchés (évite un flicker si l'utilisateur tient un modif.).
 */
export function startKeyPoller(specs: PollWatch[]): boolean {
  const fn = loadGks()
  if (!fn) return false
  watches = specs.map((w) => ({ ...w, active: false }))
  if (timer) return true // boucle déjà en cours : on a juste remplacé les watches
  appendAppConsole('log', '[voice] raccourcis via polling GetAsyncKeyState (immunisé au bug getUserMedia→hook)')
  timer = setInterval(() => {
    const down = (vk: number): boolean => (fn(vk) & 0x8000) !== 0
    const cD = down(VK_CTRL)
    const sD = down(VK_SHIFT)
    const aD = down(VK_ALT)
    const wD = down(VK_LWIN) || down(VK_RWIN)
    for (const w of watches) {
      const active = down(w.vk) && (!w.ctrl || cD) && (!w.shift || sD) && (!w.alt || aD) && (!w.meta || wD)
      if (active === w.active) continue
      w.active = active
      appendAppConsole('log', `[hotkey-poll] ${active ? 'DOWN' : 'UP'} ${w.label ?? 'vk=' + w.vk}`)
      try {
        if (active) w.onDown()
        else w.onUp?.()
      } catch (e) {
        console.error('[key-poller] handler:', (e as Error).message)
      }
    }
  }, POLL_MS)
  return true
}

export function stopKeyPoller(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  watches = []
}
