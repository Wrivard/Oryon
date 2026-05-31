// Construit la commande Claude Code CLI injectée dans un PTY + prépare la config claude pour que
// les agents démarrent SANS wizard et branchés sur l'abonnement subscription.
// Flags validés sur claude v2.1.156 (`claude --help`).
//
// ⚠️ COÛT : ne JAMAIS ajouter --bare → ce flag force l'auth ANTHROPIC_API_KEY (payant).
// Le mode interactif par défaut lit l'OAuth subscription (~/.claude/.credentials.json).
// Le pty-manager retire aussi ANTHROPIC_API_KEY de l'env par sécurité.

import { readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface ClaudeCommandOpts {
  /** ex "opus", "sonnet". Omis = modèle par défaut de la session. */
  model?: string
  /** Niveau d'effort Claude pour la session (ex. "ultracode"). Flag --effort. */
  effort?: string
  /** Prompt système de rôle (builder/reviewer/...). Phase 3. */
  appendSystemPrompt?: string
  /** Reprend la conversation la plus récente du dossier. */
  continueSession?: boolean
}

// Mode autonome : l'agent agit sans demander la permission à chaque action (indispensable pour un
// swarm parallèle). Le warning "bypass" est pré-accepté via bypassPermissionsModeAccepted (cf. config).
const AUTONOMY_FLAG = '--permission-mode bypassPermissions'

/** Quote PowerShell-safe (double les apostrophes internes). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export function buildClaudeCommand(opts: ClaudeCommandOpts = {}): string {
  let cmd = `claude ${AUTONOMY_FLAG}`
  if (opts.model) cmd += ` --model ${opts.model}`
  if (opts.effort) cmd += ` --effort ${opts.effort}`
  if (opts.appendSystemPrompt) cmd += ` --append-system-prompt ${shellQuote(opts.appendSystemPrompt)}`
  if (opts.continueSession) cmd += ' --continue'
  return cmd
}

/** Normalise une commande autostart claude existante (DB) : garantit le flag d'autonomie. */
export function normalizeClaudeAutostart(autostart: string): string {
  const a = autostart.trim()
  if (!/^claude(\s|$)/.test(a)) return autostart // pas une commande claude → inchangé
  if (/--permission-mode\b/.test(a) || /--dangerously-skip-permissions\b/.test(a)) return a
  return `${a} ${AUTONOMY_FLAG}`
}

function configPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
  return dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json')
}

/**
 * Pré-arme la config claude pour que les agents démarrent SANS wizard, branchés sur l'abonnement.
 * Idempotent (n'écrit que si nécessaire) et atomique (temp + rename) pour ne pas corrompre le
 * fichier en cas d'écriture concurrente. Ne touche JAMAIS aux credentials (auth reste l'OAuth existant).
 */
export function ensureClaudeReady(projectPath: string): void {
  const p = configPath()
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    cfg = {} // pas de config encore → on en crée une minimale
  }
  let changed = false

  // Onboarding global (thème + "Select login method") — barrière one-time de la 1re session interactive.
  if (cfg.hasCompletedOnboarding !== true) { cfg.hasCompletedOnboarding = true; changed = true }
  if (typeof cfg.theme !== 'string' || !cfg.theme) { cfg.theme = 'dark'; changed = true }
  // Pré-accepte le warning du mode bypassPermissions (sinon claude bloque sur un dialogue de confirmation).
  if (cfg.bypassPermissionsModeAccepted !== true) { cfg.bypassPermissionsModeAccepted = true; changed = true }

  // Trust + onboarding PAR PROJET (claude stocke les chemins en séparateurs '/').
  const projects = (cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {}) as Record<
    string,
    Record<string, unknown>
  >
  const key = projectPath.replace(/\\/g, '/')
  const proj = projects[key] ?? {}
  if (proj.hasTrustDialogAccepted !== true) { proj.hasTrustDialogAccepted = true; changed = true }
  if (proj.hasCompletedProjectOnboarding !== true) { proj.hasCompletedProjectOnboarding = true; changed = true }
  if (typeof proj.projectOnboardingSeenCount !== 'number' || proj.projectOnboardingSeenCount < 1) {
    proj.projectOnboardingSeenCount = 1
    changed = true
  }
  projects[key] = proj
  cfg.projects = projects

  if (!changed) return
  // Best-effort : un échec d'écriture (fichier verrouillé par une autre instance claude, course
  // avec une routine…) ne doit JAMAIS casser le spawn du terminal. Écriture atomique (temp + rename)
  // pour ne pas laisser de fichier à moitié écrit, puis relecture de contrôle.
  try {
    const tmp = `${p}.oryon-${process.pid}.tmp`
    const serialized = JSON.stringify(cfg, null, 2)
    writeFileSync(tmp, serialized)
    renameSync(tmp, p)
    JSON.parse(readFileSync(p, 'utf8')) // vérifie qu'on n'a pas été clobberé en JSON invalide
  } catch (e) {
    console.error('[claude-config] seeding non appliqué (sera réessayé au prochain spawn) :', (e as Error).message)
  }
}
