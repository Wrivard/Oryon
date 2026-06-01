// Backend des skills Claude Code : scan + CRUD complet (créer / importer dossier / importer git / éditer /
// supprimer). Les skills vivent dans <base>/<nom>/SKILL.md où <base> = ~/.claude/skills (scope 'user') ou
// <projet>/.claude/skills (scope 'project'). La couche IPC (skills.ipc.ts) ne fait que déléguer ici.
//
// INVARIANT sûreté (cf. worktrees.ts) : la suppression ne FRANCHIT JAMAIS un reparse-point (junction/symlink) —
// un lien est retiré comme nœud, jamais suivi — sinon `rmSync` recursive viderait un dossier externe pointé
// (ex. un skill symlinké, ou la junction .claude/skills d'un worktree).

import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import type { Stats } from 'fs'
import { basename, join } from 'path'
import { homedir, tmpdir } from 'os'
import type {
  SkillCreateInput,
  SkillDetail,
  SkillImportFolderInput,
  SkillImportGitInput,
  SkillImportResult,
  SkillInfo,
  SkillRef,
  SkillScope,
  SkillUpdateInput,
} from '../../shared/types'

const execFileAsync = promisify(execFile)

// ---- frontmatter ------------------------------------------------------------------------------------------

// Bloc frontmatter en tête de fichier (`---` … `---`). Robustesse Windows : BOM + CRLF normalisés par l'appelant.
// `[\s\S]*?` lazy → s'arrête au PREMIER `---` fermant (un `---` markdown dans le corps vient APRÈS, jamais capté).
const FRONTMATTER = /^\s*---\s*([\s\S]*?)\s*---/

