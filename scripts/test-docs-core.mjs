// Test headless du « spine » Docs (Phase 1) : node scripts/test-docs-core.mjs → exit 0 si tout passe, 1 sinon.
// Écrit un docSet fixture (slug de test dédié) dans le store GLOBAL ~/.oryon/docs via docs-core, le relit via
// docs-read (Node pur), asserte chunking heading-aware + code-fence-safe, ancres slug-GitHub, snippet non
// coupé dans un fence, et le ranking lexical. Nettoie le docSet de test à la fin (finally). Zéro dép, zéro Claude.
import { chunkMarkdown, writeDocSet, deleteDocSet, slugFor, readDocSet } from '../src/shared/docs-core.mjs'
import { listDocs, searchDocs, fetchSection } from '../src/mcp/docs-read.mjs'

// Fixture type Stripe/Sentry : plusieurs H1/H2/H3 + un bloc code contenant une ligne « # … » (piège : un
// commentaire shell dans un fence NE doit PAS compter comme heading).
const FIXTURE = `# Stripe API

Stripe is a payment platform. This guide covers the core API surface.

## Charges

Charges let you accept one-time payments from customers.

### Create a charge

To create a charge, call the API:

\`\`\`bash
# create a charge via curl (this comment is NOT a markdown heading)
curl https://api.stripe.com/v1/charges \\
  -d amount=2000 \\
  -d currency=usd
\`\`\`

After the call returns, store the charge id for your records.

### Retrieve a charge

Fetch a previously created charge by its id.

## Refunds

Refund a charge in full or partially. Refund policy applies to disputed payments.

# Webhooks

Webhooks notify your server when a charge event happens.
`

const SOURCE_URL = 'https://stripe.example/docs'
const results = []
const ok = (cond, msg) => {
  results.push({ pass: !!cond, msg })
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
}
const balancedFences = (s) => (String(s).match(/```/g) || []).length % 2 === 0
const findChunk = (chunks, title) => chunks.find((c) => c.title === title)

async function main() {
  const slug = slugFor('Oryon Test Docs Fixture Phase1 ZZZ')

  // ── chunkMarkdown ──────────────────────────────────────────────────────────────────────────────────────
  const chunks = chunkMarkdown(FIXTURE, { sourceUrl: SOURCE_URL, baseTags: ['stripe'] })
  ok(chunks.length === 6, `6 sections attendues (fence-aware : le « # » du bloc code ignoré) — obtenu ${chunks.length}`)

  const create = findChunk(chunks, 'Create a charge')
  ok(!!create, 'section « Create a charge » présente')
  ok(create && create.breadcrumb === 'Stripe API > Charges > Create a charge', `breadcrumb H1>H2>H3 — obtenu "${create && create.breadcrumb}"`)
  ok(create && create.anchor === 'create-a-charge', `ancre slug-GitHub "create-a-charge" — obtenu "${create && create.anchor}"`)
  ok(create && balancedFences(create.text), 'texte de section : bloc code entier (fences équilibrés)')

  const retrieve = findChunk(chunks, 'Retrieve a charge')
  ok(retrieve && retrieve.anchor === 'retrieve-a-charge', `ancre "retrieve-a-charge" — obtenu "${retrieve && retrieve.anchor}"`)
  ok(create && retrieve && create.anchor !== retrieve.anchor, 'ancres distinctes (pas de collision)')
  ok(create && create.tags.includes('stripe'), 'baseTags propagés dans les tags de section')

  // ── writeDocSet → relecture docs-core ──────────────────────────────────────────────────────────────────
  await writeDocSet({ slug, title: 'Stripe API', sourceUrl: SOURCE_URL, origin: 'paste', tags: ['stripe', 'payments'], description: 'Fixture de test', sourceMarkdown: FIXTURE, chunks })
  const set = await readDocSet(slug)
  ok(set.existed && set.meta && set.meta.chunkCount === 6, `meta.chunkCount=6 — obtenu ${set.meta && set.meta.chunkCount}`)
  ok(set.source === FIXTURE, 'source.md ré-lu identique au markdown fourni')

  // ── docs-read : listDocs ───────────────────────────────────────────────────────────────────────────────
  ok(listDocs().some((d) => d.slug === slug), 'listDocs() voit le docSet de test')
  ok(listDocs({ tag: 'payments' }).some((d) => d.slug === slug), 'listDocs({tag:"payments"}) filtre OK')
  ok(!listDocs({ tag: 'nope-absent-tag' }).some((d) => d.slug === slug), 'listDocs({tag absent}) exclut le docSet')

  // ── docs-read : searchDocs (ranking) ───────────────────────────────────────────────────────────────────
  const refund = searchDocs({ query: 'refund', docSlug: slug })
  ok(refund.length > 0 && refund[0].title === 'Refunds' && refund[0].anchor === 'refunds', `top hit "refund" = Refunds — obtenu "${refund[0] && refund[0].title}"`)

  const amount = searchDocs({ query: 'amount', docSlug: slug })
  ok(amount.length > 0 && amount[0].title === 'Create a charge', `top hit "amount" = Create a charge — obtenu "${amount[0] && amount[0].title}"`)
  ok(amount[0] && amount[0].snippet.includes('amount'), 'snippet contient le terme cherché')
  ok(amount[0] && balancedFences(amount[0].snippet), 'snippet : fences équilibrés (jamais coupé dans un bloc code)')

  ok(searchDocs({ query: 'charge', docSlug: slug, limit: 2 }).length <= 2, 'limit respecté')
  ok(searchDocs({ query: '   ', docSlug: slug }).length === 0, 'query vide → 0 résultat')

  // ── docs-read : fetchSection ───────────────────────────────────────────────────────────────────────────
  const sec = fetchSection({ docSlug: slug, anchor: 'create-a-charge' })
  ok(!sec.error && sec.title === 'Create a charge', `fetchSection résout l'ancre — titre "${sec.title}"`)
  ok(sec.markdown && sec.markdown.includes('curl https://api.stripe.com'), 'fetchSection rend le bloc code de la section')
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
