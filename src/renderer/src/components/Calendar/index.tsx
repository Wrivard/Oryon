// Vue Calendar (déclenchée par l'entrée « Calendar » du rail). Pièce maîtresse : react-big-calendar
// (vues mois/semaine/jour) habillé au thème sombre Oryon, events lus via window.bridge.calendar.events.
// ⚠ Le lot A importe ce module : NE PAS renommer le named export `CalendarView` ni le rendre props-ful.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { Calendar, dateFnsLocalizer, type Event as RbcBaseEvent, type EventProps, type View } from 'react-big-calendar'
import { format, parse, getDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfDay, endOfDay, addDays, subDays, addMonths, subMonths, addWeeks, subWeeks, isSameDay } from 'date-fns'
import { frCA } from 'date-fns/locale/fr-CA'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, RefreshCw, SlidersHorizontal, MapPin, Clock, X, ArrowUpRight, Loader2, AlertTriangle, Check, KeyRound } from 'lucide-react'
import { cn } from '../../lib/cn'
import { toast } from '../../store/toasts'
import type { CalendarEvent, CalendarAuthStatus, CalendarListEntry } from '@shared/types'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import './calendar.css'

// ── Localizer date-fns (stable, hors composant) ──────────────────────────────────────────────────────────
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales: { 'fr-CA': frCA } })

const MESSAGES = {
  date: 'Date',
  time: 'Heure',
  event: 'Événement',
  allDay: 'Journée',
  week: 'Semaine',
  day: 'Jour',
  month: 'Mois',
  previous: 'Précédent',
  next: 'Suivant',
  today: "Aujourd'hui",
  agenda: 'Agenda',
  noEventsInRange: 'Aucun événement sur cette période.',
  showMore: (total: number) => `+ ${total} de plus`,
}

const VIEW_OPTIONS: { key: View; label: string }[] = [
  { key: 'month', label: 'Mois' },
  { key: 'week', label: 'Semaine' },
  { key: 'day', label: 'Jour' },
]

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────
/** Événement normalisé pour react-big-calendar (Date réelles + référence à l'event source). */
interface RbcEvent {
  id: string
  title: string
  start: Date
  end: Date
  allDay: boolean
  resource: CalendarEvent
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const isHex = (c?: string): c is string => !!c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)

/** Date-only ISO (« 2026-06-04 ») → Date LOCALE (évite le décalage d'un jour via parsing UTC). */
function parseDateOnly(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s)
}

/** CalendarEvent (bridge) → RbcEvent. All-day : fin exclusive Google → inclusive pour l'affichage. */
function toRbc(ev: CalendarEvent): RbcEvent {
  if (ev.allDay) {
    const start = parseDateOnly(ev.start)
    const rawEnd = parseDateOnly(ev.end)
    const end = rawEnd.getTime() > start.getTime() ? subDays(rawEnd, 1) : start
    return { id: ev.id, title: ev.title || '(sans titre)', start, end, allDay: true, resource: ev }
  }
  return { id: ev.id, title: ev.title || '(sans titre)', start: new Date(ev.start), end: new Date(ev.end), allDay: false, resource: ev }
}

/** Fenêtre [timeMin,timeMax] couvrant LARGEMENT la grille visible (padding ⇒ insensible au jour de début). */
function rangeFor(view: View, date: Date): { timeMin: string; timeMax: string } {
  let min: Date
  let max: Date
  if (view === 'day') {
    min = startOfDay(date)
    max = endOfDay(date)
  } else if (view === 'week') {
    min = addDays(startOfWeek(date), -1)
    max = addDays(endOfWeek(date), 1)
  } else {
    min = addDays(startOfMonth(date), -7)
    max = addDays(endOfMonth(date), 7)
  }
  return { timeMin: min.toISOString(), timeMax: max.toISOString() }
}

