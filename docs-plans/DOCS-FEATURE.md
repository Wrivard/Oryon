# Feature « Docs » — import de doc tierce + retrieval $0 (jumeau de Mémoire/Archive)

Issu d'une revue multi-agents (7 cartographies + 3 designs + synthèse). Décisions utilisateur figées :
crawl **multi-pages (sitemap)**, **`import_doc` agent** inclus v1, recherche **lexical seul** (sémantique différé v2), portée **GLOBALE**.

## Principe
L'utilisateur importe la doc d'un outil (Sentry, Stripe…) via un panneau **Docs** (colle une URL → on trouve `llms.txt` tout seul ; sinon `.md` / `llms-full.txt` / crawl sitemap → markdown). C'est découpé **par section** + indexé. 4 outils MCP donnent à l'orchestrateur ET aux workers une recherche **ciblée par section**, sans jamais lire toute la doc.

## Portée GLOBALE — stockage
Store **global** (toutes apps) calculé par `os.homedir()` côté MCP (Node pur) ET côté main — **aucun env à câbler** :
```
~/.oryon/docs/
  index.ndjson                 # 1 ligne/docSet: { slug, title, sourceUrl, origin('llmstxt'|'md'|'llms-full'|'sitemap'|'paste'|'files'), fetchedAt, contentHash, pageCount, chunkCount, tags[], description }
  <slug>/
    source.md                  # markdown complet nettoyé (viewer / lecture section entière)
    meta.json                  # mêmes champs que la ligne d'index (source de vérité par docSet)
    chunks.ndjson              # 1 ligne/section (unité de retrieval): { docSlug, chunkId, title, breadcrumb, anchor, tags[], sourceUrl, text, charLen }
```
slug via `safeName()` (réutiliser `memory-core`). Écritures **atomiques** (`writeAtomic` tmp+rename + `renameRetry` EPERM/EBUSY). Index = NDJSON (lecteurs skippent les lignes malformées, try/catch par ligne). **Pas de DB, pas de dép native** (CI electron-rebuild/package-lock intacte). `~/.oryon/docs/` est hors repo → rien à gitignore.

