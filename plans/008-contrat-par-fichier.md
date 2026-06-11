# Plan 008 : Contrats assign_task livrés par FICHIER (fin des troncatures de paste)

> **Instructions exécuteur** : suis ce plan étape par étape ; chaque vérification doit
> donner le résultat attendu. Condition STOP → arrête et rapporte. Le reviewer tient
> `plans/README.md`.
>
> **Drift check** : `git diff --stat 29c8ae5..HEAD -- src/main/services/orchestrator/router.ts src/main/services/worktrees.ts`
> ATTENDU : router.ts a été modifié par le plan 003 (sites releaseClaimsByAgent +
> pré-check W6). Les extraits ci-dessous concernent d'AUTRES zones (dispatch/paste) —
> s'ILS ne matchent plus, STOP.

## Statut

- **Priorité** : P1 — **Effort** : M — **Risque** : MED (chemin de dispatch de la flotte)
- **Dépend de** : plan 003 (mergé — même fichier router.ts)
- **Catégorie** : bug — **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Les contrats d'assign sont APLATIS en une ligne et collés dans le PTY du worker
(bracketed paste). Au-delà d'~1,5-2k caractères, le paste se tronque/perd : le worker
reçoit la tête et/ou la queue mais perd le MILIEU — ou ne reçoit rien. Preuves :
rapport system-feedback `f89da23d` (Oryon, worker Nell), corroboré par `1975b0b1`
(kua-coiffure : PSReadLine crashe sur les longues frappes injectées) et REPRODUIT EN
DIRECT le 2026-06-11 : 3 dispatchs sur 6 perdus (Cole, Jude, Nell) pendant la vague 1
de ces plans — le prompt complet (contrat ~700 c + rappel de rôle ~1,3k c) dépassait le
seuil. Le correctif : pour tout prompt long, écrire le contrat COMPLET (multi-ligne,
lisible) dans un fichier du worktree du worker et ne coller qu'un POINTEUR court.
L'orchestrateur de kua-coiffure a déjà inventé ce pattern à la main
(`ORCHESTRATOR-TASK.md`) — on l'industrialise, avec les exclusions nécessaires pour que
ce fichier untracked ne fasse pas dérailler les sondes git.

## État actuel

