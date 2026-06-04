import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Eye, EyeOff, ExternalLink, KeyRound, LogOut, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { CalendarAuthStatus, CalendarListEntry } from '@shared/types'

// Section « Google Calendar » des réglages : enregistre les identifiants OAuth (client Desktop),
// lance/coupe la connexion, et liste les calendriers de l'utilisateur (lecture seule). Le rendu des
// events appartient à la vue Calendar (lot B) ; ici on ne gère QUE la connexion. Tout passe par
// window.bridge.calendar.* (contrat gelé). OAuth Google → aucun appel Claude (coût $0).

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials'

export function CalendarSection() {
  const [status, setStatus] = useState<CalendarAuthStatus | null>(null) // null = chargement initial
  const [statusError, setStatusError] = useState('') // échec de lecture du statut (backend absent / erreur)
  const [calendars, setCalendars] = useState<CalendarListEntry[]>([])
  const [calError, setCalError] = useState('')

  // Identifiants OAuth (Client ID + Secret). Le formulaire est imposé tant qu'aucun identifiant n'est
  // enregistré ; une fois enregistré, repliable et ré-ouvrable via « Modifier les identifiants ».
  const [credOpen, setCredOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [savingCreds, setSavingCreds] = useState(false)

  const [connecting, setConnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [error, setError] = useState('') // erreur d'une opération (connect / disconnect / setCredentials)

  const loadCalendars = useCallback(async () => {
    setCalError('')
    try {
      setCalendars(await window.bridge.calendar.listCalendars())
    } catch (e) {
      setCalError(msg(e))
    }
  }, [])

  const refresh = useCallback(async () => {
    setStatusError('')
    try {
      const s = await window.bridge.calendar.status()
      setStatus(s)
      if (s.connected) void loadCalendars()
      else setCalendars([])
    } catch (e) {
      setStatusError(msg(e))
    }
  }, [loadCalendars])

  // Statut initial + rafraîchissement quand le main signale un changement (connect/disconnect/expiration).
  useEffect(() => {
    void refresh()
    window.bridge.calendar.onChanged(() => void refresh())
    return () => window.bridge.calendar.offChanged()
  }, [refresh])

  const saveCreds = async () => {
    if (!clientId.trim() || !clientSecret.trim()) return
    setSavingCreds(true)
    setError('')
    try {
      await window.bridge.calendar.setCredentials(clientId.trim(), clientSecret.trim())
      setClientId('')
      setClientSecret('')
      setShowSecret(false)
      setCredOpen(false)
      await refresh()
    } catch (e) {
      setError(msg(e))
    } finally {
      setSavingCreds(false)
    }
  }

  const doConnect = async () => {
    setConnecting(true)
    setError('')
    try {
      const s = await window.bridge.calendar.connect()
      setStatus(s)
      if (s.connected) void loadCalendars()
    } catch (e) {
      setError(msg(e))
    } finally {
      setConnecting(false)
    }
  }

  const doDisconnect = async () => {
    setError('')
    try {
      await window.bridge.calendar.disconnect()
      setConfirmDisconnect(false)
      await refresh()
    } catch (e) {
      setError(msg(e))
    }
  }

  // Formulaire d'identifiants : imposé sans identifiants, sinon affiché à la demande.
  const showCredForm = !!status && (!status.hasCredentials || credOpen)

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          <CalendarDays size={12} /> Google Calendar
        </h3>
        {status?.connected && (
          <button
            onClick={() => void loadCalendars()}
            title="Recharger les calendriers"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent"
          >
            <RefreshCw size={12} /> Recharger
          </button>
        )}
      </div>

      {!status ? (
        statusError ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-3 text-center">
            <p className="text-[11px] text-danger">{statusError}</p>
            <button
              onClick={() => void refresh()}
              className="mt-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent"
            >
              <RefreshCw size={11} /> Réessayer
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-fg-subtle">Chargement…</p>
        )
      ) : (
        <div className="space-y-3">
          {/* État de connexion */}
          <div className="rounded-lg border border-border bg-bg-inset px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  status.connected ? 'bg-green-500' : status.hasCredentials ? 'bg-amber-400' : 'bg-fg-subtle/40',
                )}
              />
              <span className="truncate text-[12px] text-fg">
                {status.connected
                  ? `Connecté${status.email ? ` — ${status.email}` : ''}`
                  : status.hasCredentials
                    ? 'Identifiants enregistrés — non connecté'
                    : 'Identifiants OAuth requis'}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {status.connected ? (
                  confirmDisconnect ? (
                    <>
                      <button
                        onClick={() => setConfirmDisconnect(false)}
                        className="rounded px-2 py-0.5 text-[11px] text-fg-subtle hover:text-fg"
                      >
                        Annuler
                      </button>
                      <button
                        onClick={() => void doDisconnect()}
                        className="rounded-md bg-danger px-2 py-0.5 text-[11px] font-medium text-white transition hover:opacity-90"
                      >
                        Déconnecter
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDisconnect(true)}
                      title="Déconnecter et purger les jetons"
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-danger"
                    >
                      <LogOut size={12} /> Déconnecter
                    </button>
                  )
                ) : (
                  status.hasCredentials && (
                    <button
                      onClick={() => void doConnect()}
                      disabled={connecting}
                      className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover disabled:opacity-40"
                    >
                      {connecting ? 'Connexion…' : 'Connecter mon compte'}
                    </button>
                  )
                )}
              </div>
            </div>
            {/* Dernière erreur OAuth remontée par le main (ex. flow annulé, jeton refusé). */}
            {status.error && <p className="mt-1.5 break-words text-[11px] text-danger">{status.error}</p>}
          </div>

          {error && <p className="text-[11px] text-danger">{error}</p>}

          {/* Calendriers de l'utilisateur (lecture seule), une fois connecté. */}
          {status.connected && (
            <div className="space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Calendriers</span>
              {calError ? (
                <p className="text-[11px] text-danger">{calError}</p>
              ) : calendars.length === 0 ? (
                <p className="text-[11px] text-fg-subtle">Aucun calendrier.</p>
              ) : (
                calendars.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 rounded-md border border-border bg-bg-panel px-2 py-1">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full border border-border"
                      style={c.backgroundColor ? { backgroundColor: c.backgroundColor } : undefined}
                    />
                    <span className="truncate text-[12px] text-fg">{c.summary}</span>
                    {c.primary && (
                      <span className="shrink-0 rounded bg-accent-soft px-1.5 py-px text-[9px] uppercase tracking-wide text-accent">
                        principal
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* Identifiants OAuth : formulaire imposé sans identifiants, sinon repliable. */}
          {showCredForm ? (
            <div className="space-y-2 rounded-lg border border-border bg-bg-inset p-2.5">
              <p className="text-[11px] text-fg-subtle">
                Crée un client OAuth de type « Desktop » dans la{' '}
                <a
                  href={CONSOLE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-accent transition-colors hover:underline"
                >
                  Google Cloud Console <ExternalLink size={10} />
                </a>
                , active l'API Google Calendar, puis colle le Client ID et le Secret ci-dessous.
              </p>
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Client ID"
                className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
              />
              <div className="flex gap-1">
                <input
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Client Secret"
                  type={showSecret ? 'text' : 'password'}
                  className="flex-1 rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                />
                <button
                  onClick={() => setShowSecret((s) => !s)}
                  title={showSecret ? 'Masquer' : 'Afficher'}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:text-fg"
                >
                  {showSecret ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
              <div className="flex justify-end gap-2">
                {status.hasCredentials && (
                  <button
                    onClick={() => {
                      setCredOpen(false)
                      setClientId('')
                      setClientSecret('')
                      setShowSecret(false)
                    }}
                    className="rounded px-2 py-1 text-[11px] text-fg-subtle hover:text-fg"
                  >
                    Annuler
                  </button>
                )}
                <button
                  onClick={() => void saveCreds()}
                  disabled={savingCreds || !clientId.trim() || !clientSecret.trim()}
                  className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover disabled:opacity-40"
                >
                  {savingCreds ? 'Enregistrement…' : 'Enregistrer les identifiants'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCredOpen(true)}
              className="flex items-center gap-1 text-[11px] text-fg-subtle transition-colors hover:text-accent"
            >
              <KeyRound size={11} /> Modifier les identifiants
            </button>
          )}
        </div>
      )}
    </section>
  )
}
