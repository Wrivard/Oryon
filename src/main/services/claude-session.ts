// Localise les transcripts du CLI claude pour un dossier donné. Lecture FS seulement : ne lance JAMAIS
// `claude` ni aucun process (coût $0 préservé, aucune var d'auth touchée). Sert F2 (décision de reprise au
// spawn) ET l'archivage des conversations (services/archive.ts).

import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

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

// ── Id de session de reprise de l'orchestrateur (bug 052e7397) ──────────────────────────────────────────
// L'orchestrateur épingle SA session sur son <termId> (cf. terminals.ipc → --resume/--session-id), ce qui
// évite que --continue reprenne une session claude MANUELLE du même cwd (fantôme). MAIS reset_orchestrator
// repart d'un contexte frais (/clear → claude FORKE une nouvelle session) ; si la reprise restait collée au
// <termId> d'origine, un redémarrage de l'app RESSUSCITERAIT la conversation PRÉ-reset (le fork post-reset
// étant orphelin) → deux pilotes sur le même repo, travail redoublé. On persiste donc, PAR orchestrateur,
// l'id de session à reprendre : <termId> par défaut (1er lancement + restarts normaux INCHANGÉS), ROTÉ vers
// un uuid frais à chaque reset → le restart suivant démarre une session NEUVE (l'orchestrateur se ré-hydrate
// depuis git/ledger/mémoire, exactement le but du reset) au lieu de rejouer le passé. Sidecar JSON dans
// mcp-state (chemin fourni par l'appelant : ce module reste sans dépendance Electron).
function orchSessionMapPath(stateDir: string): string {
  return join(stateDir, 'orchestrator-sessions.json')
}
function readOrchSessionMap(stateDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(orchSessionMapPath(stateDir), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}
/** Id de session que l'orchestrateur <termId> doit reprendre (défaut = termId : comportement historique). */
export function getOrchestratorResumeId(stateDir: string, termId: string): string {
  return readOrchSessionMap(stateDir)[termId] || termId
}
/** Rote l'id de reprise de l'orchestrateur <termId> vers un uuid frais (appelé par reset_orchestrator). */
export function rotateOrchestratorResumeId(stateDir: string, termId: string): string {
  const map = readOrchSessionMap(stateDir)
  const fresh = randomUUID()
  map[termId] = fresh
  try {
    mkdirSync(stateDir, { recursive: true })
    const tmp = `${orchSessionMapPath(stateDir)}.tmp`
    writeFileSync(tmp, JSON.stringify(map))
    renameSync(tmp, orchSessionMapPath(stateDir))
  } catch {
    /* best-effort : si la persistance échoue, la reprise retombe sur termId (pas de crash, juste le bug d'origine) */
  }
  return fresh
}
