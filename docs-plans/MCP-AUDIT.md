# Rapport d'audit MCP — Oryon

## 1. Architecture MCP actuelle

Le MCP dans Oryon suit un flux linéaire **DB → génération de fichier → injection au spawn → consommation par le CLI claude**. Oryon n'ouvre jamais lui-même de connexion MCP : il écrit un fichier de config et le passe au binaire `claude`, qui spawn et maintient les serveurs.

**(1) Modèle de données.** Table SQLite plate `mcp_connectors` (`004_settings.ts:19-31`) : `id, name, scope, project_id, transport, command, args(JSON-array TEXT), url, enabled, created_at` + index `idx_mcp_scope(scope, project_id)`. **Aucune colonne `env` ni `headers`.** Types miroir dans `types.ts:129-149` (`McpConnector`, `McpConnectorInput` — pas de `env`/`headers`/`catalogId`).

**(2) Deux scopes + un serveur toujours présent.**
- **MCP GLOBAL** = `scope='app'` → injecté à **tous** les projets/agents.
- **MCP PAR PROJET** = `scope='project'` → injecté **uniquement** si `project_id` correspond au projet du terminal. Le `project_id` est figé à l'INSERT via `resolveProjectId` (`settings.ipc.ts:27-30`, `SELECT id FROM projects WHERE path = ?`).
- **Serveur `oryon`** = toujours ajouté en dur (`settings.ipc.ts:89-100`), quels que soient les connecteurs. Il porte les outils d'orchestration + mémoire, lancé via `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (PAS `node` du PATH) avec `env={ORYON_PROJECT_DIR, ORYON_MCP_STATE, ELECTRON_RUN_AS_NODE}`.

**(3) Génération de config.** `buildProjectMcpConfigForPath(projectPath)` (`settings.ipc.ts:69-110`) est le **seul** générateur : résout le `projectId`, lit les connecteurs `enabled=1 AND (scope='app' OR (scope='project' AND project_id=?))` (`:73-77`), construit toujours `mcpServers['oryon']`, puis ajoute chaque connecteur — `{type:'http', url}` (`:104`) ou `{command, args}` (`:105`), **jamais de bloc `env`/`headers`** pour un connecteur utilisateur. Écrit `userData/oryon-mcp-<projectId|'app'>.json` via `writeFileSync` **non atomique** (`:108`). Un connecteur nommé `oryon` est sauté (`:103`).

