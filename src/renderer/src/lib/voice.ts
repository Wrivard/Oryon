// Transcription Whisper ON-DEVICE via Transformers.js (WASM) — aucune compilation native, rien au cloud.
// Le modèle ONNX (multilingue) est téléchargé au 1er usage puis mis en cache (IndexedDB).
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

env.allowLocalModels = false // poids du modèle depuis le hub HF (cachés en IndexedDB au 1er usage)

// CAUSE RACINE de « no available backend / Unexpected token '<' » : avec wasmPaths en OBJET + useWasmCache,
// ORT lit la glue depuis le CacheStorage SANS re-fetch ; une ancienne entrée empoisonnée (page HTML 404 d'une
// tentative ratée) est servie comme JS → '<'. On coupe le cache de la glue wasm (les POIDS du modèle restent
// cachés en IndexedDB, intacts) et on purge UNE fois les entrées ORT empoisonnées.
;(env as unknown as { useWasmCache?: boolean }).useWasmCache = false

// Runtime ONNX servi en LOCAL (même origine), jamais le CDN dev-version 404 (cf. electron.vite.config copyOrtWasm).
const ortBase = new URL('ort/', window.location.href).href
const ortWasm = env.backends?.onnx?.wasm
if (ortWasm) {
  ortWasm.wasmPaths = {
    mjs: ortBase + 'ort-wasm-simd-threaded.asyncify.mjs',
    wasm: ortBase + 'ort-wasm-simd-threaded.asyncify.wasm',
  }
  ortWasm.numThreads = 1 // mono-thread déterministe : aucun SharedArrayBuffer/COI requis
  ortWasm.proxy = false
}

// Purge SCOPÉE one-time des entrées ORT empoisonnées du cache transformers (laisse les poids du modèle).
const ortCacheReady: Promise<void> = (async () => {
  try {
    if (typeof caches === 'undefined' || localStorage.getItem('oryon:ortCachePurged') === '2') return
    const c = await caches.open('transformers-cache')
    for (const req of await c.keys()) {
      if (/ort-wasm|onnxruntime-web|asyncify\.(mjs|wasm)|jsdelivr/i.test(req.url)) await c.delete(req)
    }
    localStorage.setItem('oryon:ortCachePurged', '2')
  } catch {
    /* cache indispo : on continue */
  }
})()

