// Construit la commande Claude Code CLI injectée dans un PTY + prépare la config claude pour que
// les agents démarrent SANS wizard et branchés sur l'abonnement subscription.
// Flags validés sur claude v2.1.156 (`claude --help`).
//
// ⚠️ COÛT : ne JAMAIS ajouter --bare → ce flag force l'auth ANTHROPIC_API_KEY (payant).
// Le mode interactif par défaut lit l'OAuth subscription (~/.claude/.credentials.json).
// Le pty-manager retire aussi ANTHROPIC_API_KEY de l'env par sécurité.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { WORKER_TERMINAL_SYSTEM } from './orchestrator/roles'

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

// Modèle imposé à TOUS les agents (orchestrateur + workers). Subscription $0 → toujours le plus puissant.
// 'fable' = alias de Claude Fable 5 (classe Mythos, au-dessus d'Opus). Non-contournable (cf. enforceAgentSpawn
// + clamp au spawn — les autostarts déjà stockés en DB avec --model opus y sont réécrits). Alias validé CLI.
export const AGENT_MODEL = 'fable'

/** Quote PowerShell-safe (double les apostrophes internes). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Flag --append-system-prompt-file : écrit le prompt (statique) dans un fichier userData (nommé par hash du
 * contenu → stable + dédupliqué) et passe son CHEMIN à claude. CRUCIAL — on ne colle JAMAIS le CONTENU du prompt
 * sur la ligne de commande.
 *
 * ROOT CAUSE du « prompt fantôme » (« npm »/« run » auto-soumis) : l'ANCIENNE forme
 * `--append-system-prompt "$(Get-Content -Raw '...')"` inlinait le contenu du prompt. PowerShell le gardait en UN
 * seul argument, MAIS au lancement du NATIF claude.exe il re-sérialise les args en une chaîne de ligne de commande
 * SANS échapper les guillemets (") internes du prompt. Le C-runtime de claude.exe (CommandLineToArgvW) re-découpe
 * alors ce blob sur ces " : un fragment d'un exemple CITÉ dans le prompt (l'orchestrateur contient littéralement
 * `(e.g. "1) npm run typecheck green; …")`) devient un token POSITIONNEL orphelin, que claude prend pour son
 * `[prompt]` positionnel et SOUMET tout seul. D'où « npm » (orchestrateur) / « <tool> … » (workers) en 1er tour,
 * promptSource:"typed", parentUuid:null — SANS aucune écriture « npm » au PTY (c'est l'argv de claude, pas le
 * stdin ; c'est pourquoi aucun flush console n'y pouvait rien). Passer le CHEMIN (qui ne contient pas de ")
 * supprime la cause à la racine. Bonus : garde la ligne courte (≈120 c) — le but initial du fichier (évite le
 * crash PSReadLine sur un argv multi-Ko, W3). $0 inchangé (aucune var d'auth touchée).
 */
function appendSystemPromptFlag(prompt: string): string {
  try {
    const hash = createHash('sha1').update(prompt).digest('hex').slice(0, 16)
    const file = join(app.getPath('userData'), `oryon-roleprompt-${hash}.txt`)
    if (!existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, prompt, 'utf8')
      renameSync(tmp, file)
    }
    // claude lit le fichier lui-même : le CONTENU ne transite jamais par l'argv. Seul le CHEMIN (sans guillemet
    // interne) est sur la ligne, single-quoté pour PowerShell → re-sérialisation native propre, aucune découpe.
    return `--append-system-prompt-file ${shellQuote(file)}`
  } catch {
    // Échec I/O (rare) : repli inline (au pire l'ancien comportement) ; le chemin nominal ci-dessus EST la correction.
    return `--append-system-prompt ${shellQuote(prompt)}`
  }
}

export function buildClaudeCommand(opts: ClaudeCommandOpts = {}): string {
  let cmd = `claude ${AUTONOMY_FLAG}`
  if (opts.model) cmd += ` --model ${opts.model}`
  if (opts.effort) cmd += ` --effort ${opts.effort}`
  if (opts.appendSystemPrompt) cmd += ` ${appendSystemPromptFlag(opts.appendSystemPrompt)}`
  if (opts.continueSession) cmd += ' --continue'
  return cmd
}

