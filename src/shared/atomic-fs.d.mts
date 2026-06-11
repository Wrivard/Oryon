// Types pour atomic-fs.mjs (écritures atomiques Windows-safe partagées). L'implémentation est en JS pur (.mjs)
// pour être importable par le serveur MCP standalone ; ce .d.mts donne les types côté TypeScript.
export declare function renameRetry(from: string, to: string): Promise<void>
export declare function writeAtomic(path: string, content: string): Promise<void>
