# Couche feedback / amélioration continue (analogie entreprise)

Manager = orchestrateur, employés = workers. Issu de 3 agents (audit données, faisabilité archives, patterns éprouvés).

## Clé de voûte
Le « done » d'un worker ne vaut RIEN (45/47 « done » sur les archives, souvent faux). **La vérité = le verdict du manager.** Le task ledger se mute en place (zéro historique). Donc : **capter, append-only, l'adjudication de l'orchestrateur + les événements du cycle de vie.** Tout le reste (track records, routage, playbook, métriques) = agrégation par-dessus.

## A. CAPTURE — `<projet>/.oryon/outcomes.ndjson` (append-only, écrit par le MAIN, lu par le MCP)
Nouveau module `src/main/services/orchestrator/outcomes.ts` : `recordOutcome(projectPath, ev)` → `appendFileSync` 1 ligne JSON, best-effort (ne throw JAMAIS). Schéma événementiel :
```
{ ts, event, taskId, attempt, agent, title?, fresh?, files?, worktreeSync?,
  report?, summary?, evidence?{ahead,filesChanged,worktreeDirty,mainDirty,empty}, typecheck?, mismatch?,
  verdict?, mergeOutcome?, mergeMessage?, reason? }
event ∈ assigned | reported | rejected | approved | merge_conflict | merge_deferred | cancelled | abandoned
```
Hooks (router.ts, cf. audit Agent 1) :
- `agentAssignTask` (après terminalBusy.set) → `assigned` (attempt = compteur in-mem +1 ; fresh=!open ; files ; worktreeSync=refreshed).
- evidence-gate rejet (branche vide) → `rejected` (reason:'empty-branch').
- `agentReportTask` (updateTask in-review/blocked) → `reported` (report, summary, evidence, typecheck, mismatch).
- `agentApproveTask` onDone → `approved` (**verdict='pass'** ; mergeOutcome='merged'). onConflict → `merge_conflict`/`merge_deferred`.
- re-dispatch (open réutilisé) avec feedback → verdict='needs-work' dérivé (l'action EST l'adjudication). `setTaskStatus` cancelled → `cancelled` (verdict='reject'). exit-observer R7 → `abandoned`.
**A2 verdict** : DÉRIVÉ de l'action (approve=pass, re-dispatch=needs-work, cancel=reject) — zéro friction, pas de nouvel outil. La justification = le feedback de re-dispatch (déjà écrit).

## B. MÉCANIQUES DE BOUCLE
- **R2 cap** (router.ts) : compteur d'attempts ; au re-dispatch, si attempt ≥ CAP (3), réveille l'orchestrateur « task X a rebondi N× → stop, consulte l'utilisateur » (flag fort, pas de refus dur).
- **Plan-gate** (prompt) : pour une tâche non triviale, le contrat exige que le worker poste d'abord un PLAN (via report_task « plan ») SANS éditer ; le manager approuve → re-dispatch « plan ok, implémente ».
- **Gate déterministe avant review** (prompt) : ne deep-review que ce qui a passé la green-gate advisory ; bounce le rouge direct.

## C. FLYWHEEL
- **`worker_scorecard`** (+ `team_metrics`) : nouveau `src/mcp/outcomes-read.mjs` (lit outcomes.ndjson direct, pattern archive-read) + outil(s) orchestratorTool dans server.mjs. Par worker : tasksAttempted, **firstPassApprovalRate**, avgAttempts-to-pass, blockedRate, rejectionRate, abandonRate, lastActive. Équipe : débit, re-dispatch freq, conflits, distribution verdicts.
- **Routage** (prompt) : consulter worker_scorecard AVANT d'assigner — gros/risqué → worker prouvé ; calibrer la profondeur de review par track record.
- **Playbook vivant** (prompt + note mémoire `orchestrator-playbook`) : le manager PROPOSE des leçons depuis les traces (append_memory) ; **l'humain cure** ; les workers consomment. ⚠ Auto-édité = régresse ~3% → curation humaine obligatoire.

## Ordre de build (commits)
1. **A** : `outcomes.ts` + hooks router.ts (+ compteur attempts in-mem).
2. **C-read** : `outcomes-read.mjs` + `worker_scorecard`/`team_metrics` (server.mjs).
3. **B+C-prompt** : roles.ts (plan-gate, gate déterministe, routage, playbook, justification) + R2 cap (router.ts).

## Test (après release + auto-update)
Lancer un VRAI run sur la flotte → vérifier `.oryon/outcomes.ndjson` se remplit → `worker_scorecard` sort des profils cohérents → le playbook reçoit une leçon proposée.

## Déféré / noté
Enrichissement archive (modèle/coût/timing par worker, signaux propres Agent 2) = secondaire, brancher après. Score fin de rubrique (vs coarse pass/needs-work/reject) = gold-plating. ML (GEPA/routers appris/fine-tuning) = hors $0, skip.

---

## STATUT — LIVRÉ v0.1.42 (commits sur main)
- **A capture** : `outcomes.ts` + 6 hooks router.ts (assigned/reported/rejected/approved/merge_conflict|deferred/cancelled/abandoned) `9dec3d1` + fix `c9e4892`.
- **C-read** : `outcomes-read.mjs` + outils MCP `worker_scorecard` / `team_metrics` (server.mjs) `57caa89`.
- **B+C-prompt** : R2 retry-cap (router.ts, cap 3) + prompts plan-gate / review-verdict / routing-par-scorecard / playbook vivant (roles.ts) `bcef0fb`.

EFFET seulement après auto-update + restart. **TEST sur la flotte** : lancer un VRAI run → vérifier que `.oryon/outcomes.ndjson` se remplit → `worker_scorecard` / `team_metrics` sortent des chiffres cohérents → proposer une leçon dans `orchestrator-playbook` (que l'utilisateur cure).

ENRICHISSEMENT déféré (sur demande) : signaux archive (modèle/coût/timing par worker, Agent 2) à brancher dans outcomes-read ; capture du typecheck (green/red) + mismatch dans l'event `reported` (actuellement evidence git seule) ; score fin de rubrique (vs coarse). Plan-gate = guidance prompt (pas de machinerie dure).
