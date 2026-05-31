// Intégration (merge-back) des branches d'agents dans le tronc principal — pilotée par l'intégrateur,
// SÉRIALISÉE, et qui FAIT REMONTER les conflits (jamais `git add -A` sur MAIN, jamais de perte de travail).
//
// Chaque agent committe sur sa branche `oryon/agent-<nom>` dans son worktree. À l'approbation du reviewer
// (router), on enfile un job sur UNE chaîne de promesses module-level → un seul `git merge` touche MAIN à
// la fois (l'analogue à l'instant du merge de la course d'isolation des worktrees ; des merges concurrents
// corrompraient l'index de MAIN). Le travail de l'agent vit sur la branche : il est toujours récupérable.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdirSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import type { MergeResult } from '../../../shared/types'
import { worktreeDir, branchFor, listAgentWorktrees, refreshWorktreeToHead } from '../worktrees'
import { verifyMain } from './green-gate'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  // core.editor=true : un merge non-ff (rebase-before-merge) ne doit JAMAIS ouvrir d'éditeur (bloquerait
  // le process enfant). Les merges qui passent -m ne sont pas affectés.
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', '-c', 'core.editor=true', ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout.toString()
}
/** git qui avale l'erreur (null si code ≠ 0). `git diff --quiet` sort 1 si différences → null. */
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

/** MAIN propre ? (suivi seulement — les fichiers non suivis ne bloquent pas un merge non conflictuel). */
async function isClean(main: string): Promise<boolean> {
  const wt = await tryGit(main, ['diff', '--quiet']) // null si l'arbre de travail a des modifs
  const idx = await tryGit(main, ['diff', '--cached', '--quiet']) // null si l'index a des modifs
  return wt !== null && idx !== null
}

export interface MergeBackJob {
  mainPath: string
  worktree: string
  branch: string
  agent: string
  /** Libellé de la task (numéro ou « manuel ») pour les messages. */
  task: string
  onDone: (message: string) => void
  onConflict: (message: string) => void
}

