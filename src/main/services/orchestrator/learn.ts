import { v4 as uuid } from 'uuid'
import { getDb } from '../../db'
import { appSetting } from '../../ipc/settings.ipc'
import { voiceCliOneShot } from './cli'
import { LEARN_SYSTEM } from './roles'

// INC4 — auto-add ✨ : apprend les noms propres / termes rares depuis les corrections de l'utilisateur.
// Boucle : texte dicté injecté → l'utilisateur l'édite → on diff (LCS de mots) → un classifieur `claude`
// CLI ($0) garde uniquement les termes à apprendre → voice_vocab (source='auto') + règle de remplacement.
// Tout passe par voiceCliOneShot (garde-fou coût) ; coupé si mode privacy actif.

export interface WordChange {
  from: string
  to: string
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.\-_/]*/gu

/**
 * Diff de mots (LCS) entre le texte injecté et le texte édité → paires substituées {from,to}.
 * On regroupe chaque run de suppressions suivi d'un run d'insertions comme une substitution ; une
 * insertion pure (mot ajouté sans suppression adjacente) ressort avec from=''. Seules les paires
 * dont `to` est non vide sont candidates à l'apprentissage.
 */
export function detectCorrections(injected: string, edited: string): WordChange[] {
  const a = injected.match(WORD) ?? []
  const b = edited.match(WORD) ?? []
  if (!a.length || !b.length) return []
  // LCS (table classique).
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i].toLowerCase() === b[j].toLowerCase() ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  // Backtrack → script d'édition (=, -, +).
  const ops: Array<{ t: '=' | '-' | '+'; w: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i].toLowerCase() === b[j].toLowerCase()) {
      ops.push({ t: '=', w: b[j] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ t: '-', w: a[i++] })
    } else {
      ops.push({ t: '+', w: b[j++] })
    }
  }
  while (i < n) ops.push({ t: '-', w: a[i++] })
  while (j < m) ops.push({ t: '+', w: b[j++] })
  // Regroupe les runs -/+ adjacents en substitutions.
  const changes: WordChange[] = []
  for (let k = 0; k < ops.length; ) {
    if (ops[k].t === '=') {
      k++
      continue
    }
    const removed: string[] = []
    const added: string[] = []
    while (k < ops.length && ops[k].t === '-') removed.push(ops[k++].w)
    while (k < ops.length && ops[k].t === '+') added.push(ops[k++].w)
    if (added.length) changes.push({ from: removed.join(' '), to: added.join(' ') })
  }
  return changes
}

interface ClassifiedTerm {
  term: string
  learn: boolean
  isProperNoun: boolean
  replacementFor: string | null
}

/**
 * Apprend depuis une édition utilisateur. Log toujours la correction ; n'appelle le classifieur ($0)
 * que s'il y a un vrai diff ET que le mode privacy est OFF. Ne rejette jamais. Renvoie les termes appris.
 */
export async function learnFromEdit(injected: string, edited: string, context: string): Promise<{ learned: string[] }> {
  const changes = detectCorrections(injected, edited)
  const db = getDb()
  const logId = uuid()
  db.prepare(
    `INSERT INTO voice_corrections_log (id, injected, edited, full_injected, full_edited, context, classified, learned, ts)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
  ).run(
    logId,
    changes.map((c) => c.from).join(' | '),
    changes.map((c) => c.to).join(' | '),
    injected,
    edited,
    context,
    Date.now(),
  )
  if (!changes.length) return { learned: [] }
  // Mode privacy : aucun appel réseau (le classifieur est un appel `claude`). On a quand même loggé.
  if ((appSetting('voice.privacy') ?? '0') === '1') return { learned: [] }
  // Garde coût : édition trop large = pas une correction vocale typique (> 20 paires ou payload > 512 B).
  if (changes.length > 20 || JSON.stringify(changes).length > 512) return { learned: [] }

  const raw = await voiceCliOneShot(LEARN_SYSTEM, JSON.stringify({ changes }))
  let parsed: { terms?: ClassifiedTerm[] } = {}
  try {
    const cut = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    parsed = JSON.parse(cut)
  } catch {
    return { learned: [] }
  }
  // Écrit en propre (INSERT OR IGNORE) : un terme auto NE clobbe JAMAIS une entrée manuelle/starred existante.
  const insVocab = db.prepare(
    `INSERT OR IGNORE INTO voice_vocab (id, term, starred, source, created_at) VALUES (?, ?, 0, 'auto', ?)`,
  )
  const insRepl = db.prepare(
    `INSERT OR IGNORE INTO voice_replacements (id, spoken, replacement, source, created_at) VALUES (?, ?, ?, 'auto', ?)`,
  )
  const learned: string[] = []
  for (const t of parsed.terms ?? []) {
    const term = t.term?.trim()
    if (!t.learn || !term) continue
    insVocab.run(uuid(), term, Date.now())
    learned.push(term)
    const from = t.replacementFor?.trim()
    if (from && from.toLowerCase() !== term.toLowerCase()) insRepl.run(uuid(), from, term, Date.now())
  }
  db.prepare('UPDATE voice_corrections_log SET classified = 1, learned = ? WHERE id = ?').run(learned.length, logId)
  return { learned }
}
