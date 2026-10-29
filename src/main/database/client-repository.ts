import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  checkClient,
  findDuplicates,
  queryClients,
  type Client,
  type ClientInput,
  type DirectoryQuery,
  type DuplicateCandidate
} from '../../shared/client-model'
import type { ClientMutationResult } from '../../shared/ipc'

// Client persistence (client-model/v1). Every write re-runs the shared rules, so
// the renderer's checks are never trusted. All SQL is parameterized.

export interface RepositoryClock {
  now: () => Date
  newId: () => string
}

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

interface ClientRow {
  id: string
  display_name: string
  source: Client['source']
  source_detail: string | null
  fiverr_username: string | null
  email: string | null
  other_contact: string | null
  preferred_contact_channel: Client['preferredContactChannel']
  status: Client['status']
  created_at: string
  updated_at: string
  archived_at: string | null
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    displayName: row.display_name,
    source: row.source,
    sourceDetail: row.source_detail,
    fiverrUsername: row.fiverr_username,
    email: row.email,
    otherContact: row.other_contact,
    preferredContactChannel: row.preferred_contact_channel,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  }
}

export class ClientRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  /**
   * Phase 1 directories hold at most a few hundred clients, so filtering and
   * accent-insensitive search run in JS with the same rules as the prototype.
   */
  list(query: DirectoryQuery): Client[] {
    const rows = this.db.prepare('SELECT * FROM clients').all() as unknown as ClientRow[]
    return queryClients(rows.map(toClient), query)
  }

  /**
   * Possible duplicates of the normalized input among all clients, archived
   * included (client-model/v1 §4.3). Advisory only; invalid input has none.
   */
  findDuplicates(raw: ClientInput, excludeId: string | null): DuplicateCandidate[] {
    const { input } = checkClient(raw)
    if (!input) return []
    const rows = this.db.prepare('SELECT * FROM clients').all() as unknown as ClientRow[]
    return findDuplicates(input, rows.map(toClient), excludeId ?? undefined)
  }

  get(id: string): Client | null {
    const row = this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined
    return row ? toClient(row) : null
  }

  create(raw: ClientInput): ClientMutationResult {
    const checked = this.check(raw)
    if (!checked.ok) return checked.result

    const input = checked.input
    const now = this.clock.now().toISOString()
    const id = this.clock.newId()
    this.db
      .prepare(
        `INSERT INTO clients (id, display_name, source, source_detail, fiverr_username, email, other_contact,
           preferred_contact_channel, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`
      )
      .run(
        id,
        input.displayName,
        input.source,
        input.sourceDetail,
        input.fiverrUsername,
        input.email,
        input.otherContact,
        input.preferredContactChannel,
        now,
        now
      )
    return this.found(id)
  }

  update(id: string, raw: ClientInput): ClientMutationResult {
    const existing = this.get(id)
    if (!existing) return { ok: false, reason: 'not-found' }
    if (existing.status !== 'active') return { ok: false, reason: 'wrong-status' }

    const checked = this.check(raw)
    if (!checked.ok) return checked.result

    const input = checked.input
    this.db
      .prepare(
        `UPDATE clients SET display_name = ?, source = ?, source_detail = ?, fiverr_username = ?, email = ?,
           other_contact = ?, preferred_contact_channel = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(
        input.displayName,
        input.source,
        input.sourceDetail,
        input.fiverrUsername,
        input.email,
        input.otherContact,
        input.preferredContactChannel,
        this.clock.now().toISOString(),
        id
      )
    return this.found(id)
  }

  archive(id: string): ClientMutationResult {
    return this.setStatus(id, 'archived')
  }

  restore(id: string): ClientMutationResult {
    return this.setStatus(id, 'active')
  }

  private setStatus(id: string, status: Client['status']): ClientMutationResult {
    const existing = this.get(id)
    if (!existing) return { ok: false, reason: 'not-found' }
    if (existing.status === status) return { ok: false, reason: 'wrong-status' }

    const now = this.clock.now().toISOString()
    // The system note (client-model/v1 §5.4) is written in the same transaction as the status change.
    this.transaction(() => {
      this.db
        .prepare('UPDATE clients SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?')
        .run(status, status === 'archived' ? now : null, now, id)
      this.db
        .prepare(
          `INSERT INTO client_notes (id, client_id, kind, occurred_at, channel, direction, body, created_at, updated_at)
           VALUES (?, ?, 'system', ?, NULL, NULL, ?, ?, ?)`
        )
        .run(this.clock.newId(), id, now, status === 'archived' ? 'Archived.' : 'Restored.', now, now)
    })
    return this.found(id)
  }

  private check(raw: ClientInput): { ok: true; input: ClientInput } | { ok: false; result: ClientMutationResult } {
    const { input, issues } = checkClient(raw)
    if (input) return { ok: true, input }
    return { ok: false, result: { ok: false, reason: 'invalid', issues: issues.filter((i) => i.severity === 'error') } }
  }

  private found(id: string): ClientMutationResult {
    const client = this.get(id)
    return client ? { ok: true, client } : { ok: false, reason: 'not-found' }
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
