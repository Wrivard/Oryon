import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { VoiceState } from '../../shared/types'

// Widget vocal flottant : petite fenêtre frameless/transparente always-on-top qui affiche l'état
// (Idle/Listening/Processing), draggable, double-clic = toggle. Charge le renderer en mode #voice-widget.
// Elle N'enregistre PAS : c'est la fenêtre principale (useVoice) qui capte/transcrit ; le widget reçoit
// l'état (voice:state) et renvoie les demandes de toggle (voice:requestToggle) via le main.

const W = 84
const H = 30
let widget: BrowserWindow | null = null

export function createVoiceWidget(): void {
  if (widget && !widget.isDestroyed()) {
    widget.show()
    return
  }
  widget = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  widget.setAlwaysOnTop(true, 'screen-saver') // au-dessus de tout, même plein écran

  const { workArea } = screen.getPrimaryDisplay()
  widget.setPosition(workArea.x + workArea.width - W - 24, workArea.y + workArea.height - H - 28)

  const url = process.env['ELECTRON_RENDERER_URL']
  if (url) widget.loadURL(`${url}#voice-widget`)
  else widget.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'voice-widget' })

  widget.once('ready-to-show', () => widget?.show())
  widget.on('closed', () => (widget = null))
}

export function destroyVoiceWidget(): void {
  if (widget && !widget.isDestroyed()) widget.close()
  widget = null
}

/** Pousse l'état courant de la dictée vers le widget (depuis la fenêtre principale via le main). */
export function sendVoiceState(state: VoiceState): void {
  if (widget && !widget.isDestroyed()) widget.webContents.send('voice:state', state)
}
