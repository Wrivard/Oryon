import { create } from 'zustand'

// Notifications brandées Oryon (remplacent window.alert). Auto-dismiss piloté par setTimeout côté store
// (PAS par l'animation CSS : la règle prefers-reduced-motion réduit les animations à ~0ms → un dismiss
// basé sur onAnimationEnd se fermerait instantanément). Pause au survol.

export type ToastVariant = 'error' | 'info' | 'success'

export interface Toast {
  id: number
  variant: ToastVariant
  title?: string
  message: string
  duration: number // 0 = persistant (fermeture manuelle)
  remaining: number
  startedAt: number
  timer?: ReturnType<typeof setTimeout>
}

interface ToastState {
  toasts: Toast[]
  push: (t: { variant: ToastVariant; message: string; title?: string; duration: number }) => void
  dismiss: (id: number) => void
  pause: (id: number) => void
  resume: (id: number) => void
}

let seq = 0

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = ++seq
    const toast: Toast = { ...t, id, remaining: t.duration, startedAt: Date.now() }
    if (t.duration > 0) toast.timer = setTimeout(() => get().dismiss(id), t.duration)
    set((s) => ({ toasts: [...s.toasts, toast].slice(-4) })) // cap FIFO à 4 visibles
  },
  dismiss: (id) =>
    set((s) => {
      const t = s.toasts.find((x) => x.id === id)
      if (t?.timer) clearTimeout(t.timer)
      return { toasts: s.toasts.filter((x) => x.id !== id) }
    }),
  pause: (id) =>
    set((s) => ({
      toasts: s.toasts.map((t) => {
        if (t.id !== id || !t.timer) return t
        clearTimeout(t.timer)
        return { ...t, timer: undefined, remaining: Math.max(0, t.remaining - (Date.now() - t.startedAt)) }
      }),
    })),
  resume: (id) =>
    set((s) => ({
      toasts: s.toasts.map((t) => {
        if (t.id !== id || t.timer || t.duration === 0) return t
        const timer = setTimeout(() => get().dismiss(id), t.remaining)
        return { ...t, timer, startedAt: Date.now() }
      }),
    })),
}))

const DEFAULTS: Record<ToastVariant, number> = { error: 6000, info: 4000, success: 3000 }
const make =
  (variant: ToastVariant) =>
  (message: string, opts?: { title?: string; duration?: number }): void =>
    useToastStore.getState().push({ variant, message, title: opts?.title, duration: opts?.duration ?? DEFAULTS[variant] })

/** Façade impérative — drop-in pour les anciens window.alert (appelable hors composant). */
export const toast = { error: make('error'), info: make('info'), success: make('success') }
