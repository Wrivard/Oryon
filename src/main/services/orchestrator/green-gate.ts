// Green-gate : après un merge sur MAIN (et ADVISORY au report sur un worktree), vérifie que le projet PASSE
// encore sa vérification (typecheck / compile). Un merge peut être textuellement propre mais casser la
// compilation (export renommé, type modifié, champ retiré qu'un sibling utilise) → 8 merges verts isolément
// composent un MAIN cassé. $0 Claude : commande LOCALE, aucun appel modèle. Lancé DANS la chaîne sérialisée
// de merge-back (un seul à la fois) → aucune course.
//
// GÉNÉRIQUE (O1) — la commande de vérif est résolue dans cet ordre, pour gater N'IMPORTE QUEL projet (pas
// seulement Oryon/TS) :
//   1) Override projet : `<projet>/.oryon/verify.json` { "command": "..." } — autorité totale (npm test,
//      pytest -q, make check, n'importe quoi). C'est la commande du PROPRE projet de l'utilisateur.
//   2) TypeScript (tsconfig.node/web.json + binaire tsc présent) → tsc --noEmit (chemin Oryon, inchangé).
//   3) Script npm `typecheck` → `npm run typecheck`.
//   4) Rust (Cargo.toml) → `cargo check`.   5) Go (go.mod) → `go build ./...`.
//   sinon → no-op (merge accepté ; ajouter .oryon/verify.json pour gater un écosystème non couvert).
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const execFileP = promisify(execFile)
const execShell = promisify(exec) // commande-chaîne via shell (npm.cmd/cargo/go OK, cross-plateforme)

// Les tsconfig vérifiés par `pnpm typecheck` (chemin Oryon). Lancés un par un avec --noEmit.
const TSCONFIGS = ['tsconfig.node.json', 'tsconfig.web.json']
// Une vérif à froid peut être lente sur un gros projet ; au-delà → l'appelant DIFFÈRE (ne revert jamais sur timeout).
const VERIFY_TIMEOUT_MS = 300_000

export interface GreenResult {
  green: boolean
  /** true = aucune vérif détectée pour ce projet → ignorée (merge accepté). */
  skipped: boolean
  /** true = budget dépassé → l'appelant doit DIFFÉRER, pas revert. */
  timedOut: boolean
  log: string
}

// Entrée CLI de TypeScript DU PROJET vérifié. Lancée via le binaire Electron en mode ELECTRON_RUN_AS_NODE
// (= node pur) plutôt que le shim .bin/tsc.cmd : aucune dépendance au PATH, et Node refuse un .cmd via
// execFile sans shell (CVE-2024-27980). Robuste Windows + packagé.
function tscEntry(mainPath: string): string {
  return join(mainPath, 'node_modules', 'typescript', 'bin', 'tsc')
}

/** Override de commande de vérif d'un projet : <projet>/.oryon/verify.json { command: string }. null si absent/illisible. */
function verifyOverride(projectDir: string): string | null {
  try {
    const p = join(projectDir, '.oryon', 'verify.json')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8')) as { command?: unknown }
    const c = typeof j.command === 'string' ? j.command.trim() : ''
    return c || null
  } catch {
    return null
  }
}

/** Le projet a-t-il un script npm de ce nom ? */
function hasNpmScript(projectDir: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return typeof pkg.scripts?.[name] === 'string'
  } catch {
    return false
  }
}

type Plan = { kind: 'tsc' } | { kind: 'shell'; command: string } | { kind: 'skip'; reason: string }