**(4) Injection au spawn.** `terminals.ipc.ts:9-27` est le **chokepoint unique**. Pour tout autostart commençant par `claude` : ancre MCP sur `mainProjectPath ?? cwd` (le **tronc principal**, jamais le worktree — `:21`, commentaire « piège #1 » `:17-20`), génère le fichier (`:22`), puis `autostart += --mcp-config '<file>'` (`:23`) **sans `--strict-mcp-config`**, puis `enforceAgentSpawn` (`:26`). Le fichier est réécrit à chaque spawn.

**(5) Usage orchestrateur/workers.** Chemin de spawn **identique** pour les deux (`Terminal.tsx` → `terminals:create`). Même fichier de config, donc **mêmes serveurs MCP**. La seule différence est l'env `ORYON_AGENT_ROLE` (posé dans `Terminal.tsx:183-187`, propagé via `pty-manager.ts:79`), qui pilote le role-gating dans `server.mjs:33-36` : `isOrchestrator = (ORYON_AGENT_ROLE==='orchestrator')`. Les 7 outils de **lecture mémoire** ne sont enregistrés que pour l'orchestrateur (`readMemoryTool`, fail-safe : rôle absent = worker). Garde-fou coût $0 : `ptyEnv()` retire `ANTHROPIC_API_KEY` (`pty-manager.ts:60`).

**Contraste documenté :** `cli.ts:64` (appels Voice headless) utilise `--strict-mcp-config --mcp-config <vide>` — preuve que le flag est connu du code mais **non appliqué** au spawn des agents.

---

## 2. Lacunes vérifiées (priorisées)

> Toutes les lacunes ci-dessous sont **confirmées** (ou **partielles**, signalé) par la vérification adverse. Les réfutées sont exclues.

### (a) UI & gestion des connecteurs

| # | Lacune | Sév. | Preuve | Impact |
|---|--------|------|--------|--------|
| a1 | **Aucune édition d'un connecteur** | high | Ligne = toggle + delete seulement (`SettingsModal.tsx:344-383`) ; aucun handler `updateConnector` (`settings.ipc.ts:112-123`), aucune méthode bridge/type (`preload/index.ts:69-76`, `types.ts:546-555`). `Pencil` sert uniquement aux Skills (`:499`). | Corriger une faute de frappe = delete+recreate. Aggravé : `addConnector` regénère un `uuid()` et force `enabled=true` (`settings.ipc.ts:44,52`) — l'ancien id et l'état sont perdus. Asymétrie avec les Skills (édition inline `:540-571`). |
| a2 | **Suppression immédiate sans confirmation** | medium | `deleteConnector` appelé direct au clic (`SettingsModal.tsx:374-380` → `:98-101`). Skills = confirm 2 temps (`:501-537`). | Un clic détruit la config (command/args/url) sans undo. |
| a3 | **Aucun feedback d'erreur** | medium | `submitConnector/toggleConnector/deleteConnector` sans try/catch ni état d'erreur (`SettingsModal.tsx:94-119`). Contraste : `skError/skEditError/skDeleteError` pour les Skills. | Échec IPC (DB lock, écriture impossible) avalé silencieusement ; l'UI fait juste `reload()`. |
| a4 | **Validation d'ajout insuffisante** | medium | `submitConnector` ne bloque que sur nom vide (`:103`) ; bouton désactivé seulement par `!fName.trim()` (`:442`). Un stdio sans command / http sans url est créable mais ignoré à la génération (`settings.ipc.ts:104-105`). Un nom `oryon` est accepté puis sauté (`:103`). | Connecteurs « morts » créés, affichés activés mais jamais injectés. |
| a5 | **`JSON.parse(c.args)` non gardé dans le JSX** | low | `SettingsModal.tsx:372` parse directement sans try/catch. `args` est TEXT libre (`004_settings.ts:26`). | Args malformé (corruption DB, écriture manuelle) → crash de rendu de toute la section. Faible proba via l'UI actuelle. |
| a6 | **Badge scope non localisé + scope non modifiable** | low | Badge rend `{c.scope}` brut 'app'/'project' (`:369`) alors que le select est francisé (`:399-402`) ; Skills localisés (`:488`). | Incohérence de langue ; mauvais scope = delete/recreate. |

### (b) Câblage projet & génération de config

| # | Lacune | Sév. | Preuve | Impact |
|---|--------|------|--------|--------|
| b1 | **Pas de régénération de config sur mutation de connecteur** | high | `toggleConnector/deleteConnector/submitConnector` n'appellent que `reload()` (`SettingsModal.tsx:94-118`) ; `buildProjectMcpConfigForPath` n'a **qu'un** appelant : `terminals.ipc.ts:22`. Aucun file-watcher sur `oryon-mcp-*.json`. | Un add/toggle/delete n'a **aucun effet** sur les agents lancés ni même sur le fichier disque tant qu'un **nouveau** terminal claude n'est pas spawné. On toggle, rien ne bouge ; un spawn ultérieur applique l'état DB courant, décorrélé de l'action UI. |
| b2 | **`--mcp-config` injecté SANS `--strict-mcp-config` → fusion avec `.mcp.json` racine concurrent** | high | `terminals.ipc.ts:23` (pas de strict) vs `cli.ts:64` (strict). `.mcp.json:3-5` déclare un 2e `oryon` en `command:'node'` + chemin absolu codé en dur, **sans env**. `claude --help` (v2.1.159) : sans `--strict`, le CLI charge `--mcp-config` **PLUS** « all other MCP configurations » (dont le `.mcp.json` du cwd). | **Collision certaine** de deux serveurs `oryon` (le gagnant est interne au CLI, non prouvable depuis le repo). Le `oryon` en `node` nu est le pattern « oryon · failed » documenté (`settings.ipc.ts:85-88`) car le SDK vit dans l'asar. En PROD le `.mcp.json` est exclu du paquet (`electron-builder.yml:36`) mais l'absence de strict laisse fusionner toute config user `~/.claude.json`. |
| b3 | **Secrets écrits EN CLAIR (DB + JSON disque)** | high | `args`/`url`/`command` TEXT bruts (`004_settings.ts:25-27`) ; `addConnector` sérialise verbatim (`settings.ipc.ts:50`) ; recopiés en clair dans `oryon-mcp-*.json` via `writeFileSync` **sans mode 0o600** (`:104-108`). Aucun `safeStorage`/`keytar`/`encrypt` dans tout le repo. | Tout token glissé dans `args` (stdio) ou `url` (http) finit en clair en DB + fichier userData (backups, sync cloud, autres process). Combiné à b4, pousse vers la pire pratique. |
| b4 | **Aucune colonne/champ `env` (stdio) ni `headers` (http)** | high | Absent des 5 couches : formulaire (`SettingsModal.tsx:413-435`), `McpConnectorInput` (`types.ts:141-149`), table (`004_settings.ts`), `addConnector` (`settings.ipc.ts:42-62`), génération (`:104-105`). **Preuve que ce n'est PAS une limite du CLI** : le serveur `oryon` reçoit bien un bloc `env` (`:95-99`). Le schéma `.mcp.json` accepte `env` (stdio) et `headers` (http). | Cas http **strictement plus bloquant** : le formulaire http n'a **même pas** de champ args (`:428-434`), donc un Bearer est impossible à exprimer. Cas stdio : seul contournement = secret dans `args`, alors visible en clair y compris dans la liste UI (`:372`). github/supabase/sentry inconfigurables. |
| b5 | **`project_id` sans intégrité référentielle + duplication de rows `projects`** | medium | `project_id` TEXT sans `REFERENCES` (`004_settings.ts:23`), contrairement à tasks/agents (`schema.ts:35,46` `ON DELETE CASCADE`). `projects.path` sans `UNIQUE` (`schema.ts:30`) ; `workspaces.ipc.ts:99-104` INSERT direct sans dédup au lieu de `getOrCreateProjectId`. | (a) Projet supprimé/recréé → `project_id` figé devient mort → connecteur project orphelin invisible (pas de CASCADE). (b) Deux rows `projects` pour un même path rendent `resolveProjectId` non-déterministe → connecteur project qui apparaît/disparaît selon la row gagnante. |
| b6 | **Repli silencieux sur scope 'app' si le projet n'est pas enrôlé en DB** | low | `settings.ipc.ts:70-77` : si `SELECT id FROM projects WHERE path=?` échoue, `projectId=undefined` → seuls les `scope='app'` sont inclus (clause `project_id=?` exclut les NULL). Égalité **stricte** sur path (casse/slashes Windows). | Un path qui ne matche pas exactement → connecteurs `scope='project'` **silencieusement omis** pour tous les agents, sans erreur. Parité orch/worker préservée (les deux perdent pareil). |
| b7 | **`writeFileSync` non atomique** | low | `settings.ipc.ts:108` vs `mcp-export.ts:28-32` (`writeFileAtomic` temp+rename, justifié « jamais un JSON tronqué »). Plusieurs agents partagent `oryon-mcp-<projectId>.json`. | Deux spawns rapprochés sur le même projet → fenêtre de JSON partiel lu par un claude qui boote. Proba faible (stagger `Terminal.tsx:189` + contenu identique), correctif trivial (réutiliser le `writeFileAtomic` voisin). |

### (c) Accès workers/orchestrateur & usage au bon moment

| # | Lacune | Sév. | Preuve | Impact |
|---|--------|------|--------|--------|
| c1 | **Doublon `oryon` cassé injecté par le `.mcp.json` du worktree** | high | `.mcp.json` git-tracké et **physiquement présent** dans les 8 worktrees `.oryon/agents/*` (non gitignoré). cwd worker = worktree (`Terminal.tsx:175`). Sans `--strict` (`terminals.ipc.ts:23`), le CLI fusionne. Le 2e `oryon` (`node` nu, sans env) **démarre réellement en dev** (node sur PATH + SDK dans le `node_modules` jonctionné). Aggravé par `settings.local.json:7` `bypassPermissions`. | Collision certaine (gagnant indéterminé, interne CLI). **Si** le serveur sans-env est routé : mémoire écrite dans `.oryon/memory` privé au worktree (`findProjectDir(cwd)`, le « piège #1 »), état lu depuis `APPDATA/Oryon` au lieu d'`ORYON_MCP_STATE`, role-gate neutralisé (`DEFAULT_ROLE` undefined). Correctif chirurgical : `--strict-mcp-config` au spawn, OU dé-tracker `.mcp.json`. |
| c2 | **Outils d'orchestration NON gatés par le rôle au niveau serveur** | medium | `assign_task` (`server.mjs:308-309`), `approve_task` (`:329-330`), `broadcast_command` (`:366-367`) enregistrés via `server.tool(` **inconditionnel** (vérifié : pas `readMemoryTool`). Seul le prompt dissuade (`roles.ts:26`). | Un worker dont le contexte dérive peut techniquement appeler `assign_task`/`approve_task` (merge de branche) — `currentWorkspaceId()` route la commande. Seul rempart = textuel. Un gate orchestrateur-only fermerait le trou (cohérent avec l'intention F2 du gate mémoire). |
| c3 | **Prompt worker n'enseigne pas ses outils MCP** | medium | `roles.ts:31` nomme `report_task` sans dire « MCP » ; `claim_files` n'apparaît QUE côté orchestrateur (`roles.ts:12`), jamais côté worker. | Le garde anti-collision repose sur les claims, mais seul l'orchestrateur est invité à claim (au moment de l'assign). Si l'orchestrateur omet `files`, deux workers peuvent éditer le même fichier sans claim → conflit de merge. |
| c4 | **Si la génération de config échoue, l'agent démarre sans `oryon` (dégradation muette)** | low | `terminals.ipc.ts:23` : `if (mcpFile && !/--mcp-config/...)`. `buildProjectMcpConfigForPath` fait un `writeFileSync` non protégé (`settings.ipc.ts:108`) ; une exception casserait `terminals:create`. Aucun repli/log côté agent. | En cas d'échec d'écriture, soit le spawn jette (terminal mort sans message), soit l'agent n'a QUE le `.mcp.json` cassé du worktree (c1). Orchestration/mémoire non fonctionnelles sans diagnostic. |

