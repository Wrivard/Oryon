import { shell } from 'electron'
import { createServer } from 'http'
import { createHash, randomBytes } from 'crypto'
import { encryptString, decryptString, getSetting, setSetting, delSetting } from './secure-store'
import type { CalendarAuthStatus, CalendarEvent, CalendarListEntry } from '../../shared/types'

// Google Calendar (feature Calendar, read-only v1). Intégration SANS dépendance native ni SDK googleapis :
// OAuth 2.0 PKCE pour client « Desktop » (navigateur système + redirection loopback http://127.0.0.1:PORT),
// puis appels REST Calendar v3 en `fetch` natif. Les secrets (client secret + refresh token) sont chiffrés
// au repos via secure-store (Electron safeStorage) et persistés dans la table
// clé/valeur app_settings ; le client ID et l'email du compte y sont stockés en clair. Le jeton d'accès n'est
// gardé qu'en mémoire (rafraîchi à la demande). L'utilisateur fournit lui-même son client OAuth Google
// (Client ID/Secret) via la section Settings → calendar:setCredentials.

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'
const CAL_BASE = 'https://www.googleapis.com/calendar/v3'
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')
const CONNECT_TIMEOUT_MS = 5 * 60_000
const CALLIST_TTL_MS = 5 * 60_000

// clés app_settings
const K_CLIENT_ID = 'calendar.clientId'
const K_CLIENT_SECRET = 'calendar.clientSecret' // chiffré
const K_REFRESH = 'calendar.refreshToken' // chiffré
const K_EMAIL = 'calendar.email'

// ---- état en mémoire (jamais persisté) ----
let accessToken: string | null = null
let accessTokenExp = 0
let connecting = false
let colorsCache: GColors | null = null
let calListCache: CalendarListEntry[] | null = null
let calListExp = 0

// ---- app_settings (clé/valeur) + secrets chiffrés : impl partagée dans secure-store (plan 010). ----
// Alias locaux = diff minimal (le reste du fichier garde get/set/del/enc/dec).
const get = getSetting
const set = setSetting
const del = delSetting
const enc = encryptString
const dec = decryptString

function getClientId(): string {
  return get(K_CLIENT_ID) ?? ''
}
function getClientSecret(): string {
  return dec(get(K_CLIENT_SECRET))
}
function getRefreshToken(): string {
  return dec(get(K_REFRESH))
}
function hasCredentials(): boolean {
  return !!getClientId() && !!getClientSecret()
}

function clearTokens(): void {
  del(K_REFRESH)
  del(K_EMAIL)
  accessToken = null
  accessTokenExp = 0
  colorsCache = null
  calListCache = null
  calListExp = 0
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ─────────────────────────────────────────────────────────── PKCE ──────────
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

// ─────────────────────────────────────────────────── flow loopback ──────────
const RESPONSE_HTML = (error: string | null): string =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Oryon — Google Calendar</title>` +
  `<style>body{font:15px system-ui,sans-serif;background:#0b0b0d;color:#e7e7ea;display:grid;place-items:center;height:100vh;margin:0}` +
  `div{text-align:center;max-width:32rem;padding:2rem}h1{font-size:1.1rem}</style></head><body><div>` +
  (error
    ? `<h1>Connexion refusée</h1><p>${error}. Vous pouvez fermer cet onglet et réessayer depuis Oryon.</p>`
    : `<h1>Compte connecté ✓</h1><p>Vous pouvez fermer cet onglet et revenir à Oryon.</p>`) +
  `</div></body></html>`

/** Démarre un serveur loopback éphémère, ouvre le navigateur système sur l'écran de consentement Google,
 *  et résout avec le code d'autorisation reçu sur la redirection (ou rejette sur refus / délai / CSRF). */
function runLoopbackFlow(challenge: string, state: string): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = ''
    let timer: ReturnType<typeof setTimeout>
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const code = url.searchParams.get('code')
        const err = url.searchParams.get('error')
        const st = url.searchParams.get('state')
        if (!code && !err) {
          res.writeHead(204)
          res.end()
          return // requêtes parasites du navigateur (favicon, etc.)
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(RESPONSE_HTML(err))
        cleanup()
        if (err) return reject(new Error(`autorisation refusée (${err})`))
        if (st !== state) return reject(new Error('état OAuth invalide (CSRF)'))
        if (!code) return reject(new Error('code d’autorisation manquant'))
        resolve({ code, redirectUri })
      } catch (e) {
        cleanup()
        reject(e)
      }
    })
    const cleanup = (): void => {
      clearTimeout(timer)
      try {
        server.close()
      } catch {
        /* déjà fermé */
      }
    }
    server.on('error', (e) => {
      cleanup()
      reject(e)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      redirectUri = `http://127.0.0.1:${port}`
      const authUrl =
        `${AUTH_ENDPOINT}?` +
        new URLSearchParams({
          client_id: getClientId(),
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
          state,
        }).toString()
      void shell.openExternal(authUrl)
    })
    timer = setTimeout(() => {
      cleanup()
      reject(new Error('délai de connexion dépassé'))
    }, CONNECT_TIMEOUT_MS)
  })
}

