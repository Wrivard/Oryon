# Orchestrateur ↔ Workers — Liste d'optimisations (revue en profondeur)

Synthèse de 3 analyses parallèles + notes de friction historiques :
- **Code actuel** de la boucle (`router.ts`, `roles.ts`, `merge-back.ts`, `green-gate.ts`, `mcp-export.ts`, `server.mjs`, `worktrees.ts`) → gaps encore présents.
- **Archives réelles** : 111 sessions / 92,8 Mo (44 orchestrateur + 67 workers) → modes d'échec pondérés par fréquence.
- **Historique git** (41 commits orchestration) → classes de friction récurrentes.
- Notes mémoire (F1–F8, W1–W6, memory-clobber, submit-nudge).

> ⚠️ **Caveat déploiement** : beaucoup de fixes W-series sont arrivés en v0.1.4 et ne tournaient pas quand les archives ont été enregistrées. Tu es maintenant en **v0.1.38+** → la plupart sont actifs. Les items marqués **[vérifier]** veulent dire « le fix existe, confirmer qu'il tourne » plutôt que « à construire ».

---

## CE QUI MARCHE DÉJÀ — NE PAS TOUCHER
- **Porte à preuves git > prose** au report (rejette « done » sur branche vide) — a attrapé TOUS les faux-done du corpus. Le meilleur garde-fou.
- **Assignation à fichiers disjoints** → quasi zéro vrai conflit de merge.
- **Merge-back sérialisé** (`--no-ff` un à la fois) + rebase-before-merge + revert-on-red ancré sur le SHA du merge.
- **Identité worker durable** (`--append-system-prompt`) + **role-gate MCP** (outils d'orchestration retirés aux workers).
- **Système de continuité/reset** (archive gzip + curseur + `reset_orchestrator`) — élégant, état durable hors conversation.
- **Fix data-loss des junctions** de worktree.

---

## TIER 0 — BLOQUEURS pour de VRAIS projets (≠ Oryon)
*La boucle n'a été testée que sur Oryon (TS/Electron, git). Ces 3 items la rendent sûre sur n'importe quel repo.*

- **O1 — Généraliser la green-gate au-delà de TS/Electron.** Aujourd'hui la porte (autoritaire au merge ET advisory au report) ne lance que `tsc --noEmit` sur `tsconfig.node/web.json` hardcodés ; **tout projet non-TS (Python/Go/Rust/JS) → `skipped` → AUCUNE vérification au merge.** Fix : `verify_command` configurable par workspace (`npm test`, `cargo check`, `pytest -q`…), défaut = tsc si tsconfig présent. **Effort M. #1 blocker.**
- **O2 — Projets non-git = zéro isolation.** Sans git, `ensureWorktree` renvoie `main` → tous les workers partagent le MÊME dossier, pas de branche, pas d'evidence-gate, pas de merge-back ; `approve_task` flip direct. Fan-out parallèle = N agents qui piétinent un dossier. Fix : `git init` un repo scratch à la création du workspace (le modèle worktree s'applique toujours), OU forcer le mono-worker séquentiel quand pas de VCS (+ le dire dans le prompt). **Effort M. #2 blocker.**
- **O3 — Heuristiques/timing spécifiques pnpm/gros repo.** Le check « dépendances touchées » matche `package.json|pnpm-lock.yaml` ; le timeout green-gate = 300 s fixe (un `tsc` froid sur gros repo le dépasse → « defer » systématique = plus de porte). Fix : détecter l'écosystème (lockfiles) + timeout proportionnel/configurable + tsc incrémental. **Effort S–M.**

---

## TIER 1 — CORRECTNESS (fermer les chemins « du non-vérifié atteint main »)

