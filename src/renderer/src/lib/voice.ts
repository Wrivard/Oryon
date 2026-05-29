// Transcription Whisper ON-DEVICE via Transformers.js (WASM) — aucune compilation native, rien au cloud.
// Le modèle ONNX (multilingue) est téléchargé au 1er usage puis mis en cache (IndexedDB).
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

env.allowLocalModels = false // modèles depuis le hub HF (rien de bundlé localement)

let asrPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null
let loadedModel = ''

/** Charge (lazy, et recharge si le modèle change) le pipeline ASR. */
export function loadAsr(
  model: string,
  onProgress?: (p: { status: string; progress?: number; file?: string }) => void,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asrPromise && model === loadedModel) return asrPromise
  loadedModel = model
  asrPromise = pipeline('automatic-speech-recognition', model, {
    progress_callback: onProgress as never,
  }) as Promise<AutomaticSpeechRecognitionPipeline>
  return asrPromise
}

/** Transcrit un PCM mono 16 kHz (Float32) → texte. `language` ex 'french' | 'english' | undefined (auto). */
export async function transcribe(
  pcm16k: Float32Array,
  opts: { model: string; language?: string },
): Promise<string> {
  const asr = await loadAsr(opts.model)
  const out = await asr(pcm16k, {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: opts.language || undefined,
    task: 'transcribe',
  } as never)
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : (out as { text?: string }).text
  return (text ?? '').trim()
}

// ---- capture audio (PCM brut via Web Audio — PAS de MediaRecorder/decodeAudioData, source du bug) ----
export interface Recorder {
  stop: () => Promise<Float32Array> // renvoie le PCM mono 16 kHz à l'arrêt
  cancel: () => void
}

/**
 * Démarre la capture micro en PCM brut (Float32) via un ScriptProcessor, puis ré-échantillonne en
 * 16 kHz à l'arrêt. On évite MediaRecorder → decodeAudioData (qui échouait : « Unable to decode audio data »
 * sur le webm/opus produit) en lisant directement les échantillons du graphe audio.
 */
let capturing = false // garde-fou : une seule capture micro à la fois (dictée OU command mode)

/** Traduit une erreur getUserMedia (DOMException) en message FR actionnable (résiduel « micro indisponible »). */
function micError(e: unknown): Error {
  const name = (e as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new Error('Accès micro refusé. Active le micro pour Oryon dans Réglages Windows › Confidentialité › Microphone (autorise les apps de bureau).')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new Error('Aucun micro détecté.')
  if (name === 'NotReadableError') return new Error('Micro occupé par une autre application ou bloqué par le système.')
  return e instanceof Error ? e : new Error(String(e))
}

export async function startRecording(): Promise<Recorder> {
  if (capturing) throw new Error('Capture déjà en cours')
  capturing = true
  // Tout le setup est gardé : si N'IMPORTE quelle étape échoue (permission, AudioContext, ScriptProcessor…),
  // on réinitialise `capturing` et on libère le micro — sinon le flag resterait bloqué à true (« capture déjà en cours »).
  let stream: MediaStream | null = null
  let ac: AudioContext | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    ac = new AudioContext()
    const source = ac.createMediaStreamSource(stream)
    const processor = ac.createScriptProcessor(4096, 1, 1)
    const mute = ac.createGain()
    mute.gain.value = 0 // pas de re-diffusion du micro dans les HP
    const chunks: Float32Array[] = []
    processor.onaudioprocess = (e) => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
    source.connect(processor)
    processor.connect(mute)
    mute.connect(ac.destination)
    const srcRate = ac.sampleRate
    const theAc = ac
    const theStream = stream

    const cleanup = () => {
      capturing = false
      try {
        processor.disconnect()
        source.disconnect()
        mute.disconnect()
      } catch {
        /* ignore */
      }
      theStream.getTracks().forEach((t) => t.stop())
      void theAc.close()
    }

    return {
      cancel: cleanup,
      stop: async () => {
        cleanup()
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const merged = new Float32Array(total)
        let off = 0
        for (const c of chunks) {
          merged.set(c, off)
          off += c.length
        }
        return resampleTo16k(merged, srcRate)
      },
    }
  } catch (e) {
    capturing = false
    try {
      stream?.getTracks().forEach((t) => t.stop())
    } catch {
      /* ignore */
    }
    try {
      await ac?.close()
    } catch {
      /* ignore */
    }
    throw micError(e)
  }
}

