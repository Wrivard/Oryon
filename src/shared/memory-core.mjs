// Oryon Memory — CŒUR PARTAGÉ, sans Electron (FS + path uniquement). Importé à la fois par le process
// principal (memory.ipc.ts) ET par le serveur MCP standalone (src/mcp/server.mjs), pour que le graphe/les
// backlinks vus par les agents et par l'humain ne puissent JAMAIS diverger (une seule implémentation).
// Concurrence multi-agents : append atomique (sans read-modify-write), écritures atomiques (tmp+rename),
// concurrence optimiste (mtime). Recherche plein-texte. Provenance (auteur/rôle) dans les append.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Nom de fichier sûr : pas de séparateurs/traversée, pas de chars de contrôle, noms Windows réservés évités. */
export function safeName(name) {
  let n = String(name || '')
    .replace(/\.md$/i, '')
    .replace(/[/\\:*?"<>|]+/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120)
  if (!n) n = 'note'
  if (WINDOWS_RESERVED.test(n)) n = `${n}-note`
  return n
}

export const memDir = (projectDir) => join(projectDir, '.oryon', 'memory')
const filePath = (projectDir, name) => join(memDir(projectDir), safeName(name) + '.md')
export const linkKey = (s) => String(s).trim().toLowerCase()

/** Retire les blocs/inline code avant de chercher les [[wikilinks]] (évite les faux liens dans du code). */
function stripCode(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/** Cibles [[wikilink]] sortantes, dédupliquées (alias [[a|b]] → a ; ancres #sec retirées). */
export function parseLinks(content) {
  const out = []
  const seen = new Set()
  const re = /\[\[([^[\]\n]+?)\]\]/g
  const text = stripCode(content)
  let m
  while ((m = re.exec(text))) {
    const t = m[1].split('|')[0].split('#')[0].trim()
    if (!t) continue
    const k = linkKey(t)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(t)
    }
  }
  return out
}

export function titleOf(content, name) {
  const h = String(content).match(/^#\s+(.+)$/m)
  return h ? h[1].trim() : name
}
export function excerptOf(content) {
  const line = stripCode(content)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && l !== '---')
  return (line ?? '').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').slice(0, 160)
}

const ensureDir = (dir) => fs.mkdir(dir, { recursive: true }).catch(() => {})

// Sous Windows (MoveFileEx), fs.rename ÉCHOUE (EPERM/EBUSY) si un autre process a la destination ouverte en
// lecture — fréquent quand 8 agents lisent/cherchent la même note pendant qu'un autre écrit. On retente.
async function renameRetry(from, to) {
  for (let i = 0; i < 6; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (e) {
      const code = e && e.code
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || i === 5) {
        await fs.unlink(from).catch(() => {})
        throw e
      }
      await new Promise((r) => setTimeout(r, 25 + i * 30))
    }
  }
}
let tmpSeq = 0
/** Écriture atomique (temp + rename-retry) : un lecteur ne voit jamais un fichier à moitié écrit. */
async function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`
  await fs.writeFile(tmp, content, 'utf8')
  await renameRetry(tmp, path)
}

/** Lit le brut en distinguant « absent » (ENOENT → existed:false) d'une vraie erreur (propagée). */
async function readRaw(projectDir, name) {
  try {
    return { content: await fs.readFile(filePath(projectDir, name), 'utf8'), existed: true }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { content: '', existed: false }
    throw e
  }
}

/** Charge toutes les notes (avec body) en parallèle. Base de listMemories / search / graph. */
export async function loadAll(projectDir) {
  const dir = memDir(projectDir)
  await ensureDir(dir)
  let files = []
  try {
    files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const notes = await Promise.all(
    files.map(async (f) => {
      const p = join(dir, f)
      let content = ''
      let updated = 0
      try {
        content = await fs.readFile(p, 'utf8')
      } catch {
        /* fichier verrouillé : on le liste quand même, body vide */
      }
      try {
        updated = (await fs.stat(p)).mtimeMs
      } catch {
        /* ignore */
      }
      const name = f.replace(/\.md$/i, '')
      return { name, title: titleOf(content, name), excerpt: excerptOf(content), links: parseLinks(content), updated, body: content }
    }),
  )
  return notes.sort((a, b) => b.updated - a.updated)
}

export async function listMemories(projectDir) {
  return (await loadAll(projectDir)).map(({ body, ...n }) => n) // eslint-disable-line @typescript-eslint/no-unused-vars
}

export async function readMemory(projectDir, name) {
  const { content, existed } = await readRaw(projectDir, name)
  let updated = 0
  if (existed) {
    try {
      updated = (await fs.stat(filePath(projectDir, name))).mtimeMs
    } catch {
      /* ignore */
    }
  }
  const n = safeName(name)
  return { name: n, title: titleOf(content, n), content, links: parseLinks(content), updated, existed }
}

/** Recherche plein-texte (titre + nom + corps), classée. Le cœur de la coordination inter-agents. */
export async function searchMemories(projectDir, query, limit = 20) {
  const q = String(query || '').toLowerCase().trim()
  if (!q) return []
  const all = await loadAll(projectDir)
  const scored = []
  for (const n of all) {
    let score = 0
    if (n.title.toLowerCase().includes(q)) score += 10
    if (n.name.toLowerCase().includes(q)) score += 5
    const body = n.body.toLowerCase()
    if (body.includes(q)) score += 3 + Math.min(6, body.split(q).length - 1)
    if (score > 0) scored.push({ name: n.name, title: n.title, excerpt: n.excerpt, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Écriture atomique (tmp + rename). Concurrence optimiste : si expectedUpdated fourni et le disque a avancé,
 *  renvoie {conflict:true, current} sans écraser. */
export async function writeMemory(projectDir, name, content, opts = {}) {
  const dir = memDir(projectDir)
  await ensureDir(dir)
  const path = filePath(projectDir, name)
  if (opts.expectedUpdated != null) {
    try {
      const st = await fs.stat(path)
      if (st.mtimeMs > opts.expectedUpdated + 1) return { conflict: true, current: await fs.readFile(path, 'utf8'), updated: st.mtimeMs }
    } catch {
      /* n'existe pas encore : pas de conflit */
    }
  }
  await writeAtomic(path, content)
  let updated = 0
  try {
    updated = (await fs.stat(path)).mtimeMs
  } catch {
    /* ignore */
  }
  return { name: safeName(name), updated, existed: true }
}

/** Append atomique (auto-crée si absent). Provenance optionnelle (auteur/rôle + horodatage). Pattern SANS
 *  conflit pour la flotte : chaque agent ajoute une entrée plutôt que réécrire tout le fichier. */
export async function appendMemory(projectDir, name, content, opts = {}) {
  const dir = memDir(projectDir)
  await ensureDir(dir)
  const path = filePath(projectDir, name)
  const existed = await fs
    .access(path)
    .then(() => true)
    .catch(() => false)
  let block = existed ? '' : `# ${safeName(name)}\n`
  const ts = opts.ts || new Date().toISOString().slice(0, 16).replace('T', ' ')
  const tag = opts.author ? `\n> [${opts.author}${opts.role ? ' · ' + opts.role : ''} · ${ts}]\n` : '\n'
  block += `${tag}${String(content).trim()}\n`
  await fs.appendFile(path, block, 'utf8')
  let updated = 0
  try {
    updated = (await fs.stat(path)).mtimeMs
  } catch {
    /* ignore */
  }
  return { name: safeName(name), updated, existed }
}

