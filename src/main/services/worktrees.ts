// Gestion du cycle de vie des git worktrees PAR AGENT (isolation des éditions de code + git diff par
// terminal). Un worktree par agent sous <projet>/.oryon/agents/<nom> (déjà gitignoré + ignoré par le
// watcher éditeur), branche `oryon/agent-<nom>`.
//
// INVARIANT CRITIQUE (cf. PLAN-worktree-8agent) : le worktree ne sert QUE de cwd au shell de l'agent.
//   - ORYON_PROJECT_DIR (mémoire partagée) reste = projet PRINCIPAL (cf. terminals.ipc.ts)
//   - les fichiers task/result/review du run sont des chemins ABSOLUS dans <principal>/.oryon/run
//   → mémoire partagée + UN seul point de surveillance chokidar sur le tronc principal.
//
// On utilise execFileSync (synchrone) : setup/teardown tournent une fois par démarrage/arrêt de swarm
// (jamais en hot path) ; le synchrone sérialise naturellement les opérations et évite la course sur
// .git/worktrees + index.lock (le blocblocant #1 réincarné). NE JAMAIS appeler depuis le spawn parallèle
// par terminal du renderer.

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { AgentBranch } from '../../shared/types'

const AGENT_BRANCH_PREFIX = 'oryon/agent-'

/** git synchrone dans `cwd`. Lève sur code de sortie non nul (comportement execFileSync). */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).toString()
}
/** git qui avale l'erreur (retourne null si code ≠ 0). Pour les sondes (ref existe ? worktree listé ?). */
function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args)
  } catch {
    return null
  }
}

export function isGitRepo(p: string): boolean {
  try {
    return git(p, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch {
    return false
  }
}

/** Worktree d'un agent : <principal>/.oryon/agents/<nom-minuscule>. Noms d'agents courts → sûr sous MAX_PATH. */
export function worktreeDir(main: string, agent: string): string {
  return join(main, '.oryon', 'agents', agent.toLowerCase())
}
export function branchFor(agent: string): string {
  return `${AGENT_BRANCH_PREFIX}${agent.toLowerCase()}`
}

/** Normalise un chemin pour comparaison (Windows : slashes + casse insensibles, pas de slash final). */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

interface WtEntry {
  path: string
  branch: string | null
}
/** Parse `git worktree list --porcelain` en blocs {path, branch} (branch sans le préfixe refs/heads/). */
function parseWorktreeList(porcelain: string): WtEntry[] {
  const entries: WtEntry[] = []
  let cur: WtEntry | null = null
  for (const raw of porcelain.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length).trim(), branch: null }
      entries.push(cur)
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  return entries
}

function isRegistered(main: string, dir: string): boolean {
  const out = tryGit(main, ['worktree', 'list', '--porcelain'])
  if (!out) return false
  const target = norm(dir)
  return parseWorktreeList(out).some((e) => norm(e.path) === target)
}
function branchExists(main: string, branch: string): boolean {
  const r = tryGit(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return !!r && r.trim().length > 0
}

/**
 * Idempotent : garantit un worktree pour `agent` et retourne son chemin.
 * - projet non-git → retourne `main` (repli cwd partagé documenté).
 * - worktree déjà enregistré ET présent → retourne tel quel (JAMAIS de reset : un respawn/double-mount
 *   StrictMode réattache le travail existant). Le reset n'arrive que sur un fleet-reset explicite (à part).
 * - branche déjà présente (run précédent) → réattache SANS reset (commits non mergés préservés).
 * - sinon → crée la branche depuis `base` (HEAD par défaut, résolu dynamiquement — jamais codé en dur).
 * Un enregistrement périmé (dir supprimé hors-bande) déclenche `worktree prune` + 1 retry.
 */
export function ensureWorktree(main: string, agent: string, base?: string): string {
  if (!isGitRepo(main)) return main
  const dir = worktreeDir(main, agent)
  const branch = branchFor(agent)

  if (isRegistered(main, dir) && existsSync(dir)) return dir

  const baseSha = (tryGit(main, ['rev-parse', base ?? 'HEAD']) ?? '').trim()

  const add = (): void => {
    if (branchExists(main, branch)) {
      git(main, ['worktree', 'add', dir, branch]) // réattache la branche existante (pas de reset)
    } else if (baseSha) {
      git(main, ['worktree', 'add', '-b', branch, dir, baseSha]) // nouvelle branche depuis HEAD
    } else {
      throw new Error('aucun commit de base (HEAD absent)')
    }
  }

  try {
    add()
  } catch {
    tryGit(main, ['worktree', 'prune']) // enregistrement résiduel / lock → nettoyer puis réessayer
    try {
      add()
    } catch (e) {
      console.error(`[worktrees] échec pour ${agent}, repli sur le projet principal :`, (e as Error).message)
      return main
    }
  }
  return existsSync(dir) ? dir : main
}

/** Retire le worktree d'un agent (dir + enregistrement) mais CONSERVE la branche (commits survivent). */
export function removeWorktree(main: string, agent: string): void {
  if (!isGitRepo(main)) return
  const dir = worktreeDir(main, agent)
  tryGit(main, ['worktree', 'remove', '--force', dir])
  tryGit(main, ['worktree', 'prune'])
}

/**
 * Teardown : retire + supprime UNIQUEMENT les worktrees/branches d'agents entièrement mergés
 * (`rev-list --count HEAD..branch` === 0). Les branches non mergées sont conservées et retournées
 * (à signaler à l'utilisateur pour un merge manuel — on ne détruit jamais du travail non intégré).
 */
export function pruneMergedWorktrees(main: string): string[] {
  if (!isGitRepo(main)) return []
  const retained: string[] = []
  const out = tryGit(main, ['worktree', 'list', '--porcelain']) ?? ''
  for (const e of parseWorktreeList(out)) {
    if (!e.branch || !e.branch.startsWith(AGENT_BRANCH_PREFIX)) continue
    const ahead = (tryGit(main, ['rev-list', '--count', `HEAD..${e.branch}`]) ?? '').trim()
    if (ahead === '0') {
      tryGit(main, ['worktree', 'remove', '--force', e.path])
      tryGit(main, ['worktree', 'prune'])
      tryGit(main, ['branch', '-D', e.branch])
    } else {
      retained.push(e.branch)
    }
  }
  return retained
}

/** Worktrees d'agents enregistrés (pour la vue Source) avec leur nb de commits d'avance sur HEAD. */
export function listAgentWorktrees(main: string): AgentBranch[] {
  if (!isGitRepo(main)) return []
  const out = tryGit(main, ['worktree', 'list', '--porcelain']) ?? ''
  const result: AgentBranch[] = []
  for (const e of parseWorktreeList(out)) {
    if (!e.branch || !e.branch.startsWith(AGENT_BRANCH_PREFIX)) continue
    const agent = e.branch.slice(AGENT_BRANCH_PREFIX.length)
    const ahead = parseInt((tryGit(main, ['rev-list', '--count', `HEAD..${e.branch}`]) ?? '0').trim(), 10) || 0
    result.push({ agent, branch: e.branch, path: e.path, ahead })
  }
  return result
}
