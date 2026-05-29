# 04 — Orchestrateur multi-agent (BridgeSwarm-like)

> Ta spec : « ouvrir un orchestrateur. Quand je lui pose des questions / lui dis des trucs, il pousse des tasks liés à ce que je demande aux différents terminaux. »

On réplique le modèle **BridgeSwarm** de BridgeMind : un but → des rôles (**builder, reviewer, scout, coordinator**) → travail divisé → communication via **shared mailbox** → exécution en parallèle. Et ça correspond à ton pattern connu Manager→Editor→Verifier.

## 1. Vue d'ensemble du flux

```
Toi (texte ou voix)
      │  "Ajoute l'auth Stripe + une page pricing"
      ▼
┌─────────────┐   décompose   ┌──────────────┐  route   ┌──────────────────┐
│ DECOMPOSER  │ ────────────► │   ROUTER     │ ───────► │ Terminaux/agents │
│ (Claude API)│   tasks JSON  │ (rôles+état) │ prompts  │ (Claude Code CLI)│
└─────────────┘               └──────┬───────┘          └────────┬─────────┘
                                     │  lit/écrit               │ postent
                                     ▼                          ▼
                              ┌──────────────┐  <─────────  MAILBOX partagée
                              │  COORDINATOR │   handoffs / review requests
                              └──────────────┘
```

## 2. Rôles (roles.ts)

| Rôle | Mission | Prompt système (résumé) |
| --- | --- | --- |
| **coordinator** | Découpe le but, assigne, surveille la mailbox, décide quand c'est "review/complete". | "Tu es le coordinateur. Découpe l'objectif en tasks atomiques, assigne-les, surveille les handoffs, ne codes pas toi-même." |
| **builder** | Implémente le code d'une task. | "Tu es un builder. Implémente la task assignée dans ce repo. Quand fini, poste un message mailbox `done` + résumé des fichiers touchés." |
| **reviewer** | Relit les diffs, lance tests/lint, demande des corrections. | "Tu es reviewer. Inspecte les changements du builder, lance les tests, approuve ou renvoie avec commentaires." |
| **scout** | Explore le codebase / docs / recherche avant implémentation. | "Tu es scout. Explore le repo et la doc, produis le contexte/plan nécessaire au builder. Ne modifie pas de code." |

> Au moins 1 terminal = coordinator (ou bien le coordinator est un process main sans terminal). Les autres = builders/reviewers/scouts assignables.

## 3. Decomposer (Claude API)

```ts
// src/main/services/orchestrator/decomposer.ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function decompose(goal: string, projectContext: string) {
  const sys = `Tu es le coordinateur d'une équipe d'agents codeurs.
Découpe l'objectif en 1 à N tasks atomiques exécutables en parallèle quand possible.
Réponds UNIQUEMENT en JSON valide, sans markdown, schéma:
{"tasks":[{"title":string,"instructions":string,"role":"builder"|"reviewer"|"scout","dependsOn":number[]}]}`;

  const msg = await client.messages.create({
    model: 'claude-opus-4-8', // adapter au modèle dispo
    max_tokens: 2000,
    system: sys,
    messages: [{ role: 'user', content: `Contexte projet:\n${projectContext}\n\nObjectif:\n${goal}` }],
  });
  const text = msg.content.filter(b => b.type === 'text').map(b => (b as any).text).join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}
```

> `dependsOn` permet d'ordonner (ex. scout avant builder, builder avant reviewer). Tasks sans dépendances → parallèles.

## 4. Router (router.ts)

Responsabilités :
1. Persiste chaque task (`tasks` table, status `todo`).
2. Choisit un terminal libre du bon rôle (round-robin parmi les builders dispo).
3. Passe la task `in-progress`, **injecte le prompt** dans le PTY de l'agent (cf. `03 §5`).
4. Respecte `dependsOn` : ne dispatch une task que si ses dépendances sont `complete`/`in-review`.
5. Écoute la mailbox : sur message `done` d'un builder → crée/active une task `review` pour un reviewer.

```ts
type DispatchResult = { taskId: string; terminalId: string };

export async function routeTasks(workspaceId: string, plan: Plan): Promise<DispatchResult[]> {
  // 1. insert tasks
  // 2. topological-ish dispatch selon dependsOn
  // 3. pour chaque task prête: pick terminal by role → writeTerminal(prompt)
}
```

### Construction du prompt envoyé à l'agent
```
[ROLE: builder] [TASK #3]
Objectif global: <goal>
Ta task: <instructions>
Contexte/knowledge: <knowledge>
Contraintes: respecte le design system du repo, n'applique pas de changement destructeur sans confirmation.
Quand terminé: écris une ligne "MAILBOX: done #3 — <résumé fichiers>".
```

## 5. Mailbox partagée (mailbox.ts)

- Table `mailbox` (cf. schéma `01`).
- Les agents "postent" en écrivant un marqueur reconnaissable dans leur sortie terminal (ex. `MAILBOX: done #3 — ...`).
- Le main **parse la sortie PTY** (regex sur `MAILBOX:`) → insère en DB → notifie le router + l'UI.
- Le coordinator lit la mailbox pour décider des handoffs.
- L'UI affiche la mailbox comme un flux d'activité.

> C'est la même idée que BridgeSwarm : « communicate through a shared mailbox, ship code in parallel ».

## 6. Parsing de la sortie des agents

Petit module qui scanne le flux de chaque terminal :
- `MAILBOX: done #<n>` → task `in-review`.
- `MAILBOX: blocked #<n> — <raison>` → task repasse `todo` + notif.
- `MAILBOX: handoff #<n> -> reviewer` → router assigne un reviewer.
- Détection génériques de fin (Claude Code rend la main / prompt réapparaît).

## 7. Boucle de revue
1. Builder finit → `in-review`.
2. Router pousse au reviewer : "Inspecte les changements de la task #n, lance tests/lint."
3. Reviewer poste `MAILBOX: approved #n` → task `complete`, OU `MAILBOX: changes #n — ...` → task repart au builder.
4. Le panneau **Source/Diff** (cf. `05`) montre les diffs ; tu gardes le dernier mot (Safe by default).

## 8. UI de l'orchestrateur
- Input + bouton micro (Voice).
- Après décomposition : liste des tasks avec rôle, agent assigné, état, bouton "re-route".
- Flux mailbox live.
- Bouton "Pause swarm" / "Stop all".

## 9. Garde-fous
- Limite du nombre d'agents actifs simultanés (= nb de terminaux).
- Timeout par task → repasse `todo` ou notifie.
- Jamais d'exécution destructrice auto.
- Budget tokens / coût : compteur d'appels API du decomposer.

## 10. Critère de "done"
- [ ] Je tape un but → une liste de tasks apparaît.
- [ ] Chaque task est poussée dans le PTY du bon terminal et Claude Code commence à bosser.
- [ ] Quand un builder écrit `MAILBOX: done`, un reviewer est déclenché automatiquement.
- [ ] Les états des tasks se reflètent dans le Kanban (panneau Tasks).
