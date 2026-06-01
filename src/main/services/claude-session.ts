// Détecte si une conversation Claude Code existe DÉJÀ pour un dossier donné, afin de décider au spawn
// s'il faut reprendre (`--continue`) plutôt que démarrer une session neuve. Lecture FS seulement : ne
// lance JAMAIS `claude` ni aucun process (coût $0 préservé, aucune var d'auth touchée).

import { readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Vrai ssi le CLI claude a déjà au moins un transcript pour ce dossier. Claude stocke les conversations
 * dans `~/.claude/projects/<ENC>/*.jsonl`, où ENC = le chemin absolu avec chaque '\\', '/', ':' ou '.'
 * remplacé par '-' (casse et reste du chemin inchangés — vérifié empiriquement sur les vrais dossiers).
 *
 * DÉFENSIF : toute erreur (dossier absent, accès refusé…) → false = démarrage neuf. Ne throw JAMAIS pour
 * ne pas bloquer le spawn du terminal.
 */
export function hasClaudeSession(cwd: string): boolean {
  try {
    const enc = cwd.replace(/[\\/:.]/g, '-')
    const dir = join(homedir(), '.claude', 'projects', enc)
    return readdirSync(dir).some((f) => f.endsWith('.jsonl'))
  } catch {
    return false
  }
}
