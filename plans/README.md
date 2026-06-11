# Plans d'implémentation — audit deep 2026-06-11

Générés par le skill improve (audit 8 agents + vérification manuelle) au commit
`29c8ae5`, enrichis des rapports du store system-feedback (6 rapports d'orchestrateurs,
dont 5 du swarm kua-coiffure en usage réel). Exécution par VAGUES de workers Oryon
(fichiers disjoints par vague) ; l'orchestrateur révise et merge via approve_task et
tient CE fichier à jour — les exécuteurs ne le modifient pas.

## Ordre d'exécution & statut

| Plan | Titre | Vague | Prio | Effort | Dépend de | Statut |
|------|-------|-------|------|--------|-----------|--------|
| 001 | CI sur push/PR (typecheck+build) + refresh release.yml | 1 | P1 | S | — | DONE (Kai, mergé) |
| 002 | Pipeline commandes MCP : atomique, ~0 latence, FIFO | 1 | P1 | S–M | — | DONE (Cole, mergé 2c9f720) |
| 003 | claims.json : verrou inter-processus + TTL + releases loggées | 1 | P1 | M | — | EN COURS (Nell) |
| 004 | Bridge preload : désabonnements ciblés (19 canaux) | 1 | P1 | M | — | EN COURS (Jude) |
| 005 | README.md + CLAUDE.md | 1 | P2 | S–M | — | DONE (Lia, mergé 7b98e56) |
| 006 | Archive incrémentale + persistance merges reportés | 1 | P3 | M | — | EN COURS (Gus) |
| 007 | Socle de tests (vitest + caractérisation launcher/cores/chiffrement) | 2 | P1 | M | 001 | TODO |
| 008 | Contrats assign_task livrés par FICHIER (anti-troncature) | 2 | P1 | M | 003 | TODO |
| 009 | Coalescing PTY→IPC (flux terminaux) | 2 | P2 | S–M | — | EN COURS (Roan — Cruz écarté : branche périmée, cf. note mémoire « backlog ») |
| 010 | Dé-dup helpers (secrets-crypto ×3, app-settings ×3, atomic-fs ×3) | 2 | P2 | M | 003 | TODO |
| 011 | Spawn/worktree : cwd=worktree, health-check, env identité | 3 | P1 | M | 008 | TODO |
| 012 | Retrait uiohook-napi (+ unpin Python CI) | 3 | P2 | M | 001, 007 | TODO |
| 013 | Intégrité ledger : taskId transactionnel + attribution par jeton + demote mort-né | 4 | P1 | M–L | 002, 011 | TODO |
| 014 | uuid → crypto.randomUUID (dep supprimée) | 5 | P3 | S | 012, 013 | TODO |
| 015 | Hygiène repo (.dev.log ignoré, dev.cmd tracké, scripts a11y retirés) | 0 | P3 | S | — | DONE (7372d50) |
| 016 | Lockfile unique npm (suppression pnpm-lock.yaml) | 0 | P3 | S | — | DONE (dbaf52c) |
| 017 | Upgrade Electron (32 EOL → courant) + durcissement webview | finale | P1 | L | tout le reste | TODO (orchestrateur) |

Statuts : TODO | EN COURS | DONE | BLOQUÉ (raison) | REJETÉ (raison).
« (orchestrateur) » = exécuté directement par l'orchestrateur, pas par un worker.

## Notes de dépendances

- **Vague 1** (6 workers parallèles, fichiers disjoints) : 001 `.github/` ; 002
  `server.mjs`+`mcp-export.ts`+`shared/command-types.*` ; 003 `memory-core.*`+`router.ts` ;
  004 `preload`+`shared/types.ts`+renderer ; 005 `README.md`+`CLAUDE.md` ; 006
  `archive.ts`+`merge-back.ts`.
- 007 après 001 (étend ci.yml d'un step test) ; touche package.json (vitest) — AUCUN
  autre plan de la vague 2 ne touche package.json.
- 008 et 011 et 013 touchent tous `router.ts` → strictement séquentiels (vagues 2→3→4).
- 010 touche `memory-core.mjs` (extraction atomic-fs) → après 003.
- 012 touche package.json → après 007 ; touche release.yml → après 001.
- 014 touche package.json + `task-store.ts`/`mailbox.ts` → après 012 et 013.
- 017 (Electron) en dernier : bump deps + smoke runtime dans l'arbre principal, profite
  du socle de tests (007).

## Origine des plans

- Audit deep (findings #1-15 de la table présentée le 2026-06-11) → plans 001-010, 012,
  014-017.
- Store system-feedback (rapports d'orchestrateurs en production) → 008 (rapport
  f89da23d, troncature des contrats), 011 (rapports 1975b0b1 + 1234317c : cwd=tronc,
  worktrees corrompus, ORYON_TERMINAL_ID vide, restart_agent), 013 (rapports a99d20e5 +
  c0834efb : reports mésattribués, taskId recyclés, assigns sans ledger), et la preuve
  terrain de 003 (rapport 75f445e0 : claims orphelins post-approve).

## Findings examinés et REJETÉS (ne pas re-auditer)

- « Handlers de commandes morts / drift server↔main » : FAUX — parité 15/15 vérifiée au
  commit 29c8ae5 (reste le risque de drift futur → command-types.mjs du plan 002).
- « updateTask non transactionnel » : FAUX — une seule UPDATE SQLite = atomique.
- « Sélecteurs Zustand inline = re-render storm » : mécanisme mal compris (l'identité du
  résultat compte) ; recompute O(10) négligeable.
- « Modèle Whisper jamais préchauffé » : FAUX — warm au mount + focus (useVoice.ts:78-103).
- « dev-app-update.yml manquant » : le fichier existe à la racine.
- « Commandes résiduelles rejouées au boot » : déjà balayées (mcp-export.ts:263-266).
- StrictMode double-mount : dev-only (main.tsx) — pas de plan.
- Refresh token Google Calendar concurrent : bénin (jetons réutilisables, auto-guérison) — pas de plan.
- Index inversé de recherche docs (docs-read.mjs) : prématuré — scan mtime-caché déjà
  optimisé, un index token changerait la sémantique substring. Réévaluer à >50 docsets.
- Éviction des workspaces montés (LRU) : contredit la décision produit « terminaux
  vivants au switch » (F1) ; à revisiter seulement si la RAM devient un problème mesuré.
- Direction D1-D5 (scorecard UI, refresh docs MCP, archive browser, badges vocab,
  multi-repo) : hors périmètre de ce lot sur décision utilisateur — features, pas
  optimisations. Conservées dans le rapport d'audit de session.
