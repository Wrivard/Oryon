// INC3 — contexte du projet (variable/file recognition). Extrait des termes de boost DYNAMIQUES
// (identifiants de code des fichiers ouverts + noms de fichiers du projet) pour aider la transcription
// à matcher le code. source='project' : éphémère, JAMAIS persisté dans le dictionnaire perso.

const KEYWORDS = new Set([
  'const', 'function', 'return', 'import', 'export', 'default', 'class', 'interface', 'type', 'await',
  'async', 'public', 'private', 'protected', 'static', 'void', 'string', 'number', 'boolean', 'null',
  'undefined', 'this', 'true', 'false', 'from', 'else', 'catch', 'throw', 'while', 'break', 'continue',
  'switch', 'case', 'typeof', 'extends', 'implements', 'readonly', 'namespace', 'module', 'require',
  'console', 'window', 'document', 'value', 'props', 'state', 'children', 'event', 'index', 'length',
])

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/**
 * Extrait les identifiants « qui ressemblent à du code » d'un contenu de fichier : camelCase, PascalCase,
 * snake_case ou avec chiffre. Filtre les mots-clés et la prose ordinaire. Conservateur (haute précision).
 */
export function extractIdentifiers(content: string, max = 400): string[] {
  const out = new Set<string>()
  const re = /[A-Za-z_$][A-Za-z0-9_$]{3,}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    const w = m[0]
    if (w.length > 40 || KEYWORDS.has(w.toLowerCase())) continue
    const looksId =
      /[a-z][A-Z]/.test(w) || w.includes('_') || /[A-Za-z][0-9]/.test(w) || /^[A-Z][a-z]+[A-Z]?/.test(w)
    if (!looksId) continue
    out.add(w)
    if (out.size >= max) break
  }
  return [...out]
}

/** Noms de fichiers (basenames) uniques d'une liste de chemins. */
export function projectFilesFrom(paths: string[]): string[] {
  const set = new Set<string>()
  for (const p of paths) {
    const b = baseName(p)
    if (b) set.add(b)
  }
  return [...set]
}

/**
 * Construit le contexte projet : termes de boost (stems de fichiers + identifiants des fichiers ouverts)
 * et la liste de noms de fichiers (pour le file-tagging). Dédupliqué et plafonné.
 */
export function buildProjectContext(
  allFiles: string[],
  openContents: string[],
): { terms: string[]; files: string[] } {
  const files = projectFilesFrom(allFiles)
  const terms = new Set<string>()
  for (const f of files) {
    const stem = f.replace(/\.[^.]+$/, '')
    if (stem.length >= 3 && !KEYWORDS.has(stem.toLowerCase())) terms.add(stem)
  }
  for (const c of openContents) for (const id of extractIdentifiers(c)) terms.add(id)
  return { terms: [...terms].slice(0, 600), files }
}

/**
 * File-tagging (cible chat/prompt seulement) : « tag <fichier> » / « arobase <fichier> » → « @<fichier> ».
 * Le <fichier> parlé est normalisé (espaces retirés, « point » → « . ») puis matché au mieux contre la
 * liste de fichiers du projet ; sans correspondance, on laisse le texte tel quel.
 */
export function applyFileTags(text: string, files: string[]): string {
  if (!files.length) return text
  const byKey = new Map<string, string>()
  for (const f of files) {
    const low = f.toLowerCase()
    byKey.set(low, f)
    byKey.set(low.replace(/\s+/g, ''), f)
    const stem = low.replace(/\.[^.]+$/, '')
    if (!byKey.has(stem)) byKey.set(stem, f)
  }
  const norm = (s: string): string => s.toLowerCase().replace(/\bpoint\b/g, '.').replace(/\s+/g, '')
  const alnum = (s: string): string => s.replace(/[^a-z0-9]/g, '')
  const lookup = (key: string): string | undefined => {
    // Match sur le basename complet OU le stem (les deux sont indexés) ; jamais de strip d'extension sur la
    // clé (ce qui ferait « main.pyet » → « main » à tort). Repli alnum pour tolérer la ponctuation.
    const direct = byKey.get(key)
    if (direct) return direct
    const ka = alnum(key)
    if (ka.length < 3) return undefined
    for (const [k, v] of byKey) if (alnum(k) === ka) return v
    return undefined
  }
  // Capture jusqu'à 4 tokens après le déclencheur, puis essaie le PLUS LONG préfixe qui matche un fichier
  // (évite d'avaler les mots qui suivent le nom de fichier, ex. « tag orchestrator bar maintenant »).
  const TRIG = /\b(?:tag|tague|tagger|tagge|arobase|arrobase)\s+((?:[\p{L}\p{N}]+[ .]*){1,4})/giu
  return text.replace(TRIG, (whole: string, phrase: string) => {
    const toks = phrase.trim().split(/\s+/)
    const trailing = /\s$/.test(whole) ? ' ' : '' // l'espace avant le mot suivant a été consommé par la capture
    for (let len = Math.min(toks.length, 4); len >= 1; len--) {
      const file = lookup(norm(toks.slice(0, len).join(' ')))
      if (file) {
        const rest = toks.slice(len).join(' ')
        return `@${file}${rest ? ' ' + rest : ''}${trailing}`
      }
    }
    return whole
  })
}