/** Libellé de la barre d'outils (toolbar custom ⇒ on le calcule nous-mêmes). */
function labelFor(view: View, date: Date): string {
  if (view === 'day') return cap(format(date, 'EEEE d MMMM yyyy', { locale: frCA }))
  if (view === 'week') {
    const s = startOfWeek(date)
    const e = endOfWeek(date)
    return s.getMonth() === e.getMonth()
      ? `${format(s, 'd', { locale: frCA })} – ${cap(format(e, 'd MMMM yyyy', { locale: frCA }))}`
      : `${cap(format(s, 'd MMM', { locale: frCA }))} – ${cap(format(e, 'd MMM yyyy', { locale: frCA }))}`
  }
  return cap(format(date, 'MMMM yyyy', { locale: frCA }))
}

/** Plage horaire lisible pour le popover de détail. */
function formatWhen(ev: CalendarEvent): string {
  if (ev.allDay) {
    const start = parseDateOnly(ev.start)
    const rawEnd = parseDateOnly(ev.end)
    const endIncl = rawEnd.getTime() > start.getTime() ? subDays(rawEnd, 1) : start
    if (isSameDay(start, endIncl)) return `${cap(format(start, 'EEEE d MMMM yyyy', { locale: frCA }))} · toute la journée`
    return `${cap(format(start, 'd MMM', { locale: frCA }))} – ${cap(format(endIncl, 'd MMM yyyy', { locale: frCA }))} · toute la journée`
  }
  const start = new Date(ev.start)
  const end = new Date(ev.end)
  if (isSameDay(start, end)) return `${cap(format(start, 'EEEE d MMMM', { locale: frCA }))} · ${format(start, 'HH:mm')} – ${format(end, 'HH:mm')}`
  return `${cap(format(start, 'd MMM HH:mm', { locale: frCA }))} – ${cap(format(end, 'd MMM HH:mm', { locale: frCA }))}`
}

/** Rendu compact d'un event dans la grille : heure (si timé) + titre. */
function EventContent({ event }: EventProps<RbcBaseEvent>): JSX.Element {
  return (
    <div className="flex items-center gap-1 overflow-hidden leading-tight">
      {!event.allDay && event.start && <span className="shrink-0 text-[0.92em] tabular-nums opacity-70">{format(event.start, 'HH:mm')}</span>}
      <span className="truncate">{typeof event.title === 'string' ? event.title : ''}</span>
    </div>
  )
}

