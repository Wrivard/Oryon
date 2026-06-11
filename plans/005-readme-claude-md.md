# Plan 005 : Écrire README.md + CLAUDE.md (les conventions sortent de la mémoire tribale)

> **Instructions exécuteur** : suis ce plan étape par étape. Si une condition STOP
> survient, arrête et rapporte. Le reviewer tient l'index `plans/README.md`.
> RÈGLE D'OR de ce plan : tu n'écris QUE des faits fournis dans ce plan ou vérifiables
> directement dans le repo (fichier:ligne). AUCUNE invention, AUCUNE généralité.
>
> **Drift check** : `git diff --stat 29c8ae5..HEAD -- README.md CLAUDE.md` (les deux
> fichiers ne doivent PAS exister ; s'ils existent déjà → STOP).

## Statut

- **Priorité** : P2
- **Effort** : S–M
- **Risque** : LOW (fichiers nouveaux, zéro code)
- **Dépend de** : aucun
- **Catégorie** : docs
- **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Le repo n'a NI README.md (la page GitHub n'affiche que l'arborescence) NI CLAUDE.md,
alors qu'il est édité quotidiennement par des agents Claude (l'orchestrateur d'Oryon
travaille sur le repo d'Oryon lui-même). Les conventions critiques — twin `.mjs`/`.d.mts`,
interdiction d'écrire sur stdout dans server.mjs, invariant $0 API, types de commandes
partagés — ne vivent que dans des commentaires épars et la mémoire des sessions. Chaque
nouvel agent les redécouvre ou les casse. Les docs numérotées à la racine (00-OVERVIEW.md
… 09-CLAUDE-CODE-PROMPTS.md) sont les PLANS DE CONSTRUCTION historiques, pas l'état
courant — sans avertissement, un agent les prend pour la vérité du code.

## État actuel (fiche de FAITS — la seule source autorisée)

- **Produit** : Oryon — IDE Electron multi-agents (Windows d'abord) qui pilote des
  agents CLI Claude Code dans des terminaux PTY ; un ORCHESTRATEUR par workspace
  délègue à des WORKERS, chacun dans son worktree git (`.oryon/agents/<nom>`, branche
  `oryon/agent-<nom>`), avec merge-back sérialisé vers le tronc. v0.1.64.
- **Stack** : Electron 32 + electron-vite 2 (esbuild — le build NE typecheck PAS),
  TypeScript 5.5, React 18 + Zustand 5 + Tailwind 3, better-sqlite3 (DB sous userData),
  @lydell/node-pty, serveur MCP stdio en JS pur (`src/mcp/server.mjs`), koffi (FFI
  Win32 : hotkeys/injection), transformers.js (Whisper local) + Groq STT, electron-updater
  (releases GitHub publiques Wrivard/Oryon).
- **Arborescence** : `src/main` (index.ts, db/ + migrations, ipc/*.ipc.ts, services/
  dont orchestrator/) ; `src/preload/index.ts` (contextBridge → window.bridge) ;
  `src/renderer/src` (app React) ; `src/mcp` (server.mjs + lecteurs *-read.mjs) ;
  `src/shared` (types.ts + cores .mjs avec jumeaux .d.mts) ; `scripts/` (before-pack.cjs
  bundle le serveur MCP ; dev.cmd lance le dev) ; `docs-plans/` (rapports d'audit
  historiques) ; `plans/` (plans d'implémentation, voir plans/README.md).
- **Commandes** : `npm ci` (postinstall : electron-rebuild better-sqlite3) ;
  `npm run dev` (ou double-clic `scripts/dev.cmd`) ; `npm run typecheck` (SEUL garde-fou
  de types — exigé avant tout commit) ; `npm run build` ; `npm run dist:win` (installeur
  local) ; `npm run release:stable` (bump + tag + push → CI `.github/workflows/release.yml`
  publie l'installeur ; l'app installée s'auto-update depuis les releases GitHub).
- **Conventions à documenter dans CLAUDE.md** (chacune avec son « pourquoi ») :
  1. **$0 API Claude** : les agents tournent sur l'abonnement OAuth du CLI claude
     (`~/.claude/.credentials.json`). `ANTHROPIC_API_KEY` est SCRUBBÉE de l'env avant
     chaque spawn (pty-manager, dev-server, mcp-probe). Ne JAMAIS introduire le SDK
     Anthropic ni un appel API payant dans l'app.
  2. **Twin-file** : tout module partagé importé par server.mjs est un `.mjs` JS pur ;
     s'il est aussi importé par du TypeScript, il a un jumeau `.d.mts` (exemples :
     `src/shared/memory-core.mjs` + `.d.mts`, `system-feedback-core`, `docs-core`).
     Sans le jumeau → erreur TS7016 au typecheck.
  3. **stdout interdit dans `src/mcp/server.mjs`** : stdout = protocole MCP ; les logs
     passent par `console.error`.
  4. **Types de commandes MCP→main** : la liste de vérité vit dans
     `src/shared/command-types.mjs` ; tout nouveau type = ajout là-bas + un handler dans
     `mcp-export.ts:processCommand`. (Si ce fichier n'existe pas encore au moment où tu
     écris — le plan 002 le crée — formule la règle au présent quand même et cite
     server.mjs:queueCommand.)
  5. **Commits** : conventionnels avec scope, français OK (`feat(agents): …`,
     `fix(mcp): …` — vois `git log --oneline -15`). Jamais de `--force`/`--no-verify`/
     `--amend` sans permission explicite. Stager par chemin explicite (pas `git add -A`).
  6. **Commentaires** : français, riches en POURQUOI, en-tête de fichier explicatif
     (style maison visible dans n'importe quel fichier de src/main/services/).
  7. **Workers** : chaque worker reste DANS son worktree (`git rev-parse --show-toplevel`
     doit pointer `.oryon/agents/<nom>`) ; jamais de commande destructive ; report_task
     honnête (le diff committé fait foi).
  8. **Docs racine 00-09** : plans de construction HISTORIQUES (peuvent diverger du
     code) ; l'état courant = le code + plans/README.md.
- **Install utilisateur final** : Releases GitHub → `Oryon-<version>-Setup.exe`
  (NSIS par-utilisateur, sans UAC) ; auto-update silencieux ensuite.

## Périmètre

**In scope** : `README.md` (créer), `CLAUDE.md` (créer).
**Out of scope** : tout autre fichier ; AUCUNE modification des docs 00-09 (l'avertissement
« historique » vit dans README/CLAUDE.md, pas dedans).

## Workflow git

- Branche `oryon/agent-<ton-nom>`. Un commit : `docs(repo): README + CLAUDE.md`.
- Ne push pas (merge via approve_task).

## Étapes

### Étape 1 : README.md (~60-100 lignes, en français)

Sections, dans cet ordre : titre + une phrase de pitch ; **Qu'est-ce qu'Oryon** (3-5
phrases, depuis la fiche de faits) ; **Installation** (lien Releases + nom de
l'installeur + auto-update) ; **Développement** (prérequis Node 22+, `npm ci`,
`npm run dev` / `scripts/dev.cmd`, `npm run typecheck`) ; **Build & release** (dist:win,
release:stable → CI tag) ; **Architecture** (l'arborescence commentée de la fiche) ;
**Conventions** (une ligne + renvoi vers CLAUDE.md) ; **Docs historiques** (avertissement
00-09 + docs-plans/). Ton : sobre, factuel, zéro marketing.

**Vérifier** : chaque affirmation du README provient de la fiche de faits ou d'un
fichier du repo que tu as ouvert (cite fichier:ligne dans ton rapport pour tout ajout
hors fiche).

### Étape 2 : CLAUDE.md (~60-90 lignes, en français)

Public : un agent Claude qui travaille DANS ce repo. Contenu : les 8 conventions de la
fiche de faits, chacune avec son pourquoi et un exemple de chemin réel ; puis une
section « Vérification avant commit » (npm run typecheck obligatoire ; tests si présents) ;
puis « Pièges connus » : (a) le build esbuild ne typecheck pas, (b) jumeau .d.mts
obligatoire, (c) stdout server.mjs, (d) l'app INSTALLÉE ≠ le repo (les changements ne
prennent effet qu'au build suivant).

**Vérifier** : relis CLAUDE.md en te demandant pour chaque ligne « un agent peut-il
la VÉRIFIER dans le repo ? » — supprime toute ligne qui échoue à ce test.

## Plan de test

Aucun (docs). Revue humaine du contenu par le reviewer.

## Critères de done

- [ ] README.md existe, sections de l'étape 1 présentes, français
- [ ] CLAUDE.md existe, les 8 conventions + pièges connus présents
- [ ] Aucun fait inventé (spot-check reviewer)
- [ ] `git status` : seuls README.md et CLAUDE.md créés

## Conditions STOP

- README.md ou CLAUDE.md existe déjà.
- Tu veux documenter un comportement que tu ne peux pas pointer dans le code → omets-le
  et note-le dans ton rapport.

## Notes de maintenance

- CLAUDE.md est chargé par les agents : le garder COURT et factuel (c'est un contrat,
  pas un wiki). Les plans 002/012/017 modifieront des faits (command-types, Python CI,
  version Electron) — le reviewer met à jour CLAUDE.md au fil des merges si besoin.