const asrCache = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>()
// Sonde WebGPU une seule fois au chargement du module — fallback WASM si API absente ou pas d'adapter.
const gpuDevice: Promise<'webgpu' | 'wasm'> = (async () => {
  try {
    const adapter = await (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu?.requestAdapter()
    return adapter ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
})()

/** Backend ASR effectif résolu au chargement : 'webgpu' (rapide) ou 'wasm' (CPU mono-thread, nettement plus lent). */
export function getAsrDevice(): Promise<'webgpu' | 'wasm'> {
  return gpuDevice
}

/** Charge (lazy, recharge par clé model@dtype) le pipeline ASR — après la purge du cache ORT.
 *  dtype 'q8' par défaut (léger/rapide) ; 'fp32' en dernier repli (NON quantifié → immunisé MatMulNBits). */
export function loadAsr(
  model: string,
  onProgress?: (p: { status: string; progress?: number; file?: string }) => void,
  dtype: 'q8' | 'fp32' = 'q8',
): Promise<AutomaticSpeechRecognitionPipeline> {
  const key = `${model}@${dtype}`
  const cached = asrCache.get(key)
  if (cached) return cached
  const promise = Promise.all([ortCacheReady, gpuDevice]).then(
    ([, device]) =>
      pipeline('automatic-speech-recognition', model, {
        device,
        dtype,
        progress_callback: onProgress as never,
      } as never) as Promise<AutomaticSpeechRecognitionPipeline>,
  )
  // Cache auto-réparant : si le chargement échoue (réseau, init session ORT…), évince l'entrée pour qu'une
  // prochaine dictée puisse réessayer. Sinon la promesse rejetée resterait en cache et toute dictée suivante
  // du même modèle échouerait instantanément jusqu'au reload de l'app (empoisonnement de cache).
  promise.catch(() => {
    if (asrCache.get(key) === promise) asrCache.delete(key)
  })
  asrCache.set(key, promise)
  return promise
}

/** Préchauffe le modèle ASR à l'idle (download + init session ORT) hors du chemin critique de la 1re dictée. */
export function warmModel(
  model: string,
  dtype: 'q8' | 'fp32' = 'q8',
  onProgress?: (p: { status: string; progress?: number; file?: string }) => void,
): Promise<void> {
  return loadAsr(model, onProgress, dtype).then(() => undefined)
}

/** Résout le nom court de modèle (réglage voice.model) en id de dépôt HF/ONNX réel (tiny|base|small|medium|large|distil-large). */
export function resolveModelId(short: string): string {
  switch (short) {
    case 'large':
      return 'Xenova/whisper-large-v3'
    case 'distil-large':
      return 'distil-whisper/distil-large-v3' // repli gracieux via la cascade fp32/whisper-base si l'id ONNX diffère
    default:
      return 'Xenova/whisper-' + short
  }
}

async function runAsr(model: string, pcm16k: Float32Array, language?: string, dtype: 'q8' | 'fp32' = 'q8', onProgress?: (p: { status: string; progress?: number; file?: string }) => void): Promise<string> {
  const asr = await loadAsr(model, onProgress, dtype)
  const out = await asr(pcm16k, {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: language || undefined,
    task: 'transcribe',
  } as never)
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : (out as { text?: string }).text
  return (text ?? '').trim()
}

/** Transcrit un PCM mono 16 kHz (Float32) → texte. `language` ex 'french' | 'english' | undefined (auto). */
export async function transcribe(
  pcm16k: Float32Array,
  opts: { model: string; language?: string; onProgress?: (p: { status: string; progress?: number; file?: string }) => void },
): Promise<string> {
  try {
    return await runAsr(opts.model, pcm16k, opts.language, 'q8', opts.onProgress)
  } catch (e) {
    const msg = (e as Error)?.message ?? ''
    // Échec de création de session ORT (y.c. « MatMulNBits / required scale » des modèles quantifiés) → replis.
    if (!/create a session|ORT_FAIL|failed to load|MatMulNBits|required scale/i.test(msg)) throw e
    // Bascule vers un modèle de secours (téléchargement possible) → signale-le pour le feedback 'downloading'.
    opts.onProgress?.({ status: 'initiate', file: 'modèle de secours' })
    asrCache.delete(`${opts.model}@q8`)
    // Repli 1 : whisper-base en q8 (plus léger). Repli 2 : whisper-base en fp32 (NON quantifié → le plus sûr).
    try {
      if (!/whisper-base/.test(opts.model)) return await runAsr('Xenova/whisper-base', pcm16k, opts.language, 'q8', opts.onProgress)
    } catch {
      /* le repli q8 échoue aussi → fp32 ci-dessous */
    }
    asrCache.delete('Xenova/whisper-base@q8')
    try {
      return await runAsr('Xenova/whisper-base', pcm16k, opts.language, 'fp32', opts.onProgress)
    } catch (e2) {
      const msg2 = (e2 as Error)?.message ?? ''
      throw new Error(
        /network|fetch|Failed to fetch/i.test(msg2)
          ? 'Modèle vocal indisponible (réseau). Vérifiez votre connexion internet et relancez la dictée.'
          : `Reconnaissance vocale indisponible (ORT/modèle). Relancez l'app si le problème persiste. [${msg2}]`,
      )
    }
  }
}

// ---- capture audio (PCM brut via Web Audio — PAS de MediaRecorder/decodeAudioData, source du bug) ----
export interface Recorder {
  stop: () => Promise<Float32Array> // renvoie le PCM mono 16 kHz à l'arrêt
  cancel: () => void
  hadSpeech: () => boolean // vrai si de la parole a été détectée (garde anti-transcription du silence)
}

/** Détection de fin de parole (VAD énergie RMS) → auto-stop + auto-paste. */
export interface VadOptions {
  onSilence?: () => void // appelé UNE fois quand le silence dépasse silenceMs après de la vraie parole
  silenceMs?: number // durée de silence avant auto-stop (défaut 600 — réactif ; réglable 400-2000 dans les réglages)
  minSpeechMs?: number // parole minimale avant d'armer l'auto-stop (anti silence initial)
  rmsThreshold?: number // plancher de bruit
  maxDurationMs?: number // garde-fou anti-emballement mémoire — PAS une limite de dictée (généreux exprès : « sans limite »)
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

// Micro CHAUD : on garde le MediaStream + AudioContext vivants entre deux dictées rapprochées pour supprimer la
// latence de getUserMedia/AudioContext au démarrage. Relâchés après WARM_IDLE_MS d'inactivité — le voyant micro
// de l'OS s'éteint alors (compromis vitesse / voyant assumé ; ajustable via WARM_IDLE_MS).
const WARM_IDLE_MS = 30000
let warmStream: MediaStream | null = null
let warmAc: AudioContext | null = null
let warmReleaseTimer: ReturnType<typeof setTimeout> | null = null

function warmMicLive(): boolean {
  return !!warmStream && warmStream.getAudioTracks().some((t) => t.readyState === 'live')
}

/** Relâche le micro chaud : arrête les pistes (voyant OS éteint) et ferme l'AudioContext. */
function releaseWarmMic(): void {
  if (warmReleaseTimer) {
    clearTimeout(warmReleaseTimer)
    warmReleaseTimer = null
  }
  try {
    warmStream?.getTracks().forEach((t) => t.stop())
  } catch {
    /* ignore */
  }
  try {
    void warmAc?.close()
  } catch {
    /* ignore */
  }
  warmStream = null
  warmAc = null
}

/** Programme le relâchement du micro chaud après WARM_IDLE_MS sans nouvelle capture. */
function scheduleWarmRelease(): void {
  if (warmReleaseTimer) clearTimeout(warmReleaseTimer)
  warmReleaseTimer = setTimeout(releaseWarmMic, WARM_IDLE_MS)
}

/** Réutilise le micro/AC chauds s'ils sont vivants, sinon en acquiert de frais (1re dictée / micro relâché ou changé). */
async function acquireWarmMic(): Promise<{ stream: MediaStream; ac: AudioContext }> {
  if (warmReleaseTimer) {
    clearTimeout(warmReleaseTimer)
    warmReleaseTimer = null
  }
  if (warmMicLive() && warmAc && warmAc.state !== 'closed') {
    if (warmAc.state === 'suspended') {
      try {
        await warmAc.resume()
      } catch {
        /* ignore */
      }
    }
    return { stream: warmStream as MediaStream, ac: warmAc }
  }
  releaseWarmMic() // nettoie un éventuel reste mort (piste finie / AC fermé) avant d'acquérir
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  warmStream = stream
  const ac = new AudioContext()
  warmAc = ac
  return { stream, ac }
}

export async function startRecording(vad: VadOptions = {}): Promise<Recorder> {
  if (capturing) throw new Error('Capture déjà en cours')
  capturing = true
  const { onSilence, silenceMs = 600, minSpeechMs = 350, rmsThreshold = 0.012, maxDurationMs = 600000 } = vad
  // Tout le setup est gardé : si N'IMPORTE quelle étape échoue (permission, AudioContext, ScriptProcessor…),
  // on réinitialise `capturing` et on libère le micro — sinon le flag resterait bloqué à true (« capture déjà en cours »).
  try {
    // Micro + AudioContext CHAUDS : réutilisés entre dictées rapprochées (zéro latence getUserMedia/AC au démarrage).
    const { stream, ac } = await acquireWarmMic()
    const source = ac.createMediaStreamSource(stream)
    const processor = ac.createScriptProcessor(4096, 1, 1)
    const mute = ac.createGain()
    mute.gain.value = 0 // pas de re-diffusion du micro dans les HP
    const chunks: Float32Array[] = []
    const srcRate = ac.sampleRate
    // VAD énergie : accumule la parole/le silence et déclenche onSilence une seule fois.
    let sawSpeech = false
    let speechMs = 0
    let silenceRun = 0
    let totalMs = 0
    let fired = false
    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(data))
      // Suivi énergie TOUJOURS actif (alimente hadSpeech() pour la garde anti-silence, même sans auto-stop).
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      const frameMs = (data.length / srcRate) * 1000
      totalMs += frameMs
      if (rms >= rmsThreshold) {
        speechMs += frameMs
        silenceRun = 0
        if (speechMs >= minSpeechMs) sawSpeech = true
      } else {
        silenceRun += frameMs
      }
      // Auto-stop UNIQUEMENT si onSilence est fourni (VAD activé).
      if (onSilence && !fired && ((sawSpeech && silenceRun >= silenceMs) || totalMs >= maxDurationMs)) {
        fired = true
        onSilence()
      }
    }
    source.connect(processor)
    processor.connect(mute)
    mute.connect(ac.destination)
    // cleanup : détache CE recording (handler + nœuds) mais GARDE le micro/AC chauds pour la dictée suivante ;
    // arme le relâchement après WARM_IDLE_MS d'inactivité (le voyant micro de l'OS s'éteint alors).
    const cleanup = () => {
      capturing = false
      try {
        processor.onaudioprocess = null
        processor.disconnect()
        source.disconnect()
        mute.disconnect()
      } catch {
        /* ignore */
      }
      scheduleWarmRelease()
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
      hadSpeech: () => sawSpeech,
    }
  } catch (e) {
    capturing = false
    releaseWarmMic() // setup échoué pendant/après acquisition : on relâche le micro chaud (état incertain)
    throw micError(e)
  }
}

/** Ré-échantillonne un PCM mono vers 16 kHz (interpolation linéaire JS, sans OfflineAudioContext). */
function resampleTo16k(samples: Float32Array, srcRate: number): Float32Array {
  if (samples.length === 0) return samples
  if (srcRate === 16000) return samples
  const ratio = srcRate / 16000
  const outLen = Math.round(samples.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const lo = Math.floor(pos)
    const hi = Math.min(lo + 1, samples.length - 1)
    out[i] = samples[lo] * (1 - (pos - lo)) + samples[hi] * (pos - lo)
  }
  return out
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
      const dist = dlDistance(key, t.key)
      const sim = 1 - dist / Math.max(key.length, t.key.length) + t.bonus
      // Clés courtes (≤6) : exige sim≥0.9 ET dist≤1 — évite 'table'→'ctable' à 0.833.
      if (key.length <= 6 && (sim < 0.9 || dist > 1)) continue
      if (sim > bestSim) {
        bestSim = sim
        bestTerm = t.term
      }
    }
    return bestTerm
  }

  const tokens = text.match(/[\p{L}\p{N}][\p{L}\p{N}''.\-_]*|[^\p{L}\p{N}]+/gu) ?? [text]
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
    // Remplaçant en FONCTION : insère l'expansion VERBATIM. En 2e arg string, String.replace interpréterait
    // $&, $$, $`, $' présents dans le texte utilisateur (snippet/auto-appris) → sortie corrompue.
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), () => expansion)
  }
  return out
}

/** Applique le dictionnaire de remplacements (insensible à la casse, mot entier quand possible). */
export function applyDictionary(text: string, replacements: { spoken: string; replacement: string }[]): string {
  let out = text
  for (const { spoken, replacement } of replacements) {
    if (!spoken) continue
    const esc = spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Remplaçant en FONCTION : insère le remplacement VERBATIM (les séquences $ du texte utilisateur ne sont pas réinterprétées).
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), () => replacement)
  }
  return out
}
