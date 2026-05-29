import type { Transition, Variants } from 'motion/react'

/** Easing « expo-out » — départ vif, fin douce. Donne la sensation rapide/réactive. */
export const easeOut: [number, number, number, number] = [0.16, 1, 0.3, 1]

// Durées alignées sur les tokens CSS (index.css : --dur-fast/--dur/--dur-slow).
export const transition: Transition = { duration: 0.18, ease: easeOut } // --dur
export const transitionFast: Transition = { duration: 0.12, ease: easeOut } // --dur-fast
export const transitionSlow: Transition = { duration: 0.28, ease: easeOut } // --dur-slow

/** Apparition vers le haut (panneaux, sections). */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition },
}

/** Fondu simple. */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition },
}

/** Conteneur orchestrant un stagger de ses enfants (listes, colonnes). */
export const staggerContainer = (gap = 0.04, delay = 0.02): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: gap, delayChildren: delay } },
})

/** Pression sur un élément interactif (boutons). */
export const press = { scale: 0.97 }