### (d) Cycle de vie, santé & debug

| # | Lacune | Sév. | Preuve | Impact |
|---|--------|------|--------|--------|
| d1 | **Aucun health-check ni statut « connecté/échec »** | high | Aucun champ statut dans `McpConnector` (`types.ts:129-140`) ; UI = enabled/scope/transport seulement (`SettingsModal.tsx:344-382`) ; `Terminal.tsx:150-152` bascule `claude_ready` sur regex texte cosmétique, jamais l'état MCP. Grep `connected/health/ping` = 0 hit fonctionnel. **Aucun canal de retour** de l'état MCP des agents vers le main (`server.mjs` = lecteur de fichiers sans heartbeat). | Un MCP mort est indiscernable d'un MCP sain à tous les niveaux. Pannes visibles seulement par absence d'effet (commandes jamais traitées), diagnostic a posteriori et à la main. |
| d2 | **Logs/erreurs du serveur MCP capturés nulle part comme tels** *(partiel)* | high | `server.mjs:4,387` écrit sur stderr uniquement ; aucun fichier de log MCP dédié, aucun parsing du marqueur `[oryon-mcp] connecte`, aucun canal IPC. Seule surface programmable = `get_terminal_output` (`server.mjs:80-97`) = scrollback ANSI ~20KB (`mcp-export.ts:24,72`). **Partiel** : que la stderr du serveur atterrisse dans ce scrollback dépend du câblage stdio interne du CLI claude (hors repo) — au mieux noyée, au pire perdue. | Diagnostiquer « pourquoi mon MCP ne répond pas » = lire à l'œil le TUI d'un worker et espérer que l'erreur (`ERR_MODULE_NOT_FOUND`…) soit encore dans la fenêtre. Pas d'historique fiable, pas de surface programmable. |
| d3 | **Aucun chemin de relance/réparation exposable à l'orchestrateur** | high | La surface d'outils (`server.mjs:72-383`) n'a aucune primitive kill/restart. Le bus de commandes (`mcp-export.ts:84-99`) ne dispatch aucun verbe kill/respawn. `broadcast_command` ne fait que coller une ligne dans un terminal **vivant** (`router.ts:495-511`). Kill+recreate (`pty-manager.ts:66-68,125-136`) exposés uniquement via IPC renderer (`terminals.ipc.ts:28,47`), jamais en MCP. Watchdog : « aucun kill automatique » (`router.ts:434`). | Face à un MCP mort, l'orchestrateur est sans recours autonome (ni relance serveur, ni respawn worker). Recovery 100 % humain → casse la boucle d'orchestration autonome (cohérent avec le zombie/busy observé en prod). |
| d4 | **HTTP : aucune validation d'URL, aucun test, aucun timeout/auth** | medium | `addConnector` persiste l'URL telle quelle ; génération = `{type:'http', url}` seul (`settings.ipc.ts:104`) ; `submitConnector` ne ping pas (`SettingsModal.tsx:102`). | Endpoint injoignable/mal typé/exigeant un header accepté sans broncher, échoue au boot de chaque agent. |
| d5 | **`.mcp.json` racine porte le pattern PROD historiquement cassé** | medium | `.mcp.json:4-5` `command:'node'` + chemin absolu — exactement le pattern décrit comme cause de « oryon · failed » (`before-pack.cjs`, `settings.ipc.ts:87`). Exclu du build (`electron-builder.yml:36`) donc inoffensif en prod. | Sur une machine sans node global ou hors du repo, ce serveur échoue au boot. Sert d'exemple → invite à reproduire le pattern fragile. |

