import type { Database } from 'better-sqlite3'

/**
 * Migration v12 : préférences du panneau Browser, par workspace (passe d'optim Browser).
 *  - browser_recents   : JSON BrowserRecent[]  (URLs récemment visitées, dédupliquées, cap)
 *  - browser_favorites : JSON BrowserFavorite[] (URLs épinglées)
 *  - last_browser_url  : dernière URL ouverte (auto-restore au mount du panneau)
 * ALTER ADD COLUMN est sûr + idempotent au niveau migration (gate user_version).
 */
export const migration012 = {
  version: 12,
  name: 'browser_prefs',
  up: (db: Database) => {
    db.exec(`ALTER TABLE workspaces ADD COLUMN browser_recents TEXT`)
    db.exec(`ALTER TABLE workspaces ADD COLUMN browser_favorites TEXT`)
    db.exec(`ALTER TABLE workspaces ADD COLUMN last_browser_url TEXT`)
  },
}
