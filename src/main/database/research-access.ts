import type { DatabaseSync } from 'node:sqlite'
import { tableExists } from './backup-file'

// Per-user research authorization (#210). ONE place defines who may read or write a
// client or a case, as SQL, so list queries (filtered in SQL) and id checks (point
// lookups) cannot disagree. No generic ACL framework: three scope kinds, two needs.
//
// Rules (see docs/architecture/research-authorization.md):
//  - A client with no client_ownership row is unclaimed: no user can reach it.
//  - Client level: the owner, or a client_grants row for the user. Case-only grantees
//    have NO client-level access.
//  - Case level: the client's owner, a client grant on the client, or a case_grants row.
//    The highest permission among the sources wins.
//  - A grant is effective only while the grantee AND the client's owner are 'active' app
//    users (fail closed on a disabled owner or grantee).
//  - Read = any access. Write = owner or editor, for every mutation.
//  - The app-level 'owner' role grants nothing here: only ownership rows and grants count.

/** Who a request acts for, as far as research content goes. Resolved per request, never from a client. */
export type ResearchScope = { kind: 'all' } | { kind: 'user'; userId: string } | { kind: 'none' }

export const SCOPE_ALL: ResearchScope = { kind: 'all' }
export const SCOPE_NONE: ResearchScope = { kind: 'none' }

/**
 * A reserved id that is never issued (records get random UUIDs). A denied id is replaced by this one
 * before the repository is called, so the answer is exactly what a missing record produces and never
 * echoes the requested id.
 */
export const MISSING_ID = '00000000-0000-0000-0000-000000000000'

export type AccessNeed = 'read' | 'write'
export type AccessLevel = 'none' | 'read' | 'write'

/** The ownership schema (migration 10) is missing or incomplete: every research call is refused. */
export class ResearchUnavailableError extends Error {
  constructor() {
    super('Research access is unavailable: the ownership schema is missing')
    this.name = 'ResearchUnavailableError'
  }
}

const REQUIRED_TABLES = ['clients', 'research_cases', 'app_users', 'client_ownership', 'client_grants', 'case_grants'] as const

/** True when every table the access rules read exists. */
export function researchSchemaReady(db: DatabaseSync): boolean {
  return REQUIRED_TABLES.every((table) => tableExists(db, table))
}

function assertReady(db: DatabaseSync): void {
  if (!researchSchemaReady(db)) throw new ResearchUnavailableError()
}

/** True when the profile has any app_users row (the schema must be ready). */
export function profileHasUsers(db: DatabaseSync): boolean {
  assertReady(db)
  return db.prepare('SELECT 1 FROM app_users LIMIT 1').get() !== undefined
}

/**
 * The scope of the single-operator surfaces: Electron IPC and the loopback host or a paired device.
 * A profile with users has no implicit admin or host read of research content, so those surfaces see
 * nothing; a profile without users is a single-operator profile and sees everything.
 * Throws ResearchUnavailableError on an incompatible schema (never falls back to shared access).
 */
export function localScope(db: DatabaseSync): ResearchScope {
  return profileHasUsers(db) ? SCOPE_NONE : SCOPE_ALL
}

/**
 * The scope of a signed-in user. The caller has validated the session against SQLite status,
 * role and auth_version for this request; the SQL below still requires the user to be active.
 */
export function userScope(db: DatabaseSync, userId: string): ResearchScope {
  assertReady(db)
  return { kind: 'user', userId }
}

export interface SqlFragment {
  sql: string
  /** Positional `?` values, in order of appearance. Plain `?` only, so fragments can be concatenated. */
  params: string[]
}

const ME_ACTIVE = `EXISTS (SELECT 1 FROM app_users me WHERE me.id = ? AND me.status = 'active')`

/** `SELECT client_id` of the clients `userId` may read (or write). */
export function accessibleClientIds(userId: string, need: AccessNeed): SqlFragment {
  const editor = need === 'write' ? ` AND cg.permission = 'editor'` : ''
  return {
    sql:
      `SELECT own.client_id FROM client_ownership own` +
      ` JOIN app_users ownu ON ownu.id = own.owner_user_id AND ownu.status = 'active'` +
      ` WHERE ${ME_ACTIVE}` +
      ` AND (own.owner_user_id = ?` +
      ` OR EXISTS (SELECT 1 FROM client_grants cg WHERE cg.client_id = own.client_id AND cg.grantee_user_id = ?${editor}))`,
    params: [userId, userId, userId]
  }
}

