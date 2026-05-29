import type { Database } from 'better-sqlite3'

/**
 * Migration v5 : module Voice (Phase 4).
 * - voice_replacements : dictionnaire de remplacements post-transcription (spoken → replacement).
 * - voice_history : historique des dictées (texte, durée, nb de mots, cible d'injection).
 * La config Voice (modèle, hotkey, mode, cible) vit dans app_settings (clés voice.*).
 */
export const migration005 = {
  version: 5,
  name: 'voice',
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS voice_replacements (
        id          TEXT PRIMARY KEY,
        spoken      TEXT NOT NULL,
        replacement TEXT NOT NULL,
        created_at  INTEGER
      );

      CREATE TABLE IF NOT EXISTS voice_history (
        id          TEXT PRIMARY KEY,
        text        TEXT NOT NULL,
        duration_ms INTEGER,
        word_count  INTEGER,
        source      TEXT,            -- 'orchestrator' | 'terminal'
        created_at  INTEGER
      );
    `)
  },
}