/** Crée une NOUVELLE note ; ne réécrit pas si elle existe (renvoie existed:true). */
export async function createMemory(projectDir, name, content, opts = {}) {
  const dir = memDir(projectDir)
  await ensureDir(dir)
  const path = filePath(projectDir, name)
  const existed = await fs
    .access(path)
    .then(() => true)
    .catch(() => false)
  if (existed) return { name: safeName(name), existed: true }
  let body = content && String(content).trim() ? String(content) : `# ${safeName(name)}\n\n`
  if (opts.author && !/^---/.test(body)) body = `> [${opts.author}${opts.role ? ' · ' + opts.role : ''}]\n\n${body}`
  await fs.writeFile(path, body, 'utf8')
  return { name: safeName(name), existed: false }
}

export async function deleteMemory(projectDir, name) {
  try {
    await fs.unlink(filePath(projectDir, name))
    return { deleted: true }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { deleted: false }
    throw e
  }
}

/** Graphe (topologie SEULEMENT — aucune mise en page). ids canoniques ; liens non résolus = nœuds fantômes. */
export async function buildGraph(projectDir) {
  const notes = await loadAll(projectDir)
  const byKey = new Map(notes.map((n) => [linkKey(n.name), n]))
  const nodes = notes.map((n) => ({ id: n.name, title: n.title, exists: true }))
  const seen = new Set(notes.map((n) => linkKey(n.name)))
  const edges = []
  for (const n of notes) {
    for (const link of n.links) {
      const hit = byKey.get(linkKey(link))
      const toId = hit ? hit.name : link
      if (!hit && !seen.has(linkKey(link))) {
        nodes.push({ id: link, title: link, exists: false })
        seen.add(linkKey(link))
      }
      edges.push({ from: n.name, to: toId })
    }
  }
  return { nodes, edges }
}

export async function findBacklinks(projectDir, name) {
  const k = linkKey(name)
  const notes = await loadAll(projectDir)
  return notes.filter((n) => linkKey(n.name) !== k && n.links.some((l) => linkKey(l) === k)).map((n) => ({ name: n.name, title: n.title }))
}

export async function getLinks(projectDir, name) {
  const { content } = await readRaw(projectDir, name)
  const links = parseLinks(content)
  const notes = await loadAll(projectDir)
  const exist = new Set(notes.map((n) => linkKey(n.name)))
  return { outgoing: links.filter((l) => exist.has(linkKey(l))), unresolved: links.filter((l) => !exist.has(linkKey(l))) }
}

