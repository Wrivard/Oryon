import { spawn } from 'child_process'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { existsSync, writeFileSync } from 'fs'

// Helpers PARTAGÉS pour tout appel `claude` CLI en mode SUBSCRIPTION ($0). Point unique du garde-fou
// coût : subscriptionEnv() supprime ANTHROPIC_API_KEY → OAuth ~/.claude/.credentials.json, jamais l'API
// payante. Utilisé par le décomposeur (orchestrateur) ET le module Voice (classifieur/formatting/command).

/** Résout le binaire claude (exécutable natif). Fallback PATH. */
export function resolveClaudeBin(): string {
  if (process.platform === 'win32') {
    const p = join(homedir(), '.local', 'bin', 'claude.exe')
    if (existsSync(p)) return p
  } else {
    const p = join(homedir(), '.local', 'bin', 'claude')
    if (existsSync(p)) return p
  }
  return 'claude'
}

/** Config MCP vide (avec --strict-mcp-config) → l'appel ne connecte AUCUN serveur MCP au boot. */
export function emptyMcpConfigPath(): string {
  const p = join(tmpdir(), 'oryon-empty-mcp.json')
  if (!existsSync(p)) writeFileSync(p, '{"mcpServers":{}}')
  return p
}

/** Env d'un appel claude : copie process.env SANS les vars d'auth Anthropic (API_KEY / AUTH_TOKEN / BASE_URL) → force l'OAuth subscription ($0). */
export function subscriptionEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_BASE_URL
  return env
}

/**
 * Appel one-shot `claude` CLI subscription ($0), isolé (cwd=tmpdir, --tools "", MCP vide). Renvoie le
 * texte modèle (champ `result` de l'enveloppe JSON). Ne REJETTE JAMAIS : tout échec → ''.
 * SEUL point de spawn claude pour le module Voice (classifieur d'apprentissage / formatting / command).
 * L'APPELANT doit vérifier le mode privacy AVANT d'appeler (aucun appel réseau en privacy).
 */
export function voiceCliOneShot(systemPrompt: string, userInput: string, opts?: { timeoutMs?: number }): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 90_000
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (r: string) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    try {
      const proc = spawn(
        resolveClaudeBin(),
        [
          '-p',
          '--model', 'haiku',
          '--effort', 'low',
          '--tools', '',
          '--strict-mcp-config', '--mcp-config', emptyMcpConfigPath(),
          '--disable-slash-commands',
          '--system-prompt', systemPrompt,
          '--output-format', 'json',
        ],
        { cwd: tmpdir(), env: subscriptionEnv() },
      )
      let out = ''
      timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        finish('')
      }, timeoutMs)
      proc.stdout.on('data', (d) => (out += d.toString()))
      proc.stderr.on('data', () => {})
      proc.on('error', () => finish(''))
      proc.on('close', () => {
        let text = out
        try {
          const env = JSON.parse(out)
          if (env && typeof env.result === 'string') text = env.result
        } catch {
          /* brut */
        }
        finish(text.trim())
      })
      // Écrire dans le stdin d'un claude déjà mort émet 'error' (EPIPE) sur le flux : sans listener, Node
      // relance l'erreur et peut tuer le main. On l'absorbe — l'échec est déjà géré par 'error'/'close'/timeout.
      proc.stdin.on('error', () => {})
      proc.stdin.write(userInput)
      proc.stdin.end()
    } catch {
      finish('')
    }
  })
}
