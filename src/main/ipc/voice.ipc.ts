import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID as uuid } from 'node:crypto'
import { getDb } from '../db'
import { createVoiceWidget, destroyVoiceWidget, sendVoiceState, isVoiceWidget } from '../services/voice-widget'
import { injectText } from '../services/text-injection'
import { muteForDictation, restoreAfterDictation } from '../services/audio-mute'
import { learnFromEdit } from '../services/orchestrator/learn'
import { voiceCliOneShot } from '../services/orchestrator/cli'
import { formatSystem, COMMAND_SYSTEM, CLEANUP_SYSTEM } from '../services/orchestrator/roles'
import { transcribeWithGroq, cleanupWithGroq } from '../services/groq-stt'
import { appSetting } from './settings.ipc'
import type {
  VoiceReplacement,
  VoiceHistoryItem,
  VoiceState,
  VoiceVocab,
  VoiceSnippet,
  VoiceStats,
} from '../../shared/types'

// Coalescence leading-edge 250 ms du toggle de dictée, PARTAGÉE par la hotkey globale (main/index.ts) et le
// widget (voice:requestToggle) — deux voice:toggle rapprochés ne doivent pas démarrer-puis-arrêter aussitôt une
// capture (C-7). Module-scoped pour survivre à un ré-enregistrement à chaud des hotkeys. Exclut le widget, qui
// ne doit jamais recevoir de toggle.
let lastVoiceToggle = 0
export function emitVoiceToggle(): void {
  const now = Date.now()
  if (now - lastVoiceToggle < 250) return
  lastVoiceToggle = now
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed() && !isVoiceWidget(w)) w.webContents.send('voice:toggle')
}

// Push-to-talk (mode 'hold') : la hotkey en maintien envoie le démarrage au keydown (down:true) et l'arrêt au
// keyup (down:false). Contrairement au toggle, AUCUNE coalescence — les deux fronts doivent passer (un tap rapide
// < 250 ms démarrerait-puis-arrêterait, ce que la coalescence avalerait). L'anti auto-répétition est gérée en
// amont par le service de hotkey (flag pressed). Exclut le widget, jamais destinataire (comme emitVoiceToggle).
export function emitVoiceHold(down: boolean): void {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.isDestroyed() && !isVoiceWidget(w)) w.webContents.send('voice:hold', down)
}

// Coercition défensive des arguments IPC non fiables (renderer/preload) — pas de lib de schéma.
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (Number.isFinite(v as number) ? Number(v) : 0)

function listReplacements(): VoiceReplacement[] {
  return getDb()
    .prepare('SELECT * FROM voice_replacements ORDER BY created_at DESC')
    .all() as VoiceReplacement[]
}

// Exporté : l'auto-add (learn.ts, INC4) ajoute des remplacements appris (source='auto') côté main.
export function addReplacement(spoken: string, replacement: string, source = 'manual'): VoiceReplacement {
  // Coercition défensive (str) + trim : une clé paddée (' foo ') échapperait à l'index UNIQUE NOCASE (007)
  // et créerait un doublon.
  const row: VoiceReplacement = { id: uuid(), spoken: str(spoken).trim(), replacement: str(replacement).trim(), source, created_at: Date.now() }
  const db = getDb()
  // upsert sur la clé spoken (index unique NOCASE migration 007) : on remplace l'éventuelle règle existante.
  db.prepare('DELETE FROM voice_replacements WHERE spoken = ? COLLATE NOCASE').run(row.spoken)
  db.prepare(
    'INSERT INTO voice_replacements (id, spoken, replacement, source, created_at) VALUES (@id, @spoken, @replacement, @source, @created_at)',
  ).run(row)
  return row
}

function listHistory(limit = 50): VoiceHistoryItem[] {
  return getDb()
    .prepare('SELECT * FROM voice_history ORDER BY created_at DESC LIMIT ?')
    .all(limit) as VoiceHistoryItem[]
}

function listVocab(): VoiceVocab[] {
  return (
    getDb()
      .prepare('SELECT * FROM voice_vocab ORDER BY starred DESC, created_at DESC')
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({ ...r, starred: !!r.starred })) as VoiceVocab[]
}

