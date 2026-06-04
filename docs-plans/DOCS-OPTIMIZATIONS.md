# Docs feature — optimization pass (revue 4-reviewers, 2026-06-04)

Décision utilisateur : **PASS COMPLET**. 6 lots à **fichiers DISJOINTS** → parallélisables. Specs partagées ci-dessous pour les couplages inter-lots. Contrainte : **$0 Claude** (aucun appel API/embedding ; CLI subscription seulement). Chaque lot : commit conventional-commit, stage par chemin explicite, `npm run typecheck` vert.

## Specs partagées (couplages — respecter EXACTEMENT)
- **SPEC-A — ligne de résultat `search_docs` LEAN** : `{ docSlug, breadcrumb, anchor, snippet, chunkId, score }`. RETIRER `title` (100 % redondant avec la fin du breadcrumb) et `sourceUrl` (conservé seulement dans `fetch_doc_section`). → Lot 2 l'implémente (docs-read.mjs), Lot 3 met la description de l'outil MCP en accord.
- **SPEC-B — nouveaux champs `assign_task`** : `docSlug?: string` (slug de la doc importée pertinente) + `readOnly?: boolean` (aucun commit attendu → la tâche skippe l'evidence-gate « branche vide »). → Lot 3 (server.mjs : schéma Zod + payload queueCommand) ET Lot 5 (router.ts : lecture/handling) utilisent ces noms EXACTS.

## Lot 1 — Chunker · `src/shared/docs-core.mjs`
1. **Strip des liens markdown** dans le texte de heading AVANT de dériver title/breadcrumb/anchor/tags : si le heading contient `[texte](url)`, garder « texte » (`String(s).replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')`) puis trim. Applique-le à `title` (donc breadcrumb stack ET `githubSlug(title)`). Corrige le junk d'URL (anchors `configuration-valueshttps...`, tags pollués par `https/docs/sentry`) — 60 % des chunks Sentry.
2. **Granularité** : splitter les sections sur **H1/H2 seulement** (pas H3) ; les H3 restent dans le corps de leur section parente.
3. **Fusion des mini-sections** : toute section dont le corps fait < ~300 chars est fusionnée dans la précédente (sœur/parent), pour supprimer les chunks isolés type « ### Parameters » d'une ligne.
4. (Optionnel) index incrémental (read index.ndjson, remplace/ajoute/retire la ligne du slug) au lieu d'un `rebuildIndex` complet à chaque write ; garder le full rebuild comme self-heal.
⚠ Write-side : un re-import est requis après merge pour nettoyer les docSets existants — l'orchestrateur s'en charge.

## Lot 2 — Moteur de recherche · `src/mcp/docs-read.mjs`
1. **SPEC-A** : `searchDocs` retourne la ligne lean (retirer `title` + `sourceUrl`).
2. **maxChars** défaut de `fetchSection` : 12000 → **6000** (couvre >99 % des sections ; l'appelant peut surcharger).
3. **Cache mémoire clé par mtime** : `Map<slug,{mtimeMs,chunks}>` ; `statSync(chunksPath)` (cheap) avant relecture ; recharger seulement le slug dont le mtime a changé. Idem `index.ndjson`. Évite de relire+reparser TOUS les chunks à chaque appel (48 ms→score-only ; ~624 ms évités à 50k chunks).
4. **Hot-path** : lowercaser `text` UNE fois (réutilisé par scoring + snippet) ; remplacer `text.split(term).length-1` par un comptage `indexOf` non-allouant ; garder un **top-k pendant le scan** (pas accumuler tous les chunks à score>0) ; calculer le **snippet APRÈS le slice top-k** (pas pour chaque candidat).

## Lot 3 — Surface MCP · `src/mcp/server.mjs`
1. **JSON compact** : retirer `null, 2` dans `list_docs`/`search_docs`/`fetch_doc_section`/`import_doc` (sortie consommée par une machine ; le markdown garde ses \n).
2. **Descriptions** des outils mises en accord avec SPEC-A (ligne de résultat lean ; ne plus mentionner title/sourceUrl dans search_docs).
3. **import_doc** : `unlink` du fichier résultat (okPath ET errPath) juste après lecture (best-effort, try/catch).
4. **assign_task** : ajouter `docSlug?: string` + `readOnly?: boolean` au schéma Zod (SPEC-B) + les inclure dans `queueCommand({type:'assign-task',…})`.

## Lot 4 — Prompts DOCS-AWARE · `src/main/services/orchestrator/roles.ts`
(éditer ORCHESTRATOR_TERMINAL_SYSTEM et WORKER_TERMINAL_SYSTEM)
1. **Coût** : « appelle `search_docs` DIRECTEMENT (il scanne tous les docsets) ; n'utilise `list_docs` que pour découvrir ce qui existe. Lis le SNIPPET d'abord ; n'appelle `fetch_doc_section` que pour LA section dont tu as besoin (pas plusieurs spéculativement). »
2. **Déclencheur resserré** : remplacer « involves a third-party tool » par « a SPECIFIC, EXTERNALLY-NAMED tool/SDK/service whose exact surface (methods, signatures, config keys, endpoints) you would otherwise GUESS — not the ambient framework you already know ».
3. **docSlug** : orchestrateur → « passe le `docSlug` pertinent dans le contrat assign_task (SPEC-B) pour que le worker cherche la BONNE doc directement ». Worker → « si ton contrat nomme un docSlug, `search_docs({query,docSlug})` scopé d'abord (skip la découverte list_docs) ; si la doc nécessaire n'est pas importée, escalade via `report_task` ‘blocked-pending-docs: <outil>’ pour que l'orchestrateur l'importe + re-dispatch — n'invente pas l'API ».
4. **PLAN-GATE** : « pour une tâche outil-documenté, le plan DOIT citer les sections (anchors) de doc qu'il suivra ; un plan qui invente une API sans citation est rejeté. » + « `import_doc` peut renvoyer `{pending:true}` pour un gros crawl = succès-EN-COURS (pas échec) ; re-check via list_docs/search_docs avant de grounder. »

## Lot 5 — Robustesse main-side · `src/main/services/orchestrator/router.ts` + `src/main/services/mcp-export.ts`
1. **router.ts** : lire le `docSlug` de assign_task (SPEC-B) et l'injecter dans le prompt-contrat construit pour le worker (ex. ligne « Doc de référence : utilise search_docs({docSlug:'…'}) »).
2. **router.ts** : si la tâche porte `readOnly` (SPEC-B), NE PAS appliquer le rejet evidence-gate « branche vide » (accepter un `done` sans commit comme valide ; ne PAS enregistrer l'outcome `empty-branch` ni pénaliser le scorecard). Corrige le faux positif vécu sur Nell + Cole.
3. **mcp-export.ts** : `processedCommands.delete(path)` après `unlink` réussi du fichier commande (le Set fuit sinon) ; + sweep des fichiers `mcp-state/docs-import/<reqId>.{json,err}` plus vieux que ~1 h (dans le tick périodique existant).

## Lot 6 — UX panneau · `src/renderer/src/components/RightPanel/DocsPanel.tsx`
1. **Progression agent** : afficher un indicateur ambiant (badge/spinner toolbar + bannière non-modale « Import en cours… ») quand des events `docs:import-progress` arrivent alors que `!importingRef.current` (= import déclenché par un AGENT) ; garder la vue progression complète pour les imports lancés par l'utilisateur.
2. **Recherche re-jouée** : keyer l'effet de recherche sur un `docsVersion` (incrémenté à chaque `onChanged`/reload) au lieu de `docs.length`, pour que la recherche se rafraîchisse quand le CONTENU change (re-import) sans changer le nombre de docs.
3. **Copie `.mdx`** : l'overlay drag + le hero disent « .md / .txt » mais le filtre accepte `.mdx` → uniformiser en « .md / .mdx / .txt ».

## Après les merges (orchestrateur)
- Re-importer **Sentry** et **Claude Code** (via import_doc/reimport) pour appliquer le nouveau chunker (Lot 1) aux docSets existants.
- Vérif intégrée typecheck + (le cas échéant) re-tester search_docs (ligne lean + anchors propres).
- Release.
