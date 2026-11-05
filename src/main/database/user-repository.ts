import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  checkEmail,
  checkUserName,
  isUserRole,
  type AppUser,
  type ApproveTarget,
  type IdentityResolution,
  type NewUserInput,
  type SignInRequest,
  type SignInRequestResult,
  type UserAuthState,
  type UserFailure,
  type UserMutationResult,
  type UserRole,
  type VerifiedIdentityClaims
} from '../../shared/users'
import type { RepositoryClock } from './client-repository'

// The user directory (#179). Users are created or approved by the owner (here:
// the host-local operator); nobody becomes a user by signing in. An external
// identity is bound only by (provider, subject); email and name are displayed
// claims and never match, grant or move access. Every write is one
// BEGIN IMMEDIATE transaction that also appends a user_events row, so a refused
// write leaves no trace. There is deliberately no delete: disable instead.
// The raw subject stays inside this file; nothing returned to callers carries it.
//
// Sign-in request queue: at most MAX_SIGN_IN_REQUESTS rows. Requests not seen
// for REQUEST_TTL_DAYS are pruned first; if the queue is still full a NEW
// subject is refused ('full') rather than evicting anyone silently. A known
// subject always just refreshes its row.

export const MAX_SIGN_IN_REQUESTS = 20
export const REQUEST_TTL_DAYS = 14

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

interface UserRow {
  id: string
  display_name: string
  role: UserRole
  status: AppUser['status']
  contact_email: string | null
  auth_version: number
  version: number
  created_at: string
  updated_at: string
  last_sign_in_at: string | null
  identity_provider: 'google' | null
  identity_email: string | null
  identity_authoritative: number | null
  identity_bound_at: string | null
}

const SELECT_USER = `
  SELECT u.id, u.display_name, u.role, u.status, u.contact_email, u.auth_version, u.version,
         u.created_at, u.updated_at, u.last_sign_in_at,
         i.provider AS identity_provider, i.email AS identity_email,
         i.email_authoritative AS identity_authoritative, i.bound_at AS identity_bound_at
  FROM app_users u LEFT JOIN user_identities i ON i.user_id = u.id AND i.provider = 'google'`

function toUser(row: UserRow): AppUser {
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    contactEmail: row.contact_email,
    identity: row.identity_provider
      ? {
          provider: row.identity_provider,
          email: row.identity_email,
          emailAuthoritative: row.identity_authoritative === 1,
          boundAt: row.identity_bound_at as string
        }
      : null,
    authVersion: row.auth_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSignInAt: row.last_sign_in_at
  }
}

interface RequestRow {
  id: string
  email: string | null
  email_authoritative: number
  name: string | null
  first_seen_at: string
  last_seen_at: string
  attempts: number
}

function toRequest(row: RequestRow): SignInRequest {
  return {
    id: row.id,
    email: row.email,
    emailAuthoritative: row.email_authoritative === 1,
    name: row.name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    attempts: row.attempts
  }
}

type UserAction = 'created' | 'identity-bound' | 'role-changed' | 'activated' | 'disabled' | 'sessions-revoked'
const fail = (reason: UserFailure): { ok: false; reason: UserFailure } => ({ ok: false, reason })

function cleanClaims(claims: VerifiedIdentityClaims) {
  const subject = typeof claims.subject === 'string' ? claims.subject : ''
  if (claims.provider !== 'google' || subject.length < 1 || subject.length > 255) return null
  const name = typeof claims.name === 'string' ? claims.name.trim().slice(0, 200) || null : null
  return { provider: claims.provider, subject, email: checkEmail(claims.email), authoritative: claims.emailAuthoritative === true ? 1 : 0, name }
}