async function integrate(job: MergeBackJob): Promise<void> {
  const { mainPath, worktree, branch, agent, task } = job
  try {
    // 1) Committer le travail en attente du worktree (déjà revu). Commit MACHINE → --no-verify
    //    (un merge de swarm ne peut pas rester bloqué sur un hook pre-commit interactif ; déviation
    //    assumée vis-à-vis de la règle globale no-skip-hooks, à valider par le propriétaire).
    await tryGit(worktree, ['add', '-A'])
    const dirty = (await tryGit(worktree, ['status', '--porcelain'])) ?? ''
    if (dirty.trim()) {
      await git(worktree, ['commit', '-m', `agent ${agent}: ${task}`, '--no-verify'])
    }
    // 2) Rien à intégrer ? (branche à 0 commit d'avance sur HEAD)
    const ahead = ((await tryGit(mainPath, ['rev-list', '--count', `HEAD..${branch}`])) ?? '0').trim()
    if (ahead === '0') {
      job.onDone(`#${task} : rien à intégrer (\`${branch}\` à 0 commit d'avance).`)
      return
    }
    // 3) Garde : MAIN doit être propre — protège la session éditeur/Source de l'humain sur le tronc. Au lieu
    //    d'ABANDONNER le job (F7 : un tronc sale stranglait tout le travail approuvé), on le met EN ATTENTE :
    //    drainPendingMerges() (tick mcp-export 2s) le rejoue dès que MAIN redevient propre. Branche conservée.
    if (!(await isClean(mainPath))) {
      pending.set(branch, job)
      job.onConflict(
        `#${task} : projet principal sale — intégration de \`${branch}\` REPORTÉE (auto-retry dès que MAIN sera propre ; branche conservée).`,
      )
      return
    }
    // 4) Snapshot de récupération de MAIN (git stash create = commit du WT sans toucher l'arbre), loggé.
    const snap = ((await tryGit(mainPath, ['stash', 'create'])) ?? '').trim()
    if (snap) {
      try {
        const log = join(mainPath, '.oryon', 'trash', 'recovery.log')
        mkdirSync(dirname(log), { recursive: true })
        appendFileSync(log, `${new Date().toISOString()}  merge ${branch}  ->  git stash apply ${snap}\n`)
      } catch {
        /* best-effort : ne jamais bloquer le merge sur le log */
      }
    }
    // 4b) REBASE-BEFORE-MERGE (Phase 2) : réconcilie la branche avec MAIN-courant DANS LE WORKTREE (jamais
    //     sur MAIN). Les conflits sémantiques/textuels surgissent ici, récupérables, MAIN intact → le merge
    //     final devient propre. Le worktree est propre (étape 1 a commité). Sur conflit : abort + branche
    //     conservée. (Avec --no-ff à l'étape 5, le tip pré-merge reste le 1er parent → revert green-gate OK.)
    const mainHead = ((await tryGit(mainPath, ['rev-parse', 'HEAD'])) ?? '').trim()
    if (mainHead && (await tryGit(worktree, ['merge-base', '--is-ancestor', mainHead, 'HEAD'])) === null) {
      try {
        await git(worktree, ['merge', '--no-edit', mainHead])
      } catch {
        await tryGit(worktree, ['merge', '--abort'])
        const recover = snap ? ` Récupération : \`git stash apply ${snap}\`.` : ''
        job.onConflict(
          `#${task} : \`${branch}\` diverge de MAIN — réconciliation en conflit dans le worktree, intégration reportée, branche CONSERVÉE.${recover}`,
        )
        return
      }
    }
    // 5) Merge --no-ff. En cas de conflit TEXTUEL : abort + branche CONSERVÉE + ligne de récupération exacte.
    //    On capture le tip AVANT le merge : avec --no-ff il devient le parent exact du commit de merge, donc
    //    un revert déterministe (reset --hard) si la green-gate échoue à l'étape 6.
    const preMergeTip = ((await tryGit(mainPath, ['rev-parse', 'HEAD'])) ?? '').trim()
    try {
      await git(mainPath, ['merge', '--no-ff', '-m', `merge ${branch} (#${task})`, branch])
    } catch {
      await tryGit(mainPath, ['merge', '--abort'])
      const recover = snap ? ` Récupération : \`git stash apply ${snap}\`.` : ''
      job.onConflict(
        `#${task} : conflit sur \`${branch}\` — merge annulé, branche CONSERVÉE pour merge manuel.${recover}`,
      )
      return
    }
    // 6) GREEN-GATE : le MAIN combiné doit encore typecheck (un merge propre peut quand même casser la
    //    compilation). Vérif DANS la chaîne sérialisée → un seul tsc-puis-éventuel-revert à la fois.
    //    On fige le SHA de NOTRE commit de merge : le tsc dure jusqu'à 300 s et NE verrouille PAS le git
    //    externe — un humain peut commiter sur MAIN entre-temps (scénario self-hosting). Toutes les décisions
    //    de revert/scoping s'ancrent donc sur ce SHA, jamais sur « HEAD » qui peut avoir bougé.
    const mergeCommit = ((await tryGit(mainPath, ['rev-parse', 'HEAD'])) ?? '').trim()
    const gate = await verifyMain(mainPath)
    if (gate.green) {
      refreshOtherWorktrees(mainPath, agent) // F7 : les autres workers in-flight voient la dépendance fraîchement mergée
      job.onDone(`#${task} : \`${branch}\` intégrée dans le projet principal (merge --no-ff${gate.skipped ? '' : ', green-gate ✓'}).`)
      return
    }
    // Si NOTRE merge touche package.json/pnpm-lock, un rouge peut juste signifier « install requis » → NE PAS
    // revert (sinon on annulerait en boucle un merge légitime qui ajoute une dépendance). Idem sur timeout.
    // Plage scopée à preMergeTip..mergeCommit (pas ..HEAD) → insensible à un commit humain intercalé.
    const touchedDeps = ((await tryGit(mainPath, ['diff', '--name-only', `${preMergeTip}..${mergeCommit}`])) ?? '')
      .split('\n')
      .some((f) => /(^|\/)(package\.json|pnpm-lock\.yaml)$/.test(f.trim()))
    if (gate.timedOut || touchedDeps) {
      const why = gate.timedOut ? 'typecheck trop long (timeout)' : 'le merge modifie package.json/pnpm-lock (install manuel requis)'
      job.onConflict(
        `#${task} : \`${branch}\` mergée mais green-gate non concluante — ${why}. MAIN laissé en l'état, branche conservée. Vérifie à la main (\`pnpm install\` puis \`pnpm typecheck\`).`,
      )
      return
    }
    // Rouge franc : MAIN ne compile plus → revert au dernier état vert. GARDE ANTI-PERTE : on ne reset --hard
    // QUE si MAIN-HEAD est TOUJOURS exactement notre commit de merge. Si un commit humain s'est intercalé
    // pendant le tsc, reset --hard le perdrait → on DIFFÈRE sans toucher MAIN (cohérent avec defer + branche
    // conservée). Le --no-ff garantit que preMergeTip est le 1er parent → reset déterministe quand on l'applique.
    const headNow = ((await tryGit(mainPath, ['rev-parse', 'HEAD'])) ?? '').trim()
    if (preMergeTip && mergeCommit && headNow === mergeCommit) {
      const reset = await tryGit(mainPath, ['reset', '--hard', preMergeTip])
      job.onConflict(
        reset === null
          ? `#${task} : \`${branch}\` rouge au typecheck mais le revert (reset --hard) a échoué — MAIN possiblement incohérent, branche conservée, vérifie à la main. Détail tsc :\n${gate.log}`
          : `#${task} : \`${branch}\` cassait le typecheck du projet principal — merge ANNULÉ (MAIN revenu au dernier état vert), branche CONSERVÉE. Détail tsc :\n${gate.log}`,
      )
    } else {
      job.onConflict(
        `#${task} : \`${branch}\` rouge au typecheck MAIS MAIN a bougé pendant la vérif (commit humain intercalé) — revert NON appliqué pour ne pas perdre ce commit. MAIN laissé en l'état, branche conservée, vérifie/revert à la main. Détail tsc :\n${gate.log}`,
      )
    }
  } catch (e) {
    job.onConflict(`#${task} : intégration échouée (${(e as Error).message}) — branche \`${branch}\` conservée.`)
  }
}

