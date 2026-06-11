// Types des commandes MCP→main (fichiers JSON sous mcp-state/commands/). SOURCE DE VÉRITÉ
// partagée : server.mjs les ÉMET (queueCommand), mcp-export.ts les TRAITE (processCommand).
// Tout NOUVEAU type doit être ajouté ICI + recevoir un handler dans processCommand —
// un type absent de cette liste est loggé en erreur côté main (jamais silencieux).
export const COMMAND_TYPES = Object.freeze([
  'mailbox', 'update-task-status', 'assign-task', 'report-task', 'approve-task',
  'broadcast-command', 'restart-agent', 'add-connector', 'browser-open',
  'browser-screenshot', 'docs-import', 'flush-archive', 'reset-orchestrator',
  'report-system-issue', 'resolve-system-issue',
])
