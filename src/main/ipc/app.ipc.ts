import { app, ipcMain } from 'electron'

// Infos de l'app exposées au renderer (version affichée en bas du rail + marqueur dev).
// isDev = !app.isPackaged → MÊME signal que le split d'identité dev/prod (cf. index.ts setName), donc le
// « (dev) » s'affiche exactement quand l'app tourne sous l'identité « Oryon Dev » (userData séparé).
export function registerAppIpc(): void {
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), isDev: !app.isPackaged }))
}
