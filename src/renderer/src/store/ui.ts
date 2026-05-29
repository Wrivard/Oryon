import { create } from 'zustand'

// État UI léger partagé (ouverture des Réglages sur un onglet précis — ex. le toast d'update → onglet « Mises à jour »).
interface UiStore {
  settingsOpen: boolean
  settingsTab?: string
  openSettings: (tab?: string) => void
  closeSettings: () => void
}

export const useUiStore = create<UiStore>((set) => ({
  settingsOpen: false,
  settingsTab: undefined,
  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab }),
  closeSettings: () => set({ settingsOpen: false }),
}))
