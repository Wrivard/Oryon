import { registerWorkspacesIpc } from './workspaces.ipc'
import { registerTerminalsIpc } from './terminals.ipc'
import { registerDialogIpc } from './dialog.ipc'
import { registerEditorIpc } from './editor.ipc'
import { registerBrowserIpc } from './browser.ipc'
import { registerOrchestratorIpc } from './orchestrator.ipc'
import { registerSourceIpc } from './source.ipc'
import { registerSettingsIpc } from './settings.ipc'
import { registerVoiceIpc } from './voice.ipc'
import { registerMemoryIpc } from './memory.ipc'
import { registerUpdaterIpc } from './updater.ipc'

export function registerIpcHandlers() {
  registerWorkspacesIpc()
  registerTerminalsIpc()
  registerDialogIpc()
  registerEditorIpc()
  registerBrowserIpc()
  registerOrchestratorIpc()
  registerSourceIpc()
  registerSettingsIpc()
  registerVoiceIpc()
  registerMemoryIpc()
  registerUpdaterIpc()
}
