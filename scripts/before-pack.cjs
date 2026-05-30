// electron-builder beforePack hook — bundle le serveur MCP Oryon en un fichier AUTONOME avant le packaging.
//
// POURQUOI : le serveur MCP (src/mcp/server.mjs) tourne dans un process node SÉPARÉ, hors de l'asar. Un `node`
// standalone (ou electron-as-node) lancé sur ce fichier en prod ne peut PAS résoudre @modelcontextprotocol/sdk
// ni zod : ces paquets vivent dans app.asar, invisible à la résolution node_modules ordinaire → l'ancien
// `node resources/mcp/server.mjs` plantait sur ERR_MODULE_NOT_FOUND (« oryon · failed »). On INLINE donc tout
// (SDK + zod + memory-core) en un seul .mjs autonome, copié ensuite en ressources (cf. electron-builder.yml
// extraResources `from: out/mcp`).
const { build } = require('esbuild')
const { join } = require('path')

module.exports = async function beforePack(context) {
  const root = context.appDir || process.cwd()
  await build({
    entryPoints: [join(root, 'src', 'mcp', 'server.mjs')],
    outfile: join(root, 'out', 'mcp', 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm', // server.mjs utilise du top-level await → ESM obligatoire
    target: 'node18',
    // Le bundle ESM peut embarquer des dépendances CJS (le SDK) qui appellent require() → on fournit un
    // require local dérivé de import.meta.url (sinon ReferenceError: require is not defined en ESM).
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  })
  // eslint-disable-next-line no-console
  console.log('[before-pack] Oryon MCP bundlé (autonome) → out/mcp/server.mjs')
}
