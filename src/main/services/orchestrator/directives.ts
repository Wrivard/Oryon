// Extraction des MÉTA-DIRECTIVES Claude Code d'un goal utilisateur, pour les appliquer via les vrais
// mécanismes (commande /effort, mot-clé ultrathink) au lieu de les relayer en texte aux agents.
// L'orchestrateur est ainsi "Claude-aware" : « fais un deep dive ultrathink avec l'effort à ultracode »
// → /effort ultracode envoyé au terminal + ultrathink injecté dans le prompt, et le décomposeur ignore
// ces directives (cf. system prompts) au lieu d'en faire une task.

export interface GoalDirectives {
  /** Niveau /effort détecté (low|medium|high|xhigh|max|ultracode), ou undefined. */
  effort?: string
  /** Réflexion étendue demandée (ultrathink / think hard / deep dive…). */
  think: boolean
}

// Niveaux acceptés par `claude` (cf. --help : low/medium/high/xhigh/max) + 'ultracode' (mode de ce build).
const EFFORT_LEVELS = ['ultracode', 'xhigh', 'max', 'high', 'medium', 'low']

function extractEffort(goal: string): string | undefined {
  // Contexte explicite « effort … <niveau> » ou « /effort <niveau> » (à/to/= optionnels).
  const ctx = goal.match(/\/?effort\b[^\n]{0,14}?\b(ultracode|xhigh|max|high|medium|low)\b/i)
  if (ctx) return ctx[1].toLowerCase()
  // Tokens non ambigus utilisables seuls.
  const tok = goal.match(/\b(ultracode|xhigh)\b/i)
  if (tok) return tok[1].toLowerCase()
  return undefined
}

function extractThink(goal: string): boolean {
  return /\b(ultra[\s-]?think|think\s+harder|think\s+hard|deep[\s-]?dive|réfléchis|reflechis)\b/i.test(goal)
}

export function extractDirectives(goal: string): GoalDirectives {
  const effort = extractEffort(goal)
  return { effort: effort && EFFORT_LEVELS.includes(effort) ? effort : undefined, think: extractThink(goal) }
}
