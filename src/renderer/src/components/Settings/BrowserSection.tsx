import { useCallback, useEffect, useState } from 'react'
import { Globe, Eye, EyeOff, ExternalLink, KeyRound, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/cn'

// Section « Browser » des réglages : enregistre le token d'accès Vercel (REST) qui alimente le
// dropdown des projets dans le panneau Browser (URL de prod cliquable). Le token est stocké CHIFFRÉ
// côté main et n'est JAMAIS renvoyé au renderer — on n'expose donc qu'un statut (présent / absent),
// jamais la valeur. Tout passe par window.bridge.browser.* (contrat gelé). Vercel REST → aucun appel
// Claude (coût $0). La consommation des projets appartient au panneau (lot UI) ; ici on ne gère QUE
// le token et son statut.

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const TOKENS_URL = 'https://vercel.com/account/tokens'

export function BrowserSection() {
  const [status, setStatus] = useState<{ hasToken: boolean } | null>(null) // null = chargement initial
  const [statusError, setStatusError] = useState('') // échec de lecture du statut (backend absent / erreur)

  // Saisie du token. Le formulaire est imposé tant qu'aucun token n'est enregistré ; une fois enregistré,
  // replié et ré-ouvrable via « Remplacer le token ».
  const [editing, setEditing] = useState(false)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('') // erreur de l'enregistrement du token

  const refresh = useCallback(async () => {
    setStatusError('')
    try {
      setStatus(await window.bridge.browser.vercelStatus())
    } catch (e) {
      setStatusError(msg(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = async () => {
    if (!token.trim()) return
    setSaving(true)
    setError('')
    try {
      const r = await window.bridge.browser.setVercelToken(token.trim())
      if (!r.ok) {
        setError('Token refusé.')
        return
      }
      setToken('')
      setShowToken(false)
      setEditing(false)
      await refresh()
    } catch (e) {
      setError(msg(e))
    } finally {
      setSaving(false)
    }
  }

  // Formulaire de token : imposé sans token, sinon affiché à la demande.
  const showForm = !!status && (!status.hasToken || editing)

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          <Globe size={12} /> Vercel
        </h3>
      </div>

      {!status ? (
        statusError ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-3 text-center">
            <p className="text-[11px] text-danger">{statusError}</p>
            <button
              onClick={() => void refresh()}
              className="mt-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent"
            >
              <RefreshCw size={11} /> Réessayer
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-fg-subtle">Chargement…</p>
        )
      ) : (
        <div className="space-y-3">
          <p className="text-[11px] text-fg-subtle">
            Connecte ton compte Vercel pour lister tes projets dans le panneau Browser et ouvrir leur URL de
            production en un clic. Le token est stocké chiffré localement et n'est jamais réaffiché.
          </p>

          {/* État du token */}
          <div className="rounded-lg border border-border bg-bg-inset px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  status.hasToken ? 'bg-green-500' : 'bg-fg-subtle/40',
                )}
              />
              <span className="truncate text-[12px] text-fg">
                {status.hasToken ? 'Token enregistré' : 'Aucun token'}
              </span>
              {status.hasToken && !editing && (
                <button
                  onClick={() => setEditing(true)}
                  className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent"
                >
                  <KeyRound size={11} /> Remplacer le token
                </button>
              )}
            </div>
          </div>

          {/* Saisie du token : imposée sans token, sinon repliable. */}
          {showForm && (
            <div className="space-y-2 rounded-lg border border-border bg-bg-inset p-2.5">
              <p className="text-[11px] text-fg-subtle">
                Crée un token d'accès dans les{' '}
                <a
                  href={TOKENS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-accent transition-colors hover:underline"
                >
                  réglages de ton compte Vercel <ExternalLink size={10} />
                </a>
                , puis colle-le ci-dessous.
              </p>
              <div className="flex gap-1">
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Token d'accès Vercel"
                  type={showToken ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void save()
                  }}
                  className="flex-1 rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
                />
                <button
                  onClick={() => setShowToken((s) => !s)}
                  title={showToken ? 'Masquer' : 'Afficher'}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:text-fg"
                >
                  {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
              {error && <p className="break-words text-[11px] text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                {status.hasToken && (
                  <button
                    onClick={() => {
                      setEditing(false)
                      setToken('')
                      setShowToken(false)
                      setError('')
                    }}
                    className="rounded px-2 py-1 text-[11px] text-fg-subtle hover:text-fg"
                  >
                    Annuler
                  </button>
                )}
                <button
                  onClick={() => void save()}
                  disabled={saving || !token.trim()}
                  className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover disabled:opacity-40"
                >
                  {saving ? 'Enregistrement…' : 'Enregistrer le token'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
