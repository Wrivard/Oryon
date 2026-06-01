import type { McpCatalogEntry } from '../../shared/types'

// Catalogue de serveurs MCP connus pour le wizard « plug-and-play » (mode Catalogue de ConnectorsSection).
// Chaque entrée pré-remplit command/args/url ; les `envFields`/`headerFields` deviennent des champs de secret
// guidés (clé fixe, valeur saisie par l'utilisateur, mappée en env stdio ou en en-tête http/sse à l'install).
// Statique et hors-ligne (aucun fetch réseau, aucun appel Claude — garde coût $0). Évoluera vers le registry
// officiel (https://registry.modelcontextprotocol.io) si besoin.
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    description: 'Accès lecture/écriture à des dossiers locaux. Ajoute tes dossiers à la fin des arguments.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    docUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github',
    name: 'github',
    description: 'Dépôts, issues, PRs GitHub (serveur HTTP officiel). Requiert un Personal Access Token.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headerFields: [{ key: 'Authorization', label: 'Authorization (ex. « Bearer ghp_… »)', required: true }],
    docUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    description: 'Recherche web via l\'API Brave Search. Requiert une clé API Brave.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envFields: [{ key: 'BRAVE_API_KEY', label: 'BRAVE_API_KEY', required: true }],
    docUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    id: 'puppeteer',
    name: 'puppeteer',
    description: 'Automatisation de navigateur (navigation, captures, scraping) via Puppeteer. Aucun secret.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    docUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  {
    id: 'sentry',
    name: 'sentry',
    description: 'Issues & erreurs Sentry (serveur HTTP officiel). Auth via OAuth : lance « /mcp » dans la session après l\'ajout.',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    docUrl: 'https://docs.sentry.io/product/sentry-mcp/',
  },
  {
    id: 'notion',
    name: 'notion',
    description: 'Pages & bases Notion (serveur HTTP officiel). Auth via OAuth : lance « /mcp » dans la session après l\'ajout.',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    docUrl: 'https://developers.notion.com/docs/mcp',
  },
]
