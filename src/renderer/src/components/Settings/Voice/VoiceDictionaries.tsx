import { useEffect, useRef, useState } from 'react'
import { Star, ArrowLeftRight, Code2, Plus, Trash2, Upload, Sparkles } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { toast } from '../../../store/toasts'
import type { VoiceReplacement, VoiceVocab, VoiceSnippet } from '@shared/types'
import { SectionHeader, EmptyState } from './_parts'

const SRC_BADGE: Record<string, string> = {
  manual: 'bg-bg-elevated text-fg-subtle',
  auto: 'bg-accent-soft text-accent',
  project: 'bg-bg-elevated text-fg-muted',
  csv: 'bg-bg-elevated text-fg-subtle',
}
const INPUT_CLS =
  'rounded-md border border-border bg-bg-panel px-2 py-1 text-[12px] text-fg outline-none focus:border-accent'
const ADD_BTN =
  'shrink-0 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-hover disabled:opacity-40'
const HEADER_ACTION = 'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:text-accent'

export function VoiceDictionaries() {
  const [q, setQ] = useState('')
  const [vocab, setVocab] = useState<VoiceVocab[]>([])
  const [reps, setReps] = useState<VoiceReplacement[]>([])
  const [snippets, setSnippets] = useState<VoiceSnippet[]>([])
  const [addingV, setAddingV] = useState(false)
  const [addingR, setAddingR] = useState(false)
  const [addingS, setAddingS] = useState(false)
  const [vTerm, setVTerm] = useState('')
  const [dSpoken, setDSpoken] = useState('')
  const [dRepl, setDRepl] = useState('')
  const [snTrigger, setSnTrigger] = useState('')
  const [snExpansion, setSnExpansion] = useState('')
  const [csvMessage, setCsvMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)
  const [importing, setImporting] = useState(false)
  const csvRef = useRef<HTMLInputElement>(null)
  const csvTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const loadVocab = () => window.bridge.voice.listVocab().then(setVocab)
  const loadReps = () => window.bridge.voice.listReplacements().then(setReps)
  const loadSnippets = () => window.bridge.voice.listSnippets().then(setSnippets)
  useEffect(() => {
    void loadVocab()
    void loadReps()
    void loadSnippets()
  }, [])
  // Nettoie le timeout du message CSV au démontage.
  useEffect(
    () => () => {
      if (csvTimeoutRef.current) clearTimeout(csvTimeoutRef.current)
    },
    [],
  )

  const match = (...fields: (string | null | undefined)[]) =>
    !q.trim() || fields.some((f) => (f ?? '').toLowerCase().includes(q.toLowerCase()))

  // Vocabulaire trié : starred → auto (appris ✨) → reste.
  const rank = (v: VoiceVocab) => (v.starred ? 0 : v.source === 'auto' ? 1 : 2)
  const vocabView = vocab.filter((v) => match(v.term)).sort((a, b) => rank(a) - rank(b))
  const repsView = reps.filter((r) => match(r.spoken, r.replacement))
  const snippetsView = snippets.filter((sn) => match(sn.trigger, sn.expansion))

  const addVocab = async () => {
    if (!vTerm.trim()) return
    try {
      await window.bridge.voice.addVocab(vTerm.trim())
      setVTerm('')
      void loadVocab()
    } catch {
      toast.error("Échec de l'enregistrement.")
    }
  }
  const addReplacement = async () => {
    if (!dSpoken.trim() || !dRepl.trim()) return
    try {
      await window.bridge.voice.addReplacement(dSpoken.trim(), dRepl.trim())
      setDSpoken('')
      setDRepl('')
      void loadReps()
    } catch {
      toast.error("Échec de l'enregistrement.")
    }
  }
  const addSnippet = async () => {
    if (!snTrigger.trim() || !snExpansion.trim()) return
    try {
      await window.bridge.voice.addSnippet(snTrigger.trim(), snExpansion.trim())
      setSnTrigger('')
      setSnExpansion('')
      void loadSnippets()
    } catch {
      toast.error("Échec de l'enregistrement.")
    }
  }

  const onCsv = async (file: File) => {
    const MAX_ROWS = 5000
    const HEADER_TOKENS = new Set(['term', 'replacement', 'spoken', 'vocab'])
    setImporting(true)
    try {
      const text = await file.text()
      let vocabCount = 0
      let repCount = 0
      let failed = 0
      let processed = 0
      let capped = false
      let headerChecked = false
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        const cols = line.split(/[;,\t]/).map((c) => c.trim().replace(/^"|"$/g, ''))
        // Saute une éventuelle ligne d'en-tête en tête de fichier.
        if (!headerChecked) {
          headerChecked = true
          if (cols.some((c) => HEADER_TOKENS.has(c.toLowerCase()))) continue
        }
        if (processed >= MAX_ROWS) {
          capped = true
          break
        }
        processed++
        // try/catch PAR ligne : une ligne fautive n'avorte plus tout l'import.
        try {
          if (cols.length >= 2 && cols[0] && cols[1]) {
            await window.bridge.voice.addReplacement(cols[0], cols[1])
            repCount++
          } else if (cols[0]) {
            await window.bridge.voice.addVocab(cols[0])
            vocabCount++
          }
        } catch {
          failed++
        }
      }
      let msg = `${vocabCount} terme${vocabCount !== 1 ? 's' : ''} + ${repCount} règle${repCount !== 1 ? 's' : ''} importé${vocabCount + repCount !== 1 ? 's' : ''}`
      if (failed > 0) msg += ` · ${failed} échec${failed !== 1 ? 's' : ''}`
      if (capped) msg += ` · limite de ${MAX_ROWS} lignes atteinte`
      setCsvMessage({ text: msg, kind: failed > 0 ? 'error' : 'success' })
      void loadVocab()
      void loadReps()
    } catch (e) {
      setCsvMessage({ text: `Erreur lors de l'import: ${e instanceof Error ? e.message : 'erreur inconnue'}`, kind: 'error' })
    } finally {
      setImporting(false)
      if (csvTimeoutRef.current) clearTimeout(csvTimeoutRef.current)
      csvTimeoutRef.current = setTimeout(() => setCsvMessage(null), 4000)
    }
  }

  return (
    <div className="space-y-8">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Rechercher dans les dictionnaires…"
        className="w-full rounded-md border border-border bg-bg-inset px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
      />
      {csvMessage && (
        <div className={cn('rounded-md px-3 py-2 text-[12px]', csvMessage.kind === 'success' ? 'bg-accent-soft text-accent' : 'bg-danger-soft text-danger')}>
          {csvMessage.text}
        </div>
      )}

      {/* A — Vocabulaire (boost) */}
      <section>
        <SectionHeader
          icon={Star}
          title="Vocabulaire"
          count={vocab.length}
          action={
            <div className="flex items-center gap-2">
              <button onClick={() => csvRef.current?.click()} disabled={importing} title="1 colonne = vocabulaire · 2 colonnes = entendu/corrigé" aria-label="Importer CSV" className={cn(HEADER_ACTION, 'disabled:opacity-40')}>
                <Upload size={12} /> {importing ? 'Importation…' : 'CSV'}
              </button>
              <button onClick={() => setAddingV((a) => !a)} aria-label="Ajouter vocabulaire" className={HEADER_ACTION}>
                <Plus size={12} /> Ajouter
              </button>
            </div>
          }
        />
        <input
          ref={csvRef}
          type="file"
          accept=".csv,.txt"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onCsv(f)
            e.target.value = ''
          }}
        />
        {vocabView.length === 0 ? (
          <EmptyState icon={Star} title="Aucun terme de vocabulaire." hint="Ajoute des noms propres pour améliorer la transcription." />
        ) : (
          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {vocabView.map((v) => (
              <div key={v.id} className="flex min-h-9 items-center gap-3 rounded-lg border border-border bg-bg-inset px-3 py-2">
                <button
                  onClick={async () => {
                    try {
                      await window.bridge.voice.toggleVocabStar(v.id, !v.starred)
                      void loadVocab()
                    } catch {
                      toast.error("Échec de l'enregistrement.")
                    }
                  }}
                  title={v.starred ? 'Prioritaire' : 'Mettre en priorité'}
                  aria-label={v.starred ? 'Retirer de priorité' : 'Mettre en priorité'}
                  aria-pressed={v.starred}
                  className={cn('flex h-5 w-5 items-center justify-center rounded', v.starred ? 'text-accent' : 'text-fg-subtle hover:text-fg')}
                >
                  <Star size={12} className={v.starred ? 'fill-current' : ''} />
                </button>
                <span className="text-[12.5px] text-fg">{v.term}</span>
                {v.source === 'auto' && <Sparkles size={12} className="text-accent" />}
                <span className={cn('ml-auto rounded px-1.5 py-px text-[9px] uppercase tracking-wide', SRC_BADGE[v.source] ?? 'bg-bg-elevated text-fg-subtle')}>
                  {v.source}
                </span>
                <button
                  onClick={async () => {
                    try {
                      await window.bridge.voice.deleteVocab(v.id)
                      void loadVocab()
                    } catch {
                      toast.error("Échec de l'enregistrement.")
                    }
                  }}
                  aria-label={`Supprimer "${v.term}"`}
                  className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {addingV && (
          <div className="mt-2 flex gap-2 rounded-lg border border-border bg-bg-inset p-3">
            <input
              value={vTerm}
              onChange={(e) => setVTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addVocab()}
              placeholder="terme / nom propre (ex. Supabase, kua-coiffure)"
              aria-label="Terme de vocabulaire"
              className={cn(INPUT_CLS, 'flex-1')}
            />
            <button onClick={addVocab} disabled={!vTerm.trim()} aria-label="Ajouter le terme" className={ADD_BTN}>
              <Plus size={13} />
            </button>
          </div>
        )}
      </section>

      {/* B — Règles de remplacement */}
      <section>
        <SectionHeader
          icon={ArrowLeftRight}
          title="Règles de remplacement"
          count={reps.length}
          action={
            <button onClick={() => setAddingR((a) => !a)} aria-label="Ajouter règle de remplacement" className={HEADER_ACTION}>
              <Plus size={12} /> Ajouter
            </button>
          }
        />
        {repsView.length === 0 ? (
          <EmptyState icon={ArrowLeftRight} title="Aucune règle de remplacement." hint="Ex. « next js » → « Next.js »." />
        ) : (
          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {repsView.map((r) => (
              <div key={r.id} className="flex min-h-9 items-center gap-3 rounded-lg border border-border bg-bg-inset px-3 py-2 text-[12px]">
                <span className="text-fg-subtle">{r.spoken}</span>
                <span className="text-fg-subtle">→</span>
                <span className="text-fg">{r.replacement}</span>
                {r.source === 'auto' && <Sparkles size={11} className="text-accent" />}
                <button
                  onClick={async () => {
                    try {
                      await window.bridge.voice.deleteReplacement(r.id)
                      void loadReps()
                    } catch {
                      toast.error("Échec de l'enregistrement.")
                    }
                  }}
                  aria-label={`Supprimer la règle "${r.spoken}" → "${r.replacement}"`}
                  className="ml-auto flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {addingR && (
          <div className="mt-2 rounded-lg border border-border bg-bg-inset p-3">
            <div className="grid grid-cols-2 gap-2">
              <input value={dSpoken} onChange={(e) => setDSpoken(e.target.value)} placeholder="entendu (ex. next js)" aria-label="Terme entendu" className={INPUT_CLS} />
              <div className="flex gap-2">
                <input
                  value={dRepl}
                  onChange={(e) => setDRepl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addReplacement()}
                  placeholder="remplacé par (ex. Next.js)"
                  aria-label="Remplacement"
                  className={cn(INPUT_CLS, 'flex-1')}
                />
                <button onClick={addReplacement} disabled={!dSpoken.trim() || !dRepl.trim()} aria-label="Ajouter la règle" className={ADD_BTN}>
                  <Plus size={13} />
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* C — Snippets */}
      <section>
        <SectionHeader
          icon={Code2}
          title="Snippets"
          count={snippets.length}
          action={
            <button onClick={() => setAddingS((a) => !a)} aria-label="Ajouter snippet" className={HEADER_ACTION}>
              <Plus size={12} /> Ajouter
            </button>
          }
        />
        {snippetsView.length === 0 ? (
          <EmptyState icon={Code2} title="Aucun snippet." hint="Ex. « mon adresse » → bloc de texte complet." />
        ) : (
          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {snippetsView.map((sn) => (
              <div key={sn.id} className="flex min-h-9 items-center gap-3 rounded-lg border border-border bg-bg-inset px-3 py-2">
                <span className="rounded bg-bg-elevated px-1.5 py-px text-[11px] text-accent">{sn.trigger}</span>
                <span className="text-fg-subtle">→</span>
                <span className="line-clamp-1 text-[12px] text-fg-muted" title={sn.expansion}>
                  {sn.expansion}
                </span>
                <button
                  onClick={async () => {
                    try {
                      await window.bridge.voice.deleteSnippet(sn.id)
                      void loadSnippets()
                    } catch {
                      toast.error("Échec de l'enregistrement.")
                    }
                  }}
                  aria-label={`Supprimer le snippet "${sn.trigger}"`}
                  className="ml-auto flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-hover hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {addingS && (
          <div className="mt-2 space-y-2 rounded-lg border border-border bg-bg-inset p-3">
            <input value={snTrigger} onChange={(e) => setSnTrigger(e.target.value)} placeholder="trigger parlé (ex. mon adresse)" aria-label="Trigger du snippet" className={cn(INPUT_CLS, 'w-full')} />
            <div className="flex gap-2">
              <textarea
                value={snExpansion}
                onChange={(e) => setSnExpansion(e.target.value)}
                rows={2}
                placeholder="expansion (le bloc inséré)"
                aria-label="Expansion du snippet"
                className={cn(INPUT_CLS, 'flex-1 resize-none')}
              />
              <button onClick={addSnippet} disabled={!snTrigger.trim() || !snExpansion.trim()} aria-label="Ajouter le snippet" className={ADD_BTN}>
                <Plus size={13} />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
