import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { BackupInvalidError, hashFile, openBackupReadOnly, tableExists } from './backup-file'
import type { RepositoryClock } from './client-repository'

// Research ownership and access-grant storage (#209). Clients are owned by exactly
// one approved app user; cases and everything under them derive their owner through
// research_cases.client_id, so no child row has an owner of its own.
//
// This repository STORES ownership and grants and validates every write. It does not
// enforce access to any record: that is #210. Nothing here is reachable from an HTTP
// route, a script or the UI; the grant methods and the legacy claim are trusted,
// internal, host-only seams. There is deliberately no automatic grant for the app-level
// 'owner' role: that role administers users, it does not own research.
//
// Every write is one BEGIN IMMEDIATE transaction that also appends an ownership_events
// row, so a refused or failed write leaves no trace. Event detail holds ids, counts,
// hashes and sizes only, never a path or record content.

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

export type GrantPermission = 'viewer' | 'editor'
export type OwnershipOrigin = 'created' | 'legacy-claim'
export type OwnershipAction = 'owned-on-create' | 'legacy-claimed' | 'grant-created' | 'grant-changed' | 'grant-revoked'

export interface ResourceOwner {
  ownerUserId: string
  origin: OwnershipOrigin
  assignedAt: string
}

export interface Grant {
  granteeUserId: string
  permission: GrantPermission
  grantedBy: string
  createdAt: string
  updatedAt: string
}

export type GrantFailure = 'not-found' | 'unclaimed' | 'not-owner' | 'invalid-grantee' | 'self-grant'
export type GrantResult =
  | { ok: true; grant: Grant; change: 'created' | 'changed' | 'unchanged' }
  | { ok: false; reason: GrantFailure }
export type RevokeResult = { ok: true; revoked: boolean } | { ok: false; reason: 'not-found' | 'unclaimed' | 'not-owner' }

export interface ClientGrantInput {
  clientId: string
  granteeUserId: string
  permission: GrantPermission
  /** Must be the client's owner. */
  grantedBy: string
}
export interface CaseGrantInput {
  caseId: string
  granteeUserId: string
  permission: GrantPermission
  /** Must be the owner of the case's client. */
  grantedBy: string
}
export interface ClientRevokeInput {
  clientId: string
  granteeUserId: string
  revokedBy: string
}
export interface CaseRevokeInput {
  caseId: string
  granteeUserId: string
  revokedBy: string
}

export interface OwnershipEventInput {
  action: OwnershipAction
  clientId: string
  caseId: string | null
  subjectUserId: string
  permission: GrantPermission | null
  actor: string
  detail: Record<string, unknown> | null
}

export interface OwnershipEvent extends OwnershipEventInput {
  id: string
  at: string
}

