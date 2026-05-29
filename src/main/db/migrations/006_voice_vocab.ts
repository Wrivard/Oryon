import type { Database } from 'better-sqlite3'

/**
 * Migration v6 : Voice++ — vocabulaire de boost (07b §3).
 * Termes (noms propres / jargon / identifiants) utilisés pour corriger la transcription vers le bon
 * terme (post-correction fuzzy, Transformers.js ne biaisant pas fort). `starred` = priorité ;
 * `source` = manual | auto (appris d'une correction, ✨) | project (identifiants du workspace) | csv.
 */
export const migration006 = {
  version: 6,
  name: 'voice_vocab',
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS voice_vocab (
        id         TEXT PRIMARY KEY,
        term       TEXT NOT NULL UNIQUE,
        starred    INTEGER NOT NULL DEFAULT 0,
        source     TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER
      );
    `)
  },
}