### (e) Onboarding / wizard

| # | Lacune | Sév. | Preuve | Impact |
|---|--------|------|--------|--------|
| e1 | **Aucun catalogue de serveurs connus** | high | Champs libres sans présélection (`SettingsModal.tsx:387-434`) ; aucune table/fetch de catalogue. | Barrière à l'entrée : seuls les utilisateurs ayant déjà la doc d'un serveur peuvent l'ajouter. |
| e2 | **Impossible de saisir/stocker secrets/env** | high | (= b4, vu côté onboarding) — github (`GITHUB_PERSONAL_ACCESS_TOKEN`), brave-search (`BRAVE_API_KEY`) inutilisables. | Parité requise : champ secret + stockage + écriture du bloc env. |
| e3 | **HTTP distant sans auth (headers/OAuth)** | high | `{type:'http', url}` seul (`:104`), pas de champ headers (`:429-434`). Le CLI supporte `--header` + OAuth via `/mcp`. | Notion, Sentry, Slack, GitHub HTTP échouent silencieusement. |
| e4 | **Aucun test de connexion avant enregistrement** | high | `submitConnector` insère direct (`:102-119`) ; aucun handler `testConnector` (`settings.ipc.ts:112-123`). | Mauvaise command/PAT/URL détectés seulement au runtime agent. |
| e5 | **Aucun import depuis config existante** | medium | Aucune fonction d'import dans `settings.ipc.ts`. Le CLI offre `add-from-claude-desktop` ; le repo a déjà un `.mcp.json` au format pivot. | Re-saisie manuelle complète. |
| e6 | **Parsing d'args fragile (split espaces) + transport `sse` manquant** | medium | `fArgs.split(/\s+/)` (`SettingsModal.tsx:110`) casse un chemin Windows à espace ou un DSN ; `McpTransport='stdio'|'http'` (`types.ts:128`), pas de `sse`. | filesystem sur chemin à espace, DSN postgres mal découpés. |