/** `SELECT id` of the cases `userId` may read (or write): owner, client grant or case grant, highest wins. */
export function accessibleCaseIds(userId: string, need: AccessNeed): SqlFragment {
  const editor = (alias: string) => (need === 'write' ? ` AND ${alias}.permission = 'editor'` : '')
  return {
    sql:
      `SELECT rc.id FROM research_cases rc` +
      ` JOIN client_ownership own ON own.client_id = rc.client_id` +
      ` JOIN app_users ownu ON ownu.id = own.owner_user_id AND ownu.status = 'active'` +
      ` WHERE ${ME_ACTIVE}` +
      ` AND (own.owner_user_id = ?` +
      ` OR EXISTS (SELECT 1 FROM client_grants cg WHERE cg.client_id = rc.client_id AND cg.grantee_user_id = ?${editor('cg')})` +
      ` OR EXISTS (SELECT 1 FROM case_grants kg WHERE kg.case_id = rc.id AND kg.grantee_user_id = ?${editor('kg')}))`,
    params: [userId, userId, userId, userId]
  }
}

/**
 * A WHERE condition limiting `column` (a client id or a case id column) to what `scope` may reach.
 * 'all' is `1`, 'none' is `0`, a user is `column IN (<accessible ids>)`.
 */
export function scopeCondition(scope: ResearchScope, column: string, target: 'client' | 'case', need: AccessNeed = 'read'): SqlFragment {
  if (scope.kind === 'all') return { sql: '1', params: [] }
  if (scope.kind === 'none') return { sql: '0', params: [] }
  const ids = target === 'client' ? accessibleClientIds(scope.userId, need) : accessibleCaseIds(scope.userId, need)
  return { sql: `${column} IN (${ids.sql})`, params: ids.params }
}

function allows(db: DatabaseSync, scope: ResearchScope, id: string, target: 'client' | 'case', need: AccessNeed): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'none') return false
  const ids = target === 'client' ? accessibleClientIds(scope.userId, need) : accessibleCaseIds(scope.userId, need)
  return db.prepare(`SELECT 1 AS ok WHERE ? IN (${ids.sql})`).get(id, ...ids.params) !== undefined
}

// The checks below run synchronously immediately before the repository call that uses them.
// node:sqlite is synchronous and the JavaScript turn does not yield between the check and the
// repository's own BEGIN IMMEDIATE transaction, so no other request of this process can change
// ownership, grants or user status in between. A second process on the same database file could;
// the Live cutover (#211) forbids that by running exactly one process per profile.

export function canReadClient(db: DatabaseSync, scope: ResearchScope, clientId: string): boolean {
  return allows(db, scope, clientId, 'client', 'read')
}
export function canWriteClient(db: DatabaseSync, scope: ResearchScope, clientId: string): boolean {
  return allows(db, scope, clientId, 'client', 'write')
}
export function canReadCase(db: DatabaseSync, scope: ResearchScope, caseId: string): boolean {
  return allows(db, scope, caseId, 'case', 'read')
}
export function canWriteCase(db: DatabaseSync, scope: ResearchScope, caseId: string): boolean {
  return allows(db, scope, caseId, 'case', 'write')
}

/** The effective access of `scope` to a client, for tests and diagnostics. */
export function clientAccess(db: DatabaseSync, scope: ResearchScope, clientId: string): AccessLevel {
  return canWriteClient(db, scope, clientId) ? 'write' : canReadClient(db, scope, clientId) ? 'read' : 'none'
}

/** The effective access of `scope` to a case, for tests and diagnostics. */
export function caseAccess(db: DatabaseSync, scope: ResearchScope, caseId: string): AccessLevel {
  return canWriteCase(db, scope, caseId) ? 'write' : canReadCase(db, scope, caseId) ? 'read' : 'none'
}
