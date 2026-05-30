// Green-gate : après un merge sur MAIN, vérifie que le projet TYPECHECK encore (miroir de `pnpm typecheck`,
// cf. package.json). Un merge peut être textuellement propre mais casser la compilation (export renommé,
// type modifié, champ retiré qu'un sibling utilise) → 8 merges verts isolément composent un MAIN cassé.
//
// $0 Claude : c'est du tsc LOCAL, aucun appel modèle. Lancé DANS la chaîne sérialisée de merge-back (un seul
// à la fois), donc aucune course. Sur un projet sans TypeScript / sans tsconfig → no-op (on ne bloque pas).
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'

const exec = promisify(execFile)

// Les tsconfig vérifiés par `pnpm typecheck`. On les lance un par un avec --noEmit, comme le script du repo.
const TSCONFIGS = ['tsconfig.node.json', 'tsconfig.web.json']
// tsc à froid x2 peut être lent sur un gros projet ; au-delà → l'appelant DIFFÈRE (ne revert jamais sur timeout).
const VERIFY_TIMEOUT_MS = 300_000

export interface GreenResult {
  green: boolean
  /** true = pas de TypeScript/tsconfig dans le projet → vérif ignorée (merge accepté). */
  skipped: boolean
  /** true = budget dépassé → l'appelant doit DIFFÉRER, pas revert. */
  timedOut: boolean
  log: string
}

// Entrée CLI de TypeScript DU PROJET vérifié. On la lance via le binaire Electron courant en mode
// ELECTRON_RUN_AS_NODE (= node pur) plutôt que via le shim .bin/tsc.cmd : aucune dépendance au PATH, et Node
// refuse désormais d'exécuter un .cmd via execFile sans shell (CVE-2024-27980). Robuste Windows + packagé.
function tscEntry(mainPath: string): string {
  return join(mainPath, 'node_modules', 'typescript', 'bin', 'tsc')
}

/**
 * Vérifie que MAIN typecheck. green:true si tous les tsconfig présents passent.
 * skipped:true si TypeScript/tsconfig absent (projet non-TS) → ne bloque pas le merge.
 * timedOut:true si le typecheck dépasse le budget → l'appelant diffère sans revert.
 */
export async function verifyMain(mainPath: string): Promise<GreenResult> {
  const tsc = tscEntry(mainPath)
  if (!existsSync(tsc)) return { green: true, skipped: true, timedOut: false, log: 'typescript absent du projet — green-gate ignorée' }
  const present = TSCONFIGS.filter((c) => existsSync(join(mainPath, c)))
  if (present.length === 0) return { green: true, skipped: true, timedOut: false, log: 'aucun tsconfig — green-gate ignorée' }

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  for (const cfg of present) {
    try {
      await exec(process.execPath, [tsc, '--noEmit', '-p', cfg], {
        cwd: mainPath,
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
  return { green: true, skipped: false, timedOut: false, log: 'typecheck vert' }
}
