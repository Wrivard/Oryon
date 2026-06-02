// Sons de repère de dictée : un bip court MONTANT à l'ouverture et DESCENDANT au relâchement, synthétisés via
// Web Audio (aucun fichier asset à bundler). Best-effort : toute erreur audio est ignorée (jamais bloquant, et
// indépendant du micro/AudioContext de capture — ce contexte-ci est purement de sortie).

let cueCtx: AudioContext | null = null

function ctx(): AudioContext {
  if (!cueCtx || cueCtx.state === 'closed') cueCtx = new AudioContext()
  return cueCtx
}

/** Bip court à enveloppe douce, glissant de `from` vers `to` Hz (~120 ms). */
function tone(from: number, to: number): void {
  try {
    const ac = ctx()
    if (ac.state === 'suspended') void ac.resume()
    const t = ac.currentTime
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(from, t)
    osc.frequency.exponentialRampToValueAtTime(to, t + 0.09)
    // Enveloppe : attaque rapide puis extinction douce (évite le clic).
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.start(t)
    osc.stop(t + 0.13)
  } catch {
    /* audio indisponible : on ignore */
  }
}

/** Bip d'OUVERTURE de dictée (montant). */
export function playStartCue(): void {
  tone(660, 990)
}

/** Bip de FIN/relâchement de dictée (descendant). */
export function playEndCue(): void {
  tone(880, 590)
}