export class UserRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  list(): AppUser[] {
    const rows = this.db.prepare(`${SELECT_USER} ORDER BY u.created_at, u.id`).all() as unknown as UserRow[]
    return rows.map(toUser)
  }

  get(id: string): AppUser | null {
    return this.found(id)
  }

  /** Cheap read for per-request session checks. */
  getAuthState(userId: string): UserAuthState | null {
    const row = this.db.prepare('SELECT status, role, auth_version FROM app_users WHERE id = ?').get(userId) as
      | { status: UserAuthState['status']; role: UserRole; auth_version: number }
      | undefined
    return row ? { status: row.status, role: row.role, authVersion: row.auth_version } : null
  }

  /** The owner approves a person before they sign in. Pending until an identity is bound. */
  create(input: NewUserInput, actor: string): UserMutationResult {
    const displayName = checkUserName(input?.displayName)
    const contact = input?.contactEmail == null ? null : checkEmail(input.contactEmail)
    if (!displayName || !isUserRole(input?.role) || (input.contactEmail != null && contact === null)) return fail('invalid')
    return this.transaction(() => {
      const now = this.clock.now().toISOString()
      const id = this.insertUser(displayName, input.role, 'pending', contact, now)
      this.event(id, 'created', actor, now)
      return this.ok(id)
    })
  }

  listSignInRequests(): SignInRequest[] {
    const rows = this.db.prepare('SELECT * FROM sign_in_requests ORDER BY last_seen_at DESC, id').all() as unknown as RequestRow[]
    return rows.map(toRequest)
  }

  dismissSignInRequest(id: string): boolean {
    return this.transaction(() => this.db.prepare('DELETE FROM sign_in_requests WHERE id = ?').run(id).changes > 0)
  }

  /** Queues an unknown person for the owner to look at. Never creates a user or grants anything. */
  recordSignInRequest(claims: VerifiedIdentityClaims): SignInRequestResult {
    const c = cleanClaims(claims)
    if (!c) return fail('invalid')
    return this.transaction((): SignInRequestResult => {
      const now = this.clock.now()
      const at = now.toISOString()
      if (this.boundUserId(c.provider, c.subject)) return fail('identity-in-use')
      const existing = this.db
        .prepare('SELECT id FROM sign_in_requests WHERE provider = ? AND subject = ?')
        .get(c.provider, c.subject) as { id: string } | undefined
      if (existing) {
        this.db
          .prepare('UPDATE sign_in_requests SET email = ?, email_authoritative = ?, name = ?, last_seen_at = ?, attempts = attempts + 1 WHERE id = ?')
          .run(c.email, c.authoritative, c.name, at, existing.id)
        return { ok: true, request: this.requestRow(existing.id) }
      }
      const cutoff = new Date(now.getTime() - REQUEST_TTL_DAYS * 86_400_000).toISOString()
      this.db.prepare('DELETE FROM sign_in_requests WHERE last_seen_at < ?').run(cutoff)
      const total = (this.db.prepare('SELECT count(*) AS n FROM sign_in_requests').get() as { n: number }).n
      if (total >= MAX_SIGN_IN_REQUESTS) return fail('full')
      const id = this.clock.newId()
      this.db
        .prepare(
          `INSERT INTO sign_in_requests (id, provider, subject, email, email_authoritative, name, first_seen_at, last_seen_at, attempts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(id, c.provider, c.subject, c.email, c.authoritative, c.name, at, at)
      return { ok: true, request: this.requestRow(id) }
    })
  }

  /**
   * The owner binds a queued identity to an existing user without one (a pending
   * user becomes active; a disabled user stays disabled) or to a new active user.
   * Deletes the request.
   */
  approveSignInRequest(requestId: string, target: ApproveTarget, actor: string, expectedVersion?: number): UserMutationResult {
    return this.transaction((): UserMutationResult => {
      const request = this.db.prepare('SELECT * FROM sign_in_requests WHERE id = ?').get(requestId) as
        | (RequestRow & { provider: 'google'; subject: string })
        | undefined
      if (!request) return fail('request-not-found')
      if (this.boundUserId(request.provider, request.subject)) return fail('identity-in-use')

      const now = this.clock.now().toISOString()
      let userId: string
      if ('userId' in target) {
        const user = this.found(target.userId)
        if (!user) return fail('not-found')
        if (expectedVersion !== undefined && user.version !== expectedVersion) return fail('stale')
        if (user.identity) return fail('already-bound')
        userId = user.id
        if (user.status === 'pending') {
          this.db.prepare("UPDATE app_users SET status = 'active', version = version + 1, updated_at = ? WHERE id = ?").run(now, userId)
        } else {
          this.db.prepare('UPDATE app_users SET version = version + 1, updated_at = ? WHERE id = ?').run(now, userId)
        }
      } else {
        const displayName = checkUserName(target.displayName)
        if (!displayName || !isUserRole(target.role)) return fail('invalid')
        userId = this.insertUser(displayName, target.role, 'active', null, now)
        this.event(userId, 'created', actor, now)
      }
      this.db
        .prepare(
          `INSERT INTO user_identities (provider, subject, user_id, email, email_authoritative, name, bound_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(request.provider, request.subject, userId, request.email, request.email_authoritative, request.name, now, now)
      this.event(userId, 'identity-bound', actor, now)
      if (this.found(userId)?.status === 'active') this.event(userId, 'activated', actor, now)
      this.db.prepare('DELETE FROM sign_in_requests WHERE id = ?').run(requestId)
      return this.ok(userId)
    })
  }

  /** Looks up by (provider, subject) only, never by email. Does not record a request. */
  resolveIdentity(claims: VerifiedIdentityClaims): IdentityResolution {
    const c = cleanClaims(claims)
    if (!c) return { kind: 'unknown' }
    return this.transaction((): IdentityResolution => {
      const userId = this.boundUserId(c.provider, c.subject)
      const user = userId ? this.found(userId) : null
      if (!userId || !user) return { kind: 'unknown' }
      if (user.status !== 'active') return { kind: user.status, userId }
      const now = this.clock.now().toISOString()
      this.db
        .prepare('UPDATE user_identities SET email = ?, email_authoritative = ?, name = ?, last_seen_at = ? WHERE provider = ? AND subject = ?')
        .run(c.email, c.authoritative, c.name, now, c.provider, c.subject)
      this.db.prepare('UPDATE app_users SET last_sign_in_at = ? WHERE id = ?').run(now, userId)
      return { kind: 'active', user: this.found(userId) as AppUser }
    })
  }

  setRole(id: string, role: UserRole, actor: string, expectedVersion: number): UserMutationResult {
    if (!isUserRole(role)) return fail('invalid')
    return this.transaction((): UserMutationResult => {
      const user = this.found(id)
      if (!user) return fail('not-found')
      if (user.version !== expectedVersion) return fail('stale')
      if (user.role === role) return fail('invalid')
      if (user.role === 'owner' && user.status === 'active' && this.otherActiveOwners(id) === 0) return fail('last-owner')
      const now = this.clock.now().toISOString()
      this.db
        .prepare('UPDATE app_users SET role = ?, auth_version = auth_version + 1, version = version + 1, updated_at = ? WHERE id = ?')
        .run(role, now, id)
      this.event(id, 'role-changed', actor, now)
      return this.ok(id)
    })
  }

  /**
   * 'disabled' works from any other status. 'active' re-enables a disabled user:
   * back to active if an identity is bound, otherwise back to pending. A pending
   * user becomes active only by binding an identity (approveSignInRequest).
   */
  setStatus(id: string, status: 'active' | 'disabled', actor: string, expectedVersion: number): UserMutationResult {
    if (status !== 'active' && status !== 'disabled') return fail('invalid')
    return this.transaction((): UserMutationResult => {
      const user = this.found(id)
      if (!user) return fail('not-found')
      if (user.version !== expectedVersion) return fail('stale')
      const now = this.clock.now().toISOString()
      if (status === 'disabled') {
        if (user.status === 'disabled') return fail('invalid')
        if (user.role === 'owner' && user.status === 'active' && this.otherActiveOwners(id) === 0) return fail('last-owner')
        this.db
          .prepare("UPDATE app_users SET status = 'disabled', disabled_at = ?, auth_version = auth_version + 1, version = version + 1, updated_at = ? WHERE id = ?")
          .run(now, now, id)
        this.event(id, 'disabled', actor, now)
      } else {
        if (user.status !== 'disabled') return fail('invalid')
        this.db
          .prepare('UPDATE app_users SET status = ?, disabled_at = NULL, auth_version = auth_version + 1, version = version + 1, updated_at = ? WHERE id = ?')
          .run(user.identity ? 'active' : 'pending', now, id)
        this.event(id, 'activated', actor, now)
      }
      return this.ok(id)
    })
  }

  /** Ends every existing session for this user (the session layer compares authVersion). */
  revokeSessions(id: string, actor: string): UserMutationResult {
    return this.transaction((): UserMutationResult => {
      if (!this.found(id)) return fail('not-found')
      const now = this.clock.now().toISOString()
      this.db.prepare('UPDATE app_users SET auth_version = auth_version + 1, version = version + 1, updated_at = ? WHERE id = ?').run(now, id)
      this.event(id, 'sessions-revoked', actor, now)
      return this.ok(id)
    })
  }

  private otherActiveOwners(id: string): number {
    return (
      this.db.prepare("SELECT count(*) AS n FROM app_users WHERE role = 'owner' AND status = 'active' AND id <> ?").get(id) as { n: number }
    ).n
  }

  private insertUser(displayName: string, role: UserRole, status: 'pending' | 'active', contact: string | null, now: string): string {
    const id = this.clock.newId()
    this.db
      .prepare(
        `INSERT INTO app_users (id, display_name, role, status, contact_email, auth_version, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`
      )
      .run(id, displayName, role, status, contact, now, now)
    return id
  }

  private event(userId: string, action: UserAction, actor: string, at: string): void {
    this.db
      .prepare('INSERT INTO user_events (id, user_id, at, action, actor) VALUES (?, ?, ?, ?, ?)')
      .run(this.clock.newId(), userId, at, action, actor)
  }

  private boundUserId(provider: string, subject: string): string | null {
    const row = this.db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?').get(provider, subject) as
      | { user_id: string }
      | undefined
    return row?.user_id ?? null
  }

  private requestRow(id: string): SignInRequest {
    return toRequest(this.db.prepare('SELECT * FROM sign_in_requests WHERE id = ?').get(id) as unknown as RequestRow)
  }

  private found(id: string): AppUser | null {
    const row = this.db.prepare(`${SELECT_USER} WHERE u.id = ?`).get(id) as unknown as UserRow | undefined
    return row ? toUser(row) : null
  }

  private ok(id: string): UserMutationResult {
    const user = this.found(id)
    return user ? { ok: true, user } : fail('not-found')
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
