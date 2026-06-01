import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { VoiceState } from '../../shared/types'
import { appSetting, setAppSetting } from '../ipc/settings.ipc'

// Widget vocal flottant : petite fenêtre frameless/transparente always-on-top qui affiche l'état
// (Idle/Listening/Processing), draggable, double-clic = toggle. Charge le renderer en mode #voice-widget.
// Elle N'enregistre PAS : c'est la fenêtre principale (useVoice) qui capte/transcrit ; le widget reçoit
// l'état (voice:state) et renvoie les demandes de toggle (voice:requestToggle) via le main.

const W = 84
const H = 30
let widget: BrowserWindow | null = null
// Dernier état de dictée connu (poussé par la fenêtre principale via voice:stateChanged) : sert à réhydrater
// un widget créé pendant une capture, qui sinon resterait figé sur l'« idle » d'init (C-8).
let lastState: VoiceState = 'idle'
// Clé app_settings où l'on persiste la position du widget après un drag utilisateur (C-6).
const BOUNDS_KEY = 'voice.widgetBounds'
let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null

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

// Sauve la position du widget (débouncé) dans app_settings — best-effort : la position est un confort (C-6).
function persistWidgetBounds(x: number, y: number): void {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null
    try {
      setAppSetting(BOUNDS_KEY, JSON.stringify({ x, y }))
    } catch {
      /* DB indisponible (ex. arrêt en cours) : la position est non critique */
    }
  }, 400)
}

// Restaure la dernière position sauvegardée du widget. Renvoie false si rien de valide n'est stocké (→ repli bas-droite).
function restoreBounds(): boolean {
  if (!widget || widget.isDestroyed()) return false
  try {
    const raw = appSetting(BOUNDS_KEY)
    if (!raw) return false
    const b = JSON.parse(raw) as { x?: unknown; y?: unknown }
    if (typeof b.x === 'number' && Number.isFinite(b.x) && typeof b.y === 'number' && Number.isFinite(b.y)) {
      widget.setPosition(Math.round(b.x), Math.round(b.y))
      return true
    }
  } catch {
    /* setting corrompu ou DB indisponible → repli bas-droite */
  }
  return false
}

export function createVoiceWidget(): void {
  if (widget && !widget.isDestroyed()) {
    widget.show()
    return
  }
  const w = new BrowserWindow({
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
  widget = w
  w.setAlwaysOnTop(true, 'screen-saver') // au-dessus de tout, même plein écran

  if (!restoreBounds()) positionBottomRight() // restaure la position draggée, sinon repli bas-droite (C-6)
  clampToVisibleArea() // position visible garantie (repli bas-droite si la position sauvée est hors écran)

  const url = process.env['ELECTRON_RENDERER_URL']
  if (url) w.loadURL(`${url}#voice-widget`)
  else w.loadURL('app://oryon/index.html#voice-widget') // prod : app:// (cf. index.ts)

  w.once('ready-to-show', () => {
    w.show()
    // Pousse l'état courant pour ne pas rester sur l'« idle » d'init si le widget naît pendant une capture (C-8).
    // Le renderer s'abonne à 'voice:state' dans un effet de montage (après un import dynamique) : un envoi unique
    // peut précéder l'abonnement, d'où un second envoi peu après (idempotent) pour gagner la course.
    w.webContents.send('voice:state', lastState)
    setTimeout(() => {
      if (widget === w && !w.isDestroyed()) w.webContents.send('voice:state', lastState)
    }, 250)
  })

  // Persiste la position après un drag (débouncé) pour la restaurer aux prochains show / redémarrages (C-6).
  w.on('moved', () => {
    const { x, y } = w.getBounds()
    persistWidgetBounds(x, y)
  })

  // Re-clampe si un moniteur est débranché / la résolution change pendant que le widget vit.
  const onDisplayChange = (): void => clampToVisibleArea()
  screen.on('display-removed', onDisplayChange)
  screen.on('display-metrics-changed', onDisplayChange)

  w.on('closed', () => {
    screen.removeListener('display-removed', onDisplayChange)
    screen.removeListener('display-metrics-changed', onDisplayChange)
    // Ne nulle QUE si on est encore la fenêtre courante : un toggle off→on rapide peut recréer un widget
    // (widget=W2) avant que le 'closed' de l'ancien (W1) ne fire — sans cette garde on annulerait W2 (C-4).
    if (widget === w) widget = null
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
  lastState = state // mémorise pour réhydrater un widget créé plus tard (C-8)
  if (widget && !widget.isDestroyed()) widget.webContents.send('voice:state', state)
}
