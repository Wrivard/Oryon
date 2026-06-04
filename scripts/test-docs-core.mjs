// Test headless du « spine » Docs : node scripts/test-docs-core.mjs → exit 0 si tout passe, 1 sinon.
// Écrit un docSet fixture (slug de test dédié) dans le store GLOBAL ~/.oryon/docs via docs-core, le relit via
// docs-read (Node pur), asserte : chunking H1/H2 (H3 = corps), strip des liens markdown dans les headings,
// fusion des mini-sections, code-fence-safety, ancres slug-GitHub, ligne de recherche LEAN (SPEC-A) + ranking,
// snippet non coupé dans un fence, fetchSection. Nettoie le docSet de test à la fin (finally). Zéro dép, zéro Claude.
import { chunkMarkdown, writeDocSet, deleteDocSet, slugFor, readDocSet } from '../src/shared/docs-core.mjs'
import { listDocs, searchDocs, fetchSection } from '../src/mcp/docs-read.mjs'

// Fixture type Sentry/Stripe. Pièges couverts : (1) un heading porte un LIEN markdown « ## [Configuration](url) »
// — le titre/ancre/tags ne doivent PAS être pollués par l'URL ; (2) des H3 (dsn, tracesSampleRate) restent du
// CORPS de leur H2 parent (plus de section H3) ; (3) une mini-section « Notes » (< 300 c) fusionne dans la
// précédente ; (4) un « # … » DANS un bloc code n'est PAS un heading.
const FIXTURE = `# Sentry SDK

Sentry is an error monitoring platform. This guide walks through installing the SDK, initialising the client, capturing both handled and unhandled errors, and tuning the sampling configuration so a typical web application reports cleanly to your dashboard within a few minutes of setup.

## [Configuration](https://docs.sentry.io/platforms/javascript/configuration/)

The configuration object accepts several keys that control how the SDK behaves at runtime. The most important options are described below with their defaults and the values teams typically use in production deployments.

### dsn

The DSN tells the SDK where to send events. Without it, the SDK runs in a no-op mode and captures nothing at all.

\`\`\`bash
# this is a shell comment, NOT a markdown heading
export SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0
\`\`\`

You can also pass the dsn inline when you initialise the client in your application bootstrap code.

### tracesSampleRate

Controls the fraction of transactions captured for performance monitoring. A value of 1.0 captures every transaction; lower it in production to keep event volume and cost under control.

## Capturing errors

The SDK captures unhandled exceptions and unhandled promise rejections automatically once it has been initialised. You can also report handled errors yourself by calling captureException, attaching extra context, tags, and breadcrumbs so the issue is easy to triage later from the dashboard. Manual capture is useful inside try/catch blocks where you recover from an error but still want visibility into how often it happens in production and which users it affects.

## Notes

See the changelog.

# Changelog

v2.0 shipped.
`