// ── Composant ────────────────────────────────────────────────────────────────────────────────────────────
export function CalendarView(): JSX.Element {
  const [status, setStatus] = useState<CalendarAuthStatus | null>(null)
  const [view, setView] = useState<View>('month')
  const [date, setDate] = useState<Date>(() => new Date())
  const [raw, setRaw] = useState<CalendarEvent[]>([])
  const [calendars, setCalendars] = useState<CalendarListEntry[]>([])
  const [hiddenCals, setHiddenCals] = useState<Set<string>>(() => new Set())
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const [filterOpen, setFilterOpen] = useState(false)
  const [popover, setPopover] = useState<{ ev: CalendarEvent; anchor: DOMRect } | null>(null)
  const [popPos, setPopPos] = useState<{ left: number; top: number } | null>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const connected = status?.connected === true

  const refreshStatus = async () => {
    try {
      setStatus(await window.bridge.calendar.status())
    } catch (e) {
      setStatus({ connected: false, hasCredentials: false, error: (e as Error).message })
    }
  }

  // Montage + abonnement live (connexion/déconnexion ⇒ on rafraîchit statut & events).
  useEffect(() => {
    void refreshStatus()
    const onChanged = () => {
      void refreshStatus()
      setRefreshTick((t) => t + 1)
    }
    window.bridge.calendar.onChanged(onChanged)
    return () => window.bridge.calendar.offChanged(onChanged)
  }, [])

  // Liste des calendriers (légende + filtre) une fois connecté.
  useEffect(() => {
    if (!connected) {
      setCalendars([])
      return
    }
    window.bridge.calendar
      .listCalendars()
      .then(setCalendars)
      .catch(() => setCalendars([]))
  }, [connected, refreshTick])

  // Chargement des events sur la fenêtre visible (refait à chaque changement de vue / date / refresh).
  useEffect(() => {
    if (!connected) {
      setRaw([])
      return
    }
    let cancelled = false
    setLoadingEvents(true)
    setEventsError(null)
    const { timeMin, timeMax } = rangeFor(view, date)
    window.bridge.calendar
      .events({ timeMin, timeMax })
      .then((list) => {
        if (!cancelled) setRaw(list)
      })
      .catch((e) => {
        if (!cancelled) setEventsError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoadingEvents(false)
      })
    return () => {
      cancelled = true
    }
  }, [connected, view, date, refreshTick])

  // Toute navigation ferme le popover de détail.
  useEffect(() => setPopover(null), [view, date])

  const events = useMemo<RbcEvent[]>(
    () => raw.filter((e) => !hiddenCals.has(e.calendarId)).map(toRbc),
    [raw, hiddenCals],
  )

  // Positionnement du popover : à droite de l'event, replié à gauche / clampé au viewport.
  useLayoutEffect(() => {
    if (!popover || !popRef.current) {
      setPopPos(null)
      return
    }
    const r = popRef.current.getBoundingClientRect()
    const a = popover.anchor
    const pad = 8
    let left = a.right + pad
    if (left + r.width > window.innerWidth - pad) left = a.left - r.width - pad
    if (left < pad) left = pad
    let top = a.top
    if (top + r.height > window.innerHeight - pad) top = window.innerHeight - pad - r.height
    if (top < pad) top = pad
    setPopPos({ left, top })
  }, [popover])

  // Esc ferme le popover.
  useEffect(() => {
    if (!popover) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopover(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popover])

  const goToday = () => setDate(new Date())
  const goPrev = () => setDate((d) => (view === 'month' ? subMonths(d, 1) : view === 'week' ? subWeeks(d, 1) : subDays(d, 1)))
  const goNext = () => setDate((d) => (view === 'month' ? addMonths(d, 1) : view === 'week' ? addWeeks(d, 1) : addDays(d, 1)))

  const connect = async () => {
    setConnecting(true)
    try {
      const s = await window.bridge.calendar.connect()
      setStatus(s)
      if (!s.connected && s.error) toast.error(s.error, { title: 'Connexion Google échouée' })
    } catch (e) {
      toast.error((e as Error).message, { title: 'Connexion Google échouée' })
    } finally {
      setConnecting(false)
    }
  }

  const toggleCal = (id: string) =>
    setHiddenCals((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const eventPropGetter = (event: RbcBaseEvent) => {
    const c = (event.resource as CalendarEvent | undefined)?.color
    const col = isHex(c) ? c : undefined
    return {
      style: {
        backgroundColor: col ? `color-mix(in srgb, ${col} 22%, transparent)` : 'var(--accent-soft)',
        borderLeftColor: col || 'var(--accent)',
        color: 'var(--fg)',
      } as CSSProperties,
    }
  }

  const onSelectEvent = (event: RbcBaseEvent, e: SyntheticEvent<HTMLElement>) => {
    const ev = event.resource as CalendarEvent | undefined
    if (!ev) return
    setPopover({ ev, anchor: e.currentTarget.getBoundingClientRect() })
  }

  // ── États non-calendrier (chargement / non connecté / pas d'identifiants) ──────────────────────────────
  let body: JSX.Element
  if (status === null) {
    body = (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-fg-subtle">
        <Loader2 size={14} className="animate-spin" /> Chargement…
      </div>
    )
  } else if (!connected) {
    const hasCreds = status.hasCredentials
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center animate-fade-up">
        {/* Double-bezel : coque + cœur concentriques */}
        <div className="rounded-2xl border border-border bg-bg-elevated p-1.5 shadow-md">
          <div className="rounded-xl bg-bg-panel p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
            {hasCreds ? <CalendarIcon size={24} strokeWidth={1.5} className="text-accent" /> : <KeyRound size={24} strokeWidth={1.5} className="text-fg-subtle" />}
          </div>
        </div>
        <div className="space-y-1.5">
          <h2 className="text-[15px] font-semibold tracking-tight text-fg">{hasCreds ? 'Connecte Google Calendar' : 'Configure l’accès Google Calendar'}</h2>
          <p className="mx-auto max-w-xs text-[12px] leading-relaxed text-fg-subtle">
            {hasCreds
              ? 'Autorise l’accès en lecture pour afficher tes événements ici. Aucune donnée n’est envoyée ailleurs.'
              : 'Ajoute tes identifiants OAuth Google (Client ID + Secret, type Desktop) dans Réglages → Calendar pour activer la connexion.'}
          </p>
          {status.error && <p className="mx-auto max-w-xs text-[11px] text-danger">{status.error}</p>}
        </div>
        {hasCreds && (
          <button
            onClick={() => void connect()}
            disabled={connecting}
            className="group inline-flex items-center gap-2 rounded-full bg-accent py-1.5 pl-4 pr-1.5 text-[12.5px] font-medium text-on-accent transition duration-150 ease-out hover:bg-accent-hover active:scale-[0.98] disabled:opacity-50"
          >
            {connecting ? 'Connexion…' : 'Connecter Google Calendar'}
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/20 transition duration-150 ease-out group-hover:translate-x-0.5">
              {connecting ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpRight size={13} strokeWidth={2} />}
            </span>
          </button>
        )}
      </div>
    )
  } else {
    // ── Calendrier ────────────────────────────────────────────────────────────────────────────────────
    body = (
      <div className="relative min-h-0 flex-1 p-3">
        {eventsError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center animate-fade-up">
            <AlertTriangle size={22} className="text-danger" />
            <p className="max-w-xs text-[12px] text-fg-muted">{eventsError}</p>
            <button
              onClick={() => setRefreshTick((t) => t + 1)}
              className="rounded-full border border-border bg-bg-elevated px-3.5 py-1.5 text-[12px] font-medium text-fg-muted transition duration-150 ease-out hover:bg-hover hover:text-fg active:scale-[0.98]"
            >
              Réessayer
            </button>
          </div>
        ) : (
          <div className="oryon-calendar h-full">
            <Calendar
              localizer={localizer}
              culture="fr-CA"
              events={events}
              view={view}
              date={date}
              onView={(v) => setView(v)}
              onNavigate={(d) => setDate(d)}
              views={['month', 'week', 'day']}
              toolbar={false}
              popup
              messages={MESSAGES}
              components={{ event: EventContent }}
              eventPropGetter={eventPropGetter}
              onSelectEvent={onSelectEvent}
              scrollToTime={new Date(1970, 0, 1, 7, 0, 0)}
              style={{ height: '100%' }}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* ── Barre d'outils ─────────────────────────────────────────────────────────────────────────────── */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <div className="flex items-center gap-1.5">
          <button
            onClick={goToday}
            disabled={!connected}
            className="h-7 rounded-full border border-border bg-bg-elevated px-3 text-[12px] font-medium text-fg-muted transition duration-150 ease-out hover:border-border-strong hover:text-fg active:scale-[0.97] disabled:opacity-40"
          >
            Aujourd’hui
          </button>
          <div className="flex items-center">
            <button
              onClick={goPrev}
              disabled={!connected}
              aria-label="Précédent"
              className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition duration-150 ease-out hover:bg-hover hover:text-fg active:scale-95 disabled:opacity-40"
            >
              <ChevronLeft size={17} strokeWidth={1.75} />
            </button>
            <button
              onClick={goNext}
              disabled={!connected}
              aria-label="Suivant"
              className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition duration-150 ease-out hover:bg-hover hover:text-fg active:scale-95 disabled:opacity-40"
            >
              <ChevronRight size={17} strokeWidth={1.75} />
            </button>
          </div>
        </div>

        <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-fg">{connected ? labelFor(view, date) : 'Calendrier'}</h2>

        <div className="ml-auto flex items-center gap-2">
          {connected && status?.email && (
            <span className="hidden items-center gap-1.5 text-[11px] text-fg-subtle sm:flex" title={`Connecté · ${status.email}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="max-w-[160px] truncate">{status.email}</span>
            </span>
          )}

          {connected && (
            <button
              onClick={() => setRefreshTick((t) => t + 1)}
              aria-label="Rafraîchir"
              title="Rafraîchir"
              className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition duration-150 ease-out hover:bg-hover hover:text-fg active:scale-95"
            >
              <RefreshCw size={14} strokeWidth={1.75} className={cn(loadingEvents && 'animate-spin')} />
            </button>
          )}

          {/* Filtre par calendrier */}
          {connected && calendars.length > 1 && (
            <div className="relative">
              <button
                onClick={() => setFilterOpen((o) => !o)}
                aria-label="Filtrer les calendriers"
                title="Calendriers"
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md transition duration-150 ease-out hover:bg-hover hover:text-fg active:scale-95',
                  filterOpen ? 'bg-hover text-fg' : 'text-fg-muted',
                )}
              >
                <SlidersHorizontal size={14} strokeWidth={1.75} />
              </button>
              {filterOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setFilterOpen(false)} />
                  <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-60 rounded-xl border border-border bg-bg-elevated p-1.5 shadow-lg animate-scale-in">
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-subtle">Calendriers</div>
                    <div className="max-h-72 overflow-y-auto">
                      {calendars.map((c) => {
                        const shown = !hiddenCals.has(c.id)
                        return (
                          <button
                            key={c.id}
                            onClick={() => toggleCal(c.id)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-hover"
                          >
                            <span
                              className={cn(
                                'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                                shown ? 'border-transparent' : 'border-border',
                              )}
                              style={shown ? { backgroundColor: c.backgroundColor || 'var(--accent)' } : undefined}
                            >
                              {shown && <Check size={11} strokeWidth={3} className="text-on-accent" />}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{c.summary}</span>
                            {c.primary && <span className="shrink-0 text-[9px] uppercase tracking-wide text-fg-subtle">principal</span>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Sélecteur de vue */}
          <div className="flex items-center gap-0.5 rounded-full border border-border bg-bg-inset p-0.5">
            {VIEW_OPTIONS.map((o) => (
              <button
                key={o.key}
                onClick={() => setView(o.key)}
                disabled={!connected}
                className={cn(
                  'h-6 rounded-full px-3 text-[11px] font-medium transition duration-150 ease-out disabled:opacity-40',
                  view === o.key ? 'bg-accent-soft text-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]' : 'text-fg-muted hover:text-fg',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {body}

      {/* ── Popover de détail d'event ────────────────────────────────────────────────────────────────────── */}
      {popover && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPopover(null)} />
          <div
            ref={popRef}
            className="fixed z-50 w-80 rounded-2xl border border-border bg-bg-elevated p-1.5 shadow-lg animate-scale-in"
            style={{ left: popPos?.left ?? 0, top: popPos?.top ?? 0, visibility: popPos ? 'visible' : 'hidden' }}
          >
            <div className="rounded-xl bg-bg-panel p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <div className="flex items-start gap-2">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: isHex(popover.ev.color) ? popover.ev.color : 'var(--accent)' }} />
                <h3 className="min-w-0 flex-1 text-[13.5px] font-semibold leading-snug text-fg">{popover.ev.title || '(sans titre)'}</h3>
                <button
                  onClick={() => setPopover(null)}
                  aria-label="Fermer"
                  className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="mt-2.5 flex items-start gap-2 text-[12px] text-fg-muted">
                <Clock size={13} strokeWidth={1.75} className="mt-px shrink-0 text-fg-subtle" />
                <span>{formatWhen(popover.ev)}</span>
              </div>

              {popover.ev.location && (
                <div className="mt-1.5 flex items-start gap-2 text-[12px] text-fg-muted">
                  <MapPin size={13} strokeWidth={1.75} className="mt-px shrink-0 text-fg-subtle" />
                  <span className="min-w-0 break-words">{popover.ev.location}</span>
                </div>
              )}

              {popover.ev.description && (
                <p className="mt-2.5 line-clamp-4 whitespace-pre-wrap text-[11.5px] leading-relaxed text-fg-subtle">{popover.ev.description}</p>
              )}

              {popover.ev.htmlLink && (
                <a
                  href={popover.ev.htmlLink}
                  target="_blank"
                  rel="noreferrer"
                  className="group mt-3 inline-flex items-center gap-2 rounded-full border border-border bg-bg-elevated py-1 pl-3 pr-1 text-[12px] font-medium text-fg-muted transition duration-150 ease-out hover:border-border-strong hover:text-fg active:scale-[0.98]"
                >
                  Ouvrir dans Google Agenda
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-hover transition duration-150 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-px">
                    <ArrowUpRight size={12} strokeWidth={2} />
                  </span>
                </a>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