/** Suggestions PURES (intersection de liens partagés) — aucune IA/embedding (contrainte $0). */
export async function suggestConnections(projectDir, name, limit = 10) {
  const notes = await loadAll(projectDir)
  const me = notes.find((n) => linkKey(n.name) === linkKey(name))
  if (!me) return []
  const mine = new Set(me.links.map(linkKey))
  const out = []
  for (const n of notes) {
    if (linkKey(n.name) === linkKey(name)) continue
    const shared = n.links.map(linkKey).filter((l) => mine.has(l)).length
    if (shared > 0) out.push({ name: n.name, title: n.title, sharedLinks: shared, score: shared })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Renomme une note ET réécrit [[ancien]] → [[nouveau]] dans toutes les notes (alias/ancre préservés). */
export async function renameMemory(projectDir, oldName, newName) {
  const dir = memDir(projectDir)
  const sNew = safeName(newName)
  await renameRetry(filePath(projectDir, oldName), filePath(projectDir, sNew))
  const oldKey = linkKey(oldName)
  const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.md'))
  for (const f of files) {
    const p = join(dir, f)
    let c
    try {
      c = await fs.readFile(p, 'utf8')
    } catch {
      continue
    }
    const next = c.replace(/\[\[([^[\]\n]+?)\]\]/g, (full, inner) => {
      const parts = inner.split('|')
      const targetRaw = parts[0]
      const anchor = targetRaw.includes('#') ? '#' + targetRaw.split('#').slice(1).join('#') : ''
      if (linkKey(targetRaw.split('#')[0].trim()) !== oldKey) return full
      return `[[${sNew}${anchor}${parts.length > 1 ? '|' + parts.slice(1).join('|') : ''}]]`
    })
    if (next !== c) await writeAtomic(p, next)
  }
  return { name: sNew }
}

/** Résolution du dossier projet pour le serveur MCP : ascendant jusqu'à un .oryon/.git ; sinon startCwd. */
export async function findProjectDir(startCwd) {
  let dir = startCwd
  for (let i = 0; i < 40; i++) {
    if (await fs.access(join(dir, '.oryon')).then(() => true).catch(() => false)) return dir
    if (await fs.access(join(dir, '.git')).then(() => true).catch(() => false)) return dir
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return startCwd
}

/** Chemin du fichier de claims (reserved files pour les agents). */
function claimsPath(projectDir) {
  return join(memDir(projectDir), 'claims.json')
}

/** Lit claims.json (mapping fichier → agent + uuid). Retourne {} si absent. */
export async function readClaims(projectDir) {
  try {
    const content = await fs.readFile(claimsPath(projectDir), 'utf8')
    return JSON.parse(content)
  } catch (e) {
    if (e && e.code === 'ENOENT') return {}
    throw e
  }
}

/** Ajoute/met à jour un claim (fichier → {agent, uuid, ts}). Détection de conflit : si un autre agent
 *  possède déjà ce fichier avec un uuid différent, renvoie {conflict:true, owner}. Sinon {conflict:false}. */
export async function claimFile(projectDir, filepath, agentName, opts = {}) {
  const path = claimsPath(projectDir)
  const uuid = opts.uuid || String(Math.random()).slice(2)
  const ts = Date.now()
  const dir = memDir(projectDir)
  await ensureDir(dir)

  let claims = await readClaims(projectDir)
  const existing = claims[filepath]

  // Conflit si un autre agent a déjà ce fichier
  if (existing && existing.agent !== agentName) {
    return { conflict: true, owner: existing.agent, uuid: existing.uuid }
  }

  // Pas de conflit : créer ou mettre à jour
  claims[filepath] = { agent: agentName, uuid, ts }

  // Écriture atomique
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`
  await fs.writeFile(tmp, JSON.stringify(claims, null, 2), 'utf8')
  await renameRetry(tmp, path)

  return { conflict: false, uuid }
}

/** Relâche un claim (supprime le fichier de claims.json). Idempotent. */
export async function releaseClaim(projectDir, filepath) {
  const path = claimsPath(projectDir)
  let claims = await readClaims(projectDir)

  if (claims[filepath]) {
    delete claims[filepath]
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`
    await fs.writeFile(tmp, JSON.stringify(claims, null, 2), 'utf8')
    await renameRetry(tmp, path)
  }

  return { released: true }
}

/** Relâche TOUS les claims d'un agent (à la complétion/annulation de sa task). Idempotent. Renvoie le nb supprimé. */
export async function releaseClaimsByAgent(projectDir, agentName) {
  const path = claimsPath(projectDir)
  const claims = await readClaims(projectDir)
  let released = 0
  for (const [f, c] of Object.entries(claims)) {
    if (c && c.agent === agentName) {
      delete claims[f]
      released++
    }
  }
  if (released > 0) {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`
    await fs.writeFile(tmp, JSON.stringify(claims, null, 2), 'utf8')
    await renameRetry(tmp, path)
  }
  return { released }
}
