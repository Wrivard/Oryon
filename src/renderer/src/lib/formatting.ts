// INC5/6 — Smart Formatting sensible à la cible d'injection (07b §4).
// - code-safe (terminal / éditeur) : AUCUNE capitalisation, ponctuation ou espacement FR forcés — juste un
//   nettoyage d'espaces. Le code ne doit pas être déformé.
// - prose (orchestrator bar) : Light = nettoyage LOCAL (sauts de ligne parlés, disfluences, capitalisation,
//   espacement typographique FR) ; Medium/High = via le CLI $0 (voir voice.format + roles.formatSystem).

const DISFLUENCY = /\b(?:euh+|heu+|hum+|uh+|um+)\b/gi
const THIN_NBSP = ' ' // espace fine insécable (typographie FR)

/** Nettoyage minimal pour cible code (terminal) : collapse des espaces + trim, rien d'autre. */
export function formatCodeSafe(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

/**
 * Nettoyage LOCAL (Light) pour la prose : commandes de saut de ligne parlées, retrait des disfluences,
 * capitalisation des débuts de phrase, et (si français) espace fine insécable avant ; ! ? — sans toucher
 * aux URLs/code (garde-fou de frontière de mot, « : » exclu).
 */
export function formatLight(text: string, opts?: { french?: boolean }): string {
  let t = text
  // Commandes explicites de saut de ligne.
  t = t.replace(/\b(?:nouveau paragraphe|new paragraph)\b/gi, '\n\n')
  t = t.replace(/\b(?:nouvelle ligne|à la ligne|new line)\b/gi, '\n')
  // Disfluences.
  t = t.replace(DISFLUENCY, '')
  // Espaces / sauts de ligne.
  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Capitalisation : début de texte, après . ! ? + espace, ou après saut de ligne.
  t = t.replace(/(^|[.!?]\s+|\n+)([a-zà-öø-ÿ])/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase())
  // Espacement typographique français, uniquement en frontière de mot (URLs/code épargnés).
  if (opts?.french) t = t.replace(/([\p{L}\p{N}])\s*([;!?])(\s|$)/gu, `$1${THIN_NBSP}$2$3`)
  return t
}
