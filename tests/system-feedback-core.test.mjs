// Caractérisation de system-feedback-core : l'invariant critique est `enqueue` (sérialisation in-process de
// TOUTES les écritures) qui corrige une race lost-write — vérifiée une fois à la main, plus jamais depuis.
// Le store est sous ~/.oryon/system-feedback/ (homedir() codé en dur) → on mocke node:os pour rediriger
// homedir() vers un tmpdir FRAIS par test (isolation), en gardant le reste d'os réel (tmpdir…).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, homedir: () => state.home }
})

let mod
let realTmp
beforeAll(async () => {
  const realOs = await vi.importActual('node:os')
  realTmp = realOs.tmpdir()
  mod = await import('../src/shared/system-feedback-core.mjs')
})
beforeEach(() => {
  // tmpdir frais → store vide par test (les fonctions du module relisent homedir() à chaque appel)
  state.home = mkdtempSync(join(realTmp, 'oryon-feedback-test-'))
})

describe('appendReport — valeurs par défaut', () => {
  it('pose id/ts/status par défaut et écrit le fichier', async () => {
    const rec = await mod.appendReport({ category: 'dispatch', title: 'A', severity: 'low' })
    expect(rec).not.toBeNull()
    expect(typeof rec.id).toBe('string')
    expect(rec.id.length).toBeGreaterThan(0)
    expect(typeof rec.ts).toBe('number')
    expect(rec.status).toBe('open')
    expect(existsSync(mod.reportsPath())).toBe(true)
  })
})

describe('enqueue — sérialisation anti lost-write (invariant critique)', () => {
  it('3 appends + 1 updateStatus concurrents → 4 records, statut appliqué', async () => {
    // id connu inséré AVANT le lot, ciblé par l'update
    const seed = await mod.appendReport({ id: 'seed-xyz', category: 'merge', title: 'seed', severity: 'high' })
    expect(seed.id).toBe('seed-xyz')

    // lancés ensemble : sans enqueue, le read-modify-write de l'update clobbererait des appends concurrents.
    await Promise.all([
      mod.appendReport({ category: 'worker', title: 'c1', severity: 'low' }),
      mod.appendReport({ category: 'worker', title: 'c2', severity: 'low' }),
      mod.appendReport({ category: 'worker', title: 'c3', severity: 'low' }),
      mod.updateReportStatus('seed-xyz', 'resolved', 'note de revue'),
    ])

    const all = await mod.listReports()
    expect(all.length).toBe(4) // seed + c1 + c2 + c3 : aucun append perdu
    const updated = all.find((r) => r.id === 'seed-xyz')
    expect(updated.status).toBe('resolved')
    expect(updated.reviewNote).toBe('note de revue')
  })
})

describe('listReports — filtres + résilience aux lignes malformées', () => {
  it('filtre status/category et ignore une ligne corrompue', async () => {
    await mod.appendReport({ id: 's1', category: 'merge', title: 'seed', severity: 'high' })
    await mod.updateReportStatus('s1', 'resolved', 'revue')
    await mod.appendReport({ category: 'worker', title: 'w1', severity: 'low' })
    await mod.appendReport({ category: 'worker', title: 'w2', severity: 'low' })
    await mod.appendReport({ category: 'worker', title: 'w3', severity: 'low' })

    // ligne non-JSON injectée à la main : listReports doit la sauter sans planter
    appendFileSync(mod.reportsPath(), 'ceci nest pas du JSON\n', 'utf8')

    expect((await mod.listReports()).length).toBe(4) // la ligne corrompue est ignorée, pas comptée
    const resolved = await mod.listReports({ status: 'resolved' })
    expect(resolved.length).toBe(1)
    expect(resolved[0].id).toBe('s1')
    const workers = await mod.listReports({ category: 'worker' })
    expect(workers.length).toBe(3)
    expect(workers.every((r) => r.category === 'worker')).toBe(true)
  })
})
