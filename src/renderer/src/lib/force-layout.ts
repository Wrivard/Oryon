// Layout force-directed (Fruchterman-Reingold simplifié) pour la vue graphe de BridgeMemory.
// Déterministe (positions initiales sur un cercle par index) → pas de Math.random, rendu stable.

export interface Pt {
  x: number
  y: number
}

export function forceLayout(
  ids: string[],
  edges: { from: string; to: string }[],
  width: number,
  height: number,
  iterations = 300,
): Map<string, Pt> {
  const n = ids.length
  if (n === 0) return new Map()
  const pos = ids.map((_, i) => {
    const a = (i / n) * Math.PI * 2
    return { x: width / 2 + Math.cos(a) * Math.min(width, height) * 0.32, y: height / 2 + Math.sin(a) * Math.min(width, height) * 0.32 }
  })
  const idx = new Map(ids.map((id, i) => [id, i]))
  const k = Math.sqrt((width * height) / n) * 0.7 // distance idéale
  const startTemp = Math.min(width, height) * 0.12

  for (let it = 0; it < iterations; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }))
    // Répulsion entre toutes les paires.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x
        let dy = pos[i].y - pos[j].y
        let d = Math.hypot(dx, dy) || 0.01
        const rep = (k * k) / d
        dx = (dx / d) * rep
        dy = (dy / d) * rep
        disp[i].x += dx
        disp[i].y += dy
        disp[j].x -= dx
        disp[j].y -= dy
      }
    }
    // Attraction le long des arêtes.
    for (const e of edges) {
      const a = idx.get(e.from)
      const b = idx.get(e.to)
      if (a == null || b == null) continue
      let dx = pos[a].x - pos[b].x
      let dy = pos[a].y - pos[b].y
      const d = Math.hypot(dx, dy) || 0.01
      const att = (d * d) / k
      dx = (dx / d) * att
      dy = (dy / d) * att
      disp[a].x -= dx
      disp[a].y -= dy
      disp[b].x += dx
      disp[b].y += dy
    }
    // Gravité vers le centre (évite les composantes qui dérivent).
    for (let i = 0; i < n; i++) {
      disp[i].x += (width / 2 - pos[i].x) * 0.06
      disp[i].y += (height / 2 - pos[i].y) * 0.06
    }
    // Déplacement borné par la "température" décroissante.
    const temp = startTemp * (1 - it / iterations)
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(disp[i].x, disp[i].y) || 0.01
      pos[i].x += (disp[i].x / d) * Math.min(d, temp)
      pos[i].y += (disp[i].y / d) * Math.min(d, temp)
      pos[i].x = Math.max(20, Math.min(width - 20, pos[i].x))
      pos[i].y = Math.max(20, Math.min(height - 20, pos[i].y))
    }
  }
  return new Map(ids.map((id, i) => [id, pos[i]]))
}
