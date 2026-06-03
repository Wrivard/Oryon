// Localise les transcripts du CLI claude pour un dossier donné. Lecture FS seulement : ne lance JAMAIS
// `claude` ni aucun process (coût $0 préservé, aucune var d'auth touchée). Sert F2 (décision de reprise au
// spawn) ET l'archivage des conversations (services/archive.ts).

import { readdirSync, statSync, readFileSync, appendFileSync } from 'fs'
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
 * Neutralise le « dernier prompt » que le CLI claude restaure ET AUTO-SOUMET au resume (`--continue`).
 *
 * claude persiste dans le transcript des enregistrements `{type:'last-prompt', lastPrompt, leafUuid, sessionId}`
 * et, au redémarrage avec `--continue`, ré-injecte CE texte dans la zone de saisie puis le soumet tout seul.
 * Pour l'orchestrateur (qui reprend à CHAQUE relance), un prompt fantôme (« npm »/« run ») se ré-injectait et
 * se re-soumettait en boucle (chaque soumission ré-écrivant le lastPrompt → auto-entretenu). Constat empirique :
 * le fantôme survivait à des milliers de lignes de conversation → claude restaure le DERNIER enregistrement
 * `last-prompt`, indépendamment de la feuille. On le neutralise donc en AJOUTANT (append-only — aucune
 * réécriture des données existantes, donc zéro risque de corrompre l'historique) un dernier enregistrement vide,
 * ancré sur la feuille de conversation courante (couvre aussi une éventuelle correspondance par feuille).
 *
 * À appeler APRÈS avoir tué l'ancien claude (sinon course d'écriture sur le transcript). Best-effort absolu :
 * toute erreur est avalée — ne doit JAMAIS bloquer le spawn d'un terminal.
 */
export function clearClaudeLastPrompt(cwd: string): void {
  try {
    const dir = claudeProjectDir(cwd)
    let newest: { p: string; m: number } | null = null
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(dir, f)
      const m = statSync(p).mtimeMs
      if (!newest || m > newest.m) newest = { p, m }
    }
    if (!newest) return
    const raw = readFileSync(newest.p, 'utf8')
    let leafUuid: string | null = null
    let sessionId: string | null = null
    let lastPromptText = ''
    for (const line of raw.split('\n')) {
      if (!line) continue
      let o: { type?: string; uuid?: string; sessionId?: string; lastPrompt?: string }
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof o.sessionId === 'string') sessionId = o.sessionId
      // Feuille = dernier message réel (user/assistant) portant un uuid — c'est ce que `--continue` reprend.
      if ((o.type === 'user' || o.type === 'assistant') && typeof o.uuid === 'string') leafUuid = o.uuid
      if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string') lastPromptText = o.lastPrompt
    }
    // Déjà vide (ou rien à ancrer) → ne rien empiler.
    if (!leafUuid || !sessionId || lastPromptText === '') return
    const sep = raw === '' || raw.endsWith('\n') ? '' : '\n'
    appendFileSync(
      newest.p,
      sep + JSON.stringify({ type: 'last-prompt', lastPrompt: '', leafUuid, sessionId }) + '\n',
    )
  } catch {
    /* best-effort : ne JAMAIS bloquer le spawn */
  }
}
