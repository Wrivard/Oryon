// Mappe un nombre de terminaux -> grille CSS (cf. 02-UI-SPEC §3).
// Presets pour les comptes "canoniques" ; fallback quasi-carré après split/close.

const PRESET: Record<number, { cols: number; rows: number }> = {
  1: { cols: 1, rows: 1 },
  2: { cols: 2, rows: 1 },
  3: { cols: 3, rows: 1 },
  4: { cols: 2, rows: 2 },
  5: { cols: 3, rows: 2 },
  6: { cols: 3, rows: 2 },
  8: { cols: 4, rows: 2 },
  10: { cols: 5, rows: 2 },
  12: { cols: 4, rows: 3 },
  14: { cols: 5, rows: 3 },
  16: { cols: 4, rows: 4 },
}

export function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 }
  if (PRESET[n]) return PRESET[n]
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  return { cols, rows }
}