const SOURCE_URL = 'https://sentry.example/docs'
const results = []
const ok = (cond, msg) => {
  results.push({ pass: !!cond, msg })
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
}
const balancedFences = (s) => (String(s).match(/```/g) || []).length % 2 === 0
const findChunk = (chunks, title) => chunks.find((c) => c.title === title)

async function main() {
  const slug = slugFor('Oryon Test Docs Fixture ZZZ')

  // ── chunkMarkdown : granularité H1/H2 + strip-liens + fusion ─────────────────────────────────────────────
  const chunks = chunkMarkdown(FIXTURE, { sourceUrl: SOURCE_URL, baseTags: ['sentry'] })
  // Sections H1/H2 = [Sentry SDK, Configuration, Capturing errors, Notes] ; « Notes » (< 300 c) fusionne dans
  // « Capturing errors » → 3 chunks.
  ok(chunks.length === 4, `4 sections attendues (H1/H2 only + fusion mini-section H2 + H1 tardif gardé autonome) — obtenu ${chunks.length}`)

  // (1) strip des liens markdown dans le heading « ## [Configuration](url) »
  const config = findChunk(chunks, 'Configuration')
  ok(!!config, 'titre de section nettoyé du lien markdown (« Configuration », pas « [Configuration](url) »)')
  ok(config && config.anchor === 'configuration', `ancre propre "configuration" (pas polluée par l'URL) — obtenu "${config && config.anchor}"`)
  ok(config && config.breadcrumb === 'Sentry SDK > Configuration', `breadcrumb H1>H2 — obtenu "${config && config.breadcrumb}"`)
  ok(config && !config.tags.some((t) => /http|sentry\.io|platforms/.test(t)), `tags non pollués par l'URL — obtenu ${JSON.stringify(config && config.tags)}`)

  // (2) les H3 (dsn, tracesSampleRate) restent du CORPS de la section Configuration (pas de section propre)
  ok(config && config.text.includes('### dsn') && config.text.includes('tracesSampleRate'), 'les H3 restent dans le corps de leur H2 parent')
  ok(!findChunk(chunks, 'dsn') && !findChunk(chunks, 'tracesSampleRate'), 'aucun chunk H3 isolé (dsn / tracesSampleRate)')

  // (3) fusion de la mini-section « Notes » dans la précédente (« Capturing errors »)
  const capt = findChunk(chunks, 'Capturing errors')
  ok(!findChunk(chunks, 'Notes'), 'mini-section « Notes » (H2) fusionnée (pas de chunk isolé)')
  ok(capt && capt.text.includes('See the changelog.'), 'le texte de « Notes » rejoint la section précédente (rien de perdu)')

  // (3bis) garde H1 : une mini-section de niveau H1 (« Changelog ») n'est PAS fusionnée (reste autonome)
  const changelog = findChunk(chunks, 'Changelog')
  ok(!!changelog, 'mini-section H1 « Changelog » NON fusionnée (un H1 garde son autonomie)')
  ok(changelog && changelog.breadcrumb === 'Changelog', `breadcrumb H1 « Changelog » — obtenu "${changelog && changelog.breadcrumb}"`)

  // (4) fence-safety : le bloc code entier, « # … » du fence non traité comme heading
  ok(config && balancedFences(config.text), 'texte de section : bloc code entier (fences équilibrés)')
  ok(config && config.text.includes('# this is a shell comment'), 'le « # » du bloc code reste du corps (pas un heading)')

  // ── writeDocSet → relecture docs-core ──────────────────────────────────────────────────────────────────
  await writeDocSet({ slug, title: 'Sentry SDK', sourceUrl: SOURCE_URL, origin: 'paste', tags: ['sentry', 'errors'], description: 'Fixture de test', sourceMarkdown: FIXTURE, chunks })
  const set = await readDocSet(slug)
  ok(set.existed && set.meta && set.meta.chunkCount === 4, `meta.chunkCount=4 — obtenu ${set.meta && set.meta.chunkCount}`)
  ok(set.source === FIXTURE, 'source.md ré-lu identique au markdown fourni')

  // ── docs-read : listDocs ───────────────────────────────────────────────────────────────────────────────
  ok(listDocs().some((d) => d.slug === slug), 'listDocs() voit le docSet de test')
  ok(listDocs({ tag: 'errors' }).some((d) => d.slug === slug), 'listDocs({tag:"errors"}) filtre OK')
  ok(!listDocs({ tag: 'nope-absent-tag' }).some((d) => d.slug === slug), 'listDocs({tag absent}) exclut le docSet')

  // ── docs-read : searchDocs — ligne LEAN (SPEC-A) + ranking ─────────────────────────────────────────────
  const traces = searchDocs({ query: 'tracessamplerate', docSlug: slug })
  const hit = traces[0]
  ok(hit && hit.anchor === 'configuration', `top hit "tracessamplerate" → section Configuration — obtenu "${hit && hit.anchor}"`)
  ok(hit && hit.breadcrumb === 'Sentry SDK > Configuration', 'résultat porte le breadcrumb (finit par le titre de section)')
  ok(hit && !('title' in hit) && !('sourceUrl' in hit), 'SPEC-A : ligne lean SANS title ni sourceUrl')
  ok(hit && ['docSlug', 'breadcrumb', 'anchor', 'snippet', 'chunkId', 'score'].every((k) => k in hit), 'SPEC-A : champs {docSlug,breadcrumb,anchor,snippet,chunkId,score}')
  ok(hit && hit.snippet.toLowerCase().includes('tracessamplerate'), 'snippet contient le terme cherché')
  ok(hit && balancedFences(hit.snippet), 'snippet : fences équilibrés (jamais coupé dans un bloc code)')

  const capture = searchDocs({ query: 'captureexception', docSlug: slug })
  ok(capture[0] && capture[0].anchor === 'capturing-errors', `top hit "captureexception" → Capturing errors — obtenu "${capture[0] && capture[0].anchor}"`)

  ok(searchDocs({ query: 'sentry', docSlug: slug, limit: 2 }).length <= 2, 'limit respecté')
  ok(searchDocs({ query: '   ', docSlug: slug }).length === 0, 'query vide → 0 résultat')

  // ── docs-read : fetchSection (garde title + sourceUrl, SPEC-A) ─────────────────────────────────────────
  const sec = fetchSection({ docSlug: slug, anchor: 'configuration' })
  ok(!sec.error && sec.title === 'Configuration', `fetchSection résout l'ancre + garde le titre — "${sec.title}"`)
  ok(sec.sourceUrl === SOURCE_URL, `fetchSection garde sourceUrl — obtenu "${sec.sourceUrl}"`)
  ok(sec.markdown && sec.markdown.includes('export SENTRY_DSN'), 'fetchSection rend le bloc code de la section')
  ok(sec.markdown && balancedFences(sec.markdown), 'fetchSection : fences équilibrés')
  ok(fetchSection({ docSlug: slug, anchor: 'no-such-anchor' }).error, 'fetchSection : ancre inconnue → error')

  return slug
}

let slug
let crashed = null
try {
  slug = await main()
} catch (e) {
  crashed = e
  console.error('✗ exception inattendue :', e && e.stack ? e.stack : e)
} finally {
  if (slug) await deleteDocSet(slug).catch(() => {})
}

const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} assertions OK${failed ? ` — ${failed} ÉCHEC(S)` : ''}`)
process.exit(failed === 0 && !crashed ? 0 : 1)
