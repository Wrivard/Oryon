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
import { worktreeDir, branchFor } from '../worktrees'
import { verifyMain } from './green-gate'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], {
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
    // 3) Garde : MAIN doit être propre — protège la session éditeur/Source de l'humain sur le tronc.
    if (!(await isClean(mainPath))) {
      job.onConflict(
        `#${task} : le projet principal a des changements non commités — intégration de \`${branch}\` reportée (branche conservée).`,
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
    const gate = await verifyMain(mainPath)
    if (gate.green) {
      job.onDone(`#${task} : \`${branch}\` intégrée dans le projet principal (merge --no-ff${gate.skipped ? '' : ', green-gate ✓'}).`)
      return
    }
    // Si le merge touche package.json/pnpm-lock, un rouge peut juste signifier « install requis » → NE PAS
    // revert (sinon on annulerait en boucle un merge légitime qui ajoute une dépendance). Idem sur timeout.
    const touchedDeps = ((await tryGit(mainPath, ['diff', '--name-only', `${preMergeTip}..HEAD`])) ?? '')
      .split('\n')
      .some((f) => /(^|\/)(package\.json|pnpm-lock\.yaml)$/.test(f.trim()))
    if (gate.timedOut || touchedDeps) {
      const why = gate.timedOut ? 'typecheck trop long (timeout)' : 'le merge modifie package.json/pnpm-lock (install manuel requis)'
      job.onConflict(
        `#${task} : \`${branch}\` mergée mais green-gate non concluante — ${why}. MAIN laissé en l'état, branche conservée. Vérifie à la main (\`pnpm install\` puis \`pnpm typecheck\`).`,
      )
      return
    }
    // Rouge franc : MAIN ne compile plus → revert au dernier état vert (le --no-ff garantit le parent exact),
    // branche CONSERVÉE pour correction. Les fichiers non suivis survivent à reset --hard (isClean §3 vérifié).
    if (preMergeTip) await tryGit(mainPath, ['reset', '--hard', preMergeTip])
    job.onConflict(
      `#${task} : \`${branch}\` cassait le typecheck du projet principal — merge ANNULÉ (MAIN revenu au dernier état vert), branche CONSERVÉE. Détail tsc :\n${gate.log}`,
    )
  } catch (e) {
    job.onConflict(`#${task} : intégration échouée (${(e as Error).message}) — branche \`${branch}\` conservée.`)
  }
}

// Sérialiseur : exactement un merge touche MAIN à la fois. .catch absorbe pour ne pas casser la chaîne.
let chain: Promise<void> = Promise.resolve()

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
