// Oryon — écritures atomiques Windows-safe, CŒUR PARTAGÉ (FS pur, sans Electron). Extrait par le plan 010 :
// renameRetry + writeAtomic vivaient en TROIS copies quasi byte-identiques (docs-core.mjs, memory-core.mjs,
// system-feedback-core.mjs) — un tuning Windows devait être appliqué 3 fois. Importé par ces cores (et, via
// eux, par le serveur MCP standalone) → JS pur .mjs + jumeau .d.mts.
//
// Sous Windows (MoveFileEx), fs.rename ÉCHOUE (EPERM/EBUSY/EACCES) si un autre process tient la destination
// ouverte en lecture — fréquent quand plusieurs agents lisent le même fichier pendant qu'un autre écrit. On
// retente avec backoff ; à la 6e tentative on abandonne (et on nettoie le temp).
import { promises as fs } from 'node:fs'

let tmpSeq = 0

/** Renomme from→to en retentant les EPERM/EBUSY/EACCES transitoires de Windows ; nettoie le temp si on abandonne. */
export async function renameRetry(from, to) {
  for (let i = 0; i < 6; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = e && e.code
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || i === 5) {
        await fs.unlink(from).catch(() => {})
        throw e
      }
      await new Promise((r) => setTimeout(r, 25 + i * 30))
    }
  }
}

/** Écriture atomique (temp + rename-retry) : un lecteur ne voit jamais un fichier à moitié écrit. */
export async function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`
  await fs.writeFile(tmp, content, 'utf8')
  await renameRetry(tmp, path)
}
