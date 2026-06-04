// Types pour docs-import-command.mjs (pont d'import Docs déclenché par AGENT, Phase 5). L'implémentation est en
// JS pur (.mjs) — fs/path uniquement, importeur INJECTÉ — pour rester testable en headless et découplée de
// l'importeur lourd ; ce .d.mts donne les types côté TypeScript (mcp-export.ts). Jumeau de docs-core.d.mts.
import type { DocsImportArgs, DocsImportProgress, DocsImportResult } from './docs-import'

/** Sous-dossier de mcp-state où l'issue d'import est déposée (request-response pollé par l'outil MCP import_doc). */
export const DOCS_IMPORT_SUBDIR: string

/**
 * Lance un import (importeur injecté) puis persiste son issue sous <stateDir>/docs-import/<reqId>.{json,err}.
 * Ne LÈVE jamais : un échec d'import devient un .err + un retour {ok:false}.
 */
export function runDocsImport(opts: {
  stateDir: string
  reqId: string
  args: DocsImportArgs
  importDoc: (args: DocsImportArgs, onProgress?: (p: DocsImportProgress) => void) => Promise<DocsImportResult>
  onProgress?: (p: DocsImportProgress) => void
}): Promise<{ ok: true; result: DocsImportResult } | { ok: false; error: string }>
