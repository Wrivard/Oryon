import { defineConfig } from 'vitest/config'

// Socle de tests headless (node) : caractérise les invariants critiques (quoting PowerShell de
// claude-launcher, sérialisation enqueue de system-feedback, round-trip enc:v1 des secrets). Les
// fichiers sous tests/ sont HORS des deux tsconfig (tsc ne les voit pas) → vitest les transpile lui-même.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,mjs}'],
  },
})
