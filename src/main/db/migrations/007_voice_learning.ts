import type { Database } from 'better-sqlite3'

/**
 * Migration v7 : Voice++ apprentissage (07b).
 * - voice_replacements (créée en 005 : id, spoken, replacement, created_at) → +source, +index unique
 *   sur spoken (NOCASE) après dédoublonnage. Réconciliation 07b §3 : spoken=wrong, replacement=correct
 *   (PAS de renommage, sinon casse voice.ipc/applyDictionary/preload/types/UI).
 * - voice_snippets : expansions vocales (trigger → expansion), distinct du dictionnaire.
 * - voice_corrections_log : boucle d'apprentissage (paires injecté/corrigé, statut classifieur).
 * NE recrée PAS voice_vocab (déjà en migration 006).
 */
export const migration007 = {
  version: 7,
  name: 'voice_learning',
  up: (db: Database) => {
    // +source (idempotent : SQLite lève si la colonne existe déjà).
    try {
      db.exec(`ALTER TABLE voice_replacements ADD COLUMN source TEXT DEFAULT 'manual'`)
    } catch {
      /* colonne déjà présente */
    }
    // Dédoublonnage par spoken (NOCASE) AVANT l'index unique : garder la ligne la plus récente.
    db.exec(`
      DELETE FROM voice_replacements WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY lower(spoken) ORDER BY created_at DESC) AS rn
          FROM voice_replacements
        ) WHERE rn = 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_voice_replacements_spoken ON voice_replacements(spoken COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS voice_snippets (
        id         TEXT PRIMARY KEY,
        trigger    TEXT NOT NULL,
        expansion  TEXT NOT NULL,
        created_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_voice_snippets_trigger ON voice_snippets(trigger COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS voice_corrections_log (
        id            TEXT PRIMARY KEY,
        injected      TEXT,
        edited        TEXT,
        full_injected TEXT,
        full_edited   TEXT,
        context       TEXT,
        classified    INTEGER DEFAULT 0,
        learned       INTEGER DEFAULT 0,
        ts            INTEGER
      );
    `)
  },
}
