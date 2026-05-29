/* eslint-disable @typescript-eslint/no-explicit-any */
import { app, BrowserWindow } from 'electron'
import { appSetting, setAppSetting } from '../ipc/settings.ipc'
import type { UpdaterState, UpdateChannel } from '../../shared/types'

// Auto-update brandé (electron-updater) avec deux canaux (stable / dev), pilotage MANUEL (autoDownload=false)
// → toast + UI Settings. Le canal est persisté en DB (app_settings 'update.channel', survit aux updates).
// Import dynamique : electron-updater n'est chargé qu'en build packagé (ou ORYON_FORCE_DEV_UPDATE=1 pour tester).

let updater: any = null
let state: UpdaterState = { phase: 'idle', channel: 'stable', currentVersion: '0.0.0' }

function channelFromSettings(): UpdateChannel {
  return appSetting('update.channel') === 'dev' ? 'dev' : 'stable'
}
function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:event', { type: 'state', state })
}
function patch(p: Partial<UpdaterState>): void {
  state = { ...state, ...p }
  broadcast()
}
function applyChannel(ch: UpdateChannel): void {
  if (updater) {
    if (ch === 'dev') {
      updater.channel = 'dev'
      updater.allowPrerelease = true
      updater.allowDowngrade = true // permet de revenir de dev → stable
    } else {
      updater.channel = null
      updater.allowPrerelease = false
      updater.allowDowngrade = false
    }
  }
  state.channel = ch
}

export async function initUpdater(): Promise<void> {
  const ch = channelFromSettings()
  state = { phase: 'idle', channel: ch, currentVersion: app.getVersion() }
  const forceDev = process.env.ORYON_FORCE_DEV_UPDATE === '1'
  if (!app.isPackaged && !forceDev) {
    state.phase = 'unsupported' // dev : pas d'auto-update (sauf override de test)
    return
  }
  try {
    const mod: any = await import('electron-updater')
    updater = mod.autoUpdater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    if (forceDev) updater.forceDevUpdateConfig = true
    applyChannel(ch)
    updater.on('checking-for-update', () => patch({ phase: 'checking', error: undefined }))
    updater.on('update-available', (info: any) =>
      patch({
        phase: 'available',
        available: {
          version: info?.version,
          releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
          releaseDate: info?.releaseDate,
        },
      }),
    )
    updater.on('update-not-available', () => patch({ phase: 'up-to-date' }))
    updater.on('download-progress', (p: any) =>
      patch({ phase: 'downloading', progress: { percent: p?.percent ?? 0, bytesPerSecond: p?.bytesPerSecond ?? 0, transferred: p?.transferred ?? 0, total: p?.total ?? 0 } }),
    )
    updater.on('update-downloaded', () => patch({ phase: 'downloaded' }))
    updater.on('error', (e: any) => patch({ phase: 'error', error: e?.message ?? String(e) }))
    setTimeout(() => updater.checkForUpdates().catch(() => {}), 3000) // check silencieux au boot
  } catch (e) {
    state = { ...state, phase: 'error', error: (e as Error).message }
  }
}

export function getUpdaterState(): UpdaterState {
  return state
}
export async function checkUpdate(): Promise<UpdaterState> {
  if (updater) {
    patch({ phase: 'checking', error: undefined })
    await updater.checkForUpdates().catch((e: any) => patch({ phase: 'error', error: e?.message ?? String(e) }))
  }
  return state
}
export function downloadUpdate(): void {
  if (!updater) return
  patch({ phase: 'downloading', progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 } })
  updater.downloadUpdate().catch((e: any) => patch({ phase: 'error', error: e?.message ?? String(e) }))
}
export function installUpdate(): void {
  if (updater) setImmediate(() => updater.quitAndInstall(false, true))
}
export async function setUpdateChannel(ch: UpdateChannel): Promise<UpdaterState> {
  setAppSetting('update.channel', ch)
  applyChannel(ch)
  broadcast()
  return checkUpdate()
}