/** Résout COMMENT vérifier ce projet (override → TS → npm typecheck → Rust → Go → skip). */
function resolveVerify(projectDir: string, tscRoot: string): Plan {
  const override = verifyOverride(projectDir)
  if (override) return { kind: 'shell', command: override }
  if (existsSync(tscEntry(tscRoot)) && TSCONFIGS.some((c) => existsSync(join(projectDir, c)))) return { kind: 'tsc' }
  if (hasNpmScript(projectDir, 'typecheck')) return { kind: 'shell', command: 'npm run typecheck' }
  if (existsSync(join(projectDir, 'Cargo.toml'))) return { kind: 'shell', command: 'cargo check' }
  if (existsSync(join(projectDir, 'go.mod'))) return { kind: 'shell', command: 'go build ./...' }
  return {
    kind: 'skip',
    reason: 'aucune vérif détectée (TS/npm typecheck/cargo/go) — ajoute .oryon/verify.json {"command":"..."} pour gater',
  }
}

/** Chemin tsc (Oryon) : tsc --noEmit sur chaque tsconfig présent, binaire TS de `tscRoot` (= MAIN). */
async function runTsc(projectDir: string, tscRoot: string): Promise<GreenResult> {
  const tsc = tscEntry(tscRoot)
  const present = TSCONFIGS.filter((c) => existsSync(join(projectDir, c)))
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  for (const cfg of present) {
    try {
      await execFileP(process.execPath, [tsc, '--noEmit', '-p', cfg], {
        cwd: projectDir,
        env,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        timeout: VERIFY_TIMEOUT_MS,
      })
    } catch (e: unknown) {
      const err = e as { killed?: boolean; signal?: string; stdout?: string; stderr?: string }
      if (err.killed && err.signal === 'SIGTERM') {
        return { green: false, skipped: false, timedOut: true, log: `[${cfg}] timeout (> ${VERIFY_TIMEOUT_MS / 1000}s)` }
      }
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
      return { green: false, skipped: false, timedOut: false, log: `[${cfg}] tsc a échoué\n${out.slice(-4000)}` }
    }
  }
  return { green: true, skipped: false, timedOut: false, log: 'typecheck vert (tsc)' }
}

/** Chemin générique : la commande de vérif du projet, via shell (cwd = projet). */
async function runShellVerify(projectDir: string, command: string): Promise<GreenResult> {
  try {
    await execShell(command, {
      cwd: projectDir,
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      timeout: VERIFY_TIMEOUT_MS,
    })
    return { green: true, skipped: false, timedOut: false, log: `vert (${command})` }
  } catch (e: unknown) {
    const err = e as { killed?: boolean; signal?: string; stdout?: string; stderr?: string }
    if (err.killed && err.signal === 'SIGTERM') {
      return { green: false, skipped: false, timedOut: true, log: `\`${command}\` timeout (> ${VERIFY_TIMEOUT_MS / 1000}s)` }
    }
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
    return { green: false, skipped: false, timedOut: false, log: `\`${command}\` a échoué\n${out.slice(-4000)}` }
  }
}

async function runVerify(projectDir: string, tscRoot: string): Promise<GreenResult> {
  const plan = resolveVerify(projectDir, tscRoot)
  if (plan.kind === 'skip') return { green: true, skipped: true, timedOut: false, log: plan.reason }
  if (plan.kind === 'tsc') return runTsc(projectDir, tscRoot)
  return runShellVerify(projectDir, plan.command)
}

/**
 * Vérifie que MAIN passe sa vérif (autoritaire à l'approve). green:true si OK. skipped:true si aucune vérif
 * détectée → ne bloque pas le merge. timedOut:true → l'appelant diffère.
 */
export async function verifyMain(mainPath: string): Promise<GreenResult> {
  return runVerify(mainPath, mainPath)
}

/**
 * Vérifie qu'un WORKTREE d'agent passe sa vérif. ADVISORY au report (W5) : informe la revue, ne bloque pas
 * (le gate autoritaire reste verifyMain à l'approve sur le tronc mergé). Pour le chemin tsc, le binaire TS
 * vient du tronc (mainPath, qui a toujours node_modules ; le worktree résout via la junction).
 */
export async function verifyWorktree(worktreePath: string, mainPath: string): Promise<GreenResult> {
  return runVerify(worktreePath, mainPath)
}