function parseFmFields(block: string): { name?: string; description?: string } {
  const out: { name?: string; description?: string } = {}
  for (const line of block.split('\n')) {
    const kv = line.match(/^(name|description)\s*:\s*(.+)$/)
    if (kv) out[kv[1] as 'name' | 'description'] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}
/** Normalise (BOM + CRLF) puis renvoie les champs name/description du frontmatter (vide si aucun bloc). */
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const src = md.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = src.match(FRONTMATTER)
  return m ? parseFmFields(m[1]) : {}
}
/** Comme parseFrontmatter mais renvoie aussi le CORPS (markdown après le `---` fermant) pour l'édition. */
function splitFrontmatter(md: string): { name?: string; description?: string; body: string } {
  const src = md.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = src.match(FRONTMATTER)
  if (!m) return { body: src }
  // corps = tout après le bloc ; on retire la fin de la ligne du `---` fermant (whitespace jusqu'au 1er \n inclus)
  const body = src.slice((m.index ?? 0) + m[0].length).replace(/^\s*\n/, '')
  return { ...parseFmFields(m[1]), body }
}
/** Compose un SKILL.md : frontmatter (name + description mono-ligne) puis corps normalisé. */
function buildSkillMd(name: string, description: string, body: string): string {
  const desc = description.replace(/\r?\n/g, ' ').trim()
  const normBody = body.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/^\n+/, '')
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${normBody}${normBody.endsWith('\n') ? '' : '\n'}`
}

// ---- résolution de chemins --------------------------------------------------------------------------------

/** Nom de skill sûr comme nom de DOSSIER (kebab-case Claude Code) : pas de séparateur, ni de point initial → pas
 *  de traversée (`../`, chemin absolu). Appliqué à la création + en garde sur les refs (defense-in-depth). */
function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`Nom de skill invalide : « ${name} ».`)
}

/** Dossier racine des skills pour un scope. 'project' EXIGE projectPath (résout <projet>/.claude/skills). */
function baseDir(scope: SkillScope, projectPath?: string | null): string {
  if (scope === 'project') {
    if (!projectPath) throw new Error('projectPath requis pour un skill de scope « project ».')
    return join(projectPath, '.claude', 'skills')
  }
  return join(homedir(), '.claude', 'skills')
}

/** Résout le DOSSIER d'un skill depuis une ref name+scope. Voie rapide : <base>/<name> (cas usuel folder==name) ;
 *  repli : le frontmatter `name:` d'un sous-dossier matche ref.name (skill dont le dossier diffère du nom déclaré). */
function resolveSkillDir(ref: SkillRef): string {
  assertSafeName(ref.name)
  const base = baseDir(ref.scope, ref.projectPath)
  const direct = join(base, ref.name)
  if (existsSync(join(direct, 'SKILL.md'))) return direct
  if (existsSync(base)) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        if (parseFrontmatter(readFileSync(join(base, entry.name, 'SKILL.md'), 'utf8')).name === ref.name)
          return join(base, entry.name)
      } catch {
        /* pas un skill lisible → suivant */
      }
    }
  }
  throw new Error(`Skill introuvable : « ${ref.name} » (${ref.scope}).`)
}

// ---- listing ----------------------------------------------------------------------------------------------

/** Scanne UN dossier (<base>/<skill>/SKILL.md). N'émet une entrée QUE pour les sous-dossiers avec un SKILL.md
 *  LISIBLE (sinon on remonterait des dossiers non-skill). Accepte les junctions/symlinks (reparse-points). */
function scanSkillsDir(dir: string, scope: SkillScope): SkillInfo[] {
  if (!existsSync(dir)) return []
  const out: SkillInfo[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    let fm: { name?: string; description?: string }
    try {
      fm = parseFrontmatter(readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8'))
    } catch {
      continue // SKILL.md absent/illisible → pas un skill
    }
    out.push({
      name: fm.name ?? entry.name,
      description: fm.description ?? '',
      source: 'user',
      scope,
      path: join(dir, entry.name),
    })
  }
  return out
}

/** Globaux (~/.claude/skills) d'abord, puis ceux du projet ouvert. Dédup si le projet EST le home (même dossier). */
export function listSkills(projectPath?: string | null): SkillInfo[] {
  const userDir = join(homedir(), '.claude', 'skills')
  const out = scanSkillsDir(userDir, 'user')
  if (projectPath) {
    const projDir = join(projectPath, '.claude', 'skills')
    if (projDir !== userDir) out.push(...scanSkillsDir(projDir, 'project'))
  }
  return out
}

/** Contenu éditable (frontmatter + corps) d'un skill. */
export function readSkill(ref: SkillRef): SkillDetail {
  const md = join(resolveSkillDir(ref), 'SKILL.md')
  const { name, description, body } = splitFrontmatter(readFileSync(md, 'utf8'))
  return { name: name ?? ref.name, description: description ?? '', body, scope: ref.scope, path: md }
}

// ---- création / édition / suppression ---------------------------------------------------------------------

/** Crée un skill depuis zéro → écrit <base>/<name>/SKILL.md. Refuse si le dossier existe déjà. */
export function createSkill(input: SkillCreateInput): SkillInfo {
  assertSafeName(input.name)
  const dir = join(baseDir(input.scope, input.projectPath), input.name)
  if (existsSync(dir)) throw new Error(`Un skill nommé « ${input.name} » existe déjà (${input.scope}).`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), buildSkillMd(input.name, input.description, input.body), 'utf8')
  return { name: input.name, description: input.description, source: 'user', scope: input.scope, path: dir }
}

/** Met à jour description + corps d'un skill existant. Le nom (frontmatter + dossier) ne change pas. */
export function updateSkill(input: SkillUpdateInput): SkillInfo {
  const dir = resolveSkillDir(input.ref)
  const md = join(dir, 'SKILL.md')
  const name = splitFrontmatter(readFileSync(md, 'utf8')).name ?? basename(dir)
  writeFileSync(md, buildSkillMd(name, input.description, input.body), 'utf8')
  return { name, description: input.description, source: 'user', scope: input.ref.scope, path: dir }
}

/** Suppression récursive qui ne FRANCHIT JAMAIS un reparse-point : un lien (junction/symlink) est retiré comme
 *  nœud (rmdir, ou unlink en repli pour un symlink-fichier) sans toucher sa cible. Garantie cross-plateforme,
 *  plus stricte que `rmSync` recursive (qui peut suivre/ vider une cible externe sur certaines plateformes). */
function safeRemoveRecursive(target: string): void {
  let st: Stats | undefined
  try {
    st = lstatSync(target) // lstat ne suit PAS le lien
  } catch {
    return // déjà absent
  }
  if (st.isSymbolicLink()) {
    try {
      rmdirSync(target)
    } catch {
      try {
        unlinkSync(target)
      } catch {
        /* best-effort */
      }
    }
    return
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(target)) safeRemoveRecursive(join(target, name))
    rmdirSync(target)
  } else {
    unlinkSync(target)
  }
}

/** Supprime un skill (dossier complet). SÛR vis-à-vis des junctions/symlinks. */
export function deleteSkill(ref: SkillRef): void {
  safeRemoveRecursive(resolveSkillDir(ref))
}

// ---- import (dossier local / git) -------------------------------------------------------------------------

/** Repère les dossiers de skills dans un arbre importé. Gère : (a) racine = un skill (SKILL.md à la racine),
 *  (b) layout « plugin » (skills/<name>/SKILL.md), (c) un dossier contenant plusieurs skills (sous-dossiers). */
function collectSkillDirs(root: string): string[] {
  if (existsSync(join(root, 'SKILL.md'))) return [root]
  const dirs: string[] = []
  const pluginSkills = join(root, 'skills')
  const scanRoots = existsSync(pluginSkills) ? [pluginSkills, root] : [root]
  for (const base of scanRoots) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (existsSync(join(base, entry.name, 'SKILL.md'))) dirs.push(join(base, entry.name))
    }
  }
  return [...new Set(dirs)]
}

/** Nom de dossier d'installation : le `name:` du frontmatter s'il est un slug sûr, sinon le nom de dossier source
 *  (corrige le cas « racine = skill » où basename serait un dossier temporaire de clone). */
function installFolderName(src: string): string {
  try {
    const fm = parseFrontmatter(readFileSync(join(src, 'SKILL.md'), 'utf8'))
    if (fm.name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fm.name)) return fm.name
  } catch {
    /* pas de frontmatter exploitable */
  }
  return basename(src)
}

/** Copie chaque dossier de skill sous <base> (récursif, sans .git, sans suivre les liens). Ignore ceux déjà
 *  présents (→ skipped). */
function installSkillDirs(skillDirs: string[], base: string): SkillImportResult {
  mkdirSync(base, { recursive: true })
  const installed: string[] = []
  const skipped: string[] = []
  for (const src of skillDirs) {
    const name = installFolderName(src)
    if (!name || name === '.' || name === '..') {
      skipped.push(basename(src))
      continue
    }
    const dest = join(base, name)
    if (existsSync(dest)) {
      skipped.push(name)
      continue
    }
    cpSync(src, dest, { recursive: true, dereference: false, filter: (s) => basename(s) !== '.git' })
    installed.push(name)
  }
  return { installed, skipped }
}

/** Importe depuis un dossier local contenant un (ou plusieurs) SKILL.md (copie récursive). */
export function importFolder(input: SkillImportFolderInput): SkillImportResult {
  if (!input.sourcePath || !existsSync(input.sourcePath))
    throw new Error(`Dossier introuvable : ${input.sourcePath}`)
  const skillDirs = collectSkillDirs(input.sourcePath)
  if (skillDirs.length === 0)
    throw new Error('Aucun SKILL.md trouvé dans ce dossier (ni à la racine, ni dans des sous-dossiers).')
  return installSkillDirs(skillDirs, baseDir(input.scope, input.projectPath))
}

/** Clone une URL git (peu profond, sans prompt d'auth) dans un dossier temporaire, installe les skills trouvés,
 *  puis nettoie le clone. Gère le layout plugin (`skills/<name>/`). */
export async function importGit(input: SkillImportGitInput): Promise<SkillImportResult> {
  const url = input.url?.trim()
  if (!url) throw new Error('URL git requise.')
  const tmp = mkdtempSync(join(tmpdir(), 'oryon-skill-'))
  try {
    await execFileAsync('git', ['clone', '--depth', '1', url, tmp], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      // GIT_TERMINAL_PROMPT=0 : échoue vite sur un repo privé au lieu de bloquer le main sur un prompt d'auth.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const skillDirs = collectSkillDirs(tmp)
    if (skillDirs.length === 0)
      throw new Error('Le dépôt ne contient aucun SKILL.md (racine, skills/<name>/, ou sous-dossiers).')
    return installSkillDirs(skillDirs, baseDir(input.scope, input.projectPath))
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true }) // clone jetable (pas de reparse-point ici)
    } catch {
      /* nettoyage best-effort */
    }
  }
}
