import { ipcMain, BrowserWindow } from 'electron'
import * as gc from '../services/google-calendar'

// Google Calendar (read-only v1) — IPC fin par-dessus le service google-calendar.ts (OAuth PKCE + Calendar v3).
// Les changements d'état de connexion (connect/disconnect/setCredentials) émettent 'calendar:changed' pour que
// la vue Calendar et la section Settings se rafraîchissent en direct. status/listCalendars/events sont de simples
// passe-plats (le service gère jetons, refresh et normalisation).

function broadcast(channel: string): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel)
}

export function registerCalendarIpc(): void {
  ipcMain.handle('calendar:status', () => gc.getAuthStatus())
  ipcMain.handle('calendar:setCredentials', (_e, clientId: string, clientSecret: string) => {
    const r = gc.setCredentials(String(clientId ?? ''), String(clientSecret ?? ''))
    broadcast('calendar:changed') // hasCredentials a changé (et une reconfig invalide les jetons)
    return r
  })
  ipcMain.handle('calendar:connect', async () => {
    const status = await gc.connect()
    broadcast('calendar:changed')
    return status
  })
  ipcMain.handle('calendar:disconnect', () => {
    const r = gc.disconnect()
    broadcast('calendar:changed')
    return r
  })
  ipcMain.handle('calendar:listCalendars', () => gc.listCalendars())
  ipcMain.handle('calendar:events', (_e, opts: { timeMin: string; timeMax: string; calendarId?: string }) =>
    gc.listEvents(opts),
  )
}