// Exporté : l'auto-add (learn.ts, INC4) ajoute des termes appris (source='auto') côté main.
export function addVocab(term: string, starred = false, source = 'manual'): VoiceVocab {
  // Coercition défensive (str) + trim : un terme paddé échapperait à l'index UNIQUE NOCASE (009) et créerait un doublon.
  const row: VoiceVocab = { id: uuid(), term: str(term).trim(), starred, source: str(source) || 'manual', created_at: Date.now() }
  const db = getDb()
  // Upsert NOCASE : supprime l'éventuelle variante de casse (index NOCASE migration 009) puis réinsère.
  db.prepare('DELETE FROM voice_vocab WHERE term = ? COLLATE NOCASE').run(row.term)
  db.prepare(
    'INSERT INTO voice_vocab (id, term, starred, source, created_at) VALUES (@id, @term, @s, @source, @created_at)',
  ).run({ ...row, s: starred ? 1 : 0 })
  return row
}

function listSnippets(): VoiceSnippet[] {
  return getDb().prepare('SELECT * FROM voice_snippets ORDER BY created_at DESC').all() as VoiceSnippet[]
}
function addSnippet(trigger: string, expansion: string): VoiceSnippet {
  // Coercition défensive (str) + trim : un trigger paddé échapperait à l'index UNIQUE NOCASE (007) et créerait un doublon.
  const row: VoiceSnippet = { id: uuid(), trigger: str(trigger).trim(), expansion: str(expansion).trim(), created_at: Date.now() }
  const db = getDb()
  db.prepare('DELETE FROM voice_snippets WHERE trigger = ? COLLATE NOCASE').run(row.trigger)
  db.prepare(
    'INSERT INTO voice_snippets (id, trigger, expansion, created_at) VALUES (@id, @trigger, @expansion, @created_at)',
  ).run(row)
  return row
}

/** Agrège le tableau de bord d'usage Voice depuis voice_history + voice_vocab + voice_corrections_log. */
function computeStats(): VoiceStats {
  const db = getDb()
  const h = db
    .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(word_count), 0) AS w FROM voice_history')
    .get() as { c: number; w: number }
  const vocabCount = db.prepare('SELECT COUNT(*) AS c FROM voice_vocab').pluck().get() as number
  const autoLearnedCount = db
    .prepare("SELECT COUNT(*) AS c FROM voice_vocab WHERE source = 'auto'")
    .pluck()
    .get() as number
  // « Mots les plus corrigés » : `injected` agrège par ' | ' TOUTES les formes mal transcrites d'UNE
  // édition (cf. learn.ts). On éclate donc en formes avant de compter, sinon on dénombre des ensembles
  // d'édition et non des mots. Top 5.
  let mostCorrected: { word: string; count: number }[] = []
  try {
    const rows = db
      .prepare(`SELECT injected FROM voice_corrections_log WHERE injected IS NOT NULL AND TRIM(injected) != ''`)
      .all() as { injected: string }[]
    const counts = new Map<string, number>()
    for (const r of rows)
      for (const part of r.injected.split(' | ')) {
        const word = part.trim()
        if (word) counts.set(word, (counts.get(word) ?? 0) + 1)
      }
    mostCorrected = [...counts.entries()]
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  } catch {
    mostCorrected = []
  }
  const dictationCount = h.c
  const totalWords = h.w
  return {
    dictationCount,
    totalWords,
    avgWords: dictationCount ? Math.round((totalWords / dictationCount) * 10) / 10 : 0,
    timeSavedSec: Math.round((totalWords / 130) * 60),
    autoLearnedCount,
    vocabCount,
    mostCorrected,
  }
}

