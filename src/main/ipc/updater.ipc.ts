import { ipcMain } from 'electron'
import { checkUpdate, downloadUpdate, installUpdate, getUpdaterState, setUpdateChannel } from '../services/updater'
import type { UpdateChannel, UpdaterState } from '../../shared/types'

export function registerUpdaterIpc(): void {
  ipcMain.handle('update:check', (): Promise<UpdaterState> => checkUpdate())
  ipcMain.handle('update:download', (): void => downloadUpdate())
  ipcMain.handle('update:getState', (): UpdaterState => getUpdaterState())
  ipcMain.handle('update:setChannel', (_e, ch: UpdateChannel): Promise<UpdaterState> => setUpdateChannel(ch))
  ipcMain.on('update:install', () => installUpdate())
}
