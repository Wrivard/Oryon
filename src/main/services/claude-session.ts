// Localise les transcripts du CLI claude pour un dossier donné. Lecture FS seulement : ne lance JAMAIS
// `claude` ni aucun process (coût $0 préservé, aucune var d'auth touchée). Sert F2 (décision de reprise au
// spawn) ET l'archivage des conversations (services/archive.ts).

import { readdirSync, statSync, readFileSync, writeFileSync, renameSync } from 'fs'
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
 * se re-soumettait en boucle. Constat empirique (v0.1.45) : AJOUTER un record vide ne suffit PAS — claude
 * restaure le dernier `lastPrompt` NON VIDE (les records vides sont ignorés), ou en choisit un par feuille. On
 * RÉÉCRIT donc en place TOUS les records `last-prompt` non vides en `lastPrompt:''` → plus aucun brouillon non
 * vide à restaurer, quelle que soit la logique de lecture de claude.
 *
 * Sûreté : seules les lignes dont le `type` PARSÉ vaut `last-prompt` sont modifiées (toutes les autres — messages,
 * snapshots — recopiées octet pour octet) ; garde sur le nombre de lignes ; écriture atomique (tmp + rename).
 * À appeler APRÈS avoir tué l'ancien claude (transcript fermé → pas de course / verrou Windows). Best-effort
 * absolu : toute erreur est avalée — ne doit JAMAIS bloquer le spawn d'un terminal.
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
    const lines = raw.split('\n')
    let changed = false
    const out = lines.map((line) => {
      if (!line.includes('"type":"last-prompt"')) return line // pré-filtre : recopie verbatim
      try {
        const o = JSON.parse(line) as { type?: string; lastPrompt?: string }
        if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string' && o.lastPrompt !== '') {
          o.lastPrompt = ''
          changed = true
          return JSON.stringify(o)
        }
      } catch {
        /* ligne non-JSON (ou substring fortuit dans un message) → recopie verbatim */
      }
      return line
    })
    if (!changed || out.length !== lines.length) return // rien à neutraliser / garde-fou intégrité
    const tmp = `${newest.p}.oryon-clearlp.tmp`
    writeFileSync(tmp, out.join('\n'))
    renameSync(tmp, newest.p)
  } catch {
    /* best-effort : ne JAMAIS bloquer le spawn */
  }
}
