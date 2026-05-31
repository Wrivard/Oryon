import type { Database } from 'better-sqlite3'
import { migration001 } from './001_init'
import { migration002 } from './002_dev_command'
import { migration003 } from './003_orchestrator_tasks'
import { migration004 } from './004_settings'
import { migration005 } from './005_voice'
import { migration006 } from './006_voice_vocab'
import { migration007 } from './007_voice_learning'
import { migration008 } from './008_terminal_worktree'
import { migration009 } from './009_voice_vocab_nocase'

export interface Migration {
  /** Entier strictement croissant. Stocké dans `PRAGMA user_version`. */
  version: number
  name: string
  up: (db: Database) => void
}

/**
 * Registre ordonné des migrations. Pour faire évoluer le schéma :
 * ajouter un nouveau fichier `00N_xxx.ts` et l'enregistrer ICI.
 * NE JAMAIS éditer une migration déjà livrée (elle a pu tourner sur des DB existantes).
 */
export const MIGRATIONS: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
]

/**
 * Applique toutes les migrations dont la version > `user_version` courant,
 * dans l'ordre, chacune dans sa propre transaction (atomique).
 * @returns le nombre de migrations appliquées.
 */
export function runMigrations(db: Database): number {
  // Avec { simple: true }, better-sqlite3 renvoie la valeur scalaire ; user_version est un INTEGER.
  const current = db.pragma('user_version', { simple: true }) as number
  const pending = MIGRATIONS
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)

  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db)
      // user_version n'accepte pas de paramètre lié ; m.version est un entier de notre code (sûr).
      db.pragma(`user_version = ${m.version}`)
    })
    tx()
  }

  return pending.length
}
