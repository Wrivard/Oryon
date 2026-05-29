import { useEffect, useState } from 'react'
import { Mic, Loader2, GripVertical } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { VoiceState } from '@shared/types'

// Widget flottant always-on-top (fenêtre Electron dédiée, fond transparent). DISCRET : petite pilule
// translucide au repos, sans gros rectangle. Draggable via la poignée, double-clic = toggle (relayé à
// la fenêtre principale qui capte/transcrit).
export function VoiceWidget() {
  const [state, setState] = useState<VoiceState>('idle')

  useEffect(() => {
    window.bridge.voice.onState((s) => setState(s))
    return () => window.bridge.voice.offState()
  }, [])

  return (
    <div className="flex h-screen w-screen items-center justify-center [font-family:'Geist_Variable',sans-serif]">
      <style>{`@keyframes oryon-bar{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}`}</style>
      <div
        // @ts-expect-error -- propriété CSS Electron non typée
        style={{ WebkitAppRegion: 'no-drag' }}
        onDoubleClick={() => window.bridge.voice.requestToggle()}
        title="Double-clic = démarrer / arrêter la dictée"
        className={cn(
          'group flex h-6 items-center gap-1.5 rounded-full border px-1.5 transition-all duration-200',
          state === 'idle' && 'border-border/50 bg-bg-elevated/60 opacity-60 hover:opacity-100',
          state === 'listening' && 'border-danger/70 bg-bg-elevated/95 opacity-100 shadow-md',
          state === 'processing' && 'border-warning/70 bg-bg-elevated/95 opacity-100 shadow-md',
        )}
      >
        {/* Poignée de déplacement (drag) */}
        <span
          // @ts-expect-error -- propriété CSS Electron non typée
          style={{ WebkitAppRegion: 'drag' }}
          className="flex cursor-grab items-center text-fg-subtle/60 group-hover:text-fg-subtle"
        >
          <GripVertical size={10} />
        </span>

        {state === 'listening' ? (
          <div className="flex items-center gap-[2px] pr-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <span
                key={i}
                className="w-[2px] rounded-full bg-danger"
                style={{ height: 12, animation: 'oryon-bar 0.7s ease-in-out infinite', animationDelay: `${i * 0.1}s` }}
              />
            ))}
          </div>
        ) : state === 'processing' ? (
          <Loader2 size={12} className="mr-0.5 animate-spin text-warning" />
        ) : (
          <Mic size={12} className="mr-0.5 text-accent" />
        )}
      </div>
    </div>
  )
}
