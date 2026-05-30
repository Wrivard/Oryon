import { app } from 'electron'
import { join, dirname } from 'path'
import { existsSync, copyFileSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { runMigrations } from './migrations'

let db: Database.Database | null = null

/**
 * Migration one-time du renommage BridgeForge → Oryon : si la DB Oryon n'existe pas encore mais que
 * l'ancienne (%APPDATA%/BridgeForge/bridgeforge.db) existe, on la replie (checkpoint WAL) puis copie.
 * Best-effort : un échec ne bloque pas le démarrage (on repart simplement sur une DB neuve).
 */
function migrateLegacyDbIfNeeded(newDbPath: string): void {
  // PROD uniquement : le build dev (userData « Oryon Dev ») démarre VIERGE et ne touche pas l'ancienne DB
  // BridgeForge. Sinon dev + prod, à leur 1er lancement, checkpointeraient/copieraient en concurrence le
  // MÊME fichier legacy %APPDATA%/BridgeForge/bridgeforge.db (course d'écriture). Dev = environnement neuf.
  if (!app.isPackaged) return
  if (existsSync(newDbPath)) return
  const userData = dirname(newDbPath)
  const legacy = join(dirname(userData), 'BridgeForge', 'bridgeforge.db')
  if (!existsSync(legacy)) return
  try {
    const old = new Database(legacy)
    old.pragma('wal_checkpoint(TRUNCATE)') // folde le WAL dans le fichier principal avant copie
    old.close()
    mkdirSync(userData, { recursive: true })
    copyFileSync(legacy, newDbPath)
    console.log('[DB] Migration BridgeForge → Oryon effectuée')
  } catch (e) {
    console.error('[DB] Migration BridgeForge → Oryon échouée (DB neuve) :', e)
  }
}

/**
 * Ouvre (ou crée) la base SQLite dans le dossier userData d'Electron,
 * active les pragmas de sécurité/perf, puis applique les migrations en attente.
 * Idempotent : un second appel renvoie la connexion existante.
 */
export function initDb(): Database.Database {
  if (db) return db

  const dbPath = join(app.getPath('userData'), 'oryon.db')
  // userData = %APPDATA%/Oryon sur Windows (cf. app.setName). On migre l'ancienne DB BridgeForge si besoin.
  migrateLegacyDbIfNeeded(dbPath)
  db = new Database(dbPath)

  // WAL = lectures concurrentes pendant l'écriture ; FK = intégrité référentielle (ON DELETE CASCADE).
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const applied = runMigrations(db)
  const version = db.pragma('user_version', { simple: true })
  console.log(`[DB] Prête : ${dbPath} (migrations appliquées: ${applied}, user_version=${version})`)

  return db
}

/** Renvoie la connexion. Lance si initDb() n'a pas encore été appelé. */
export function getDb(): Database.Database {
  if (!db) throw new Error('DB non initialisée — appeler initDb() au démarrage du main process.')
  return db
}

/** Ferme proprement la connexion (à appeler sur app quit). */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
