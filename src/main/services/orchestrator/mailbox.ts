import { v4 as uuid } from 'uuid'
import { getDb } from '../../db'
import type { MailboxMessage } from '../../../shared/types'

// Séquences ANSI/contrôle préfixées par ESC (\x1b). Exiger le préfixe pour NE PAS supprimer
// des crochets/parenthèses littéraux d'un résumé (ex. "Array[0]" resterait intact).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][AB0]/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Note : l'avancement des agents passe désormais par des FICHIERS (cf. run-files.ts + router.ts),
// plus par des marqueurs "MAILBOX:" dans la sortie terminal (l'ancien mécanisme se faisait reparser
// sur l'écho du prompt → boucle de spam). La table `mailbox` reste le fil d'activité de l'UI,
// alimenté par le router à partir des événements fichiers.

export function recordMailbox(
  workspaceId: string,
  fromAgent: string | null,
  body: string,
): MailboxMessage {
  const msg: MailboxMessage = {
    id: uuid(),
    workspace_id: workspaceId,
    from_agent: fromAgent,
    to_agent: null,
    body,
    created_at: Date.now(),
  }
  getDb()
    .prepare(
      `INSERT INTO mailbox (id, workspace_id, from_agent, to_agent, body, created_at)
       VALUES (@id, @workspace_id, @from_agent, @to_agent, @body, @created_at)`,
    )
    .run(msg)
  return msg
}

export function listMailbox(workspaceId: string): MailboxMessage[] {
  return getDb()
    .prepare('SELECT * FROM mailbox WHERE workspace_id = ? ORDER BY created_at')
    .all(workspaceId) as MailboxMessage[]
}
