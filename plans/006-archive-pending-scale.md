# Plan 006 : Sweep d'archive incrémental + persistance des merges reportés

> **Instructions exécuteur** : suis ce plan étape par étape. Lance chaque vérification
> avant de continuer. Condition STOP → arrête et rapporte. Le reviewer tient l'index
> `plans/README.md`.
>
> **Drift check (à lancer d'abord)** :
> `git diff --stat 29c8ae5..HEAD -- src/main/services/archive.ts src/main/services/orchestrator/merge-back.ts`
> Sur écart avec les extraits « État actuel », condition STOP.

## Statut

- **Priorité** : P3
- **Effort** : M
- **Risque** : LOW-MED
- **Dépend de** : aucun
- **Catégorie** : perf + bug
- **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Deux plafonds d'échelle dans les services de fond :
1. **Archive** : le sweep (toutes les 2 min, `mcp-export.ts` tick) RÉÉCRIT le
   `.meta.json` de CHAQUE session archivée à CHAQUE passage (commentaire explicite
   `archive.ts:128` « meta réécrite à CHAQUE passage ») puis reconstruit l'index
   complet (`rebuildIndexes` relit TOUS les meta.json). À 1000+ sessions accumulées,
   chaque tick paie O(total sessions) en I/O pour, le plus souvent, ZÉRO changement.
2. **Merges reportés** : quand le tronc est sale, un merge approuvé est mis en attente
   dans `pending` — une **Map en mémoire** (`merge-back.ts:190`). Si l'app crashe ou
   quitte avant le drain, le job est perdu ; la task reste 'in-review' et le merge
   n'arrive que si un humain ré-approuve. On persiste la partie sérialisable et on
   rejoue au prochain démarrage.

## État actuel

- `src/main/services/archive.ts` :
  - lignes 96-151 : `planAgent(ref)` — pour CHAQUE `.jsonl` source : stat, calcule
    `needsGzip` en comparant au meta précédent (`prev.sourceBytes !== st.size ||
    prev.sourceMtimeMs !== st.mtimeMs || !existsSync(gzPath)`), puis appelle
    `writeFileAtomic(metaPath, JSON.stringify({ sessionId, agent, role, workspaceId,
    project, bytes, sourceMtimeMs, archivedAt: Date.now(), gz, tasks }, null, 2))`
    INCONDITIONNELLEMENT (le commentaire ligne 128 le dit : MAJ tags/horodatage).
  - lignes 190-215 : `rebuildIndexes(projects)` — re-scanne TOUS les dossiers/meta du
    projet et réécrit `index.ndjson`, appelé par les DEUX sweeps à chaque passage.
  - lignes 218-233 : `sweepArchive()` (async, périodique) et `sweepArchiveSync()`
    (will-quit) — même structure : `planAgent` puis gzip puis `rebuildIndexes`.
  - `readJson`/`writeFileAtomic` (lignes 74-89) sont les helpers locaux.
- `src/main/services/orchestrator/merge-back.ts` :
  - ligne 187 : `let chain: Promise<void> = Promise.resolve()` (sérialiseur).
  - lignes 189-194 : `const pending = new Map<string, MergeBackJob>()` + clé composite
    `pendingKey = (j) => `${j.mainPath} ${j.branch}``.
  - lignes 197-205 : `drainPendingMerges()` — rejoue si `isClean(mainPath)`, sinon remet
    en pending. Appelé par le tick 2 s de mcp-export.
  - lignes 219-222 : `enqueueMergeBack(job)` — pousse dans `chain`.
  - Le type `MergeBackJob` contient `{ mainPath, worktree, branch, agent, task,
    onDone(m), onConflict(m) }` — les DEUX callbacks sont des closures NON
    sérialisables (posées par router.agentApproveTask).
  - La mise en pending se fait dans `integrate()` (plus haut dans le fichier) quand le
    tronc est sale — localise avec `grep -n "pending.set" src/main/services/orchestrator/merge-back.ts`.
- Contrainte d'architecture : ce plan ne doit PAS toucher `mcp-export.ts` (un autre
  plan le modifie en parallèle). La réhydratation doit donc être LAZY (déclenchée au
  premier appel de `drainPendingMerges`, pas par un nouvel appel d'init).

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Installer (1× si besoin) | `npm ci --ignore-scripts` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |

## Périmètre

**In scope** :
- `src/main/services/archive.ts`
- `src/main/services/orchestrator/merge-back.ts`

**Out of scope** :
- `src/main/services/mcp-export.ts` (tick inchangé — réhydratation lazy obligatoire).
- `router.ts` (les callbacks réels restent posés par approve_task).
- `src/mcp/docs-read.mjs` (l'index inversé de recherche docs a été évalué et REJETÉ —
  prématuré ; cf. plans/README.md).

## Workflow git

- Branche `oryon/agent-<ton-nom>`. Commits conventionnels, ex.
  `perf(archive): sweep incrémental` puis `fix(merge-back): persistance des merges reportés`.
- Ne push pas (merge via approve_task).

## Étapes

### Étape 1 : archive — n'écrire le meta QUE s'il change

Dans `planAgent` :
- Construis l'objet meta SANS `archivedAt` d'abord ; compare aux champs du `prev`
  (déjà lu) : `bytes`, `sourceMtimeMs`, `gz`, `agent`, `role`, `workspaceId`, `project`
  et la signature des tasks (`JSON.stringify(tasks)` vs `JSON.stringify(prev.tasks ?? [])`).
- Écris le meta UNIQUEMENT si `needsGzip` est vrai OU si un de ces champs diffère OU si
  `prev` est absent ; conserve alors `archivedAt: Date.now()` dans l'objet écrit.
- Fais remonter un booléen « changed » : `planAgent` retourne désormais
  `{ jobs: GzJob[], changed: boolean }` (changed = au moins un meta écrit ou un gzip
  planifié). Adapte les DEUX appelants (`sweepArchive`, `sweepArchiveSync`).

**Vérifier** : `npm run typecheck` exit 0.

### Étape 2 : archive — ne reconstruire l'index QUE pour les projets changés

Dans `sweepArchive` et `sweepArchiveSync` : collecte `changedProjects` (les `ref.project`
dont planAgent a retourné `changed: true` OU dont au moins un gzip a tourné) et appelle
`rebuildIndexes(changedProjects)` au lieu de tous les projets. Si la liste est vide,
ne PAS appeler rebuildIndexes. Cas spécial premier passage : si `index.ndjson` n'existe
pas encore pour un projet qui a des sessions, force la reconstruction de celui-là
(`!existsSync(join(archiveRoot(project), 'index.ndjson'))`).

**Vérifier** : `npm run typecheck` exit 0. Smoke manuel (optionnel mais recommandé) :
`node -e` qui importe… N'EST PAS possible (TS). À la place, relis le diff et vérifie la
logique des deux chemins (async + sync) ligne à ligne.

### Étape 3 : merge-back — persister les jobs reportés

- Ajoute un chemin de persistance PAR projet :
  `const pendingPath = (mainPath: string) => join(mainPath, '.oryon', 'pending-merges.json')`
  (ajoute l'import `join` de `node:path` s'il manque — vérifie l'en-tête du fichier).
- `savePending()` : regroupe les jobs de `pending` par `mainPath` et écrit dans chaque
  fichier la liste `[{ mainPath, worktree, branch, agent, task }]` (PAS les callbacks),
  écriture atomique tmp+rename (copie le motif `writeFileAtomic` d'archive.ts en
  helper local). Si un projet n'a plus de jobs, écris `[]`.
  Appelle `savePending()` partout où `pending` MUTE : après `pending.set(...)` dans
  `integrate()`, et dans `drainPendingMerges()` après le clear/re-set.
- Réhydratation LAZY : un flag module `let rehydrated = false` ; au DÉBUT de
  `drainPendingMerges()`, si `!rehydrated` : passe-le à true, puis pour chaque workspace
  CONNU il faut une source de mainPath — tu ne connais pas les projets ici SANS les
  fichiers : lis simplement les `pending-merges.json` des `mainPath` déjà rencontrés ?
  NON — au boot la Map est vide. Solution retenue : `rehydrateFor(mainPath)` est appelé
  par `enqueueMergeBack` ET `drainPendingMerges` n'a pas la liste… donc EXPOSE
  `export function rehydratePendingMerges(mainPath: string): void` qui lit le fichier
  du projet et re-`pending.set` chaque entrée avec des callbacks PAR DÉFAUT :
  `onDone: (m) => console.error('[merge-back] merge réhydraté OK :', m)` et
  `onConflict: (m) => console.error('[merge-back] merge réhydraté en conflit :', m)`.
  Puis appelle `rehydratePendingMerges(job.mainPath)` (une fois par mainPath — garde un
  `Set` des mainPath déjà réhydratés) au début de `enqueueMergeBack` ET de
  `mergeAgentBranch`. Ainsi le premier contact d'un projet avec le module recharge ses
  reports, sans toucher mcp-export.
- IMPORTANT : ne réhydrate PAS un job dont la clé est déjà dans `pending` (le vivant
  gagne sur le persisté).

**Vérifier** : `npm run typecheck` exit 0 ; `grep -n "pending.set" src/main/services/orchestrator/merge-back.ts`
montre un `savePending()` à proximité de chaque site.

### Étape 4 : gitignore du fichier de persistance — NON REQUIS

`.oryon/` est déjà gitignoré dans ce repo et `pending-merges.json` n'est pas un
`*.lock` (l'invariant isClean de v0.1.63 ignore les `.lock` ; un fichier UNTRACKED sous
`.oryon/` ne salit pas le tronc non plus — `isClean` regarde l'arbre git). Vérifie just
e : `git check-ignore .oryon/pending-merges.json` depuis la racine de ton worktree → chemin affiché (= ignoré).

**Vérifier** : la commande check-ignore affiche le chemin.

## Plan de test

Pas de framework (plan 007 plus tard). Validation = typecheck + revue ligne à ligne du
diff + check-ignore. Candidat de test futur (à noter dans ton rapport, ne pas créer) :
round-trip savePending/rehydrate sur un tmpdir.

## Critères de done

- [ ] planAgent ne réécrit plus les meta inchangés (lecture du diff : écriture conditionnelle)
- [ ] rebuildIndexes appelé uniquement pour les projets changés (les deux sweeps)
- [ ] pending-merges.json écrit atomiquement à chaque mutation de `pending`
- [ ] `rehydratePendingMerges` exporté, appelé lazy (enqueueMergeBack + mergeAgentBranch), idempotent par mainPath, ne clobbe pas un job vivant
- [ ] `git check-ignore .oryon/pending-merges.json` → ignoré
- [ ] `npm run typecheck` exit 0
- [ ] `git status` : seuls archive.ts et merge-back.ts modifiés

## Conditions STOP

- Les extraits « État actuel » ne matchent pas (drift).
- Tu crois devoir modifier `mcp-export.ts` pour réhydrater — STOP, c'est exclu par
  conception (un autre plan tient ce fichier en parallèle).
- `integrate()` met en pending à un endroit que tu ne retrouves pas via
  `grep -n "pending.set"` — rapporte la structure réelle.

## Notes de maintenance

- Si un futur plan ajoute des champs à MergeBackJob, étendre la liste sérialisée de
  savePending (les callbacks restent non persistables — par conception).
- Reviewer : vérifier le chemin will-quit (`sweepArchiveSync`) — il doit garder la même
  sémantique « écrit le delta avant fermeture », juste sans réécritures inutiles.
- Rejet documenté : index inversé de recherche docs (docs-read.mjs) — le scan actuel est
  mtime-caché et optimisé ; un index changerait la sémantique substring. Pas maintenant.
