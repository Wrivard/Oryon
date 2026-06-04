// Oryon Docs (Phase 5) — PONT d'import déclenché par AGENT : l'outil MCP `import_doc` (orchestrateur) émet une
// commande 'docs-import' → mcp-export.processCommand → ICI. L'import RÉEL (fetch réseau + turndown) vit dans
// docs-import.ts, hors du serveur MCP (process Node pur) ; ce module fait le pont en PERSISTANT l'issue de
// l'import là où l'outil MCP la relit en polling : <stateDir>/docs-import/<reqId>.json (succès) ou .err (échec)
// — même convention request-response que browser-screenshot (screenshots/<reqId>.png|.err).
//
// Node PUR (fs/path uniquement : ni Electron, ni turndown) → testable en headless et découplé de l'importeur
// lourd, qui est INJECTÉ par l'appelant (`importDoc`). Ne LÈVE jamais : une erreur d'import devient un .err,
// sinon l'outil MCP pollerait dans le vide jusqu'à son timeout. Écriture atomique (tmp + rename).
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export const DOCS_IMPORT_SUBDIR = 'docs-import' // sous-dossier de mcp-state où l'issue est déposée (poll côté MCP)

let tmpSeq = 0
/** Écriture atomique (temp + rename) : l'outil MCP ne lit jamais un fichier d'issue à moitié écrit. */
async function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`
  await fs.writeFile(tmp, content, 'utf8')
  try {
    await fs.rename(tmp, path)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
}

/**
 * Exécute un import déclenché par agent puis dépose son issue pour l'outil MCP (qui la relit en polling).
 * @param {object} opts
 * @param {string} opts.stateDir  racine mcp-state (le main passe son app.getPath('userData')/mcp-state)
 * @param {string} opts.reqId     id de requête (clé du fichier d'issue, fourni par l'outil MCP)
 * @param {{url?:string, markdown?:string, label?:string}} opts.args  arguments d'import
 * @param {(args:object, onProgress?:Function)=>Promise<object>} opts.importDoc  importeur réel (injecté)
 * @param {(p:object)=>void} [opts.onProgress]  callback de progression optionnel
 * @returns {Promise<{ok:true, result:object} | {ok:false, error:string}>}
 */
export async function runDocsImport({ stateDir, reqId, args, importDoc, onProgress = () => {} }) {
  const dir = join(stateDir, DOCS_IMPORT_SUBDIR)
  await fs.mkdir(dir, { recursive: true }).catch(() => {})
  try {
    const result = await importDoc(args, onProgress)
    await writeAtomic(join(dir, `${reqId}.json`), JSON.stringify(result))
    return { ok: true, result }
  } catch (e) {
    const error = String((e && e.message) || e || 'import échoué')
    await writeAtomic(join(dir, `${reqId}.err`), error)
    return { ok: false, error }
  }
}
