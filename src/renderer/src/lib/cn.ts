/** Concatène des classes conditionnelles. Suffisant ici (pas de merge Tailwind nécessaire). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