/** Appends one audit row. Callers are inside their own transaction. */
export function insertOwnershipEvent(db: DatabaseSync, clock: RepositoryClock, event: OwnershipEventInput, at: string): void {
  db.prepare(
    `INSERT INTO ownership_events (id, at, action, client_id, case_id, subject_user_id, permission, actor, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    clock.newId(),
    at,
    event.action,
    event.clientId,
    event.caseId,
    event.subjectUserId,
    event.permission,
    event.actor,
    event.detail === null ? null : JSON.stringify(event.detail)
  )
}

// ---- Legacy claim: the tree under one client -------------------------------------------------

interface TreeTable {
  key: string
  table: string
  /** SQL expression for the row's identifier. */
  id: string
  /** WHERE clause that selects this table's rows for the client bound as the only parameter. */
  scope: string
}

const CASES_OF_CLIENT = 'SELECT id FROM research_cases WHERE client_id = ?'

/**
 * Every table that holds a client's research records, in a fixed order. The scope token and the
 * backup comparison are computed from exactly these. (case_time_entries and case_active_timer also
 * carry client_id, but a trigger keeps it equal to the case's client, so scoping by case is exact.)
 */
const TREE: readonly TreeTable[] = [
  { key: 'clientNotes', table: 'client_notes', id: 'id', scope: 'client_id = ?' },
  { key: 'researchCases', table: 'research_cases', id: 'id', scope: 'client_id = ?' },
  { key: 'caseEvents', table: 'case_events', id: 'id', scope: `case_id IN (${CASES_OF_CLIENT})` },
  { key: 'caseBriefs', table: 'case_briefs', id: 'case_id', scope: `case_id IN (${CASES_OF_CLIENT})` },
  { key: 'caseJournalEntries', table: 'case_journal_entries', id: 'id', scope: `case_id IN (${CASES_OF_CLIENT})` },
  { key: 'caseTasks', table: 'case_tasks', id: 'id', scope: `case_id IN (${CASES_OF_CLIENT})` },
  { key: 'caseTimeEntries', table: 'case_time_entries', id: 'id', scope: `case_id IN (${CASES_OF_CLIENT})` },
  { key: 'caseActiveTimer', table: 'case_active_timer', id: 'CAST(id AS TEXT)', scope: `case_id IN (${CASES_OF_CLIENT})` },
  { key: 'caseNotebooks', table: 'case_notebooks', id: 'id', scope: `case_id IN (${CASES_OF_CLIENT})` },
  { key: 'notebookSections', table: 'notebook_sections', id: 'id', scope: `case_id IN (${CASES_OF_CLIENT})` },
  { key: 'notebookPages', table: 'notebook_pages', id: 'id', scope: `case_id IN (${CASES_OF_CLIENT})` },
  { key: 'notebookPageRevisions', table: 'notebook_page_revisions', id: 'id', scope: `case_id IN (${CASES_OF_CLIENT})` }
]

export type TreeKey =
  | 'clientNotes'
  | 'researchCases'
  | 'caseEvents'
  | 'caseBriefs'
  | 'caseJournalEntries'
  | 'caseTasks'
  | 'caseTimeEntries'
  | 'caseActiveTimer'
  | 'caseNotebooks'
  | 'notebookSections'
  | 'notebookPages'
  | 'notebookPageRevisions'

export type TreeCounts = Record<TreeKey, number>
export type TreeIds = Record<TreeKey, string[]>

interface TreeScope {
  counts: TreeCounts
  ids: TreeIds
  scopeToken: string
}

/** Ids of the client's whole record tree (a table missing from an older schema is empty) and its token. */
function readScope(db: DatabaseSync, clientId: string): TreeScope {
  const ids = {} as TreeIds
  const counts = {} as TreeCounts
  const canonical: [string, string[]][] = []
  for (const t of TREE) {
    const key = t.key as TreeKey
    let list: string[] = []
    if (tableExists(db, t.table)) {
      const rows = db.prepare(`SELECT ${t.id} AS id FROM ${t.table} WHERE ${t.scope}`).all(clientId) as { id: string }[]
      list = rows.map((r) => String(r.id)).sort()
    }
    ids[key] = list
    counts[key] = list.length
    canonical.push([key, list])
  }
  const scopeToken = createHash('sha256').update(JSON.stringify({ clientId, tables: canonical })).digest('hex')
  return { counts, ids, scopeToken }
}

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return 'N;'
  if (typeof value === 'bigint') return `I${value.toString()};`
  if (typeof value === 'number') return `R${Object.is(value, -0) ? '-0' : String(value)};`
  if (typeof value === 'string') return `T${Buffer.byteLength(value)}:${value};`
  if (value instanceof Uint8Array) return `B${value.byteLength}:${Buffer.from(value).toString('hex')};`
  return 'U;'
}

/**
 * SHA-256 over the full content of the client's row and every row of its record tree (all columns,
 * type-tagged and length-prefixed, rows ordered by id). A table missing from an older schema
 * contributes an explicit marker. Only the hash leaves this function, never content.
 */
export function scopeContentDigest(db: DatabaseSync, clientId: string): string {
  const hash = createHash('sha256')
  const feed = (text: string): void => {
    hash.update(serializeValue(text))
  }
  const columnsOf = (table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  const select = (columns: string[]): string => columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(', ')
  const feedRows = (sql: string, columns: string[]): void => {
    const statement = db.prepare(sql)
    statement.setReadBigInts(true)
    for (const row of statement.iterate(clientId) as Iterable<Record<string, unknown>>) {
      for (const column of columns) hash.update(serializeValue(row[column]))
      hash.update('\n')
    }
  }

  feed('clients')
  const clientColumns = columnsOf('clients')
  for (const column of clientColumns) feed(column)
  feedRows(`SELECT ${select(clientColumns)} FROM clients WHERE id = ?`, clientColumns)
  for (const t of TREE) {
    feed(t.table)
    if (!tableExists(db, t.table)) {
      hash.update('MISSING;')
      continue
    }
    const columns = columnsOf(t.table)
    for (const column of columns) feed(column)
    feedRows(`SELECT ${select(columns)} FROM ${t.table} WHERE ${t.scope} ORDER BY ${t.id}`, columns)
    hash.update('END;')
  }
  return hash.digest('hex')
}

export interface UnclaimedClient {
  id: string
  displayName: string
  status: 'active' | 'archived'
  createdAt: string
  caseCount: number
}

export const DEFAULT_UNCLAIMED_LIMIT = 100
export const MAX_UNCLAIMED_LIMIT = 500

export interface ClaimPreview {
  clientId: string
  clientStatus: 'active' | 'archived'
  counts: TreeCounts
  ids: TreeIds
  /** Grants already stored for this client or its cases. Always 0 for an unclaimed client. */
  existingGrantCount: number
  /** SHA-256 of the canonical client id and sorted ids of every table in the tree. */
  scopeToken: string
}

export type PreviewResult = { ok: true; preview: ClaimPreview } | { ok: false; reason: 'not-found' | 'already-claimed' }

/** What the operator keeps as proof that a verified backup of exactly this scope existed. */
export interface BackupEvidence {
  sha256: string
  bytes: number
  schemaVersion: number
  scopeToken: string
}

export type BackupVerifyFailure = 'not-a-backup' | 'damaged' | 'too-new' | 'client-missing' | 'scope-mismatch'
export type BackupVerifyResult = { ok: true; evidence: BackupEvidence } | { ok: false; reason: BackupVerifyFailure }

export function claimConfirmationPhrase(clientId: string, targetUserId: string): string {
  return `claim client ${clientId} for user ${targetUserId}`
}

export interface ClaimInput {
  clientId: string
  targetUserId: string
  scopeToken: string
  backup: BackupEvidence
  /** Must equal claimConfirmationPhrase(clientId, targetUserId). */
  confirmation: string
  /** Who performs the claim, recorded in the audit event ('host' for the host-local operator). */
  actor: string
  /** Groups the claims of one operator batch (#245). A UUID when given; recorded in the event detail. */
  batchId?: string
}

export type ClaimFailure =
  | 'confirmation-mismatch'
  | 'invalid-input'
  | 'not-found'
  | 'already-claimed'
  | 'target-unavailable'
  | 'scope-changed'
export type ClaimResult = { ok: true; owner: ResourceOwner } | { ok: false; reason: ClaimFailure }

const SHA256_HEX = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validEvidence(backup: BackupEvidence): boolean {
  return (
    typeof backup === 'object' &&
    backup !== null &&
    typeof backup.sha256 === 'string' &&
    SHA256_HEX.test(backup.sha256) &&
    Number.isSafeInteger(backup.bytes) &&
    backup.bytes > 0 &&
    Number.isSafeInteger(backup.schemaVersion) &&
    backup.schemaVersion >= 1 &&
    typeof backup.scopeToken === 'string' &&
    SHA256_HEX.test(backup.scopeToken)
  )
}

interface OwnerRow {
  owner_user_id: string
  origin: OwnershipOrigin
  assigned_at: string
}
interface GrantRow {
  grantee_user_id: string
  permission: GrantPermission
  granted_by: string
  created_at: string
  updated_at: string
}

const toOwner = (row: OwnerRow): ResourceOwner => ({ ownerUserId: row.owner_user_id, origin: row.origin, assignedAt: row.assigned_at })
const toGrant = (row: GrantRow): Grant => ({
  granteeUserId: row.grantee_user_id,
  permission: row.permission,
  grantedBy: row.granted_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

export class OwnershipRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  // ---- Reads --------------------------------------------------------------------------------

  /** The client's owner, or null when it is unclaimed (or does not exist). */
  getClientOwner(clientId: string): ResourceOwner | null {
    const row = this.db
      .prepare('SELECT owner_user_id, origin, assigned_at FROM client_ownership WHERE client_id = ?')
      .get(clientId) as OwnerRow | undefined
    return row ? toOwner(row) : null
  }

  /** A case has no stored owner: it is the owner of its client. Null when unclaimed or unknown. */
  getCaseOwner(caseId: string): ResourceOwner | null {
    const row = this.db
      .prepare(
        `SELECT o.owner_user_id, o.origin, o.assigned_at
         FROM research_cases c JOIN client_ownership o ON o.client_id = c.client_id WHERE c.id = ?`
      )
      .get(caseId) as OwnerRow | undefined
    return row ? toOwner(row) : null
  }

  listGrants(scope: { clientId: string } | { caseId: string }): Grant[] {
    const rows =
      'clientId' in scope
        ? this.db.prepare('SELECT * FROM client_grants WHERE client_id = ? ORDER BY created_at, grantee_user_id').all(scope.clientId)
        : this.db.prepare('SELECT * FROM case_grants WHERE case_id = ? ORDER BY created_at, grantee_user_id').all(scope.caseId)
    return (rows as unknown as GrantRow[]).map(toGrant)
  }

  listEvents(clientId: string): OwnershipEvent[] {
    const rows = this.db.prepare('SELECT * FROM ownership_events WHERE client_id = ? ORDER BY at, rowid').all(clientId) as unknown as {
      id: string
      at: string
      action: OwnershipAction
      client_id: string
      case_id: string | null
      subject_user_id: string
      permission: GrantPermission | null
      actor: string
      detail: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      clientId: r.client_id,
      caseId: r.case_id,
      subjectUserId: r.subject_user_id,
      permission: r.permission,
      actor: r.actor,
      detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>)
    }))
  }

  // ---- Grants (trusted internal use only; no route, no UI) -------------------------------------

  setClientGrant(input: ClientGrantInput): GrantResult {
    return this.transaction(() => {
      if (!this.clientExists(input.clientId)) return { ok: false, reason: 'not-found' }
      return this.writeGrant('client', input.clientId, input.clientId, null, input)
    })
  }

  setCaseGrant(input: CaseGrantInput): GrantResult {
    return this.transaction(() => {
      const found = this.db.prepare('SELECT client_id FROM research_cases WHERE id = ?').get(input.caseId) as { client_id: string } | undefined
      if (!found) return { ok: false, reason: 'not-found' }
      return this.writeGrant('case', input.caseId, found.client_id, input.caseId, input)
    })
  }

  revokeClientGrant(input: ClientRevokeInput): RevokeResult {
    return this.transaction(() => {
      if (!this.clientExists(input.clientId)) return { ok: false, reason: 'not-found' }
      return this.removeGrant('client', input.clientId, input.clientId, null, input.granteeUserId, input.revokedBy)
    })
  }

  revokeCaseGrant(input: CaseRevokeInput): RevokeResult {
    return this.transaction(() => {
      const found = this.db.prepare('SELECT client_id FROM research_cases WHERE id = ?').get(input.caseId) as { client_id: string } | undefined
      if (!found) return { ok: false, reason: 'not-found' }
      return this.removeGrant('case', input.caseId, found.client_id, input.caseId, input.granteeUserId, input.revokedBy)
    })
  }

  // ---- Legacy reconciliation (host-only library; no route, no script, no UI) -------------------

  /** Clients without an owner, oldest first, at most `limit` (default 100, capped at 500). */
  listUnclaimedClients(options: { limit?: number } = {}): UnclaimedClient[] {
    const requested = options.limit ?? DEFAULT_UNCLAIMED_LIMIT
    const limit = Math.min(Math.max(Number.isInteger(requested) ? requested : DEFAULT_UNCLAIMED_LIMIT, 1), MAX_UNCLAIMED_LIMIT)
    const rows = this.db
      .prepare(
        `SELECT c.id, c.display_name, c.status, c.created_at,
                (SELECT count(*) FROM research_cases r WHERE r.client_id = c.id) AS case_count
         FROM clients c
         WHERE NOT EXISTS (SELECT 1 FROM client_ownership o WHERE o.client_id = c.id)
         ORDER BY c.created_at, c.id LIMIT ?`
      )
      .all(limit) as unknown as { id: string; display_name: string; status: 'active' | 'archived'; created_at: string; case_count: number }[]
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, status: r.status, createdAt: r.created_at, caseCount: r.case_count }))
  }

  /** The exact set of records a claim would assign, with a token that changes if any id is added or removed. */
  previewClaim(clientId: string): PreviewResult {
    const client = this.db.prepare('SELECT status FROM clients WHERE id = ?').get(clientId) as { status: 'active' | 'archived' } | undefined
    if (!client) return { ok: false, reason: 'not-found' }
    if (this.getClientOwner(clientId)) return { ok: false, reason: 'already-claimed' }
    const scope = readScope(this.db, clientId)
    return {
      ok: true,
      preview: {
        clientId,
        clientStatus: client.status,
        counts: scope.counts,
        ids: scope.ids,
        existingGrantCount: this.grantCount(clientId),
        scopeToken: scope.scopeToken
      }
    }
  }

  /**
   * Opens a backup file read-only and checks it is intact, current-or-older, and holds the previewed
   * client's tree with the same per-table counts. Returns the evidence to pass to claimLegacyClient.
   * A backup taken before records were added (or after some were) does not match.
   */
  verifyClaimBackup(file: string, preview: ClaimPreview): BackupVerifyResult {
    let opened: ReturnType<typeof openBackupReadOnly>
    try {
      opened = openBackupReadOnly(file)
    } catch (error) {
      if (error instanceof BackupInvalidError) return { ok: false, reason: error.problem }
      throw error
    }
    try {
      const present = opened.db.prepare('SELECT 1 FROM clients WHERE id = ?').get(preview.clientId)
      if (!present) return { ok: false, reason: 'client-missing' }
      const scope = readScope(opened.db, preview.clientId)
      for (const t of TREE) {
        if (scope.counts[t.key as TreeKey] !== preview.counts[t.key as TreeKey]) return { ok: false, reason: 'scope-mismatch' }
      }
      const { sha256, bytes } = hashFile(file)
      return { ok: true, evidence: { sha256, bytes, schemaVersion: opened.schemaVersion, scopeToken: scope.scopeToken } }
    } finally {
      opened.db.close()
    }
  }

  /**
   * Assigns an unclaimed client, and with it its whole record tree, to an active user.
   *
   * Only the single client_ownership root row is written; cases and every descendant derive their
   * owner through it. A partially assigned family tree is therefore impossible by construction:
   * either the root row exists (everything under it is owned) or it does not (nothing is). The
   * transaction below makes the root row and its audit event atomic, and its recomputed scope
   * token refuses the claim if the tree changed since the preview or the verified backup.
   */
  claimLegacyClient(input: ClaimInput): ClaimResult {
    if (input.confirmation !== claimConfirmationPhrase(input.clientId, input.targetUserId)) {
      return { ok: false, reason: 'confirmation-mismatch' }
    }
    if (!validEvidence(input.backup)) return { ok: false, reason: 'invalid-input' }
    if (typeof input.actor !== 'string' || input.actor.length < 1 || input.actor.length > 36) return { ok: false, reason: 'invalid-input' }
    if (input.batchId !== undefined && (typeof input.batchId !== 'string' || !UUID.test(input.batchId))) return { ok: false, reason: 'invalid-input' }

    return this.transaction((): ClaimResult => {
      const target = this.db.prepare('SELECT status FROM app_users WHERE id = ?').get(input.targetUserId) as { status: string } | undefined
      if (!target || target.status !== 'active') return { ok: false, reason: 'target-unavailable' }
      if (!this.clientExists(input.clientId)) return { ok: false, reason: 'not-found' }
      if (this.getClientOwner(input.clientId)) return { ok: false, reason: 'already-claimed' }

      const scope = readScope(this.db, input.clientId)
      if (scope.scopeToken !== input.scopeToken || scope.scopeToken !== input.backup.scopeToken) {
        return { ok: false, reason: 'scope-changed' }
      }

      const at = this.clock.now().toISOString()
      this.db
        .prepare(`INSERT INTO client_ownership (client_id, owner_user_id, origin, assigned_at, assigned_by) VALUES (?, ?, 'legacy-claim', ?, ?)`)
        .run(input.clientId, input.targetUserId, at, input.actor)
      insertOwnershipEvent(
        this.db,
        this.clock,
        {
          action: 'legacy-claimed',
          clientId: input.clientId,
          caseId: null,
          subjectUserId: input.targetUserId,
          permission: null,
          actor: input.actor,
          detail: {
            backupSha256: input.backup.sha256,
            backupBytes: input.backup.bytes,
            schemaVersion: input.backup.schemaVersion,
            scopeToken: scope.scopeToken,
            counts: scope.counts,
            ...(input.batchId === undefined ? {} : { batchId: input.batchId })
          }
        },
        at
      )
      return { ok: true, owner: { ownerUserId: input.targetUserId, origin: 'legacy-claim', assignedAt: at } }
    })
  }

  // ---- Internals ------------------------------------------------------------------------------

  private clientExists(clientId: string): boolean {
    return this.db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId) !== undefined
  }

  private grantCount(clientId: string): number {
    const direct = this.db.prepare('SELECT count(*) AS n FROM client_grants WHERE client_id = ?').get(clientId) as { n: number }
    const viaCases = this.db
      .prepare(`SELECT count(*) AS n FROM case_grants WHERE case_id IN (${CASES_OF_CLIENT})`)
      .get(clientId) as { n: number }
    return direct.n + viaCases.n
  }

  /** Runs inside a transaction. `clientId` is the owning client; `caseId` is null for a client-level grant. */
  private writeGrant(
    scope: 'client' | 'case',
    resourceId: string,
    clientId: string,
    caseId: string | null,
    input: { granteeUserId: string; permission: GrantPermission; grantedBy: string }
  ): GrantResult {
    const owner = this.getClientOwner(clientId)
    if (!owner) return { ok: false, reason: 'unclaimed' }
    if (owner.ownerUserId !== input.grantedBy) return { ok: false, reason: 'not-owner' }
    if (input.granteeUserId === owner.ownerUserId) return { ok: false, reason: 'self-grant' }
    if (input.permission !== 'viewer' && input.permission !== 'editor') return { ok: false, reason: 'invalid-grantee' }
    const grantee = this.db.prepare('SELECT status FROM app_users WHERE id = ?').get(input.granteeUserId) as { status: string } | undefined
    if (!grantee || grantee.status !== 'active') return { ok: false, reason: 'invalid-grantee' }

    const table = scope === 'client' ? 'client_grants' : 'case_grants'
    const key = scope === 'client' ? 'client_id' : 'case_id'
    const existing = this.db
      .prepare(`SELECT * FROM ${table} WHERE ${key} = ? AND grantee_user_id = ?`)
      .get(resourceId, input.granteeUserId) as GrantRow | undefined
    const at = this.clock.now().toISOString()

    if (existing && existing.permission === input.permission) return { ok: true, grant: toGrant(existing), change: 'unchanged' }

    if (existing) {
      this.db
        .prepare(`UPDATE ${table} SET permission = ?, updated_at = ? WHERE ${key} = ? AND grantee_user_id = ?`)
        .run(input.permission, at, resourceId, input.granteeUserId)
    } else {
      this.db
        .prepare(`INSERT INTO ${table} (${key}, grantee_user_id, permission, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(resourceId, input.granteeUserId, input.permission, input.grantedBy, at, at)
    }
    insertOwnershipEvent(
      this.db,
      this.clock,
      {
        action: existing ? 'grant-changed' : 'grant-created',
        clientId,
        caseId,
        subjectUserId: input.granteeUserId,
        permission: input.permission,
        actor: input.grantedBy,
        detail: existing ? { previousPermission: existing.permission } : null
      },
      at
    )
    const stored = this.db
      .prepare(`SELECT * FROM ${table} WHERE ${key} = ? AND grantee_user_id = ?`)
      .get(resourceId, input.granteeUserId) as unknown as GrantRow
    return { ok: true, grant: toGrant(stored), change: existing ? 'changed' : 'created' }
  }

  private removeGrant(
    scope: 'client' | 'case',
    resourceId: string,
    clientId: string,
    caseId: string | null,
    granteeUserId: string,
    revokedBy: string
  ): RevokeResult {
    const owner = this.getClientOwner(clientId)
    if (!owner) return { ok: false, reason: 'unclaimed' }
    if (owner.ownerUserId !== revokedBy) return { ok: false, reason: 'not-owner' }
    const table = scope === 'client' ? 'client_grants' : 'case_grants'
    const key = scope === 'client' ? 'client_id' : 'case_id'
    const existing = this.db
      .prepare(`SELECT * FROM ${table} WHERE ${key} = ? AND grantee_user_id = ?`)
      .get(resourceId, granteeUserId) as GrantRow | undefined
    if (!existing) return { ok: true, revoked: false }
    // A grant is a permission, not a research record, so it is deleted; the audit row remains.
    this.db.prepare(`DELETE FROM ${table} WHERE ${key} = ? AND grantee_user_id = ?`).run(resourceId, granteeUserId)
    insertOwnershipEvent(
      this.db,
      this.clock,
      {
        action: 'grant-revoked',
        clientId,
        caseId,
        subjectUserId: granteeUserId,
        permission: existing.permission,
        actor: revokedBy,
        detail: null
      },
      this.clock.now().toISOString()
    )
    return { ok: true, revoked: true }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
