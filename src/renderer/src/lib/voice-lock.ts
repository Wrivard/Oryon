// Verrou micro PARTAGÉ (un seul micro physique). La dictée (useVoice) et le command mode (useVoiceCommand)
// coordonnent via ce verrou : tenter d'enregistrer quand l'autre détient le micro = no-op gracieux (pas
// d'alerte « capture déjà en cours »). Observable → l'UI peut désactiver le bouton opposé.

type Owner = 'dictation' | 'command'
let owner: Owner | null = null
const subs = new Set<() => void>()

export function tryAcquire(o: Owner): boolean {
  if (owner && owner !== o) return false
  owner = o
  subs.forEach((f) => f())
  return true
}
export function release(o: Owner): void {
  if (owner === o) {
    owner = null
    subs.forEach((f) => f())
  }
}
export function lockedBy(): Owner | null {
  return owner
}
export function subscribeLock(f: () => void): () => void {
  subs.add(f)
  return () => subs.delete(f)
}
