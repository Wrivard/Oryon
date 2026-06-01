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
 * insertion pure (mot ajouté sans suppression adjacente) ressort avec from=''. Une correction de
 * casse/accent seule (mots égaux à la casse près) ressort aussi en substitution. Seules les paires
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
  // Backtrack → script d'édition (=, -, +). Pour les '=', on garde AUSSI le mot injecté (from) : une
  // égalité insensible à la casse peut masquer une correction de casse/accent (a[i] !== b[j]).
  const ops: Array<{ t: '=' | '-' | '+'; w: string; from?: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i].toLowerCase() === b[j].toLowerCase()) {
      ops.push({ t: '=', w: b[j], from: a[i] })
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
      // Correction de casse/accent seule : alignée en '=' (égalité insensible à la casse) mais from !== to.
      const op = ops[k]
      if (op.from !== undefined && op.from !== op.w) changes.push({ from: op.from, to: op.w })
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
 * Extrait le PREMIER objet JSON `{…}` équilibré d'une sortie modèle (tolère préambule/fences éventuels).
 * Scan caractère par caractère en respectant chaînes et échappements — robuste là où indexOf/lastIndexOf
 * cassait (prose après le JSON, accolade dans une string). Renvoie null si aucun objet équilibré.
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let k = start; k < raw.length; k++) {
    const ch = raw[k]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return raw.slice(start, k + 1)
    }
  }
  return null
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
  // Le classifieur n'apprend QUE des substitutions/corrections de casse : une insertion pure (from='')
  // n'a aucun mot mal transcrit à corriger. On la garde dans le log mais on ne la soumet pas.
  const classifiable = changes.filter((c) => c.from !== '')
  if (!classifiable.length) return { learned: [] }
  // Mode privacy : aucun appel réseau (le classifieur est un appel `claude`). On a quand même loggé.
  if ((appSetting('voice.privacy') ?? '0') === '1') return { learned: [] }
  // Garde coût : édition trop large = pas une correction vocale typique (> 20 paires ou payload > 512 B).
  if (classifiable.length > 20 || JSON.stringify(classifiable).length > 512) return { learned: [] }

  const raw = await voiceCliOneShot(LEARN_SYSTEM, JSON.stringify({ changes: classifiable }))
  const json = extractJsonObject(raw)
  if (json === null) {
    console.warn('[voice.learn] parse échoué : aucun objet JSON équilibré dans la sortie du classifieur')
    return { learned: [] }
  }
  let parsed: { terms?: ClassifiedTerm[] } = {}
  try {
    parsed = JSON.parse(json)
  } catch {
    console.warn('[voice.learn] parse échoué : JSON invalide dans la sortie du classifieur')
    return { learned: [] }
  }
  // Écrit en propre (INSERT OR IGNORE) : un terme auto NE clobbe JAMAIS une entrée manuelle/starred existante.
  // Les noms propres (isProperNoun) sont insérés starred=1 → priorité de boosting whisper.
  const insVocab = db.prepare(
    `INSERT OR IGNORE INTO voice_vocab (id, term, starred, source, created_at) VALUES (?, ?, ?, 'auto', ?)`,
  )
  const insRepl = db.prepare(
    `INSERT OR IGNORE INTO voice_replacements (id, spoken, replacement, source, created_at) VALUES (?, ?, ?, 'auto', ?)`,
  )
  const learned: string[] = []
  for (const t of parsed.terms ?? []) {
    const term = t.term?.trim()
    if (!t.learn || !term) continue
    insVocab.run(uuid(), term, t.isProperNoun ? 1 : 0, Date.now())
    learned.push(term)
    const from = t.replacementFor?.trim()
    if (from && from.toLowerCase() !== term.toLowerCase()) insRepl.run(uuid(), from, term, Date.now())
  }
  if (!learned.length) console.log('[voice.learn] rien à apprendre : aucun terme retenu par le classifieur')
  db.prepare('UPDATE voice_corrections_log SET classified = 1, learned = ? WHERE id = ?').run(learned.length, logId)
  return { learned }
}
