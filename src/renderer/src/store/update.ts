import { create } from 'zustand'
import type { UpdaterState, UpdateChannel } from '@shared/types'

// État d'auto-update (source unique côté renderer) + actions déléguées au main. Le toast ET la page
// Settings y souscrivent → jamais désynchronisés.
interface UpdateStore extends UpdaterState {
  apply: (s: UpdaterState) => void
  check: () => void
  download: () => void
  install: () => void
  setChannel: (c: UpdateChannel) => void
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  phase: 'idle',
  channel: 'stable',
  currentVersion: '',
  apply: (s) => set({ ...s }),
  check: () => void window.bridge.update.check(),
  download: () => void window.bridge.update.download(),
  install: () => window.bridge.update.install(),
  setChannel: (c) => void window.bridge.update.setChannel(c),
}))