---

## 3. Design proposé

### 3a. Wizard d'installation intelligent (parité Claude Desktop)

**Principe :** remplacer le formulaire « expert » par un parcours en 3 modes (Catalogue / Manuel / Import), avec saisie guidée des secrets, test de connexion, et écriture de `env`/`headers`. Coût $0 préservé : le wizard ne fait qu'écrire des entrées `mcpServers` dans le fichier injecté au CLI subscription — aucun appel Claude, aucun SDK Anthropic.

#### Étapes UI

1. **Choix de la source** (3 onglets) :
   - **Catalogue** : grille des serveurs connus (cf. ci-dessous). Sélection → champs `command/args` pré-remplis, et **champs de secrets typés** générés depuis le manifeste (placeholder, `required`, `sensitive`).
   - **Manuel** : le formulaire actuel, enrichi de `env` (paires clé/valeur) et `headers`.
   - **Import** : liste les serveurs détectés dans `~/.claude.json` (`projects[<path>].mcpServers` + user-scope), le `.mcp.json` du repo, et `claude_desktop_config.json` (emplacement standard). Cases à cocher + dédup par nom (suffixe numérique en collision).
2. **Configuration des secrets** : pour chaque variable `sensitive`, un champ masqué. Affiche d'où vient le secret (env var name) et son `required`.
3. **Test de connexion** (bouton « Tester » avant « Enregistrer ») : handshake MCP réel → affiche `OK · N outils` ou l'erreur. **Bloquant optionnel** (avertissement si échec, pas blocage dur, pour les cas offline).
4. **Scope** (app/projet) + **transport** (stdio/http, +sse).

#### Catalogue (~6 serveurs, `command/args/env` pré-remplis)

| Serveur | command/args | env (sensitive) |
|---------|-------------|-----------------|
| filesystem | `npx -y @modelcontextprotocol/server-filesystem <dir…>` | — (dossiers = args, type `directory multiple`) |
| github (HTTP recommandé) | transport http `https://api.githubcopilot.com/mcp/` | header `Authorization: Bearer <PAT>` |
| postgres | `npx -y @bytebase/dbhub --dsn "<DSN>"` | DSN (sensitive, dans un arg, pas split) |
| brave-search | `npx -y @modelcontextprotocol/server-brave-search` | `BRAVE_API_KEY` |
| sentry (HTTP/OAuth) | http `https://mcp.sentry.dev/mcp` | OAuth via `/mcp` |
| notion (HTTP/OAuth) | http `https://mcp.notion.com/mcp` | OAuth via `/mcp` |

