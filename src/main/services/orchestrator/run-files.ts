import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'

// Dossier partagé d'un run d'orchestration, DANS le projet cible :
//   <projet>/.oryon/run/
//     GOAL.md                  ← objectif global
//     tasks/NN-slug.md         ← instructions d'une sub-task (écrit par l'orchestrateur)
//     tasks/NN.result.md       ← résultat (écrit par l'agent builder/scout à la fin)
//     tasks/NN.review.md       ← verdict du reviewer
// Le contexte se partage par fichiers (un agent lit les result.md de ses dépendances), et
// l'orchestrateur détecte l'avancement en surveillant l'apparition des *.result.md / *.review.md
// (chokidar) — fini le parsing fragile de la sortie terminal.

const RUN_SUBDIR = join('.oryon', 'run')

export function runDir(projectPath: string): string {
  return join(projectPath, RUN_SUBDIR)
}
export function tasksDir(projectPath: string): string {
  return join(runDir(projectPath), 'tasks')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  )
}

export function taskFileName(n: number, title: string): string {
  return `${pad(n)}-${slugify(title)}.md`
}
export function resultFileName(n: number): string {
  return `${pad(n)}.result.md`
}
export function reviewFileName(n: number): string {
  return `${pad(n)}.review.md`
}

// Chemins ABSOLUS dans le tronc PRINCIPAL. Avec un worktree par agent (cwd = worktree), un chemin
// relatif pointerait vers <worktree>/.oryon/run (inexistant, jamais surveillé) → dispatch silencieusement
// cassé. Ces helpers garantissent que task/result/review vivent dans <principal>/.oryon/run/tasks.
export function taskFilePath(main: string, name: string): string {
  return join(tasksDir(main), name)
}
export function resultFilePath(main: string, n: number): string {
  return join(tasksDir(main), resultFileName(n))
}
export function reviewFilePath(main: string, n: number): string {
  return join(tasksDir(main), reviewFileName(n))
}

/** Reconnaît un nom de fichier de sortie d'agent : "NN.result.md" ou "NN.review.md". */
export function parseOutputFileName(name: string): { n: number; kind: 'result' | 'review' } | null {
  const m = /^(\d+)\.(result|review)\.md$/i.exec(name)
  if (!m) return null
  return { n: parseInt(m[1], 10), kind: m[2].toLowerCase() as 'result' | 'review' }
}

function ensureGitignore(projectPath: string): void {
  const gi = join(projectPath, '.gitignore')
  const line = '.oryon/'
  try {
    const content = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
    if (content.split(/\r?\n/).some((l) => l.trim() === line)) return
    const sep = content && !content.endsWith('\n') ? '\n' : ''
    appendFileSync(gi, `${sep}${line}\n`)
  } catch {
    /* best-effort : ne jamais bloquer un run sur le .gitignore */
  }
}

/** (Ré)initialise le dossier de run : vide l'ancien (result.md périmés → pas de faux trigger), écrit GOAL.md. */
export function initRun(projectPath: string, goal: string): void {
  ensureGitignore(projectPath)
  try {
    rmSync(runDir(projectPath), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  mkdirSync(tasksDir(projectPath), { recursive: true })
  writeFileSync(join(runDir(projectPath), 'GOAL.md'), `# Objectif global\n\n${goal}\n`)
}

export interface TaskFileInput {
  n: number
  title: string
  role: 'builder' | 'scout'
  instructions: string
  depNumbers: number[]
}

/** Écrit le fichier d'instructions d'une sub-task. Retourne son nom de fichier. */
export function writeTaskFile(projectPath: string, t: TaskFileInput): string {
  const name = taskFileName(t.n, t.title)
  // Chemins ABSOLUS dans le tronc principal : un agent dépendant (cwd = worktree) lit les prérequis
  // dans <principal>/.oryon/run, pas dans un <worktree>/.oryon inexistant.
  const deps = t.depNumbers.length
    ? t.depNumbers.map((d) => `- \`${resultFilePath(projectPath, d)}\``).join('\n')
    : '_(aucune)_'
  const body = [
    `# Task #${t.n} — ${t.title}`,
    ``,
    `**Rôle :** ${t.role}`,
    ``,
    `## Instructions`,
    ``,
    t.instructions,
    ``,
    `## Contexte des dépendances`,
    ``,
    `Lis le résultat de ces tasks (chemins absolus) avant de commencer :`,
    deps,
    ``,
  ].join('\n')
  writeFileSync(join(tasksDir(projectPath), name), body)
  return name
}

export interface ParsedOutput {
  status: string // done | blocked | approved | changes | ...
  summary: string
}

/** Parse un fichier result/review : statut via `STATUS: xxx`, résumé via `SUMMARY:` (ou repli). Tolérant au markdown. */
export function parseOutputFile(path: string): ParsedOutput | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const clean = text.replace(/[*_`>#]/g, ' ')
  const sm = /STATUS\s*:?\s*([a-zA-Z]+)/i.exec(clean)
  if (!sm) return null
  const status = sm[1].toLowerCase()
  const summaryMatch = /SUMMARY\s*:?\s*([^\n]*)/i.exec(clean)
  // Une ligne SUMMARY présente (même vide) fait foi ; repli sur le corps SEULEMENT si elle est absente.
  const summary = summaryMatch
    ? summaryMatch[1].trim()
    : clean
        .replace(/STATUS\s*:?\s*[a-zA-Z]+/i, '')
        .replace(/\s+/g, ' ')
        .trim()
  return { status, summary: summary.slice(0, 300) }
}
