import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Settings2, BookOpenText, Keyboard, BarChart3 } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { transitionFast } from '../../../lib/motion'
import { VoiceGeneral } from './VoiceGeneral'
import { VoiceDictionaries } from './VoiceDictionaries'
import { VoiceHotkeys } from './VoiceHotkeys'
import { VoiceStats } from './VoiceStats'

const SUBS = [
  { id: 'general', label: 'Général', icon: Settings2 },
  { id: 'dict', label: 'Dictionnaires', icon: BookOpenText },
  { id: 'hotkeys', label: 'Raccourcis', icon: Keyboard },
  { id: 'stats', label: 'Stats', icon: BarChart3 },
] as const
type VoiceSub = (typeof SUBS)[number]['id']

/** Catégorie Voice des réglages : sous-rail vertical + panneau de contenu (router AnimatePresence). */
export function VoiceSettings() {
  const [sub, setSub] = useState<VoiceSub>('stats') // ouvre sur Stats (la page vitrine)

  return (
    <div className="flex min-h-0 flex-1">
      {/* Sous-rail — frère du rail de catégories, piste plus sombre */}
      <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border bg-bg-panel/60 p-2">
        <span className="px-2.5 pb-1 text-[10px] uppercase tracking-wide text-fg-subtle">Voix</span>
        {SUBS.map((s) => {
          const Icon = s.icon
          const active = sub === s.id
          return (
            <button
              key={s.id}
              onClick={() => setSub(s.id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-fast',
                active ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              <Icon size={14} />
              {s.label}
            </button>
          )
        })}
      </nav>

      {/* Panneau de contenu — possède le scroll + la transition de sous-page */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={sub}
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={transitionFast}
          >
            {sub === 'general' && <VoiceGeneral />}
            {sub === 'dict' && <VoiceDictionaries />}
            {sub === 'hotkeys' && <VoiceHotkeys />}
            {sub === 'stats' && <VoiceStats onGoToDict={() => setSub('dict')} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
