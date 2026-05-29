# 06 — Intégration MCP

Objectif : rester dans le même écosystème que BridgeMind. On réplique le **modèle BridgeMCP** (projets / tasks / agents + lifecycle) et on peut, au choix : (A) brancher le vrai serveur BridgeMCP hébergé, et/ou (B) exposer notre propre serveur MCP local.

## 1. Rappel du modèle BridgeMCP (référence)

- **Transport** : Streamable HTTP (préféré) + SSE (legacy). Endpoint `POST /mcp`.
- **Auth** : header `Authorization: Bearer <api_key>` (ou `?apiKey=`).
- **Serveur hébergé** : `https://mcp.bridgemind.ai/mcp`.
- **Outils** exposés :
  - Projets : `list_projects`, `create_project`.
  - Tasks : `list_tasks`, `get_task`, `create_task`, `update_task`.
  - Agents : `list_agents`, `get_agent`, `create_agent`, `update_agent`, `delete_agent`.
- **Lifecycle task** : `todo → in-progress → in-review → complete` (+ `cancelled`).
- **taskKnowledge** : jusqu'à 50 000 caractères de contexte attaché à une task.

> Notre schéma SQLite (`01`) reprend déjà exactement ces entités et ce lifecycle → compatibilité native.

## 2. Deux modes d'intégration

### Mode A — Consommer BridgeMCP hébergé (si tu as un compte BridgeMind)
- Brancher Claude Code (dans chaque terminal) sur le serveur MCP BridgeMind via `.mcp.json` à la racine du projet :

```json
{
  "mcpServers": {
    "bridgemind": {
      "type": "http",
      "url": "https://mcp.bridgemind.ai/mcp",
      "headers": { "Authorization": "Bearer ${BRIDGEMIND_API_KEY}" }
    }
  }
}
```
- Avantage : les tasks créées dans BridgeForge apparaissent dans leur dashboard et inversement.
- Inconvénient : dépendance à leur service + compte payant.

### Mode B — Notre serveur MCP local (recommandé pour l'autonomie)
- Exposer un serveur MCP local (stdio ou HTTP) avec `@modelcontextprotocol/sdk` qui mappe nos tables SQLite.
- Les terminaux Claude Code s'y connectent → les agents lisent/écrivent **nos** projets/tasks/agents.
- Les mêmes noms d'outils que BridgeMCP (drop-in compatible) : `list_projects`, `create_task`, `update_task`, etc.

```ts
// src/main/services/mcp-server.ts (squelette)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// + accès à la DB SQLite

const server = new McpServer({ name: 'bridgeforge', version: '0.1.0' });

server.tool('list_projects', {}, async () => ({ content: [{ type:'text', text: JSON.stringify(db.listProjects()) }] }));
server.tool('create_task', { projectId:'string', instructions:'string', taskKnowledge:'string?', status:'string?' },
  async (args) => { const t = db.createTask(args); return { content:[{type:'text',text:JSON.stringify(t)}] }; });
server.tool('update_task', { taskId:'string', status:'string?', instructions:'string?', taskKnowledge:'string?' },
  async (args) => { const t = db.updateTask(args); return { content:[{type:'text',text:JSON.stringify(t)}] }; });
// … list_tasks, get_task, list_agents, create_agent, update_agent, delete_agent

const transport = new StdioServerTransport();
await server.connect(transport);
```

- Générer dynamiquement un `.mcp.json` dans chaque projet pointant sur ce serveur local (commande de lancement + chemin), pour que les terminaux Claude Code l'utilisent automatiquement.

## 3. Pourquoi c'est central pour ton orchestrateur

L'orchestrateur (`04`) et le MCP partagent la **même table `tasks`**. Donc :
- Quand le coordinator décompose un but → il crée des tasks (via MCP ou directement en DB).
- Chaque agent Claude Code peut, **de lui-même**, appeler `list_tasks` / `update_task` pour piocher et mettre à jour son travail (vrai workflow agentique BridgeMind).
- Le Kanban (panneau Tasks) lit la même source.

→ Un seul modèle de tâches, trois consommateurs (orchestrateur, agents via MCP, UI Kanban). C'est ce qui fait que « tout fonctionne bien ensemble ».

## 4. Auth & clés
- `BRIDGEMIND_API_KEY` (mode A) et `ANTHROPIC_API_KEY` (decomposer) stockées dans le main (keychain via `keytar` ou variables d'env), jamais dans le renderer.

## 5. Critère de "done"
- [ ] Mode B : un agent Claude Code dans un terminal peut appeler `list_tasks` et voir nos tasks.
- [ ] `update_task` depuis un agent met à jour le Kanban en temps réel.
- [ ] (Option) Mode A : connexion au serveur hébergé fonctionne avec une clé valide.
