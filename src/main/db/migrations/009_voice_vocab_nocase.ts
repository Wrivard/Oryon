import type { Database } from 'better-sqlite3'

/**
 * Migration v9 : NOCASE sur voice_vocab.term.
 * Migration 006 créait `term TEXT NOT NULL UNIQUE` (case-sensitive). On recrée la table pour :
 * - supprimer la contrainte UNIQUE inline (case-sensitive, impossible à modifier par ALTER)
 * - dédoublonner les lignes par lower(term) : garder source='manual' > starred > created_at DESC
 * - créer l'index UNIQUE NOCASE (comme voice_replacements / voice_snippets en migration 007).
 */
export const migration009 = {
  version: 9,
  name: 'voice_vocab_nocase',
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS voice_vocab_new (
        id         TEXT PRIMARY KEY,
        term       TEXT NOT NULL,
        starred    INTEGER NOT NULL DEFAULT 0,
        source     TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER
      );

      INSERT INTO voice_vocab_new (id, term, starred, source, created_at)
      SELECT id, term, starred, source, created_at
      FROM (
        SELECT id, term, starred, source, created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY lower(term)
                 ORDER BY (CASE WHEN source = 'manual' THEN 0 ELSE 1 END),
                          (CASE WHEN starred = 1 THEN 0 ELSE 1 END),
                          created_at DESC
               ) AS rn
        FROM voice_vocab
      ) WHERE rn = 1;

      DROP TABLE voice_vocab;
      ALTER TABLE voice_vocab_new RENAME TO voice_vocab;

      CREATE UNIQUE INDEX IF NOT EXISTS ux_voice_vocab_term ON voice_vocab(term COLLATE NOCASE);
    `)
  },
}
