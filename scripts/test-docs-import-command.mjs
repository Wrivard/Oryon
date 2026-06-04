// Test headless du PONT d'import déclenché par agent (Phase 5) : node scripts/test-docs-import-command.mjs
// → exit 0 si tout passe, 1 sinon. Couvre le contrat que l'outil MCP `import_doc` relit en polling :
//   • succès → l'issue est déposée dans <stateDir>/docs-import/<reqId>.json (= le DocsImportResult), ET le
//     docSet apparaît dans index.ndjson (« drop command → docSet dans index.ndjson ») ;
//   • échec → l'issue est un <reqId>.err contenant le message, et AUCUN .json n'est écrit ;
//   • runDocsImport ne LÈVE jamais (renvoie {ok:false} au lieu de propager).
// L'importeur réel (docs-import.ts : réseau + turndown) est remplacé par un fake injecté → zéro réseau, zéro
// dép TS. Le fake « succès » crée un VRAI docSet via docs-core (chemin 'paste'), donc on asserte le store réel
// (~/.oryon/docs) sous un slug de test dédié, nettoyé en finally. stateDir = dossier temp jetable. $0, 0 Claude.
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDocsImport, DOCS_IMPORT_SUBDIR } from '../src/main/services/docs-import-command.mjs'
import { chunkMarkdown, writeDocSet, deleteDocSet, slugFor } from '../src/shared/docs-core.mjs'
import { listDocs } from '../src/mcp/docs-read.mjs'

const FIXTURE = `# Acme SDK

The Acme SDK lets you call the Acme API from Node.

## Authentication

Pass your API key in the Authorization header.

## Webhooks

Acme posts webhook events to your endpoint when something changes.
`

const results = []
const ok = (cond, msg) => {
  results.push({ pass: !!cond, msg })
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
}

const slug = slugFor('Oryon Test Docs Import Command Phase5 ZZZ')
const TITLE = 'Oryon Test Docs Import Command Phase5 ZZZ'
const stateDir = mkdtempSync(join(tmpdir(), 'oryon-docs-import-'))

// Fake importeur SUCCÈS : reproduit le chemin 'paste' réel (chunk + writeDocSet via docs-core) puis renvoie la
// forme exacte d'un DocsImportResult — ce que l'importeur réel renverrait, sans réseau.
async function fakeImportOk(args) {
  const chunks = chunkMarkdown(args.markdown, { sourceUrl: '', baseTags: [] })
  const w = await writeDocSet({
    slug,
    title: args.label || TITLE,
    sourceUrl: '',
    origin: 'paste',
    tags: [],
    description: '',
    sourceMarkdown: args.markdown,
    chunks,
  })
  return { slug: w.slug, title: args.label || TITLE, origin: 'paste', chunkCount: w.chunkCount, pageCount: w.pageCount, errors: [] }
}

async function main() {
  // ── Succès : issue .json + docSet dans index.ndjson ─────────────────────────────────────────────────────
  const reqId = 'reqok-12345'
  const r = await runDocsImport({ stateDir, reqId, args: { markdown: FIXTURE, label: TITLE }, importDoc: fakeImportOk })
  ok(r && r.ok === true, 'runDocsImport renvoie {ok:true} en cas de succès')
  ok(r.result && r.result.slug === slug, `result.slug = "${slug}" — obtenu "${r.result && r.result.slug}"`)
  ok(r.result && r.result.chunkCount > 0, `result.chunkCount > 0 — obtenu ${r.result && r.result.chunkCount}`)

  const okPath = join(stateDir, DOCS_IMPORT_SUBDIR, `${reqId}.json`)
  ok(existsSync(okPath), `issue déposée sous docs-import/${reqId}.json (lue en polling par import_doc)`)
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(okPath, 'utf8'))
  } catch {
    /* parsed reste null */
  }
  ok(parsed && parsed.slug === slug && parsed.chunkCount === r.result.chunkCount, 'le .json reparse au DocsImportResult exact')

  // Le cœur du contrat plan : « drop command → docSet dans index.ndjson ».
  ok(listDocs().some((d) => d.slug === slug), 'le docSet importé apparaît dans index.ndjson (listDocs le voit)')

  // ── Échec : issue .err, pas de .json, pas d'exception propagée ───────────────────────────────────────────
  const reqIdErr = 'reqerr-67890'
  const r2 = await runDocsImport({
    stateDir,
    reqId: reqIdErr,
    args: { url: 'https://nope.invalid' },
    importDoc: async () => {
      throw new Error('boom-test-import')
    },
  })
  ok(r2 && r2.ok === false, 'runDocsImport renvoie {ok:false} en cas d\'échec (ne LÈVE pas)')
  ok(r2.error && r2.error.includes('boom-test-import'), `error propage le message — obtenu "${r2 && r2.error}"`)
  const errPath = join(stateDir, DOCS_IMPORT_SUBDIR, `${reqIdErr}.err`)
  ok(existsSync(errPath), `issue d'échec déposée sous docs-import/${reqIdErr}.err`)
  ok(readFileSync(errPath, 'utf8').includes('boom-test-import'), 'le .err contient le message d\'erreur')
  ok(!existsSync(join(stateDir, DOCS_IMPORT_SUBDIR, `${reqIdErr}.json`)), 'aucun .json écrit quand l\'import échoue')
}

let crashed = null
try {
  await main()
} catch (e) {
  crashed = e
  console.error('✗ exception inattendue :', e && e.stack ? e.stack : e)
} finally {
  await deleteDocSet(slug).catch(() => {})
  try {
    rmSync(stateDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} assertions OK${failed ? ` — ${failed} ÉCHEC(S)` : ''}`)
process.exit(failed === 0 && !crashed ? 0 : 1)
