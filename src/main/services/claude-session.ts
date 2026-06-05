// Localise les transcripts du CLI claude pour un dossier donné. Lecture FS seulement : ne lance JAMAIS
// `claude` ni aucun process (coût $0 préservé, aucune var d'auth touchée). Sert F2 (décision de reprise au
// spawn) ET l'archivage des conversations (services/archive.ts).

import { readdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Dossier où le CLI claude stocke les transcripts d'un cwd : `~/.claude/projects/<ENC>/`, où ENC = le chemin
 * absolu avec chaque '\\', '/', ':' ou '.' remplacé par '-' (casse + reste du chemin inchangés — vérifié
 * empiriquement sur les vrais dossiers). SOURCE UNIQUE de l'encodage (partagée hasClaudeSession + archive).
 */
export function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[\\/:.]/g, '-'))
}

/**
 * Vrai ssi le CLI claude a déjà au moins un transcript (`*.jsonl`) pour ce dossier.
 * DÉFENSIF : toute erreur (dossier absent, accès refusé…) → false = démarrage neuf. Ne throw JAMAIS pour ne
 * pas bloquer le spawn du terminal.
 */
export function hasClaudeSession(cwd: string): boolean {
  try {
    return readdirSync(claudeProjectDir(cwd)).some((f) => f.endsWith('.jsonl'))
  } catch {
    return false
  }
}

/**
 * Vrai ssi le CLI claude a déjà le transcript de CETTE session PRÉCISE (`<sessionId>.jsonl`) dans ce dossier.
 * Sert à l'épinglage de l'orchestrateur sur SA session dédiée : `--resume <id>` si elle existe, sinon
 * `--session-id <id>` (création). Évite que `--continue` (la plus récente du dossier) reprenne une session
 * `claude` MANUELLE de l'utilisateur partageant le même cwd (→ restauration d'un input résiduel = fantôme).
 */
export function hasClaudeSessionId(cwd: string, sessionId: string): boolean {
  try {
    return existsSync(join(claudeProjectDir(cwd), `${sessionId}.jsonl`))
  } catch {
    return false
  }
}
