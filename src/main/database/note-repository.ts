import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { checkNote, type ClientNote, type NoteInput } from '../../shared/client-model'
import type { NoteMutationResult } from '../../shared/ipc'
import type { RepositoryClock } from './client-repository'

// Internal notes and the manual contact log (client-model/v1 §2.3). Every query
// is scoped by client id, so one client's entries can never be read or changed
// through another client. Entries are never deleted in Phase 1.

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

interface NoteRow {
  id: string
  client_id: string
  kind: ClientNote['kind']
  occurred_at: string
  channel: ClientNote['channel']
  direction: ClientNote['direction']
  body: string
  created_at: string
  updated_at: string
}

function toNote(row: NoteRow): ClientNote {
  return {
    id: row.id,
    clientId: row.client_id,
    kind: row.kind,
    occurredAt: row.occurred_at,
    channel: row.channel,
    direction: row.direction,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class NoteRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  /** Newest first (see compareNotes); empty for an unknown client. */
  list(clientId: string): ClientNote[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM client_notes WHERE client_id = ? ORDER BY occurred_at DESC, created_at DESC, id DESC'
      )
      .all(clientId) as unknown as NoteRow[]
    return rows.map(toNote)
  }

  create(clientId: string, raw: NoteInput): NoteMutationResult {
    const blocked = this.checkClient(clientId)
    if (blocked) return blocked
    const { input, issues } = checkNote(raw, this.clock.now())
    if (!input) return { ok: false, reason: 'invalid', issues }

    const id = this.clock.newId()
    const now = this.clock.now().toISOString()
    this.db
      .prepare(
        `INSERT INTO client_notes (id, client_id, kind, occurred_at, channel, direction, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, clientId, input.kind, input.occurredAt, input.channel, input.direction, input.body, now, now)
    return this.found(clientId, id)
  }

  /** Edits a note or contact entry of this client. System entries cannot be edited. */
  update(clientId: string, noteId: string, raw: NoteInput): NoteMutationResult {
    const blocked = this.checkClient(clientId)
    if (blocked) return blocked
    const existing = this.get(clientId, noteId)
    if (!existing) return { ok: false, reason: 'not-found' }
    if (existing.kind === 'system') return { ok: false, reason: 'wrong-status' }
    const { input, issues } = checkNote(raw, this.clock.now())
    if (!input) return { ok: false, reason: 'invalid', issues }

    this.db
      .prepare(
        `UPDATE client_notes SET kind = ?, occurred_at = ?, channel = ?, direction = ?, body = ?, updated_at = ?
         WHERE id = ? AND client_id = ? AND kind != 'system'`
      )
      .run(
        input.kind,
        input.occurredAt,
        input.channel,
        input.direction,
        input.body,
        this.clock.now().toISOString(),
        noteId,
        clientId
      )
    return this.found(clientId, noteId)
  }

  private get(clientId: string, noteId: string): ClientNote | null {
    const row = this.db.prepare('SELECT * FROM client_notes WHERE id = ? AND client_id = ?').get(noteId, clientId) as
      | NoteRow
      | undefined
    return row ? toNote(row) : null
  }

  /** Notes can be added or edited only on an existing, active client (archived profiles are read-only). */
  private checkClient(clientId: string): NoteMutationResult | null {
    const row = this.db.prepare('SELECT status FROM clients WHERE id = ?').get(clientId) as { status: string } | undefined
    if (!row) return { ok: false, reason: 'not-found' }
    if (row.status !== 'active') return { ok: false, reason: 'wrong-status' }
    return null
  }

  private found(clientId: string, noteId: string): NoteMutationResult {
    const note = this.get(clientId, noteId)
    return note ? { ok: true, note } : { ok: false, reason: 'not-found' }
  }
}