export function registerVoiceIpc(): void {
  ipcMain.handle('voice:stats', (): VoiceStats => computeStats())
  ipcMain.handle('voice:listReplacements', (): VoiceReplacement[] => listReplacements())
  ipcMain.handle('voice:addReplacement', (_e, spoken: string, replacement: string): VoiceReplacement =>
    addReplacement(spoken, replacement),
  )
  ipcMain.handle('voice:deleteReplacement', (_e, id: string): void => {
    getDb().prepare('DELETE FROM voice_replacements WHERE id = ?').run(id)
  })
  ipcMain.handle(
    'voice:addHistory',
    (_e, item: { text: string; durationMs: number; wordCount: number; source: string }): void => {
      if (!item || typeof item.text !== 'string') return
      const db = getDb()
      db.prepare(
        'INSERT INTO voice_history (id, text, duration_ms, word_count, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(uuid(), str(item.text), num(item.durationMs), num(item.wordCount), str(item.source) || 'unknown', Date.now())
      // Borne de rétention : ne conserve que les 2000 dictées les plus récentes (pas de migration).
      db.prepare(
        'DELETE FROM voice_history WHERE id NOT IN (SELECT id FROM voice_history ORDER BY created_at DESC LIMIT 2000)',
      ).run()
    },
  )
  ipcMain.handle('voice:listHistory', (_e, limit?: number): VoiceHistoryItem[] => listHistory(limit))
  // Privacy : efface tout l'historique de dictée et le journal de corrections (câblage UI ultérieur).
  ipcMain.handle('voice:clearHistory', (): void => {
    const db = getDb()
    db.prepare('DELETE FROM voice_history').run()
    db.prepare('DELETE FROM voice_corrections_log').run()
  })
  ipcMain.handle('voice:listVocab', (): VoiceVocab[] => listVocab())
  ipcMain.handle('voice:addVocab', (_e, term: string, starred?: boolean, source?: string): VoiceVocab =>
    addVocab(term, starred, source),
  )
  ipcMain.handle('voice:listSnippets', (): VoiceSnippet[] => listSnippets())
  ipcMain.handle('voice:addSnippet', (_e, trigger: string, expansion: string): VoiceSnippet =>
    addSnippet(trigger, expansion),
  )
  ipcMain.handle('voice:deleteSnippet', (_e, id: string): void => {
    getDb().prepare('DELETE FROM voice_snippets WHERE id = ?').run(id)
  })
  // Auto-add ✨ (INC4) : apprend depuis une édition du texte dicté (diff + classifieur $0, coupé en privacy).
  ipcMain.handle('voice:learnFromEdit', (_e, injected: string, edited: string, context: string) =>
    learnFromEdit(injected, edited, context),
  )
  // Smart formatting Medium/High (INC6) : nettoyage via CLI $0. Coupé en mode privacy ('' → repli Light côté renderer).
  ipcMain.handle('voice:format', async (_e, text: string, level: 'medium' | 'high'): Promise<string> => {
    if (!text.trim() || (appSetting('voice.privacy') ?? '0') === '1') return ''
    return voiceCliOneShot(formatSystem(level === 'high' ? 'high' : 'medium'), text)
  })
  // Nettoyage intelligent (layer post-dictée) via LLM Groq RAPIDE (clé Groq, $0 Claude). Édition soustractive :
  // hésitations + auto-corrections (« scratch that ») + commandes parlées. Renvoie '' → l'appelant garde le texte
  // brut/formaté localement (repli). Coupé en mode privacy (appel réseau) et sans clé Groq.
  ipcMain.handle('voice:cleanup', async (_e, text: string): Promise<string> => {
    const t = str(text)
    if (!t.trim() || (appSetting('voice.privacy') ?? '0') === '1') return ''
    const key = (appSetting('voice.groqApiKey') ?? '').trim()
    if (!key) return ''
    try {
      const model = appSetting('voice.cleanupModel') || 'llama-3.1-8b-instant'
      return await cleanupWithGroq(t, CLEANUP_SYSTEM, key, model)
    } catch (e) {
      console.error('[voice] cleanup Groq échec → repli brut : ' + ((e as Error)?.message ?? ''))
      return ''
    }
  })
  // Command mode (INC9) : la voix transforme la sélection / insère inline, via CLI $0. Coupé en mode privacy.
  ipcMain.handle('voice:command', async (_e, command: string, selection: string): Promise<string> => {
    if (!command.trim() || (appSetting('voice.privacy') ?? '0') === '1') return ''
    return voiceCliOneShot(COMMAND_SYSTEM, JSON.stringify({ command, selection: selection ?? '' }))
  })
  // Cible 'system' (voice.target, façon WisprFlow) : colle la transcription au curseur de l'app au premier plan
  // (presse-papier + Ctrl+V, Windows seulement). Ne lève jamais — renvoie { ok, reason } au renderer pour le toast.
  ipcMain.handle('voice:injectText', (_e, text: string): Promise<{ ok: boolean; reason?: string }> =>
    injectText(str(text)),
  )
  // Transcription distante via Groq (moteur 'groq' = défaut, cf. voice.engine). La clé Groq reste côté main.
  // Renvoie { ok:false, reason } sans lever → useVoice bascule alors en transcription LOCALE on-device (repli).
  ipcMain.handle(
    'voice:transcribeRemote',
    async (
      _e,
      pcm: Float32Array,
      opts: { language?: string },
    ): Promise<{ ok: boolean; text?: string; reason?: string; message?: string }> => {
      const key = (appSetting('voice.groqApiKey') ?? '').trim()
      if (!key) return { ok: false, reason: 'no-key' }
      const samples = pcm instanceof Float32Array ? pcm : new Float32Array(pcm as ArrayBufferLike)
      if (samples.length === 0) return { ok: false, reason: 'empty' }
      // 'french'|'english'|'' (valeurs app) → ISO-639-1 attendu par Groq.
      const lang = opts?.language === 'english' ? 'en' : opts?.language === 'french' ? 'fr' : ''
      const model = appSetting('voice.groqModel') || 'whisper-large-v3-turbo'
      // Amorce BILINGUE Whisper (≤224 tokens). Whisper « verrouille » UNE langue par clip et francise l'autre →
      // le code-switching FR↔EN est sa faiblesse STRUCTURELLE. Le levier #1 (gratuit) est le prompt : une amorce
      // qui MÉLANGE québécois + anglicismes/termes techniques dans leur ORTHOGRAPHE ANGLAISE démontre au modèle de
      // GARDER l'anglais en anglais (vs l'ancienne amorce 100 % FR qui biaisait contre). Noms propres/jargon de
      // l'utilisateur EN FIN (Whisper pondère plus fort la fin du prompt → termes les plus mal transcrits en dernier).
      const PRIMER =
        "Salut, c'est correct, on se call tantôt. Faut que je deploy le build pis que je merge la pull request. " +
        "J'ai un bug dans le frontend, check les logs pis le dashboard, on va shipper ça là."
      const terms = [...new Set([...listVocab().map((v) => v.term), ...listReplacements().map((r) => r.replacement)])].filter(Boolean).slice(0, 30)
      const prompt = (PRIMER + (terms.length ? ' ' + terms.join(', ') + '.' : '')).slice(0, 800)
      try {
        const t0 = Date.now()
        let text = await transcribeWithGroq(samples, lang, key, model, prompt)
        // Garde anti-fuite de prompt : Whisper recrache parfois l'amorce en tête du transcript → on la retire.
        if (text && text.startsWith(PRIMER.slice(0, 30))) text = text.slice(PRIMER.length).replace(/^[\s.,;:!?…-]+/, '')
        console.log('[voice] Groq ' + model + ' · ' + (Date.now() - t0) + 'ms · ' + samples.length + ' samples → "' + text.slice(0, 60) + '"')
        return { ok: true, text }
      } catch (e) {
        const message = (e as Error)?.message ?? String(e)
        console.error('[voice] Groq échec → repli local : ' + message)
        return { ok: false, reason: 'error', message }
      }
    },
  )
  ipcMain.handle('voice:toggleVocabStar', (_e, id: string, starred: boolean): void => {
    getDb().prepare('UPDATE voice_vocab SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id)
  })
  ipcMain.handle('voice:deleteVocab', (_e, id: string): void => {
    getDb().prepare('DELETE FROM voice_vocab WHERE id = ?').run(id)
  })

  // Widget → toggle : passe par le MÊME coalesceur 250 ms que la hotkey (C-7) — sinon un double-clic widget et
  // une hotkey rapprochés démarreraient-puis-arrêteraient aussitôt une capture. emitVoiceToggle exclut le widget.
  ipcMain.on('voice:requestToggle', () => emitVoiceToggle())
  // Fenêtre principale → état courant → widget.
  ipcMain.on('voice:stateChanged', (_e, state: VoiceState) => {
    sendVoiceState(state)
    // Couper le son système pendant l'ÉCOUTE (réglage voice.muteDuringDictation), rétabli dès qu'on quitte
    // 'listening' (arrêt / annulation / idle). Asynchrone : ne bloque pas le pont d'état → widget.
    if (state === 'listening' && (appSetting('voice.muteDuringDictation') ?? '0') === '1') void muteForDictation()
    else void restoreAfterDictation()
  })
  // Settings : afficher/cacher le widget flottant.
  ipcMain.handle('voice:setWidget', (_e, visible: boolean): void => {
    if (visible) createVoiceWidget()
    else destroyVoiceWidget()
  })
}