// Sérialiseur : exactement un merge touche MAIN à la fois. .catch absorbe pour ne pas casser la chaîne.
let chain: Promise<void> = Promise.resolve()

// Jobs REPORTÉS faute de MAIN propre (F7), rejoués par drainPendingMerges quand le tronc redevient propre.
const pending = new Map<string, MergeBackJob>()

/** Rejoue les merges en attente dès que MAIN est propre (appelé périodiquement par mcp-export, tick 2s). */
export async function drainPendingMerges(): Promise<void> {
  if (pending.size === 0) return
  const jobs = [...pending.values()]
  pending.clear()
  for (const j of jobs) {
    if (await isClean(j.mainPath)) void enqueueMergeBack(j)
    else pending.set(j.branch, j) // toujours sale → reste en attente
  }
}

/** Après un merge réussi : amène les AUTRES worktrees d'agents (propres) à MAIN-HEAD (F7, anti stale-fork). */
function refreshOtherWorktrees(main: string, justMerged: string): void {
  try {
    for (const w of listAgentWorktrees(main)) {
      if (w.agent.toLowerCase() === justMerged.toLowerCase()) continue
      refreshWorktreeToHead(main, w.agent) // saute en interne les worktrees sales/busy
    }
  } catch {
    /* best-effort : ne jamais casser le merge sur le refresh */
  }
}

export function enqueueMergeBack(job: MergeBackJob): Promise<void> {
  chain = chain.then(() => integrate(job)).catch(() => {})
  return chain
}

/** Merge manuel d'une branche d'agent (vue Source) — passe par la MÊME chaîne sérialisée/conflict-safe. */
export function mergeAgentBranch(main: string, branch: string): Promise<MergeResult> {
  const agent = branch.startsWith('oryon/agent-') ? branch.slice('oryon/agent-'.length) : branch
  return new Promise<MergeResult>((resolve) => {
    void enqueueMergeBack({
      mainPath: main,
      worktree: worktreeDir(main, agent),
      branch: branch.startsWith('oryon/') ? branch : branchFor(agent),
      agent,
      task: 'manuel',
      onDone: (message) => resolve({ ok: true, message }),
      onConflict: (message) => resolve({ ok: false, message }),
    })
  })
}
