import type { Database } from 'better-sqlite3'
import { SCHEMA } from '../schema'

/**
 * Migration initiale (v1) : schéma exact de docs/01-ARCHITECTURE.md §3.
 * Tables : workspaces, terminals, projects, tasks, agents, mailbox.
 *
 * Phase 0 : une seule migration, le DDL vit dans ../schema.ts (source canonique).
 * À l'ajout d'une migration 002+, NE PAS modifier le comportement de v1 :
 * figer le DDL ci-dessous si besoin et laisser SCHEMA refléter la forme courante.
 */
export const migration001 = {
  version: 1,
  name: 'init',
  up: (db: Database) => {
    db.exec(SCHEMA)
  },
}