/**
 * Enforcement au SPAWN (chokepoint universel, cf. terminals.ipc) appliqué à tout agent claude :
 * 1) MODÈLE clampé sur le plus puissant — un `--model` plus faible (haiku|sonnet|opus) est réécrit en AGENT_MODEL,
 *    une commande sans `--model` le reçoit. Aucun réglage ne peut downgrader un agent (corrige F1).
 * 2) IDENTITÉ : un agent claude SANS `--append-system-prompt` est un WORKER → on lui injecte son rôle
 *    durable (WORKER_TERMINAL_SYSTEM). L'orchestrateur a déjà le sien, il est donc exclu (corrige F2/F3/F5/F6).
 * 3) EFFORT max par défaut. Idempotent : ré-appliquer ne change rien.
 */
export function enforceAgentSpawn(autostart: string): string {
  if (!/^claude(\s|$)/.test(autostart.trim())) return autostart // pas une commande claude → inchangé
  let cmd = autostart
  if (/--model\s+(haiku|sonnet|opus)\b/i.test(cmd)) cmd = cmd.replace(/--model\s+\S+/i, `--model ${AGENT_MODEL}`)
  else if (!/--model\b/.test(cmd)) cmd += ` --model ${AGENT_MODEL}`
  if (!/--effort\b/.test(cmd)) cmd += ' --effort max'
  if (!/--append-system-prompt\b/.test(cmd)) cmd += ` ${appendSystemPromptFlag(WORKER_TERMINAL_SYSTEM)}`
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
let claudeCfgSeq = 0

// Lecture résiliente de ~/.claude.json : plusieurs `claude` qui démarrent en parallèle écrivent ce même
// fichier et peuvent le corrompre (ex. « }} » en fin). On RÉPARE (tronque le bruit final jusqu'à un JSON
// valide), sinon on restaure le `.backup` que claude maintient. Évite (1) que claude refuse de démarrer
// sur un JSON invalide, (2) qu'Oryon ÉCRASE la config de l'utilisateur par un objet vide. `repaired` force
// la réécriture du fichier réparé même si le seeding ne change rien d'autre (= auto-guérison au spawn).
function readClaudeConfigResilient(p: string): { cfg: Record<string, unknown>; repaired: boolean } {
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch {
    return { cfg: {}, repaired: false } // pas de fichier → config neuve
  }
  try {
    return { cfg: JSON.parse(raw) as Record<string, unknown>, repaired: false }
  } catch {
    /* corrompu → réparation ci-dessous */
  }
  let cut = raw
  for (let i = 0; i < 8 && cut.length; i++) {
    try {
      return { cfg: JSON.parse(cut) as Record<string, unknown>, repaired: true }
    } catch (e) {
      const m = /position (\d+)/.exec((e as Error).message)
      if (m) cut = cut.slice(0, Number(m[1])).replace(/\s+$/, '')
      else break
    }
  }
  try {
    return { cfg: JSON.parse(readFileSync(`${p}.backup`, 'utf8')) as Record<string, unknown>, repaired: true }
  } catch {
    /* pas de backup exploitable */
  }
  return { cfg: {}, repaired: true } // dernier recours (rare)
}

export function ensureClaudeReady(projectPath: string): void {
  const p = configPath()
  const { cfg, repaired } = readClaudeConfigResilient(p)
  let changed = repaired // fichier réparé → toujours réécrit (auto-guérison)

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
    const tmp = `${p}.oryon-${process.pid}-${++claudeCfgSeq}.tmp`
    const serialized = JSON.stringify(cfg, null, 2)
    writeFileSync(tmp, serialized)
    renameSync(tmp, p)
    JSON.parse(readFileSync(p, 'utf8')) // vérifie qu'on n'a pas été clobberé en JSON invalide
  } catch (e) {
    console.error('[claude-config] seeding non appliqué (sera réessayé au prochain spawn) :', (e as Error).message)
  }
}