Le catalogue est **statique** au minimum (constante backend). Évolution possible : fetch du registry officiel (noms reverse-DNS, versions).

#### Changements backend

- **DB (migration 011)** : `ALTER TABLE mcp_connectors ADD COLUMN env TEXT` (JSON `{KEY:value}`, **chiffré**) + `ADD COLUMN headers TEXT` (JSON, chiffré) + optionnel `ADD COLUMN catalog_id TEXT`. Append-only respecté (`migrations/index.ts:21-24`).
- **Stockage des secrets** : **Electron `safeStorage`** (Windows Credential Manager / DPAPI). Chiffrer `env`/`headers` à l'INSERT, déchiffrer **seulement** dans `buildProjectMcpConfigForPath` juste avant l'écriture du JSON. Le `oryon-mcp-*.json` reste en clair (le CLI doit le lire) **mais** écrit en `mode:0o600`. Alternative légère si `safeStorage` indisponible : stocker `${VAR}` et compter sur l'expansion native du CLI (`command/args/env/url/headers` supportent `${VAR}` / `${VAR:-default}`) — l'utilisateur exporte la var hors de l'app.
- **Génération** (`settings.ipc.ts:104-105`) : émettre `env` pour stdio et `headers` pour http quand présents.
- **IPC + bridge** : ajouter `settings:testConnector` (handshake MCP : spawn court du serveur stdio via `process.execPath` + `ELECTRON_RUN_AS_NODE` / fetch http `initialize`+`tools/list`, timeout court, kill) et `settings:importConnectors` (parse des configs existantes). Exposer dans `preload/index.ts` + `types.ts`.
- **Types** : `McpConnectorInput` += `env?: Record<string,string>`, `headers?: Record<string,string>`, `catalogId?: string` ; `McpTransport` += `'sse'`.

#### OAuth (http/remote)

Déléguer au CLI : enregistrer le serveur http puis laisser l'utilisateur lancer le flux navigateur via `/mcp` dans la session. Les tokens vont dans le keychain OS du CLI, **jamais** dans la config Oryon. Aucun appel Claude payant.

**Sources web** (vérifiées dans la cartographie) :
- Claude Code MCP (`claude mcp add`/`add-json`/`add-from-claude-desktop`, `--env`/`--header`, OAuth `/mcp`, expansion `${VAR}`, schéma `.mcp.json`) : `https://code.claude.com/docs/en/mcp`
- Desktop extensions (manifest `user_config`, `sensitive`/`multiple`, keychain, Node bundlé) : `https://www.anthropic.com/engineering/desktop-extensions`
- Spec MCPB + MANIFEST : `https://github.com/modelcontextprotocol/mcpb`
- Registry officiel : `https://registry.modelcontextprotocol.io/` ; Directory curé : `https://claude.ai/directory`
- Serveurs de référence : `https://github.com/modelcontextprotocol/servers`

### 3b. Gestion & debug des connexions

- **Statut par connecteur (UI)** : ajouter une pastille `connecté / échec / non testé` dans la ligne (`SettingsModal.tsx:344-383`). Alimentée par le résultat de `settings:testConnector` (état non persisté, ré-évalué au test) **et** par un retour de boot agent (voir ci-dessous).
- **Capture des logs MCP** : aujourd'hui les logs `oryon-mcp` sont au mieux noyés dans le scrollback (d2). Proposer un **fichier de log dédié** : faire écrire `server.mjs` dans `ORYON_MCP_STATE/mcp-<terminalId>.log` (en plus de stderr), et exposer un outil `get_mcp_log` côté serveur + un panneau UI. Parser le marqueur `[oryon-mcp] connecte` (`server.mjs:387`) pour dériver un statut « connecté » fiable.
- **Donner à l'orchestrateur les moyens de diagnostiquer/réparer** (lacune d3, la plus structurante) :
  - **`mcp_health({terminal})`** (outil MCP, orchestrateur-only) : lit le log MCP dédié + le marqueur de connexion → renvoie `connected/failed/unknown` + dernière erreur.
  - **`restart_agent({terminal})`** : nouveau **verbe du bus de commandes** (`mcp-export.ts:84-99`) que le main traduit en kill+recreate (`pty-manager.ts`) du PTY ciblé — la **seule** façon de relancer un MCP mort (il est enfant du `claude`). Gater orchestrateur-only. C'est le chaînon manquant pour fermer la boucle autonome.
  - **`--strict-mcp-config`** au spawn (cf. b2/c1) pour rendre l'état MCP déterministe avant tout diagnostic.