// ──────────────────────────────────────────────────────── jetons ────────────
interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  error?: string
  error_description?: string
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const json = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok) {
    throw new Error(`OAuth ${res.status} : ${json.error_description || json.error || res.statusText}`)
  }
  return json
}

async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
  return postToken({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  })
}

async function refreshAccessToken(): Promise<void> {
  const rt = getRefreshToken()
  if (!rt) throw new Error('non connecté à Google Calendar')
  let json: TokenResponse
  try {
    json = await postToken({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      refresh_token: rt,
      grant_type: 'refresh_token',
    })
  } catch (e) {
    // refresh token révoqué/expiré (invalid_grant) → on se déconnecte pour forcer une reconnexion propre
    if (/\b400\b|\b401\b|invalid_grant/i.test(errMsg(e))) clearTokens()
    throw e
  }
  if (!json.access_token) throw new Error('jeton d’accès absent de la réponse OAuth')
  accessToken = json.access_token
  accessTokenExp = Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000 // marge anti-dérive d'horloge
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessTokenExp) return accessToken
  await refreshAccessToken()
  if (!accessToken) throw new Error('jeton d’accès indisponible')
  return accessToken
}

// ─────────────────────────────────────────────────── Calendar v3 ────────────
interface GColors {
  event?: Record<string, { background?: string }>
}
interface GCalListItem {
  id?: string
  summary?: string
  summaryOverride?: string
  primary?: boolean
  backgroundColor?: string
}
interface GEventDate {
  date?: string
  dateTime?: string
}
interface GEvent {
  id?: string
  status?: string
  summary?: string
  location?: string
  description?: string
  colorId?: string
  htmlLink?: string
  start?: GEventDate
  end?: GEventDate
}

/** GET authentifié sur l'API Calendar, avec une tentative de refresh sur 401. */
async function gapi<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(CAL_BASE + path)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let res = await fetch(url, { headers: { Authorization: `Bearer ${await getAccessToken()}` } })
  if (res.status === 401) {
    await refreshAccessToken()
    res = await fetch(url, { headers: { Authorization: `Bearer ${await getAccessToken()}` } })
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) throw new Error(`Google API ${res.status} : ${json?.error?.message || res.statusText}`)
  return json
}

async function fetchColors(): Promise<GColors | null> {
  if (colorsCache) return colorsCache
  colorsCache = await gapi<GColors>('/colors')
  return colorsCache
}