## Recherche $0 — lexical pur
`src/mcp/docs-read.mjs` (LECTURE SEULE, jumeau d'`archive-read.mjs`, Node pur, zéro npm, zéro Claude) lit `chunks.ndjson` et score chaque chunk avec **l'algo de `memory-core.searchMemories`** : titre +10 / breadcrumb+tags +5 / corps +3 + bonus fréquence `min(6,count)`. Substring insensible à la casse, termes sanitizés (pas d'opérateurs FTS à casser). Snippet ±200 chars autour du 1er hit, **jamais coupé dans un bloc code**. Retourne top-k {docSlug, title, breadcrumb, anchor, sourceUrl, snippet, chunkId, score}.
**Pourquoi PAS FTS5/embeddings en v1** : le serveur MCP est un process Node pur → il ne peut PAS ouvrir le `better-sqlite3` (ABI Electron) → FTS5 forcerait un aller-retour command-queue par recherche. Le `.ndjson` lu en-process = instantané, $0, zéro warm-up. Rerank sémantique (MiniLM déjà bundlé voix) = **v2, différé** (toggle, seulement si le lexical déçoit).

## Outils MCP (orchestrateur + workers, NON-gatés — doc = référence, pas coordination)
- `list_docs({tag?})` → docsets importés (lit `index.ndjson`). Jumeau `list_memories`.
- `search_docs({query, docSlug?, tag?, limit?=8})` → top-k sections (snippet+ancre). Le cœur « trouve la section sans tout lire ». Jumeau `search_memories`.
- `fetch_doc_section({docSlug, anchor, maxChars?=12000})` → markdown complet d'**une** section (join des chunks adjacents même-heading, code fences intacts). Jumeau `read_archived_session`.
- `import_doc({url?, markdown?, label?})` → **gaté orchestrateur**, WRITE : `queueCommand({type:'docs-import',…})` → `mcp-export.processCommand` → `docs-import.ts`. ⚠ ajouter le type dans server.mjs ET le switch processCommand (sinon no-op silencieux).

## Ingestion $0 (`src/main/services/docs-import.ts`)
Tiers : (1) sonde `<origin>/llms.txt` + headers `X-Llms-Txt`/`Link` + `/.well-known/llms.txt` → fetch chaque page liée en `.md` (Sentry/Stripe/Mintlify servent du markdown propre, zéro parsing) ; (2) sinon `<url>.md` / `Accept: text/markdown` ; (3) sinon `llms-full.txt` (chunké, jamais injecté entier) ; (4) sinon **`sitemap.xml` → crawl multi-pages borné** (cap ~300 pages, 10MB/page, timeout 15s/page, dédup par URL canonique) + `turndown` (HTML→MD). Erreurs **par page** remontées à l'UI, jamais silencieuses. `contentHash` pour dédup au ré-import. Une seule dép : **`turndown`** (pure-JS) → garder `package-lock.json` en phase pour `npm ci`.
Chunking (offline, regex, $0) : split H1/H2/H3, sous-split au cap de taille **sans couper un bloc code**, breadcrumb (H1>H2>H3) + ancre slug-GitHub, tags = sections H2 du llms.txt ∪ tokens de headings. 1 record/section → `<slug>/chunks.ndjson` ; meta → `<slug>/meta.json` + ligne dans `index.ndjson` (rebuild atomique depuis les dossiers, self-healing comme `rebuildIndexes` d'archive).

## UI (`src/renderer/src/components/RightPanel/DocsPanel.tsx`, jumeau MemoryPanel)
Onglet « Docs » (icône lucide `BookOpen`, lazy-mount) dans `RightPanel/index.tsx` TABS. Empty-state = hero « Colle une URL de doc (on trouve son llms.txt) » + « ou colle du markdown / dépose des fichiers » + overlay drag-drop (.md/.txt/.mdx). À l'import → vue **progression** (états explicites depuis le main : « Sonde llms.txt… » → « Index trouvé (N pages) » / « Crawl sitemap… » → « Fetch N/Total (titre) » → « Chunking & index » → « Fini (M sections) »), erreurs par-page **inline**. Sidebar = liste docsets (titre, nb chunks, chips tags, « sync il y a 2h ») + ↻ ré-importer + 🗑 supprimer (atomique : rm `<slug>/` + drop ligne index). Pane droit = `source.md` en viewer markdown lecture-seule (highlight code) ; taper dans la recherche → liste de résultats classés (breadcrumb+snippet, clic → scroll ancre). **Lecture seule, PAS de wikilink/graph/édition** (≠ Mémoire). Bridge `window.bridge.docs.{list,read,search,import,reimport,delete,onChanged}` (preload + `BridgeApi` dans `src/shared/types.ts`) ; `src/main/ipc/docs.ipc.ts` délègue à docs-core/docs-import + UN watcher chokidar sur `~/.oryon/docs` → broadcast `docs:changed` (panneau live).

## Plan de build (vagues, parallélisable entre workers)
- **Vague 1 (spine, séquentiel)** — Phase 1 : `src/shared/docs-core.mjs` (résout `~/.oryon/docs`, slug, chunker heading-aware code-fence-safe, writeAtomic store source.md/meta.json/chunks.ndjson, rebuildIndex self-healing, read/list/delete) + `src/mcp/docs-read.mjs` (listDocs/searchDocs[scoring searchMemories]/fetchSection) + test headless (bornes de chunk, slug ancre, snippet code-fence, ranking sur fixture Stripe/Sentry). **Doit merger avant le reste.**
- **Vague 2 (‖)** — Phase 2 : 3 outils read (`list_docs`/`search_docs`/`fetch_doc_section`) dans `src/mcp/server.mjs` (UNGATED → `server.tool`, PAS `readMemoryTool`/`orchestratorTool` ; schémas Zod ; vérifier qu'un rôle worker les voit). // Phase 3 : `src/main/services/docs-import.ts` (ingestion tiered + sitemap crawl) + `src/main/ipc/docs.ipc.ts` (list/read/search/import/reimport/delete + watcher chokidar) + enregistrement dans `src/main/ipc/index.ts` + `turndown` dans package.json + `package-lock.json` sync. *(fichiers disjoints de Phase 2)*
- **Vague 3 (‖)** — Phase 4 : `DocsPanel.tsx` + entrée TABS `RightPanel/index.tsx` + `window.bridge.docs.*` (preload) + `BridgeApi` (`src/shared/types.ts`) + events progression. // Phase 5 : `import_doc` (orchestrator-gated) dans `server.mjs` + case `'docs-import'` dans `mcp-export.processCommand` (⚠ les DEUX) + test headless (drop command → docSet dans index.ndjson).
- **v2 différé** — rerank sémantique local (MiniLM), toggle.

## Risques / pièges
Câblage dual-site (Phase 5 : server.mjs ET processCommand). Crawl sitemap fragile (SPA/boilerplate → borner, dédup canonique, erreurs inline). Fidélité d'ancre (capturer l'ancre source si dispo, sinon slugify GitHub ; le TEXTE reste correct même si le saut d'ancre rate). Scan O(n) par docSet (cap chunks ; signal pour activer v2 si ça mord). Race ré-import (lock par docSet). `package-lock` drift (turndown pure-JS → pas d'electron-rebuild, juste committer le lock). Watcher multi-projet : globale ici donc UN watcher sur `~/.oryon/docs` (pas de re-target par workspace).
