import { clipboard } from 'electron'
import { spawn } from 'child_process'

// Injection « système » (cible voice.target='system', façon WisprFlow) : colle la transcription au curseur de
// N'IMPORTE QUELLE app au premier plan, sans dépendance native (le build CI v0.1.10 n'embarque AUCUN module
// natif — nut.js/robotjs sont INTERDITS). Mécanisme Windows v1 : on dépose le texte dans le presse-papier puis
// on synthétise Ctrl+V via PowerShell SendKeys (envoyé à la fenêtre qui a le focus clavier). Le texte passe par
// le presse-papier, donc AUCUN échappement SendKeys n'est requis sur son contenu (on ne tape que « ^v »).
//
// Limites assumées v1 : (1) la frappe va à la fenêtre FOCUS — l'utilisateur doit garder son app cible au premier
// plan (un déclenchement via la hotkey globale / le widget ne vole pas le focus ; cliquer dans Oryon, si). (2) Un
// presse-papier non-texte (image/fichiers) n'est pas restauré fidèlement (best-effort sur le texte uniquement).

const RESTORE_DELAY_MS = 250 // laisse l'app cible consommer le WM_PASTE avant de restaurer le presse-papier
const SENDKEYS_TIMEOUT_MS = 5000 // garde-fou : PowerShell bloqué → on n'attend pas indéfiniment

/** Envoie Ctrl+V à la fenêtre au premier plan via PowerShell SendKeys (hidden, sans voler le focus). */
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
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
        ],
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
 * Colle `text` au curseur de l'app au premier plan (Windows uniquement). Ne LÈVE jamais : tout échec est renvoyé
 * en `{ ok:false, reason }`. Sauvegarde puis restaure (best-effort) le texte du presse-papier de l'utilisateur.
 */
export async function injectText(text: string): Promise<{ ok: boolean; reason?: string }> {
  if (!text || !text.trim()) return { ok: false, reason: 'empty' }
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-os' }

  const previous = clipboard.readText() // best-effort : ne capture que le texte (image/fichiers non préservés)
  clipboard.writeText(text)

  const sent = await sendPasteKeystroke()
  if (!sent.ok) {
    if (previous) clipboard.writeText(previous) // rien collé → restaure tout de suite
    return sent
  }
  // Restaure l'ancien presse-papier après que la frappe a eu le temps d'être consommée (best-effort, non bloquant).
  if (previous) setTimeout(() => clipboard.writeText(previous), RESTORE_DELAY_MS)
  return { ok: true }
}
