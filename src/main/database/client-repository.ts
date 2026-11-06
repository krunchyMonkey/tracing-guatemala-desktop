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
import { insertOwnershipEvent } from './ownership-repository'

// Client persistence (client-model/v1). Every write re-runs the shared rules, so
// the renderer's checks are never trusted. All SQL is parameterized.

export interface RepositoryClock {
  now: () => Date
  newId: () => string
}

/**
 * Who owns a client being created (#209). Nothing here comes from a browser: the web host builds
 * 'user' from the validated session, and 'unowned' is only for profiles that have no users.
 */
export type ClientCreateOwnership =
  /** Owned by this active app user. `actor` is recorded in the audit trail ('host' for a host-chosen owner). */
  | { kind: 'user'; userId: string; actor: string }
  /** No owner. Allowed only while the profile has no app_users rows; the client stays unclaimed. */
  | { kind: 'unowned' }

export type ClientOwnershipRefusal = 'owner-required' | 'owner-unavailable'

/** A create was refused for ownership reasons. Nothing was written. Carries no input values. */
export class ClientOwnershipError extends Error {
  constructor(readonly reason: ClientOwnershipRefusal) {
    super(`Client not created: ${reason}`)
    this.name = 'ClientOwnershipError'
  }
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

  /**
   * Creates a client together with its owner row and 'owned-on-create' event in ONE transaction.
   * Throws ClientOwnershipError (nothing written) when the owner is not an active user, or when an
   * unowned create is attempted in a profile that has users: the host or app owner is never
   * assigned silently.
   */
  create(raw: ClientInput, ownership: ClientCreateOwnership): ClientMutationResult {
    const checked = this.check(raw)
    if (!checked.ok) return checked.result

    const input = checked.input
    const now = this.clock.now().toISOString()
    const id = this.clock.newId()
    this.transaction(() => {
      if (ownership.kind === 'user') {
        const owner = this.db.prepare('SELECT status FROM app_users WHERE id = ?').get(ownership.userId) as { status: string } | undefined
        if (!owner || owner.status !== 'active') throw new ClientOwnershipError('owner-unavailable')
      } else if (this.hasAnyUser()) {
        throw new ClientOwnershipError('owner-required')
      }
      this.insertClient(id, input, now)
      if (ownership.kind === 'user') {
        this.db
          .prepare(`INSERT INTO client_ownership (client_id, owner_user_id, origin, assigned_at, assigned_by) VALUES (?, ?, 'created', ?, ?)`)
          .run(id, ownership.userId, now, ownership.actor)
        insertOwnershipEvent(
          this.db,
          this.clock,
          { action: 'owned-on-create', clientId: id, caseId: null, subjectUserId: ownership.userId, permission: null, actor: ownership.actor, detail: null },
          now
        )
      }
    })
    return this.found(id)
  }

  /** Profiles older than schema 9 have no app_users table (restore staging, fixtures): no users. */
  private hasAnyUser(): boolean {
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_users'").get() === undefined) return false
    return this.db.prepare('SELECT 1 FROM app_users LIMIT 1').get() !== undefined
  }

  private insertClient(id: string, input: ClientInput, now: string): void {
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
