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

// Repositionne le widget en bas-à-droite de la zone de travail de l'écran principal (marges d'origine).
function positionBottomRight(): void {
  if (!widget || widget.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  widget.setPosition(workArea.x + workArea.width - W - 24, workArea.y + workArea.height - H - 28)
}

// Si le widget ne recoupe plus aucun moniteur (débranché / résolution changée), le ramène sur l'écran principal.
function clampToVisibleArea(): void {
  if (!widget || widget.isDestroyed()) return
  const b = widget.getBounds()
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.bounds
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
  })
  if (!onScreen) positionBottomRight()
}

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

  positionBottomRight()
  clampToVisibleArea() // position visible garantie dès la création (multi-moniteur)

  const url = process.env['ELECTRON_RENDERER_URL']
  if (url) widget.loadURL(`${url}#voice-widget`)
  else widget.loadURL('app://oryon/index.html#voice-widget') // prod : app:// (cf. index.ts)

  widget.once('ready-to-show', () => widget?.show())

  // Re-clampe si un moniteur est débranché / la résolution change pendant que le widget vit.
  const onDisplayChange = (): void => clampToVisibleArea()
  screen.on('display-removed', onDisplayChange)
  screen.on('display-metrics-changed', onDisplayChange)

  widget.on('closed', () => {
    screen.removeListener('display-removed', onDisplayChange)
    screen.removeListener('display-metrics-changed', onDisplayChange)
    widget = null
  })
}

export function destroyVoiceWidget(): void {
  if (widget && !widget.isDestroyed()) widget.close()
  widget = null
}

/** Vrai si la fenêtre donnée EST le widget flottant — sert à l'exclure des diffusions de toggle (voice:requestToggle). */
export function isVoiceWidget(w: BrowserWindow): boolean {
  return w === widget
}

/** Pousse l'état courant de la dictée vers le widget (depuis la fenêtre principale via le main). */
export function sendVoiceState(state: VoiceState): void {
  if (widget && !widget.isDestroyed()) widget.webContents.send('voice:state', state)
}
