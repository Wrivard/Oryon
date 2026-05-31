import type { Database } from 'better-sqlite3'

/**
 * Migration v10 : nettoyage (« prune ») des lignes Voice dégénérées.
 * Une fois les index UNIQUE NOCASE en place (007/009) et les inserts manuels normalisés (trim côté
 * voice.ipc.ts), on purge les lignes qui ne servent à rien et que d'anciennes saisies / imports CSV ont
 * pu laisser :
 * - voice_replacements : règle vide (spoken/replacement blanc) ou no-op (spoken === replacement → n'altère
 *   rien). Comparaison EXACTE (sans NOCASE) pour préserver les corrections de casse légitimes ('Github' →
 *   'GitHub'). Cohérent avec learn.ts qui ne crée jamais de règle no-op.
 * - voice_vocab : terme blanc (inutile, et collait à l'index UNIQUE NOCASE).
 * - voice_snippets : trigger ou expansion blanc (inexploitable).
 * Purge idempotente, sans perte de donnée utile. NE touche PAS voice_history ni voice_corrections_log
 * (agrégés par les stats / réexploitables par la boucle d'apprentissage).
 */
export const migration010 = {
  version: 10,
  name: 'voice_prune',
  up: (db: Database) => {
    db.exec(`
      DELETE FROM voice_replacements
      WHERE TRIM(COALESCE(spoken, '')) = ''
         OR TRIM(COALESCE(replacement, '')) = ''
         OR spoken = replacement;

      DELETE FROM voice_vocab
      WHERE TRIM(COALESCE(term, '')) = '';

      DELETE FROM voice_snippets
      WHERE TRIM(COALESCE(trigger, '')) = ''
         OR TRIM(COALESCE(expansion, '')) = '';
    `)
  },
}
