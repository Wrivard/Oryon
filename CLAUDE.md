# CLAUDE.md — contrat pour les agents qui modifient ce dépôt

Ce fichier est lu par les agents Claude qui travaillent DANS Oryon. Garde-le court et
factuel. Chaque règle ci-dessous est vérifiable dans le code (un chemin réel est cité).

## Conventions (chacune avec son pourquoi)

1. **Coût $0 sur l'API Claude.** Les agents tournent sur l'abonnement OAuth du CLI `claude`
   (`~/.claude/.credentials.json`). `ANTHROPIC_API_KEY` est *scrubbée* de l'environnement
   avant chaque spawn — voir `src/main/services/pty-manager.ts`, `dev-server.ts`,
   `mcp-probe.ts`. *Pourquoi* : une clé API facturerait des crédits en double de
   l'abonnement. N'introduis JAMAIS le SDK Anthropic (`@anthropic-ai/sdk`) ni un appel API
   payant dans l'app. Dans le doute, arrête et demande.

2. **Jumeau `.d.mts` pour tout core `.mjs`.** Un module partagé importé par le serveur MCP
   est du `.mjs` JS pur ; s'il est AUSSI importé par du TypeScript, il a un jumeau `.d.mts`
   à côté — ex. `src/shared/memory-core.mjs` + `memory-core.d.mts` (idem
   `system-feedback-core`, `docs-core`). *Pourquoi* : sans le jumeau, le typecheck échoue
   en TS7016 (« could not find a declaration file »).

3. **Jamais de `stdout` dans `src/mcp/server.mjs`.** stdout y porte le protocole MCP
   (stdio) ; tout log passe par `console.error` (stderr). Voir l'en-tête de
   `src/mcp/server.mjs` (« ne JAMAIS écrire sur stdout hors protocole MCP »). *Pourquoi* :
   une écriture parasite sur stdout corrompt le flux et fait planter le serveur.

4. **Commandes MCP → main.** Un passage du serveur MCP vers le process principal se fait
   par une commande : `queueCommand({ type, … })` dans `src/mcp/server.mjs` l'écrit sur
   disque, `processCommand()` dans `src/main/services/mcp-export.ts` la relit et la route.
   Ajouter un type = l'émettre côté `server.mjs` ET ajouter son handler côté
   `mcp-export.ts`. *Pourquoi* : les deux côtés sont des process séparés ; oublier un côté
   = commande silencieusement ignorée. Le registre partagé des types vit dans
   `src/shared/command-types.mjs` : tout nouveau type s'y ajoute (le main logge en
   erreur tout type hors registre).

5. **Commits conventionnels avec scope.** Format `feat(agents): …`, `fix(mcp): …`,
   `docs(repo): …` (français OK — voir `git log --oneline`). JAMAIS `--force`,
   `--no-verify` ni `--amend` sans permission explicite dans la conversation. Stage les
   fichiers par chemin explicite, pas `git add -A`. *Pourquoi* : l'historique reste
   lisible et le merge-back sérialisé ne ramasse pas de changements non voulus.

6. **Commentaires en français, riches en POURQUOI.** Chaque fichier non trivial ouvre sur
   un en-tête qui explique son rôle et ses pièges (style visible dans n'importe quel
   `src/main/services/*.ts` ou dans `electron-builder.yml`). *Pourquoi* : le prochain agent
   hérite du contexte sans relire tout l'historique.

7. **Workers : reste dans ton worktree.** Chaque worker travaille dans
   `.oryon/agents/<nom>` (`git rev-parse --show-toplevel` doit pointer là), sur la branche
   `oryon/agent-<nom>`. Aucune commande destructive ; `report_task` honnête (le diff
   committé fait foi). *Pourquoi* : les worktrees des autres agents et le tronc sont
   hors-limites — l'orchestrateur seul fait le merge-back.

8. **Les docs racine `00-OVERVIEW.md` … `09-CLAUDE-CODE-PROMPTS.md` sont HISTORIQUES.**
   Ce sont des plans de construction ; ils peuvent diverger du code. L'état courant = le
   code + `plans/` (et `plans/README.md` comme index). *Pourquoi* : les prendre pour la
   vérité du code mène à réimplémenter ou casser ce qui existe déjà.

## Vérification avant commit

- `npm run typecheck` est **obligatoire** avant tout commit qui touche du TypeScript —
  c'est le SEUL garde-fou de types (il lance `tsconfig.node.json` + `tsconfig.web.json`).
- `npm test` (vitest, fichiers sous `tests/`) — obligatoire aussi : caractérise les
  invariants critiques (quoting claude-launcher, sérialisation system-feedback,
  round-trip enc:v1). La CI (`.github/workflows/ci.yml`) lance typecheck + test + build.
- Scripts ad hoc du domaine docs : `node scripts/test-docs-core.mjs`,
  `scripts/test-docs-import-command.mjs` — lance-les si tu touches ce domaine.

## Pièges connus

- **Le build ne typecheck PAS.** `npm run dev` / `npm run build` (electron-vite/esbuild)
  transpilent sans vérifier les types. Un code faux compile et tourne. Toujours
  `npm run typecheck` à part.
- **Oublier le jumeau `.d.mts`** d'un nouveau core `.mjs` → TS7016 au typecheck (cf.
  convention 2).
- **Écrire sur `stdout` dans `server.mjs`** casse le flux MCP (cf. convention 3).
- **L'app INSTALLÉE ≠ ce dépôt.** Les changements ne prennent effet qu'au prochain build /
  release (l'installeur empaquette `out/`, pas les sources). Modifier le code ici ne change
  rien à l'app déjà installée tant qu'une nouvelle version n'est pas construite.
- **Natifs = prébuilts only.** `postinstall` lance `electron-builder install-app-deps`
  (prebuild-aware) ; ne JAMAIS revenir à `electron-rebuild -f` (forçait node-gyp →
  échec sans MSVC local). Conséquence : monter Electron exige qu'un prébuilt
  better-sqlite3 existe pour la nouvelle ABI (cf. releases WiseLibs/better-sqlite3 —
  c'est ce qui borne aujourd'hui à Electron 41/ABI 145 ; re-bump 42+ dès v146 publiée).
