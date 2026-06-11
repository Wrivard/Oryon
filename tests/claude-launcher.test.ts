// Caractérisation des invariants de claude-launcher (le quoting PowerShell a déjà causé le bug du « prompt
// fantôme » — corruption d'argv). shellQuote et appendSystemPromptFlag sont PRIVÉS → on les teste via l'API
// publique (buildClaudeCommand / enforceAgentSpawn), qui sont leurs seuls appelants.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Le module importe `{ app } from 'electron'` au top-level → mock obligatoire. `state.userData` est mutable :
// les tests du chemin nominal le pointent sur un vrai tmpdir (écrit le fichier de prompt) ; le test du repli
// inline le pointe sur un dossier INEXISTANT pour forcer le catch I/O de appendSystemPromptFlag.
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))

import { buildClaudeCommand, enforceAgentSpawn, AGENT_MODEL } from '../src/main/services/claude-launcher'

const FILE_FLAG = /--append-system-prompt-file '([^']+)'/

let tmp: string
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'oryon-launcher-test-'))
})
beforeEach(() => {
  state.userData = tmp // chemin nominal par défaut ; un test peut le réécrire
})

describe('shellQuote (via le repli inline de appendSystemPromptFlag)', () => {
  it("double les apostrophes internes : a'b → 'a''b'", () => {
    // userData → dossier inexistant : writeFileSync throw ENOENT → catch → repli `--append-system-prompt '<quoté>'`
    state.userData = join(tmp, 'pas', 'un', 'dossier')
    const cmd = buildClaudeCommand({ appendSystemPrompt: "a'b" })
    expect(cmd).toContain("--append-system-prompt 'a''b'")
    expect(cmd).not.toContain('--append-system-prompt-file')
  })
})

describe('appendSystemPromptFlag (via buildClaudeCommand, chemin nominal)', () => {
  // Prompt piégé : guillemets doubles, substitution, backticks, accents, multiligne — exactement ce qui cassait
  // l'argv natif quand le CONTENU était inliné. Désormais seul le CHEMIN (sans ") est sur la ligne de commande.
  const trapped = [
    'des "guillemets doubles" qui cassaient l\'argv natif de claude.exe',
    'une substitution $(whoami) et des backticks `ls -la`',
    'accents FR-QC : déjà vu, çœ, élève — garanti',
    'et une fin multiligne',
  ].join('\n')

  it('écrit le prompt OCTET-IDENTIQUE dans un fichier ; le flag est -file et le chemin ne porte AUCUN guillemet', () => {
    const cmd = buildClaudeCommand({ appendSystemPrompt: trapped })
    const m = FILE_FLAG.exec(cmd)
    expect(m).not.toBeNull()
    const file = m![1]
    expect(file).not.toContain('"') // racine du fantôme supprimée : pas de " dans l'argv
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(trapped) // byte-pour-byte
  })

  it('même prompt deux fois → même fichier (hash de contenu stable, dédup)', () => {
    const f1 = FILE_FLAG.exec(buildClaudeCommand({ appendSystemPrompt: trapped }))![1]
    const f2 = FILE_FLAG.exec(buildClaudeCommand({ appendSystemPrompt: trapped }))![1]
    expect(f2).toBe(f1)
  })
})

describe('enforceAgentSpawn (clamp universel au spawn)', () => {
  it('claude nu → --model fable + --effort max + --append-system-prompt-file', () => {
    const out = enforceAgentSpawn('claude')
    expect(AGENT_MODEL).toBe('fable')
    expect(out).toContain(`--model ${AGENT_MODEL}`)
    expect(out).toContain('--effort max')
    expect(out).toContain('--append-system-prompt-file')
  })

  it('--model haiku|sonnet|opus réécrit en --model fable', () => {
    for (const weak of ['haiku', 'sonnet', 'opus']) {
      const out = enforceAgentSpawn(`claude --model ${weak}`)
      expect(out).toContain('--model fable')
      expect(out).not.toMatch(new RegExp(`--model ${weak}\\b`))
    }
  })

  it('--model fable laissé tel quel (un seul --model, pas de doublon)', () => {
    const out = enforceAgentSpawn('claude --model fable --effort max --append-system-prompt-file x')
    expect(out.match(/--model fable/g)!.length).toBe(1)
  })

  it('commande non-claude (npm run dev) STRICTEMENT inchangée', () => {
    expect(enforceAgentSpawn('npm run dev')).toBe('npm run dev')
  })

  it('idempotent : ré-appliquer ne change rien', () => {
    const once = enforceAgentSpawn('claude')
    expect(enforceAgentSpawn(once)).toBe(once)
  })
})