### 3c. Accessibilité & usage par les agents

- **Clarifier qui voit quoi** : aujourd'hui orchestrateur et workers voient **exactement les mêmes serveurs** (même fichier de config) ; seule diffère la lecture mémoire (role-gate `server.mjs:33-36`). À documenter explicitement dans l'UI (un libellé « ces connecteurs sont injectés à TOUS les agents du projet »).
- **Gate symétrique sur l'orchestration** (c2) : passer `assign_task`/`approve_task`/`broadcast_command` (`server.mjs:308,329,366`) derrière le même `readMemoryTool`-like (orchestrateur-only). Ferme le trou « worker qui s'orchestre » par le serveur, pas seulement par le prompt.
- **Informer l'agent QUAND se servir de chaque MCP** :
  - **Prompt worker** (`roles.ts:24-32`) : nommer `claim_files` et `report_task` comme **outils MCP**, dire **quand** (claim avant d'éditer des fichiers partagés ; report à la fin). Aligne la couverture worker sur l'orchestrateur (`roles.ts:9-16`).
  - **Descriptions d'outils** : les serveurs tiers ajoutés via catalogue devraient embarquer une description claire (déjà le cas pour les outils oryon, ex. `server.mjs:74`). Le catalogue peut porter un court « à utiliser pour… » par serveur.

---

## 4. Plan d'implémentation par lots

> **CONTRAT PARTAGÉ À GELER EN PREMIER** (Lot 0, séquentiel, bloque tout le reste). Tout le parallélisme en dépend.

### Lot 0 — Contrat (types + bridge + canaux IPC + migration)
- **Objectif** : figer la surface partagée pour que les lots suivants soient disjoints.
- **In-scope** : `src/shared/types.ts` (`McpConnectorInput`+=`env/headers/catalogId`, `McpTransport`+=`sse`, `McpConnector`+=`env/headers`, signatures `testConnector`/`importConnectors`/`mcp_health`/`restart_agent`), `src/preload/index.ts` (déclarer les nouvelles méthodes bridge), `src/main/db/migrations/011_mcp_secrets.ts` (nouvelle migration `ALTER TABLE`).
- **Done** : `pnpm typecheck` vert ; la migration 011 s'applique sur une DB existante sans perte ; les nouveaux types compilent côté main+renderer.

### Lot A — Sécurité câblage (chirurgical, indépendant)
- **Objectif** : neutraliser b2/c1 et b3 (clair).
- **In-scope** : `src/main/ipc/terminals.ipc.ts` (ajouter `--strict-mcp-config` à la ligne 23, aligné sur `cli.ts:64`) ; `.mcp.json` (dé-tracker ou neutraliser) ; `settings.ipc.ts:108` (`writeFileSync` → `writeFileAtomic` + `mode:0o600`).
- **Done** : un agent spawné ne charge QUE le fichier `--mcp-config` (vérifiable : `claude mcp list` dans un worker ne montre qu'un seul `oryon`) ; `.mcp.json` absent des worktrees ; fichier de config écrit atomiquement.
- **Couplage** : touche `terminals.ipc.ts` et `settings.ipc.ts` — **séquencer après Lot C** si ce dernier touche les mêmes fichiers (sinon paralléliser sur des hunks disjoints).

### Lot B — Génération de config : env/headers + régénération
- **Objectif** : b1 + b4 (émission) + déchiffrement secrets.
- **In-scope** : `src/main/ipc/settings.ipc.ts` (`addConnector` persiste `env/headers` chiffrés via `safeStorage` ; `buildProjectMcpConfigForPath` émet `env`/`headers` déchiffrés `:104-105` ; nouveau `regenerateAllConfigs()` appelé sur add/toggle/delete).
- **Done** : un connecteur stdio avec `env` produit un bloc `env` dans `oryon-mcp-*.json` ; un toggle régénère le(s) fichier(s) sans spawn ; secrets chiffrés en DB (inspection SQLite ne montre pas le token en clair).
- **Couplage** : **dépend de Lot 0** (migration + types). Partage `settings.ipc.ts` avec Lot A et C → **séquencer** ou découper par fonction.

### Lot C — Test de connexion + health-check + relance (debug)
- **Objectif** : d1/d2/d3/d4 + 3b.
- **In-scope** : `src/main/ipc/settings.ipc.ts` (handler `settings:testConnector`) ; `src/mcp/server.mjs` (log dédié `mcp-<id>.log`, outils `mcp_health`/`get_mcp_log` orchestrateur-only) ; `src/main/services/mcp-export.ts` (verbe `restart_agent` dans le bus) ; `src/main/services/orchestrator/router.ts` (traduire `restart_agent` en kill+recreate).
- **Done** : `testConnector` renvoie `OK · N outils` ou erreur ; un MCP mort est diagnosticable par l'orchestrateur via `mcp_health` ; `restart_agent` relance effectivement un worker.
- **Couplage** : partage `settings.ipc.ts` (Lot B) et `server.mjs` (Lot E). Séquencer après Lot 0 ; coordonner les hunks `settings.ipc.ts` avec B.

### Lot D — Wizard UI + catalogue + import
- **Objectif** : 3a (UI), e1/e5/e6 + a1/a2/a3/a4/a5/a6.
- **In-scope** : `src/renderer/src/components/Settings/SettingsModal.tsx` (parcours 3 modes, champs env/headers, pastille statut, bouton tester, édition inline, confirm suppression, garde `JSON.parse`, badge localisé) ; nouveau `src/main/services/mcp-catalog.ts` (constante catalogue) ; `src/main/ipc/settings.ipc.ts` (handler `settings:importConnectors` — parse `~/.claude.json` + `claude_desktop_config.json` + `.mcp.json`).
- **Done** : sélection catalogue pré-remplit les champs ; un secret saisi est masqué ; import liste les serveurs détectés ; édition d'un connecteur sans delete/recreate ; `pnpm typecheck` vert.
- **Couplage** : `SettingsModal.tsx` est **exclusivement** à ce lot (gros fichier, mono-owner). Partage `settings.ipc.ts` (import) avec B/C → séquencer le handler `importConnectors` après B.

### Lot E — Gate orchestration + prompts (accessibilité agents)
- **Objectif** : c2 + c3 + 3c.
- **In-scope** : `src/mcp/server.mjs` (gater `assign_task`/`approve_task`/`broadcast_command` orchestrateur-only, `:308/329/366`) ; `src/main/services/orchestrator/roles.ts` (prompt worker : nommer `claim_files`/`report_task` comme outils MCP + quand les utiliser, `:24-32`).
- **Done** : un worker (rôle ≠ orchestrator) n'a PAS `assign_task`/`approve_task`/`broadcast_command` exposés (vérifiable : `claude mcp` dans un worker ne les liste pas) ; le prompt worker mentionne `claim_files`.
- **Couplage** : partage `server.mjs` avec Lot C → séquencer (C ajoute des outils, E gate d'autres) ou découper par bloc d'outils.

---

### Séquencement recommandé
```
Lot 0  (contrat, bloquant)
  ├─► Lot A  (sécurité câblage — peut partir tôt, hunks disjoints)
  ├─► Lot B  (génération env/headers)
  │      └─► Lot C  (test/health/relance — partage settings.ipc.ts & server.mjs)
  │             └─► Lot E  (gate + prompts — partage server.mjs avec C)
  └─► Lot D  (wizard UI — SettingsModal mono-owner ; handler import après B)
```
**Parallélisables d'emblée après Lot 0** : A, B, D (fichiers majoritairement disjoints : `terminals.ipc.ts`+`.mcp.json` / `settings.ipc.ts` génération / `SettingsModal.tsx`). **Points de friction `settings.ipc.ts`** (A, B, C, D-import) et **`server.mjs`** (C, E) : séquencer ou découper par fonction pour éviter les conflits de merge.

**Contrainte $0** respectée partout : tout passe par l'écriture de `mcpServers` injectée au CLI subscription (`terminals.ipc.ts:23`) ; `testConnector` spawn le serveur MCP localement (pas d'appel Claude) ; OAuth délégué au `/mcp` du CLI ; aucun SDK Anthropic.

### Fichiers de référence (absolus)
- `C:\Users\Kolyxe\Desktop\ide\src\main\ipc\settings.ipc.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\main\ipc\terminals.ipc.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\main\db\migrations\004_settings.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\shared\types.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\preload\index.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\mcp\server.mjs`
- `C:\Users\Kolyxe\Desktop\ide\src\main\services\orchestrator\roles.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\main\services\orchestrator\router.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\main\services\orchestrator\cli.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\main\services\mcp-export.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\main\services\pty-manager.ts`
- `C:\Users\Kolyxe\Desktop\ide\src\renderer\src\components\Settings\SettingsModal.tsx`
- `C:\Users\Kolyxe\Desktop\ide\.mcp.json`