async function fetchEmail(): Promise<string | undefined> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${await getAccessToken()}` } })
    if (!res.ok) return undefined
    const json = (await res.json().catch(() => ({}))) as { email?: string }
    return json.email
  } catch {
    return undefined
  }
}

async function getCalendars(): Promise<CalendarListEntry[]> {
  if (calListCache && Date.now() < calListExp) return calListCache
  const data = await gapi<{ items?: GCalListItem[] }>('/users/me/calendarList', { minAccessRole: 'reader' })
  calListCache = (data.items ?? []).map((c) => ({
    id: String(c.id),
    summary: String(c.summaryOverride || c.summary || c.id),
    primary: c.primary === true ? true : undefined,
    backgroundColor: c.backgroundColor || undefined,
  }))
  calListExp = Date.now() + CALLIST_TTL_MS
  return calListCache
}

function normalizeEvent(raw: GEvent, calendarId: string, calBg: string | undefined, colors: GColors | null): CalendarEvent {
  const allDay = !!(raw.start?.date && !raw.start?.dateTime)
  const start = raw.start?.dateTime || raw.start?.date || ''
  const end = raw.end?.dateTime || raw.end?.date || start
  const evColor = raw.colorId ? colors?.event?.[raw.colorId]?.background : undefined
  return {
    id: String(raw.id),
    calendarId,
    title: raw.summary ? String(raw.summary) : '(sans titre)',
    start,
    end,
    allDay,
    location: raw.location || undefined,
    description: raw.description || undefined,
    color: evColor || calBg || undefined, // event colorId résolu, sinon couleur du calendrier
    htmlLink: raw.htmlLink || undefined,
  }
}

function requireConnected(): void {
  if (!hasCredentials()) throw new Error('identifiants OAuth Google manquants')
  if (!getRefreshToken()) throw new Error('non connecté à Google Calendar')
}

// ──────────────────────────────────────────────────── API publique ──────────
export function getAuthStatus(): CalendarAuthStatus {
  return {
    connected: !!getRefreshToken(),
    hasCredentials: hasCredentials(),
    email: get(K_EMAIL) || undefined,
  }
}

/** Enregistre le client OAuth Desktop (Client ID + Secret). Changer d'identifiants invalide les jetons existants. */
export function setCredentials(clientId: string, clientSecret: string): { ok: boolean } {
  const id = (clientId ?? '').trim()
  const secret = (clientSecret ?? '').trim()
  const changed = id !== getClientId() || secret !== getClientSecret()
  set(K_CLIENT_ID, id)
  if (secret) set(K_CLIENT_SECRET, enc(secret))
  else del(K_CLIENT_SECRET)
  if (changed) clearTokens() // l'ancien refresh token appartient à l'ancien client OAuth
  return { ok: true }
}

/** Lance le flow OAuth ; résout TOUJOURS avec un CalendarAuthStatus (champ `error` rempli en cas d'échec). */
export async function connect(): Promise<CalendarAuthStatus> {
  if (!hasCredentials()) {
    return { connected: false, hasCredentials: false, error: 'Identifiants OAuth manquants (Client ID/Secret).' }
  }
  if (connecting) return { ...getAuthStatus(), error: 'Connexion déjà en cours.' }
  connecting = true
  try {
    const { verifier, challenge } = pkce()
    const state = randomBytes(16).toString('hex')
    const { code, redirectUri } = await runLoopbackFlow(challenge, state)
    const tok = await exchangeCode(code, verifier, redirectUri)
    if (tok.refresh_token) set(K_REFRESH, enc(tok.refresh_token))
    if (!getRefreshToken()) throw new Error('aucun refresh token reçu (réautorisez avec « offline »)')
    accessToken = tok.access_token ?? null
    accessTokenExp = Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000
    const email = await fetchEmail()
    if (email) set(K_EMAIL, email)
    return getAuthStatus()
  } catch (e) {
    return { connected: !!getRefreshToken(), hasCredentials: hasCredentials(), email: get(K_EMAIL) || undefined, error: errMsg(e) }
  } finally {
    connecting = false
  }
}

/** Déconnecte : purge les jetons (les identifiants OAuth sont conservés pour permettre une reconnexion). */
export function disconnect(): { ok: boolean } {
  clearTokens()
  return { ok: true }
}

export async function listCalendars(): Promise<CalendarListEntry[]> {
  requireConnected()
  return getCalendars()
}

/** Events sur la fenêtre [timeMin,timeMax] (ISO), tous les calendriers ou un seul (calendarId). */
export async function listEvents(opts: { timeMin: string; timeMax: string; calendarId?: string }): Promise<CalendarEvent[]> {
  requireConnected()
  if (!opts?.timeMin || !opts?.timeMax) throw new Error('timeMin et timeMax requis')
  await getAccessToken() // fait remonter une erreur d'auth en amont (sinon avalée par le try/catch par-calendrier)
  const cals = opts.calendarId
    ? [{ id: opts.calendarId, backgroundColor: undefined as string | undefined }]
    : (await getCalendars()).map((c) => ({ id: c.id, backgroundColor: c.backgroundColor }))
  const colors = await fetchColors().catch(() => null)
  const all: CalendarEvent[] = []
  await Promise.all(
    cals.map(async (cal) => {
      try {
        // singleEvents=true développe les récurrences ; une page (maxResults 2500) suffit pour une vue jour/semaine/mois.
        const data = await gapi<{ items?: GEvent[] }>(`/calendars/${encodeURIComponent(cal.id)}/events`, {
          timeMin: String(opts.timeMin),
          timeMax: String(opts.timeMax),
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '2500',
        })
        for (const raw of data.items ?? []) {
          if (raw.status === 'cancelled' || !raw.id) continue
          all.push(normalizeEvent(raw, cal.id, cal.backgroundColor, colors))
        }
      } catch {
        // un calendrier en échec (droits, 404…) ne doit pas vider toute la fenêtre — les autres restent affichés
      }
    }),
  )
  return all
}
