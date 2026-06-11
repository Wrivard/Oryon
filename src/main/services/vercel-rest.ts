import { encryptString, decryptString, getSetting, setSetting, delSetting } from './secure-store'
import type { VercelProject } from '../../shared/types'

// Intégration Vercel REST (passe d'optim Browser, lot B). Pas de SDK : appels `fetch` natifs vers l'API REST
// Vercel pour lister les projets + leur URL de prod (dropdown du panneau Browser). Le token d'accès est chiffré
// au repos via secure-store (Electron safeStorage)
// et persisté dans la table clé/valeur app_settings ; il n'est JAMAIS renvoyé au renderer (seul un booléen
// hasToken l'est). L'utilisateur fournit lui-même son token Vercel (Settings → Browser).

const K_TOKEN = 'browser.vercelToken' // chiffré au repos
const PROJECTS_ENDPOINT = 'https://api.vercel.com/v10/projects?limit=100'

// ---- app_settings (clé/valeur) + secret chiffré : impl partagée dans secure-store (plan 010). ----
// Alias locaux = diff minimal (le reste du fichier garde get/set/del/enc/dec).
const get = getSetting
const set = setSetting
const del = delSetting
const enc = encryptString
const dec = decryptString

/** Enregistre (ou efface si vide) le token Vercel, chiffré au repos. Ne renvoie jamais le token. */
export function setVercelToken(token: string): { ok: boolean } {
  const t = (token ?? '').trim()
  if (!t) {
    del(K_TOKEN)
    return { ok: true }
  }
  set(K_TOKEN, enc(t))
  return { ok: true }
}

/** Un token Vercel est-il configuré ? (ne renvoie jamais le token lui-même). */
export function hasVercelToken(): boolean {
  return !!dec(get(K_TOKEN))
}

// Forme minimale d'un projet renvoyé par `GET /v10/projects`. La doc REST n'expose pas le sous-schéma de
// `targets.production` ni de `alias` → on garde des champs optionnels et une extraction défensive.
interface VProject {
  id?: string
  name?: string
  framework?: string | null
  alias?: Array<string | { domain?: string }>
  targets?: { production?: { url?: string; alias?: string[]; inspectorUrl?: string } | null }
  latestDeployments?: Array<{ url?: string }>
}

// Premier alias de prod custom : soit targets.production.alias[], soit le top-level alias[] (strings ou {domain}).
function firstAlias(p: VProject): string | undefined {
  const prodAlias = p.targets?.production?.alias?.[0]
  if (typeof prodAlias === 'string' && prodAlias) return prodAlias
  const top = p.alias?.[0]
  if (typeof top === 'string') return top || undefined
  if (top && typeof top === 'object' && typeof top.domain === 'string') return top.domain || undefined
  return undefined
}

// URL de prod cliquable : alias custom > url du dernier déploiement prod > <name>.vercel.app (fallback canonique).
function prodUrl(p: VProject): string {
  const host = firstAlias(p) || p.targets?.production?.url || p.latestDeployments?.[0]?.url
  if (host) return host.startsWith('http') ? host : `https://${host}`
  return `https://${p.name ?? 'unknown'}.vercel.app`
}

/** Liste les projets Vercel (REST) avec leur URL de prod — pour le dropdown du panneau Browser. */
export async function listVercelProjects(): Promise<VercelProject[]> {
  const token = dec(get(K_TOKEN))
  if (!token) throw new Error('Aucun token Vercel configuré (Settings → Browser).')
  // Timeout dur (15 s) : un appel suspendu (réseau/proxy) ne doit pas figer le dropdown indéfiniment.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  const res = await fetch(PROJECTS_ENDPOINT, {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer))
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Token Vercel invalide ou sans permission.')
    throw new Error(`Vercel API ${res.status}`)
  }
  const json = (await res.json().catch(() => ({}))) as { projects?: VProject[] }
  const projects = Array.isArray(json.projects) ? json.projects : []
  return projects.map((p) => ({
    id: String(p.id ?? ''),
    name: String(p.name ?? ''),
    url: prodUrl(p),
    inspectorUrl: typeof p.targets?.production?.inspectorUrl === 'string' ? p.targets.production.inspectorUrl : undefined,
    framework: typeof p.framework === 'string' ? p.framework : undefined,
  }))
}
