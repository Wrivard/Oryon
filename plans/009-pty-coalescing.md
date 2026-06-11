# Plan 009 : Coalescing du flux PTY → renderer (un send par rafale, pas par chunk)

> **Instructions exécuteur** : suis ce plan étape par étape ; chaque vérification doit
> donner le résultat attendu. Condition STOP → arrête et rapporte. Le reviewer tient
> `plans/README.md`.
>
> **Drift check** : `git diff --stat 29c8ae5..HEAD -- src/main/ipc/terminals.ipc.ts`
> Si la zone onData/onExit ne matche plus l'extrait, STOP.

## Statut

- **Priorité** : P2 — **Effort** : S–M — **Risque** : MED (chemin chaud de TOUS les terminaux)
- **Dépend de** : aucun
- **Catégorie** : perf — **Écrit à** : commit `29c8ae5`, 2026-06-11

## Pourquoi c'est important

Chaque chunk PTY déclenche un `webContents.send` individuel. Un agent claude qui
streame émet des dizaines d'événements/seconde ; multiplié par jusqu'à 9 terminaux par
workspace × tous les workspaces montés en permanence, c'est des centaines d'IPC/s qui
traversent main→renderer pour finir dans xterm.write. Coalescer ~8 ms réduit l'IPC
d'un ordre de grandeur sans latence perceptible (une frame ≈ 16 ms).

## État actuel

- `src/main/ipc/terminals.ipc.ts` l.46-59 (handler `terminals:create`) :
  ```ts
  createTerminal({
    id: opts.id,
    cwd: opts.cwd,
    autostart,
    cols: opts.cols,
    rows: opts.rows,
    env: opts.env,
    onData: (data) => {
      if (!wc.isDestroyed()) wc.send(`terminal:data:${opts.id}`, data)
    },
    onExit: (code) => {
      if (!wc.isDestroyed()) wc.send(`terminal:exit:${opts.id}`, code)
    },
  })
  ```
- IMPORTANT : il existe un DEUXIÈME site de spawn avec les mêmes callbacks dans
  `src/main/services/orchestrator/router.ts` (`agentRestartAgent`, ~l.857-866, via
  `sendToAllWindows`). Pour ne pas dupliquer la logique, le coalescing s'implémente en
  HELPER PARTAGÉ dans terminals.ipc.ts, exporté et utilisé par les deux sites.
- Les observers internes de pty-manager (mcp-export logs, orchestrator lastData) lisent
  le flux EN AMONT — ils ne passent PAS par ces callbacks : NE PAS y toucher.
- Le renderer (`Terminal.tsx:168`) fait `xterm.write(data)` par message — il bénéficie
  du coalescing sans modification.

## Commandes nécessaires

| Usage | Commande | Attendu |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |

## Périmètre

**In scope** : `src/main/ipc/terminals.ipc.ts` (helper + site 1),
`src/main/services/orchestrator/router.ts` (UNIQUEMENT les callbacks onData/onExit de
agentRestartAgent → utiliser le helper).

**Out of scope** : `pty-manager.ts` (les observers internes doivent garder le flux
BRUT non coalescé), `Terminal.tsx`, le canal `terminals:write` (entrée clavier).

## Workflow git

Branche `oryon/agent-<ton-nom>` ; commit `perf(terminals): coalescing du flux PTY→renderer (~8 ms)`. Ne push pas.

## Étapes

### Étape 1 : helper de coalescing (terminals.ipc.ts)

```ts
// Coalescing du flux PTY→renderer : un send par rafale (~8 ms) au lieu d'un par chunk.
// Un agent claude qui streame = des dizaines de chunks/s × N terminaux montés — l'IPC
// par chunk coûtait cher pour rien (xterm.write accepte les blocs). 8 ms < 1 frame
// (16 ms) → aucune latence perceptible. flushNow garantit l'ORDRE data→exit.
const FLUSH_MS = 8
const FLUSH_MAX_BYTES = 64 * 1024
export function makeCoalescedSender(send: (data: string) => void): {
  push: (data: string) => void
  flushNow: () => void
} {
  let buf = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  const flushNow = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!buf) return
    const out = buf
    buf = ''
    send(out)
  }
  return {
    push: (data: string): void => {
      buf += data
      if (buf.length >= FLUSH_MAX_BYTES) { flushNow(); return }
      if (!timer) timer = setTimeout(flushNow, FLUSH_MS)
    },
    flushNow,
  }
}
```

**Vérifier** : `npm run typecheck` exit 0 (le helper compile, pas encore branché).

### Étape 2 : brancher le site terminals:create

```ts
const sender = makeCoalescedSender((data) => {
  if (!wc.isDestroyed()) wc.send(`terminal:data:${opts.id}`, data)
})
createTerminal({
  …,
  onData: (data) => sender.push(data),
  onExit: (code) => {
    sender.flushNow() // l'exit ne doit JAMAIS doubler un dernier bout de sortie encore bufferisé
    if (!wc.isDestroyed()) wc.send(`terminal:exit:${opts.id}`, code)
  },
})
```

**Vérifier** : `npm run typecheck` exit 0.

### Étape 3 : brancher agentRestartAgent (router.ts)

Même motif avec `sendToAllWindows` : importe `makeCoalescedSender` depuis
`'../../ipc/terminals.ipc'` (VÉRIFIE le chemin relatif réel), sender →
`sendToAllWindows(`terminal:data:${id}`, data)`, push dans onData, flushNow avant le
send d'exit. ⚠ Ce fichier est touché par d'autres plans : limite ton diff aux ~10
lignes de ces deux callbacks.

**Vérifier** : `npm run typecheck` exit 0 ; `git diff --stat` : 2 fichiers seulement.

## Plan de test

Pas de harnais PTY. Validation = typecheck + revue (l'ordre data→exit via flushNow est
LE point à relire). Test runtime (reviewer, post-merge + rebuild) : ouvrir un terminal,
lancer une commande verbeuse, vérifier l'affichage fluide et la fin de session propre.

## Critères de done

- [ ] Helper unique exporté ; les DEUX sites de spawn l'utilisent
- [ ] `flushNow()` appelé avant chaque send d'exit (ordre garanti)
- [ ] Aucune modification de pty-manager.ts ni du flux observers
- [ ] `npm run typecheck` exit 0
- [ ] `git status` : seuls les 2 fichiers in-scope

## Conditions STOP

- L'extrait terminals.ipc.ts ne matche pas.
- Le site router/agentRestartAgent a changé de forme (autres plans mergés) au point que
  le branchement dépasse ~10 lignes — rapporte au lieu d'élargir.

## Notes de maintenance

- Si un futur consommateur a besoin du flux NON coalescé côté renderer, il doit passer
  par un nouvel observer pty-manager, pas par ce canal.
- Reviewer : vérifier qu'aucun timer ne survit à l'exit (flushNow cleare le timer).
