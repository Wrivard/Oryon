import type { Database } from 'better-sqlite3'

/**
 * Migration v8 : worktree git par agent (isolation des éditions + diff git par terminal).
 * `worktree_path` = arbre de travail dédié de ce terminal (<projet>/.oryon/agents/<nom>), où le
 * shell de l'agent démarre. La colonne `cwd` garde son sens (= chemin du projet PRINCIPAL / repli
 * shell) et reste l'ancre de la mémoire partagée (ORYON_PROJECT_DIR) + du run d'orchestration.
 * Nullable → les lignes existantes et les projets non-git retombent sur cwd = projet principal.
 * ALTER ADD COLUMN est sûr/idempotent au niveau migration (gate user_version).
 */
export const migration008 = {
  version: 8,
  name: 'terminal_worktree',
  up: (db: Database) => {
    db.exec(`ALTER TABLE terminals ADD COLUMN worktree_path TEXT`)
  },
}