/** Ré-échantillonne un PCM mono vers 16 kHz (format attendu par Whisper) via OfflineAudioContext. */
async function resampleTo16k(samples: Float32Array, srcRate: number): Promise<Float32Array> {
  if (samples.length === 0) return samples
  if (srcRate === 16000) return samples
  const length = Math.max(1, Math.round((samples.length * 16000) / srcRate))
  const offline = new OfflineAudioContext(1, length, 16000)
  const buf = offline.createBuffer(1, samples.length, srcRate)
  buf.getChannelData(0).set(samples) // évite le typage strict de copyToChannel (Float32Array générique)
  const src = offline.createBufferSource()
  src.buffer = buf
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

function normTerm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Boost vocabulaire (étape 1, conservateur) : corrige chaque MOT transcrit dont la forme normalisée
 * (sans casse/accents/ponctuation) == un terme connu → la graphie canonique du terme. Sûr (match exact
 * normalisé = haute confiance, pas de fuzzy hasardeux). Le fuzzy/multi-mots viendra d'un incrément suivant.
 */
export function applyVocabBoost(text: string, terms: string[]): string {
  if (!terms.length) return text
  const byNorm = new Map<string, string>()
  for (const t of terms) {
    const n = normTerm(t)
    if (n && !byNorm.has(n)) byNorm.set(n, t)
  }
  return text.replace(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu, (tok) => {
    const canon = byNorm.get(normTerm(tok))
    return canon && canon !== tok ? canon : tok
  })
}

// ---- fuzzyBoost (INC2) : correction post-transcription vers le vocabulaire (Damerau-Levenshtein + n-gram) ----
function normKey(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]/g, '')
}
function dlDistance(a: string, b: string): number {
  const al = a.length
  const bl = b.length
  if (!al) return bl
  if (!bl) return al
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0))
  for (let i = 0; i <= al; i++) d[i][0] = i
  for (let j = 0; j <= bl; j++) d[0][j] = j
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[al][bl]
}
// mots fréquents FR/EN qu'on ne corrige JAMAIS vers un terme du vocab (anti faux-positif).
const BOOST_STOP = new Set([
  'avec', 'dans', 'pour', 'cette', 'comme', 'mais', 'donc', 'plus', 'tout', 'fait', 'sont', 'leur', 'vous', 'nous',
  'that', 'this', 'with', 'from', 'have', 'will', 'your', 'they', 'them', 'then', 'when', 'what', 'data', 'code',
])

/**
 * Boost vocabulaire (INC2) : corrige la transcription vers les termes connus.
 * - n-gram join (2-3 mots consécutifs collés == terme normalisé) → "get user data" → "getUserData".
 * - mot isolé proche d'un terme (Damerau-Levenshtein normalisé ≥ seuil ; bonus aux "starred") → graphie exacte.
 * Conservateur : len≥4, écart de longueur ≤2, stoplist, n-gram en match EXACT only.
 */
export function fuzzyBoost(
  text: string,
  vocab: { term: string; starred?: boolean }[],
  opts?: { threshold?: number },
): string {
  if (!vocab.length) return text
  const threshold = opts?.threshold ?? 0.82
  const terms = vocab.map((v) => ({ term: v.term, key: normKey(v.term), bonus: v.starred ? 0.05 : 0 })).filter((t) => t.key.length >= 3)
  if (!terms.length) return text
  const exactByKey = new Map<string, string>()
  for (const t of terms) if (!exactByKey.has(t.key)) exactByKey.set(t.key, t.term)

  const bestFuzzy = (key: string): string | null => {
    if (key.length < 4 || exactByKey.has(key)) return exactByKey.get(key) ?? null
    let bestTerm: string | null = null
    let bestSim = threshold
    for (const t of terms) {
      if (Math.abs(t.key.length - key.length) > 2) continue
      const sim = 1 - dlDistance(key, t.key) / Math.max(key.length, t.key.length) + t.bonus
      if (sim > bestSim) {
        bestSim = sim
        bestTerm = t.term
      }
    }
    return bestTerm
  }

  const tokens = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.\-_]*|[^\p{L}\p{N}]+/gu) ?? [text]
  const isWord = (s: string): boolean => /[\p{L}\p{N}]/u.test(s[0] ?? '')
  const wordIdx: number[] = []
  tokens.forEach((t, i) => isWord(t) && wordIdx.push(i))
  const consumed = new Set<number>()

  // n-gram join (3 puis 2 mots) : match EXACT du collage normalisé → terme canonique.
  for (const n of [3, 2]) {
    for (let w = 0; w + n <= wordIdx.length; w++) {
      const idxs = wordIdx.slice(w, w + n)
      if (idxs.some((i) => consumed.has(i))) continue
      const canon = exactByKey.get(normKey(idxs.map((i) => tokens[i]).join('')))
      if (canon) {
        tokens[idxs[0]] = canon
        for (let k = 1; k < idxs.length; k++) tokens[idxs[k]] = ''
        for (let i = idxs[0] + 1; i < idxs[idxs.length - 1]; i++) if (!isWord(tokens[i])) tokens[i] = ''
        idxs.forEach((i) => consumed.add(i))
      }
    }
  }
  // mots isolés restants : fuzzy.
  for (const i of wordIdx) {
    if (consumed.has(i)) continue
    const tok = tokens[i]
    if (BOOST_STOP.has(tok.toLowerCase())) continue
    const canon = bestFuzzy(normKey(tok))
    if (canon && canon !== tok) tokens[i] = canon
  }
  return tokens.join('')
}

/** Snippets vocaux : trigger parlé (mot/phrase entière, insensible casse) → expansion. En tête de pipeline. */
export function applySnippets(text: string, snippets: { trigger: string; expansion: string }[]): string {
  let out = text
  for (const { trigger, expansion } of snippets) {
    if (!trigger) continue
    const esc = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`\\b${esc}\\b`, 'gi'), expansion)
  }
  return out
}

/** Applique le dictionnaire de remplacements (insensible à la casse, mot entier quand possible). */
export function applyDictionary(text: string, replacements: { spoken: string; replacement: string }[]): string {
  let out = text
  for (const { spoken, replacement } of replacements) {
    if (!spoken) continue
    const esc = spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`\\b${esc}\\b`, 'gi'), replacement)
  }
  return out
}