- `src/main/services/orchestrator/router.ts` :
  - l.119-122 : `oneLinePrompt(s)` = `s.replace(/\s+/g, ' ').trim()`.
  - l.124-129 : `pasteLine(terminalId, line)` = writeTerminal(line) puis `\r` différé
    (INJECT_ENTER_DELAY).
  - l.382-398 (dans `agentAssignTask`) : construit `roleReminder` (5 bullets verbeux si
    task FRAÎCHE ; `[]` si re-dispatch — Q5), `docNote`, `staleNote`, puis :
    ```ts
    const prompt = oneLinePrompt([`[task ${task.id}]`, instructions, docNote, staleNote, ...roleReminder].join(' '))
    pasteLine(id, prompt)
    ```
  - l.427-433 : filet R1 anti-« busy zombie » (re-Entrée si l'écho ne démarre pas claude).
  - Le router importe déjà `worktreeDir` (utilisé l.652) et `terminalName`.
- `src/main/services/worktrees.ts` :
  - l.222-252 : `refreshWorktreeToHead` — `if ((tryGit(dir, ['status', '--porcelain']) ?? '').trim()) return 'dirty'`
    → N'IMPORTE QUEL fichier untracked (donc notre futur fichier contrat) rend le
    worktree « dirty » et SAUTE la synchro sur main (faux positif documenté par
    1975b0b1).
  - l.313-340 : `branchEvidence` — `worktreeDirty = !!wtStatus.trim()` et `uncommitted`
    dérivés de `status --porcelain` : le fichier contrat untracked rendrait
    `worktreeDirty=true` et `empty=false`, AFFAIBLISSANT l'evidence-gate (un « done »
    sans travail ne serait plus détecté vide).
  - l.73-76 : `isTransientHarnessPath` (exemple existant d'exclusion de chemins harness).

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |

## Périmètre

**In scope** : `src/main/services/orchestrator/router.ts` (zone dispatch uniquement),
`src/main/services/worktrees.ts` (filtres status + constante).

**Out of scope** : `pasteLine`/`oneLinePrompt` eux-mêmes (les notifications courtes à
l'orchestrateur continuent de les utiliser tels quels) ; merge-back.ts ; le serveur MCP ;
les prompts de rôle (roles.ts).

## Workflow git

Branche `oryon/agent-<ton-nom>` ; commit conventionnel
`fix(orchestrator): contrats longs livrés par fichier (anti-troncature)`. Ne push pas.

## Étapes

### Étape 1 : constante partagée + filtre des sondes (worktrees.ts)

- Exporte `export const ORCHESTRATOR_TASK_FILE = 'ORCHESTRATOR-TASK.md'` avec un
  commentaire français expliquant (contrat de tâche déposé par l'orchestrateur,
  untracked, ne doit gater NI la synchro NI l'evidence-gate).
- Ajoute un helper local `statusLinesIgnoringContract(dir)` : lit
  `tryGit(dir, ['status', '--porcelain']) ?? ''`, splitte en lignes, filtre celles dont
  le chemin (après `l.slice(3).trim()`, gérer les guillemets éventuels) est
  `ORCHESTRATOR_TASK_FILE`.
- `refreshWorktreeToHead` : remplace le check dirty (l.226) par ce helper (dirty si
  lignes restantes non vides).
- `branchEvidence` : calcule `wtStatus` filtré de la même façon pour `worktreeDirty` et
  `uncommitted` (le fichier contrat ne compte ni comme dirty ni comme fichier changé).

**Vérifier** : `npm run typecheck` exit 0.

### Étape 2 : livraison par fichier (router.ts, agentAssignTask)

Remplace les deux lignes `const prompt = …` / `pasteLine(id, prompt)` par :

```ts
// Anti-troncature (rapport system-feedback f89da23d) : le bracketed-paste perd le MILIEU
// des longs prompts (~>1200 c). Au-delà du seuil, le contrat COMPLET (multi-ligne, lisible)
// est écrit dans <worktree>/ORCHESTRATOR-TASK.md et seul un POINTEUR court est collé.
const fullInline = oneLinePrompt([`[task ${task.id}]`, instructions, docNote, staleNote, ...roleReminder].join(' '))
const wtDir = isGitRepo(ws.project_path) ? worktreeDir(ws.project_path, terminalName(id)) : null
const contractPath = wtDir ? join(wtDir, ORCHESTRATOR_TASK_FILE) : null
if (contractPath && fullInline.length > CONTRACT_PASTE_MAX) {
  const body = [`# Tâche [task ${task.id}] — ${task.title ?? ''}`, '', instructions, docNote, staleNote, ...roleReminder]
    .filter(Boolean).join('\n\n')
  try {
    writeFileSync(contractPath, body, 'utf8')
    pasteLine(id, oneLinePrompt(
      `[task ${task.id}] Ton contrat COMPLET est dans le fichier ${ORCHESTRATOR_TASK_FILE} à la RACINE de ton worktree — lis-le en entier et exécute-le. ${staleNote}`,
    ))
  } catch {
    pasteLine(id, fullInline) // échec d'écriture (rare) → repli inline, pas pire qu'avant
  }
} else {
  if (contractPath) { try { unlinkSync(contractPath) } catch { /* absent : rien à nettoyer */ } } // jamais de contrat PÉRIMÉ lisible
  pasteLine(id, fullInline)
}
```

Détails d'intégration : `CONTRACT_PASTE_MAX = 1200` en constante module commentée ;
imports à compléter (`join` de node:path, `writeFileSync`/`unlinkSync` de node:fs,
`ORCHESTRATOR_TASK_FILE` + `isGitRepo` depuis ./worktrees — vérifie ce qui est déjà
importé en tête de fichier et n'ajoute QUE le manquant). Le filet R1 (l.427) et tout le
reste de la fonction restent INCHANGÉS.

**Vérifier** : `npm run typecheck` exit 0 ; relis le diff : la branche inline reste le
chemin par défaut des contrats courts.

### Étape 3 : trace outcome

Dans le `recordOutcome({ event: 'assigned', … })` juste après (l.400-409), ajoute le
champ `contractDelivery: fullInline.length > CONTRACT_PASTE_MAX ? 'file' : 'paste'`
(recordOutcome accepte des champs additionnels ? VÉRIFIE sa signature dans
orchestrator/outcomes.ts — si le type est fermé, étends l'interface d'événement de ce
fichier d'UN champ optionnel ; si ça dépasse 5 lignes de changement, ABANDONNE cette
étape 3 et note-le, ce n'est pas critique).

**Vérifier** : `npm run typecheck` exit 0.

## Plan de test

Pas de harnais PTY testable ici. Validation = typecheck + revue du diff. Test runtime
réel (reviewer, post-merge + rebuild) : dispatcher un contrat > 1200 c → le fichier
apparaît dans le worktree du worker et le worker reçoit le pointeur.

## Critères de done

- [ ] Contrat > 1200 c → écrit dans `<worktree>/ORCHESTRATOR-TASK.md` + pointeur court collé
- [ ] Contrat court → inline comme avant + fichier contrat résiduel supprimé
- [ ] `refreshWorktreeToHead` et `branchEvidence` IGNORENT ORCHESTRATOR-TASK.md (helper partagé)
- [ ] `npm run typecheck` exit 0
- [ ] `git status` : seuls router.ts et worktrees.ts modifiés

## Conditions STOP

- Les zones dispatch (l.382-433) ou sondes (refreshWorktreeToHead/branchEvidence) ne
  matchent plus les extraits après le merge du plan 003 — rapporte le code réel.
- `recordOutcome` impose une refonte de type > 5 lignes (saute l'étape 3, note-le).
- Tu envisages de toucher pasteLine/oneLinePrompt globalement — hors périmètre.

## Notes de maintenance

- Le plan 011 (spawn/worktree) s'appuie sur ORCHESTRATOR_TASK_FILE exporté.
- Les orchestrateurs (roles.ts) n'ont PAS besoin de changement : le pointeur collé dit
  au worker où lire ; le rappel de rôle complet vit dans le fichier en mode file.
- Reviewer : vérifier le repli inline en cas d'échec d'écriture (jamais de dispatch perdu).
