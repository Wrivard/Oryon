import { ipcMain, dialog, BrowserWindow } from 'electron'

export function registerDialogIpc() {
  ipcMain.handle('dialog:pickFolder', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { properties: ['openDirectory', 'createDirectory'] as const }
    const res = win
      ? await dialog.showOpenDialog(win, { properties: [...opts.properties] })
      : await dialog.showOpenDialog({ properties: [...opts.properties] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })
}