- **C1 — Identité de task explicite.** `report_task`/`approve_task` n'ont pas de `taskId` ; le matching se fait par terminal → 2 assignations distinctes au même worker s'écrasent en une seule ligne de task (le 1er contrat disparaît du ledger). Fix : passer le `taskId` (retourné par `assign_task`) dans report/approve ; refuser une 2e task vivante sur un worker occupé. **Effort S–M.** (code P0-1/P0-3, archives #3)
- **C2 — `git add -A` au merge commite du non-commité.** `integrate()` fait `git add -A` + commit `--no-verify` sur le worktree avant le merge → si le worker a laissé des éditions non commitées (hors-scope, artefacts), elles partent dans main SANS que tu les aies reviewées. Fix : ne pas `add -A` aveugle ; si worktree dirty au report → rejeter/différer en demandant au worker de committer. **Effort S.** (code P0-2)
- **C3 — Garde anti-doublon/fantôme au dispatch.** Avant `assign_task`, vérifier `list_tasks` pour une task ouverte au titre/fichiers chevauchants → refuser/fusionner ; réconcilier les tasks fantômes (in-progress jamais nettoyées) AVANT une vague. Fix code + discipline. **Effort S.** (archives #3, code P0-1)

---

## TIER 2 — FIABILITÉ (moins de babysitting)

- **R1 — Porte de confirmation de SOUMISSION post-dispatch.** Mode d'échec #1 du corpus : le contrat est COLLÉ dans le TUI du worker mais l'**Enter ne part pas** (race paste/submit, `INJECT_ENTER_DELAY=200 ms`) → `busy:true` fantôme sur un prompt peuplé-non-soumis. Fix : après chaque dispatch, vérifier `get_terminal_output` une fois ; si non soumis → auto-`broadcast_command command:""` (Enter nu). Rendre la recette PROACTIVE (aujourd'hui = diagnostic manuel). **Effort S. Très haut levier.** (archives #1)
- **R2 — Compteur de retry / garde-boucle.** La boucle « changes-requested » réutilise la task à l'infini, sans compteur. Fix : `attempts` sur la task ; après N (≈3) → wake-line distincte « stop, consulte l'utilisateur » + badge board. **Effort S.** (code P1-1)
- **R3 — Récupération de stall automatique.** Le watchdog SIGNALE (>5 min silencieux) mais **n'agit jamais** (`restart_agent`/requeue existent mais pas câblés) ; et il est **aveugle à un worker mort-né** (jamais émis d'octet → `last=undefined` → jamais flaggé). Fix : stall = busy + rien depuis l'assign > seuil ; après 2 surfaçages sans progrès git → auto-restart/requeue. **Effort M.** (code P1-2, git §5)
- **R4 — Heartbeat MCP (tuer l'angle mort « busy zombie »).** `mcp_health` reste « connected » à vie (grep de log) → un MCP qui meurt APRÈS boot (claude vivant, MCP enfant mort) n'est pas détecté. Fix : le serveur MCP append un timestamp périodique dans `mcp-<name>.log` ; `mcp_health` renvoie `stale` si trop vieux ; auto-surface comme le watchdog. $0 (FS). **Effort S–M.** (code P1-3, git §7)
- **R5 — `restart_agent` complet.** Ne refait PAS le worktree (ni junctions `node_modules`/`.claude/skills`) et laisse la task `in-progress` orpheline. Fix : `ensureWorktree` + `provisionWorktreeDeps` avant recreate ; demote la task → `todo`. **Effort S.** (code P1-4)
- **R6 — Claims avec TTL + GC + release-on-death.** Les claims n'ont pas d'expiry ; un worker mort laisse un claim qui bloque les futurs assigns (« REFUSÉ W6 » sur des fichiers que personne n'édite). Fix : TTL (GC > ~30 min) + release des claims du worker mort (watchdog/restart). Rendre l'auto-claim au dispatch autoritaire (le worker n'a pas à self-claim). **Effort S–M.** (code P1-5)
- **R7 — `reconcileStaleTasks` périodique** (pas seulement au boot) → nettoie les zombies en cours de session. **Effort S.** (git §5)
- **R8 — Persister la file de merges différés.** La `pending` map (merges reportés rejoués au tick) est **en mémoire seule** → un crash pendant un merge différé la perd silencieusement (seul endroit où du travail mergé peut être perdu). Fix : persister, ou reconstruire au boot depuis les tasks approved-but-unmerged. **Effort S–M.** (git §3)
- **R9 — Lock sur `~/.claude.json`.** Spawn concurrent de ~9 `claude` corrompt le config partagé (mitigé par stagger 500 ms = heuristique, pas garantie ; corruption = hard-stop flotte). Fix : file-lock / write-queue sérialisé. **Effort S.** (git §6)

---

## TIER 3 — QUALITÉ DES CONTRATS (sortie des workers)

- **Q1 — Cap 3-5 items + CHECKLIST de livrables vérifiée au report.** Échec QUALITÉ dominant : contrat trop gros → livraison PARTIELLE silencieuse (Nell : 2/8 items). Fix : émettre une checklist explicite de livrables dans le contrat ; au report, differ la branche vs la checklist → rejeter « done » si un item n'a aucun hunk. Découper les gros goals en sous-tâches séquentielles. **Effort M. Haut levier qualité.** (archives #2)
- **Q2 — `files` quasi-obligatoire en parallèle + lint de contrat.** `files` optionnel → la garantie disjoint s'évapore si omis ; aucun garde-fou sur la qualité du contrat (tout texte passe). Fix : avertir/refuser un 2e assign concurrent sans `files` ; flag les contrats trop courts / sans definition-of-done. **Effort S–M.** (code P2-4)
- **Q3 — Pin Opus au spawn [vérifier] + corps de tâche EN PREMIER + pas de `/effort` sur modèle non-capable.** Archives : 14 sessions sur Haiku/Sonnet (pas Opus) → `/effort ultracode` échoue → le worker DÉRAILLE complètement (« what are you trying to accomplish ? » alors que le contrat est dans le même message). F1 (enforceAgentSpawn → Opus) devrait régler le modèle en v0.1.38 → **confirmer**. Toujours utile : mettre le corps du contrat AVANT toute slash-command, et ne pas pousser `/effort ultra` à un modèle non-xhigh. **Effort S.** (archives #4)
- **Q4 — Politique git worker allégée.** Le SKILL.md git-workflow COMPLET (push/merge/PR) est injecté aux workers à qui on dit « ne push/merge jamais » → contradiction + bloat de tokens à chaque spawn. Fix : politique git worker-scoped (commit-sur-branche + conventional + staging explicite + typecheck, stop). **Effort S.** (archives #6)
- **Q5 — Re-dispatch = SEULEMENT le corps du contrat.** Ne jamais renvoyer le bloc de rôle seul (le worker perd un tour à dire « pas de tâche ici ») ; ne pas poker un worker idle. **Effort S.** (archives #7)
- **Q6 — Récolter les bugs « signalés-non-corrigés ».** Les workers signalent bien les bugs adjacents hors-scope (bonne discipline) mais l'orchestrateur doit les capturer (backlog/mémoire) sinon perdus. **Effort S.** (archives #8)

---

## TIER 4 — OBSERVABILITÉ / VITESSE DE REVUE

- **V1 — Diff dans la wake-line + outil `get_branch_diff`.** Aujourd'hui : juste des compteurs (« N commits, M fichiers ») + suggestion de lancer `git diff` → chaque revue = un round-trip. `branchEvidence` calcule DÉJÀ `filesChanged` (jeté en `.length`). Fix : inclure la liste (cap 15) + `--stat` ; ajouter un outil MCP `get_branch_diff` pour pull le diff sans git brut. **Effort S–M. Accélère CHAQUE revue.** (code P2-3)
- **V2 — `broadcast_command` saute les workers occupés** (sinon une commande de réglage injecte une ligne dans un TUI mid-task et le déraille). **Effort S.** (code P2-6)
- **V3 — `reset_orchestrator` : ré-hydration dans le prompt de rôle** (pas un paste temporisé à 1 s qui peut rater si `/clear` n'a pas fini → réveil sans curseur). **Effort S.** (code P2-7)

---

## HAZARD OPÉRATIONNEL (discipline, pas un build)
- **Memory-clobber pendant un dispatch** : éditer `MEMORY.md` (mémoire Claude Code auto) pendant qu'on assigne/qu'un worker tourne injecte un system-reminder « memory updated » dans les PTY workers qui **ÉCRASE le corps de l'`assign_task`** → le worker ne reçoit que du boilerplate. **Règle : ne jamais écrire la mémoire Claude Code tant que la flotte n'est pas idle.** (Les écritures `.oryon/memory` via MCP ne semblent PAS clobber — à confirmer.)

---

## RECOMMANDATION — 1re vague (avant de vrais projets)
Pour débloquer les VRAIS projets + couper le babysitting, dans l'ordre :
1. **O1 + O2** (Tier 0) — sans ça, la boucle est non vérifiée/non isolée hors TS+git. *Le prérequis réel.*
2. **R1 + R3 + R4 + R7** — tuent le « busy zombie » et la race de soumission (le gros du babysitting).
3. **Q1 + Q3** — fin de la livraison partielle + du déraillement modèle.
4. **C1 + C2** — ferment les 2 derniers chemins « non-vérifié → main ».
5. **V1** — accélère chaque revue.

Le reste (R2/R5/R6/R8/R9, Q2/Q4/Q5/Q6, O3, V2/V3) = 2e vague, polish.

---

## STATUT — VAGUE 1 LIVRÉE (v0.1.40, commits sur main)
Implémentée par l'orchestrateur dans le tronc (contention router.ts/server.mjs → fan-out workers peu rentable) :
- **V1** wake-line liste les fichiers changés `9ad81ff` · **O1** green-gate générique multi-écosystème `b9c1c1f`
- **O2** isolation non-git séquentielle + **R1** filet anti-busy-zombie (re-Entrée) + **R3** watchdog mort-né `3532f66`
- **R7** requeue task d'un worker mort + **C1** flag rapport non-vérifiable `e3e916b` · **C2** merge `add -u` (pas de junk) `bca13e7`
- **Q1** contrats checklist de livrables + check anti-sous-livraison `a540a55` · **R4** heartbeat MCP → statut `stale` `c39c1c2`
- **Q3** (pin Opus) confirmé DÉJÀ actif (`enforceAgentSpawn`/F1, clamp haiku|sonnet→opus) — rien à coder.

**DÉFÉRÉ** (2e vague / durcissements) : `get_branch_diff` (redondant — l'orchestrateur a `git diff` via Bash) ;
C1-complet (threading explicite du taskId) ; C2-complet (rejet-au-report d'un worktree sale → nécessite distinguer
dirty-suivi/non-suivi dans branchEvidence) ; Q4 (politique git worker allégée), Q5 (re-dispatch corps-seul),
Q6 (récolte des bugs signalés) ; R5 (restart re-provisionne le worktree), R6 (claims TTL), R8 (persister pending
merges), R9 (lock `~/.claude.json`) ; O3 (timing/heuristiques par écosystème) ; V2/V3.
