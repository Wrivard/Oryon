// Caractérisation du chiffrement enc:v1 des secrets MCP (settings.ipc). decryptSecrets échoue en SILENCE
// (`catch { return {} }`) → un round-trip cassé = secrets perdus sans erreur. On verrouille le contrat.
import { describe, it, expect, vi } from 'vitest'

// settings.ipc importe electron (safeStorage) + getDb (better-sqlite3 natif, illisible sous vitest/node) au
// top-level → on mocke les deux. safeStorage factice = round-trip symétrique réversible (préfixe FAKE: + base64),
// PAS du vrai chiffrement : on teste la LOGIQUE enc:v1 (préfixe, repli clair, catch silencieux), pas DPAPI.
const enc = vi.hoisted(() => ({ available: true }))
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => enc.available,
    encryptString: (s: string) => Buffer.from('FAKE:' + s, 'utf8'),
    decryptString: (buf: Buffer) => {
      const raw = Buffer.from(buf).toString('utf8')
      if (!raw.startsWith('FAKE:')) throw new Error('cipher invalide')
      return raw.slice('FAKE:'.length)
    },
  },
}))
// getDb (natif) ne doit JAMAIS être appelé par encrypt/decryptSecrets — stub pour neutraliser l'import.
vi.mock('../src/main/db', () => ({
  getDb: () => {
    throw new Error('getDb ne devrait pas être appelé par les fonctions de secrets')
  },
  closeDb: () => {},
}))

import { encryptSecrets, decryptSecrets } from '../src/main/ipc/settings.ipc'

describe('secrets enc:v1 — round-trip', () => {
  it('objet non vide, mode CHIFFRÉ (safeStorage dispo) → préfixe enc:v1: + round-trip', () => {
    enc.available = true
    const obj = { TOKEN: 'abc123', URL: 'https://x.example/api' }
    const stored = encryptSecrets(obj)
    expect(typeof stored).toBe('string')
    expect(stored!.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecrets(stored)).toEqual(obj)
  })

  it('objet non vide, mode CLAIR (safeStorage indispo) → JSON sans préfixe + round-trip', () => {
    enc.available = false
    const obj = { K: 'v', N: '42' }
    const stored = encryptSecrets(obj)
    expect(typeof stored).toBe('string')
    expect(stored!.startsWith('enc:v1:')).toBe(false)
    expect(JSON.parse(stored!)).toEqual(obj) // c'est bien du JSON clair
    expect(decryptSecrets(stored)).toEqual(obj)
  })

  it('objet vide / null / undefined → null (rien à stocker)', () => {
    enc.available = true
    expect(encryptSecrets({})).toBeNull()
    expect(encryptSecrets(null)).toBeNull()
    expect(encryptSecrets(undefined)).toBeNull()
  })

  it("valeur corrompue → {} (échec SILENCIEUX, jamais de throw)", () => {
    enc.available = true
    expect(() => decryptSecrets('enc:v1:zzzz')).not.toThrow()
    expect(decryptSecrets('enc:v1:zzzz')).toEqual({}) // base64 ok mais pas 'FAKE:' → decryptString throw → catch {}
    expect(decryptSecrets('enc:v1:@@@pas-base64@@@')).toEqual({})
    expect(decryptSecrets(undefined)).toEqual({})
    expect(decryptSecrets('')).toEqual({})
    expect(decryptSecrets(123 as unknown as string)).toEqual({})
  })
})
