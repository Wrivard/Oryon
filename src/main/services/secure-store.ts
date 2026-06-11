import { safeStorage } from 'electron'
import { getDb } from '../db'

// Coffre partagé : chiffrement safeStorage `enc:v1:` + CRUD clé/valeur de la table app_settings. Avant le
// plan 010 ces logiques existaient en TROIS copies (settings.ipc.ts en variante JSON ; google-calendar.ts et
// vercel-rest.ts en variante chaîne) — un fix de sécurité ou un tuning devait être appliqué 3 fois, dérive
// garantie. Secrets chiffrés via Electron safeStorage (DPAPI sous Windows / Keychain / libsecret), stockés
// préfixés ENC_PREFIX + base64 ; repli en clair si le coffre OS est indisponible (le préfixe disambigue la
// lecture). Déchiffrés UNIQUEMENT côté main (just-in-time), jamais renvoyés au renderer.
//
// DEUX variantes de chiffrement coexistent VOLONTAIREMENT — leurs replis d'échec diffèrent et doivent rester
// distincts :
//   • chaîne (un seul secret : client secret / refresh / token Vercel) → repli '' (chaîne vide) ;
//   • JSON   (objet env/headers d'un connecteur MCP)                   → null si vide, {} si lecture échoue.
export const ENC_PREFIX = 'enc:v1:'

// ── Variante CHAÎNE (un secret unique) — corps EXACT de google-calendar.ts / vercel-rest.ts. ──
export function encryptString(plain: string): string {
  if (!plain) return ''
  if (safeStorage.isEncryptionAvailable()) return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
  return plain // repli en clair si le coffre OS est indisponible
}
export function decryptString(stored: string | undefined): string {
  if (!stored) return ''
  try {
    if (stored.startsWith(ENC_PREFIX)) return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    return stored
  } catch {
    return ''
  }
}

// ── Variante JSON (objet de secrets) — corps EXACT de settings.ipc.ts (encryptSecrets/decryptSecrets). ──
export function encryptJson(obj: Record<string, string> | null | undefined): string | null {
  if (!obj || Object.keys(obj).length === 0) return null
  const json = JSON.stringify(obj)
  if (safeStorage.isEncryptionAvailable()) return ENC_PREFIX + safeStorage.encryptString(json).toString('base64')
  return json
}
export function decryptJson(stored: unknown): Record<string, string> {
  if (typeof stored !== 'string' || stored.length === 0) return {}
  try {
    if (stored.startsWith(ENC_PREFIX)) {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
      return JSON.parse(safeStorage.decryptString(buf)) as Record<string, string>
    }
    return JSON.parse(stored) as Record<string, string>
  } catch {
    return {}
  }
}

// ── CRUD clé/valeur de la table app_settings — corps EXACT du get/set/del partagé par les services. ──
export function getSetting(key: string): string | undefined {
  return getDb().prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get(key) as string | undefined
}
export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}
export function delSetting(key: string): void {
  getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key)
}
