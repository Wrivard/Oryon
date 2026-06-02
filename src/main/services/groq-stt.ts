// Transcription STT via Groq (Whisper hébergé, API OpenAI-compatible) — choix utilisateur (console.groq.com).
// Fournisseur SÉPARÉ de Claude : n'utilise JAMAIS la clé/abonnement Claude (le coût $0 Claude reste intact).
// La clé Groq vit côté MAIN (jamais requise par le renderer). L'audio (PCM 16 kHz mono Float32) est encodé en
// WAV PCM 16-bit puis posté en multipart. Si cette fonction lève, l'appelant (useVoice) bascule sur le moteur
// LOCAL on-device (repli) — donc une coupure réseau / une clé invalide ne casse jamais la dictée.

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'

/** Encode un PCM mono Float32 [-1,1] en WAV PCM 16-bit little-endian (en-tête 44 octets) sur un ArrayBuffer simple. */
function encodeWav16(pcm: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const n = pcm.length
  const ab = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(ab)
  const writeStr = (off: number, str: string): void => {
    for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  dv.setUint32(4, 36 + n * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  dv.setUint32(16, 16, true) // taille du sous-chunk fmt
  dv.setUint16(20, 1, true) // format PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true) // byte rate = sampleRate * blockAlign
  dv.setUint16(32, 2, true) // block align = canaux * bits/8
  dv.setUint16(34, 16, true) // bits par échantillon
  writeStr(36, 'data')
  dv.setUint32(40, n * 2, true)
  let off = 44
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    dv.setInt16(off, (s < 0 ? s * 0x8000 : s * 0x7fff) | 0, true)
    off += 2
  }
  return new Uint8Array(ab)
}

/**
 * Transcrit un PCM 16 kHz mono via Groq. `language` = code ISO-639-1 ('fr' | 'en') ou '' (auto-détection).
 * Lève en cas d'échec (réseau, 4xx/5xx, clé invalide) — à l'appelant de retomber sur le moteur local.
 */
export async function transcribeWithGroq(
  pcm16k: Float32Array,
  language: string,
  apiKey: string,
  model = 'whisper-large-v3-turbo',
  prompt = '',
): Promise<string> {
  const wav = encodeWav16(pcm16k, 16000)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', model)
  if (language) form.append('language', language)
  // Amorce Whisper (≤224 tokens) : oriente la langue (français QC) + fait reconnaître les noms propres / le jargon.
  if (prompt) form.append('prompt', prompt)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Groq ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as { text?: string }
  return (json.text ?? '').trim()
}

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'

/**
 * Nettoyage intelligent du transcript via un LLM Groq RAPIDE (défaut llama-3.1-8b-instant) : retire les
 * hésitations, applique les auto-corrections parlées (« scratch that ») + commandes, SANS rien inventer (édition
 * soustractive, cf. CLEANUP_SYSTEM). Fournisseur SÉPARÉ de Claude → $0 Claude. Renvoie '' (→ repli sur le brut)
 * si vide, erreur, ou si la sortie a beaucoup gonflé (garde anti-hallucination/emballement).
 */
export async function cleanupWithGroq(
  text: string,
  systemPrompt: string,
  apiKey: string,
  model = 'llama-3.1-8b-instant',
): Promise<string> {
  // Borne la sortie près de la taille de l'entrée → coupe court à un emballement (« répète un mot 100× »).
  const maxTokens = Math.min(2048, Math.ceil((text.length / 4) * 1.4) + 64)
  const res = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0, // transformation déterministe, pas de génération créative → minimise hallucination/paraphrase
      top_p: 1,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Groq chat ${res.status} ${res.statusText}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const out = (json.choices?.[0]?.message?.content ?? '').trim()
  // Garde anti-ballonnement : une sortie nettement plus longue que l'entrée = probable dérive → repli sur le brut.
  if (!out || out.length > text.length * 1.6 + 40) return ''
  return out
}
