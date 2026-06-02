import { spawn } from 'child_process'

// Coupe le son système pendant la dictée (réglage voice.muteDuringDictation), via l'API Core Audio de Windows
// pilotée en PowerShell + interop C# — AUCUNE dépendance native. On utilise des SET explicites (pas un toggle) et
// on sauvegarde l'état de mute d'avant pour le restaurer → robuste (ne « débloque » jamais par erreur un système
// déjà coupé). ASYNCHRONE / fire-and-forget : ne bloque jamais la dictée ; la coupure s'applique ~1 s après (le
// temps que PowerShell compile l'interop). Tout échec est silencieux (le son n'est pas critique). Windows seulement.

// Interface Core Audio minimale. L'ORDRE des méthodes EST le vtable COM : 11 méthodes avant SetMute (#12) puis
// GetMute (#13) — cf. endpointvolume.h. Les stubs ne sont jamais appelés (seul leur emplacement compte).
const CORE_AUDIO_CS = `
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAEV {
  int RegisterControlChangeNotify(IntPtr n);
  int UnregisterControlChangeNotify(IntPtr n);
  int GetChannelCount(out uint c);
  int SetMasterVolumeLevel(float l, Guid e);
  int SetMasterVolumeLevelScalar(float l, Guid e);
  int GetMasterVolumeLevel(out float l);
  int GetMasterVolumeLevelScalar(out float l);
  int SetChannelVolumeLevel(uint n, float l, Guid e);
  int SetChannelVolumeLevelScalar(uint n, float l, Guid e);
  int GetChannelVolumeLevel(uint n, out float l);
  int GetChannelVolumeLevelScalar(uint n, out float l);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, Guid e);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMD { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDE {
  int EnumAudioEndpoints(int flow, int state, out IntPtr devices);
  int GetDefaultAudioEndpoint(int flow, int role, out IMMD dev);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDEnum {}
public static class OryonAudio {
  static IAEV Vol() {
    var en = (IMMDE)(new MMDEnum());
    IMMD dev; en.GetDefaultAudioEndpoint(0, 0, out dev); // eRender, eConsole
    Guid iid = typeof(IAEV).GUID; object o;
    dev.Activate(ref iid, 23, IntPtr.Zero, out o); // CLSCTX_ALL
    return (IAEV)o;
  }
  public static bool Get() { bool m; Vol().GetMute(out m); return m; }
  public static void Set(bool m) { Vol().SetMute(m, Guid.Empty); }
}
`

let savedMute: boolean | null = null // état de mute AVANT notre coupure (à restaurer) ; null = on n'a rien coupé
let busy = false // évite des spawns concurrents (coupure/restauration qui se chevaucheraient)

function runPs(body: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const script = `Add-Type -TypeDefinition @"\n${CORE_AUDIO_CS}\n"@ -ErrorAction Stop; ${body}`
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
      let out = ''
      proc.stdout?.on('data', (d) => {
        out += String(d)
      })
      proc.on('error', () => resolve(''))
      proc.on('close', () => resolve(out.trim()))
    } catch {
      resolve('')
    }
  })
}

/** Coupe le son système (sauve l'état courant pour pouvoir le restaurer). No-op hors Windows / si déjà coupé par nous. */
export async function muteForDictation(): Promise<void> {
  if (process.platform !== 'win32' || busy || savedMute !== null) return
  busy = true
  try {
    // Une seule passe : lit l'état courant, et coupe seulement s'il ne l'était pas déjà.
    const out = await runPs(`if ([OryonAudio]::Get()) { 'was-muted' } else { [OryonAudio]::Set($true); 'we-muted' }`)
    if (out === 'we-muted') savedMute = false // on a coupé → restaurer en NON-coupé
    else if (out === 'was-muted') savedMute = true // déjà coupé → restauration = no-op (on garde la cohérence)
    // out vide (échec/interop KO) → savedMute reste null : rien à restaurer, et on n'a probablement rien coupé
  } finally {
    busy = false
  }
}

/** Restaure l'état de mute d'avant la dictée. No-op si on n'avait rien coupé. */
export async function restoreAfterDictation(): Promise<void> {
  if (process.platform !== 'win32' || savedMute === null) return
  const target = savedMute
  savedMute = null
  await runPs(`[OryonAudio]::Set($${target ? 'true' : 'false'})`)
}
