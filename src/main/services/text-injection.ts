import { clipboard } from 'electron'
import { spawn } from 'child_process'
import { appendAppConsole } from '../ipc/browser.ipc'

// Injection « système » (cible voice.target='system', façon WisprFlow) : colle la transcription au curseur de
// N'IMPORTE QUELLE app au premier plan. Mécanisme : on dépose le texte dans le presse-papier puis on synthétise
// Ctrl+V. Le texte passe par le presse-papier → aucun échappement requis sur son contenu.
//
// Ctrl+V est envoyé via Win32 `keybd_event` (koffi, FFI prébuildé, aucune dépendance native compilée) : FIABLE et
// SANS spawn, contrairement à PowerShell SendKeys (lent, finaud sur le focus, parfois ignoré). PowerShell reste un
// REPLI si koffi ne charge pas. On logue aussi le TITRE de la fenêtre au premier plan (diag) : la frappe va à la
// fenêtre FOCUS, donc savoir QUELLE fenêtre est au premier plan au moment du collage est la clé du débogage.
//
// Limites assumées : (1) la frappe va à la fenêtre FOCUS — garder l'app cible au premier plan (la hotkey globale en
// polling NE vole PAS le focus ; cliquer dans Oryon, si). (2) Presse-papier non-texte (image/fichiers) non restauré.

const RESTORE_DELAY_MS = 400 // laisse l'app cible consommer le collage AVANT de restaurer le presse-papier (anti-race)
const SENDKEYS_TIMEOUT_MS = 5000

const VK_CONTROL = 0x11
const VK_V = 0x56
const KEYEVENTF_KEYUP = 0x02

interface U32 {
  keybd: (vk: number, scan: number, flags: number, extra: number) => void
  foregroundTitle: () => string
}
let u32: U32 | null | undefined // undefined = pas tenté ; null = indisponible (→ repli PowerShell)
function loadU32(): U32 | null {
  if (u32 !== undefined) return u32
  if (process.platform !== 'win32') return (u32 = null)
  try {
    const koffi = require('koffi') as typeof import('koffi')
    const user32 = koffi.load('user32.dll')
    const keybd = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr']) as unknown as U32['keybd']
    const getFg = user32.func('__stdcall', 'GetForegroundWindow', 'void*', []) as unknown as () => unknown
    const getText = user32.func('__stdcall', 'GetWindowTextA', 'int', ['void*', 'char*', 'int']) as unknown as (h: unknown, b: Buffer, n: number) => number
    u32 = {
      keybd,
      foregroundTitle: () => {
        try {
          const h = getFg()
          const buf = Buffer.alloc(256)
          const n = getText(h, buf, 256)
          return buf.toString('latin1', 0, Math.max(0, n))
        } catch {
          return '?'
        }
      },
    }
  } catch (e) {
    console.error('[inject] koffi indisponible — repli PowerShell SendKeys :', (e as Error).message)
    u32 = null
  }
  return u32
}

/** Ctrl+V via Win32 keybd_event (à la fenêtre FOCUS). Renvoie false si koffi indisponible (→ repli SendKeys). */
function pasteViaKeybd(): boolean {
  const k = loadU32()
  if (!k) return false
  k.keybd(VK_CONTROL, 0, 0, 0) // Ctrl ↓
  k.keybd(VK_V, 0, 0, 0) // V ↓ (Ctrl tenu → l'app voit Ctrl+V)
  k.keybd(VK_V, 0, KEYEVENTF_KEYUP, 0) // V ↑
  k.keybd(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0) // Ctrl ↑
  return true
}

/** REPLI : Ctrl+V via PowerShell SendKeys (lent, sans vol de focus) si koffi indisponible. */
function sendPasteKeystroke(): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (r: { ok: boolean; reason?: string }): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    try {
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"],
        { windowsHide: true },
      )
      timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        finish({ ok: false, reason: 'timeout' })
      }, SENDKEYS_TIMEOUT_MS)
      proc.on('error', () => finish({ ok: false, reason: 'sendkeys-failed' }))
      proc.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, reason: `sendkeys-exit-${code}` }))
    } catch {
      finish({ ok: false, reason: 'sendkeys-failed' })
    }
  })
}

/**
 * Colle `text` au curseur de l'app au premier plan (Windows). Ne LÈVE jamais : tout échec → { ok:false, reason }.
 * Sauvegarde puis restaure (best-effort, texte seulement) le presse-papier de l'utilisateur.
 */
export async function injectText(text: string): Promise<{ ok: boolean; reason?: string }> {
  if (!text || !text.trim()) return { ok: false, reason: 'empty' }
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-os' }

  // Diag : QUELLE fenêtre recevra la frappe ? (titre du premier plan, lu juste avant le collage)
  const fg = loadU32()?.foregroundTitle() ?? '?'
  appendAppConsole('log', `[inject] premier plan="${fg}" · ${text.length} car. · via=${u32 ? 'keybd_event' : 'sendkeys'}`)

  const previous = clipboard.readText() // best-effort (texte uniquement)
  clipboard.writeText(text)

  const sent = pasteViaKeybd() ? { ok: true } : await sendPasteKeystroke()
  if (!sent.ok) {
    if (previous) clipboard.writeText(previous) // rien collé → restaure tout de suite
    return sent
  }
  if (previous) setTimeout(() => clipboard.writeText(previous), RESTORE_DELAY_MS)
  return { ok: true }
}
