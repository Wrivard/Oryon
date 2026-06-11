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
import { existsSync, lstatSync, mkdirSync, rmdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import type { AgentBranch } from '../../shared/types'

const AGENT_BRANCH_PREFIX = 'oryon/agent-'

/** git synchrone dans `cwd`. Lève sur code de sortie non nul (comportement execFileSync). */
function git(cwd: string, args: string[]): string {
  // core.editor=true : un merge non-ff ne doit JAMAIS ouvrir d'éditeur (bloquerait le process enfant Windows).
  // safe.directory=* : Oryon lancé en ADMINISTRATEUR crée les worktrees possédés par « Administrators » → git
  // refuserait sinon (« detected dubious ownership ») et la création de worktree / le merge échoueraient. On fait
  // confiance à TOUS les dépôts pour NOS appels git (repos de l'utilisateur ; portée -c, pas de config globale).
  return execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'core.editor=true', '-c', 'safe.directory=*', ...args], {
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

/**
 * Fichier TRANSITOIRE du harness/Oryon (lock réécrit en continu) qui ne doit JAMAIS gater un merge-back ni
 * déclencher une alarme de contamination du tronc. Cas réel : `.claude/scheduled_tasks.lock` (planificateur
 * Claude Code) suivi par git dans certains repos → réécrit en boucle → MAIN « sale » en permanence, ce qui
 * (a) reportait à l'infini TOUT merge-back (isClean=false, travail coincé sur les branches) et (b) faisait croire
 * à une contamination du tronc. On ne matche QUE les `*.lock` sous `.claude/` ou `.oryon/` — jamais les lockfiles
 * de dépendances à la racine (package-lock.json/pnpm-lock.yaml/yarn.lock ne sont pas concernés).
 */
export function isTransientHarnessPath(p: string): boolean {
  const s = p.replace(/\\/g, '/').toLowerCase()
  return s.endsWith('.lock') && (s.includes('.claude/') || s.includes('.oryon/'))
}

// Contrat de tâche déposé par l'orchestrateur à la RACINE du worktree du worker (cf. router.ts,
// livraison par fichier des longs contrats). Untracked : il ne doit gater NI la synchro sur main
// (refreshWorktreeToHead) NI l'evidence-gate (branchEvidence) — sinon le seul fait d'avoir reçu un
// contrat ferait croire à un worktree « sale » / non vide.
export const ORCHESTRATOR_TASK_FILE = 'ORCHESTRATOR-TASK.md'

/** Lignes de `git status --porcelain` du worktree, EXCEPTÉ celle du contrat de tâche (untracked). */
function statusLinesIgnoringContract(dir: string): string[] {
  return (tryGit(dir, ['status', '--porcelain']) ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .filter((l) => l.slice(3).trim().replace(/^"(.*)"$/, '$1') !== ORCHESTRATOR_TASK_FILE)
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
 * Worktree git SAIN : HEAD résoluble ET index lisible. Un worktree dont les refs sont remplies de 0x00
 * (corruption vue en prod, rapport 1975b0b1) passe `isRegistered`+`existsSync` mais fait échouer tout git
 * ultérieur — on le détecte ICI pour le recréer proprement au lieu de spawner un claude dans un cwd cassé.
 */
function isWorktreeHealthy(dir: string): boolean {
  return tryGit(dir, ['rev-parse', 'HEAD']) !== null && tryGit(dir, ['status', '--porcelain']) !== null
}

/**
 * Idempotent : garantit un worktree pour `agent` et retourne son chemin.
 * - projet non-git → retourne `main` (repli cwd partagé documenté).
 * - worktree déjà enregistré ET présent → retourne tel quel (JAMAIS de reset : un respawn/double-mount
 *   StrictMode réattache le travail existant). Le reset n'arrive que sur un fleet-reset explicite (à part).
 * - branche déjà présente (run précédent) → réattache SANS reset (commits non mergés préservés).
 * - sinon → crée la branche depuis `base` (HEAD par défaut, résolu dynamiquement — jamais codé en dur).
 * - worktree irrécupérable (création échouée / corruption non réparable) → LÈVE (jamais de repli silencieux
 *   sur le tronc pour un worker, cf. plan 011) ; SEUL le cas « projet non-git » retourne encore `main`.
 * Un enregistrement périmé (dir supprimé hors-bande) déclenche `worktree prune` + 1 retry.
 */
export function ensureWorktree(main: string, agent: string, base?: string): string {
  if (!isGitRepo(main)) return main
  const dir = worktreeDir(main, agent)
  const branch = branchFor(agent)

  if (isRegistered(main, dir) && existsSync(dir)) {
    if (isWorktreeHealthy(dir)) {
      provisionWorktreeDeps(main, dir)
      return dir
    }
    // Enregistré + présent mais git CORROMPU (refs 0x00 / index illisible) : on démonte et on laisse la
    // création normale ci-dessous recréer un worktree propre. La branche n'est supprimée que si SA ref est
    // elle-même corrompue (sinon on la CONSERVE → réattache le travail existant).
    console.error(`[worktrees] worktree corrompu détecté pour ${agent} (HEAD/index illisible) → recréation`)
    removeWorktree(main, agent)
    tryGit(main, ['worktree', 'prune'])
    if (tryGit(main, ['rev-parse', '--verify', branch]) === null) {
      tryGit(main, ['update-ref', '-d', `refs/heads/${branch}`])
    }
  }

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
      // PLUS de repli silencieux sur le tronc (plan 011) : un WORKER lancé dans l'arbre principal = contamination
      // réelle (rapport 1975b0b1 — Cole a exécuté une tâche DANS le tronc). On LÈVE → l'appelant (chokepoint
      // terminals:create / agentRestartAgent) REFUSE le spawn et alerte au lieu de retomber sur cwd=main.
      throw new Error(`worktree irrécupérable pour ${agent} : ${(e as Error).message}`)
    }
  }
  if (!existsSync(dir)) throw new Error(`worktree irrécupérable pour ${agent} : dossier absent après création`)
  provisionWorktreeDeps(main, dir)
  return dir
}

/**
 * Provisionne les dépendances d'un worktree via des JUNCTIONS → tronc (Windows, sans privilège ; ignorées
 * par git via .gitignore). Chaque junction est best-effort et INDÉPENDANTE (try/catch séparé) : un échec ou
 * un skip de l'une ne doit jamais empêcher l'autre. Idempotent ; skip si déjà présent (préserve un setup
 * manuel) ou si la cible du tronc n'existe pas encore.
 *   1. node_modules : pour exécuter tsc/typecheck (green-gate au report, W5).
 *   2. .claude/skills : rend les skills Claude Code par-projet (du tronc, gitignorés donc ABSENTS d'un
 *      worktree frais) découvrables par l'agent worker dont le cwd est ce worktree.
 */
export function provisionWorktreeDeps(main: string, dir: string): void {
  if (!dir || dir === main) return
  // 1. node_modules → tronc.
  try {
    const link = join(dir, 'node_modules')
    const target = join(main, 'node_modules')
    if (!existsSync(link) && existsSync(target)) symlinkSync(target, link, 'junction')
  } catch (e) {
    console.error('[worktrees] junction node_modules ignorée (best-effort) :', (e as Error).message)
  }
  // 2. .claude/skills → tronc. Le dossier .claude est gitignoré → absent du worktree frais : on crée le
  //    parent avant la junction (mkdir recursive = no-op s'il existe déjà).
  try {
    const link = join(dir, '.claude', 'skills')
    const target = join(main, '.claude', 'skills')
    if (!existsSync(link) && existsSync(target)) {
      mkdirSync(join(dir, '.claude'), { recursive: true })
      symlinkSync(target, link, 'junction')
    }
  } catch (e) {
    console.error('[worktrees] junction .claude/skills ignorée (best-effort) :', (e as Error).message)
  }
}

/**
 * Sévère les junctions SORTANTES d'un worktree (node_modules, .claude/skills) AVANT un `git worktree remove`.
 * CRITIQUE : `git worktree remove --force` recurse À TRAVERS une junction et VIDE la CIBLE (le tronc) — il faut
 * donc retirer le NŒUD de junction lui-même d'abord. `rmdirSync` retire le reparse-point SANS toucher la cible
 * (`unlinkSync` lèverait EPERM sur une junction-dir). On ne touche QUE des reparse-points (isSymbolicLink),
 * jamais un vrai dossier. Best-effort, idempotent, ne throw JAMAIS.
 */
function unlinkWorktreeJunctions(dir: string): void {
  for (const rel of ['node_modules', join('.claude', 'skills')]) {
    const link = join(dir, rel)
    let isLink = false
    try {
      isLink = lstatSync(link).isSymbolicLink() // lstat ne suit PAS le lien (marche même si la cible a disparu)
    } catch {
      continue // pas de lien à cet emplacement (ENOENT) → rien à sévrer
    }
    if (!isLink) continue // vrai dossier (pas une junction) → ne JAMAIS le supprimer
    try {
      rmdirSync(link) // retire le NŒUD de junction, PAS sa cible
    } catch (e) {
      console.error('[worktrees] désliage junction ignoré (best-effort) :', (e as Error).message)
    }
  }
}

/**
 * Phase 2 (anti stale-fork) : amène le worktree d'un agent à MAIN-HEAD AVANT de (re)dispatcher une task,
 * pour qu'il voie les dépendances déjà mergées (sinon il forke un tronc périmé créé à l'ouverture du workspace).
 * N'opère QUE sur un worktree PROPRE : un re-dispatch après 'changes' a du travail non commité → on saute
 * (le rebase-before-merge de l'intégration réconciliera). Merge non-éditeur ; sur conflit → abort + 'conflict'
 * (l'agent travaille quand même : pas pire qu'aujourd'hui, et l'intégration conserve la branche sur conflit).
 * JAMAIS d'écriture sur MAIN — uniquement la branche de l'agent dans son worktree.
 */
export function refreshWorktreeToHead(main: string, agent: string): 'updated' | 'dirty' | 'conflict' | 'skip' {
  if (!isGitRepo(main)) return 'skip'
  const dir = worktreeDir(main, agent)
  if (dir === main || !existsSync(dir) || !isRegistered(main, dir)) return 'skip'
  if (statusLinesIgnoringContract(dir).length) return 'dirty'
  const head = (tryGit(main, ['rev-parse', 'HEAD']) ?? '').trim()
  if (!head) return 'skip'
  // MAIN-HEAD déjà ancêtre du worktree → rien à amener (is-ancestor sort 0 → tryGit ≠ null).
  if (tryGit(dir, ['merge-base', '--is-ancestor', head, 'HEAD']) !== null) return 'updated'
  // Worktree PROPRE ici (dirty déjà retourné plus haut). Si la branche n'a AUCUN commit authored non mergé
  // (worktree idle d'une session passée : juste en retard sur main), un reset --hard sur MAIN-HEAD ne perd
  // RIEN, garantit la présence des commits-prérequis (corrige W1) et évite un commit de merge (anti-inflation
  // W4). On ne reset JAMAIS une branche qui porte du travail non mergé (cf. invariant l.98).
  const authored = parseInt((tryGit(dir, ['rev-list', '--count', `${head}..HEAD`]) ?? '0').trim(), 10) || 0
  if (authored === 0) {
    try {
      git(dir, ['reset', '--hard', head])
      return 'updated'
    } catch {
      return 'conflict'
    }
  }
  // La branche porte du travail non mergé → merge (jamais de reset qui le détruirait) ; conflit → abort.
  try {
    git(dir, ['merge', '--no-edit', head])
    return 'updated'
  } catch {
    tryGit(dir, ['merge', '--abort'])
    return 'conflict'
  }
}

/** Retire le worktree d'un agent (dir + enregistrement) mais CONSERVE la branche (commits survivent). */
export function removeWorktree(main: string, agent: string): void {
  if (!isGitRepo(main)) return
  const dir = worktreeDir(main, agent)
  unlinkWorktreeJunctions(dir) // CRITIQUE : sévrer les junctions sortantes AVANT remove (sinon git vide le tronc)
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
      unlinkWorktreeJunctions(e.path) // CRITIQUE : sévrer les junctions sortantes AVANT remove (sinon git vide le tronc)
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

export interface BranchEvidence {
  ahead: number // commits de la branche en avance sur MAIN-HEAD
  filesChanged: string[] // fichiers modifiés (commités + non commités)
  worktreeDirty: boolean // modifs non commitées dans le worktree
  mainDirty: boolean // tronc principal avec modifs SUIVIES (contamination possible — F3)
  empty: boolean // aucun travail : 0 commit d'avance ET worktree propre
}

/**
 * Sonde de PREUVE pour la porte de complétion (cf. agentReportTask, F4/F8) : l'état git RÉEL de la branche
 * d'un agent vs MAIN, lu en synchrone. Sert à ne plus faire confiance au seul rapport texte du worker.
 */
export function branchEvidence(main: string, agent: string): BranchEvidence {
  const dir = worktreeDir(main, agent)
  const branch = branchFor(agent)
  // Plage AUTHORED (merge-base(main,branch)..branch), PAS vs HEAD courant : sinon les commits de merge de
  // refresh (refreshWorktreeToHead / refreshOtherWorktrees) gonflent le compte (symptôme W4). `--no-merges`
  // + diff three-dot ne gardent que le travail réellement écrit par le worker (cf. idiome source.ipc.ts).
  const base = (tryGit(main, ['merge-base', 'HEAD', branch]) ?? '').trim() || 'HEAD'
  const ahead = parseInt((tryGit(main, ['rev-list', '--count', '--no-merges', `${base}..${branch}`]) ?? '0').trim(), 10) || 0
  const wtLines = existsSync(dir) ? statusLinesIgnoringContract(dir) : []
  const worktreeDirty = wtLines.length > 0
  const committed = (tryGit(main, ['diff', '--name-only', `${base}...${branch}`]) ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const uncommitted = wtLines.map((l) => l.slice(3).trim()).filter(Boolean)
  const filesChanged = Array.from(new Set([...committed, ...uncommitted]))
  // Contamination du tronc = fichiers SUIVIS modifiés sur MAIN, HORS locks transitoires du harness (sinon un
  // `.claude/scheduled_tasks.lock` réécrit en boucle déclenchait un faux « ⚠ TRONC PRINCIPAL SALE » en continu).
  const mainDirty = (tryGit(main, ['status', '--porcelain', '--untracked-files=no']) ?? '')
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .some((p) => !isTransientHarnessPath(p))
  return { ahead, filesChanged, worktreeDirty, mainDirty, empty: ahead === 0 && !worktreeDirty }
}
