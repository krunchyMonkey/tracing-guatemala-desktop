import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData } from '../../src/main/database/app-data'
import { configureConnection } from '../../src/main/database/connection'
import { getSchemaVersion, migrate, migrations } from '../../src/main/database/migrations'
import { MAX_SIGN_IN_REQUESTS } from '../../src/main/database/user-repository'
import { checkEmail, checkUserName, type AppUser, type VerifiedIdentityClaims } from '../../src/shared/users'

// The user directory (#179): migration, identity binding, roles, guards and
// backups. Fictional people and subjects only.

let root: string
let data: AppData
let clockMs: number
const NOW = Date.parse('2026-11-01T09:00:00.000Z')

function open(): AppData {
  return new AppData(join(root, 'profile'), () => new Date(clockMs))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-users-test-'))
  clockMs = NOW
  data = open()
})

afterEach(() => {
  try {
    data.close()
  } catch {
    // Closed by the test.
  }
  rmSync(root, { recursive: true, force: true })
})

const claims = (subject: string, email: string | null = `${subject}@example.test`, name: string | null = 'Ana Example'): VerifiedIdentityClaims => ({
  provider: 'google',
  subject,
  email,
  emailVerified: true,
  emailAuthoritative: false,
  name
})

function must(result: { ok: boolean; user?: AppUser; reason?: string }): AppUser {
  expect(result.ok, String(result.reason)).toBe(true)
  return result.user as AppUser
}

/** Active owner bound to `sub-owner`. */
function bootstrapOwner(subject = 'sub-owner'): AppUser {
  const pending = must(data.users.create({ displayName: 'Ana Example', role: 'owner', contactEmail: 'ana@example.test' }, 'host'))
  const request = data.users.recordSignInRequest(claims(subject))
  if (!request.ok) throw new Error('request refused')
  return must(data.users.approveSignInRequest(request.request.id, { userId: pending.id }, 'host'))
}

function approveNew(subject: string, displayName: string, role: 'owner' | 'researcher'): AppUser {
  const request = data.users.recordSignInRequest(claims(subject))
  if (!request.ok) throw new Error('request refused')
  return must(data.users.approveSignInRequest(request.request.id, { displayName, role }, 'host'))
}

const events = (userId: string) =>
  (data.db.prepare('SELECT action, actor FROM user_events WHERE user_id = ? ORDER BY rowid').all(userId) as { action: string; actor: string }[]).map(
    (e) => `${e.action}:${e.actor}`
  )

describe('migration 9', () => {
  it('creates the tables on a fresh database', () => {
    expect(getSchemaVersion(data.db)).toBe(migrations.length)
    expect(migrations[8]?.name).toBe('app_users')
    expect(data.users.list()).toEqual([])
  })

  it('upgrades an existing version 8 database with no users', () => {
    const db = new DatabaseSync(join(root, 'old.sqlite'))
    configureConnection(db)
    migrate(db, {}, migrations.slice(0, 8))
    db.exec(`INSERT INTO clients (id, display_name, source, status, preferred_contact_channel, created_at, updated_at)
             VALUES ('${'a'.repeat(36)}', 'Ana Ejemplo', 'direct', 'active', 'email', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`)
    expect(getSchemaVersion(db)).toBe(8)
    expect(migrate(db)).toEqual({ from: 8, to: migrations.length })
    expect((db.prepare('SELECT count(*) AS n FROM app_users').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT count(*) AS n FROM clients').get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('enforces its CHECK constraints and triggers', () => {
    const id = 'u'.repeat(36)
    const insert = (role: string, status: string, disabledAt: string | null) =>
      data.db
        .prepare(
          `INSERT INTO app_users (id, display_name, role, status, created_at, updated_at, disabled_at) VALUES (?, 'Ana Example', ?, ?, 'x', 'x', ?)`
        )
        .run(id, role, status, disabledAt)
    expect(() => insert('admin', 'active', null)).toThrow()
    expect(() => insert('owner', 'banned', null)).toThrow()
    expect(() => insert('owner', 'disabled', null)).toThrow()
    expect(() => insert('owner', 'active', 'x')).toThrow()
    expect(() => data.db.prepare(`INSERT INTO app_users (id, display_name, role, status, created_at, updated_at) VALUES ('short', 'A', 'owner', 'active', 'x', 'x')`).run()).toThrow()
    insert('researcher', 'active', null)
    expect(() => data.db.prepare('DELETE FROM app_users WHERE id = ?').run(id)).toThrow(/never deleted/)
    expect(() => data.db.prepare("UPDATE app_users SET id = ? WHERE id = ?").run('v'.repeat(36), id)).toThrow(/immutable/)
    expect(() =>
      data.db
        .prepare(`INSERT INTO user_identities (provider, subject, user_id, email_authoritative, bound_at, last_seen_at) VALUES ('github', 's', ?, 0, 'x', 'x')`)
        .run(id)
    ).toThrow()
    expect(() =>
      data.db
        .prepare(`INSERT INTO user_events (id, user_id, at, action, actor) VALUES (?, ?, 'x', 'exploded', 'host')`)
        .run('e'.repeat(36), id)
    ).toThrow()
  })

  it('keeps user events append-only and identities fixed', () => {
    const owner = bootstrapOwner()
    expect(() => data.db.prepare("UPDATE user_events SET actor = 'x'").run()).toThrow(/append-only/)
    expect(() => data.db.prepare('DELETE FROM user_events').run()).toThrow(/append-only/)
    expect(() => data.db.prepare("UPDATE user_identities SET subject = 'other' WHERE user_id = ?").run(owner.id)).toThrow(/never moved/)
  })
})

describe('shared validators', () => {
  it('trims names and lowercases emails', () => {
    expect(checkUserName('  Ana Example ')).toBe('Ana Example')
    expect(checkUserName('   ')).toBeNull()
    expect(checkUserName('x'.repeat(121))).toBeNull()
    expect(checkEmail(' Ana@Example.TEST ')).toBe('ana@example.test')
    expect(checkEmail('no-at-sign')).toBeNull()
    expect(checkEmail('a b@example.test')).toBeNull()
    expect(checkEmail(`${'a'.repeat(250)}@example.test`)).toBeNull()
  })
})

describe('provisioning and binding', () => {
  it('creates pending users and records requests without granting anything', () => {
    const pending = must(data.users.create({ displayName: ' Ben Example ', role: 'researcher' }, 'host'))
    expect(pending).toMatchObject({ displayName: 'Ben Example', status: 'pending', role: 'researcher', identity: null, authVersion: 1, version: 1 })
    expect(data.users.create({ displayName: '', role: 'owner' }, 'host')).toEqual({ ok: false, reason: 'invalid' })
    expect(data.users.create({ displayName: 'Cy Example', role: 'owner', contactEmail: 'bad' }, 'host')).toEqual({ ok: false, reason: 'invalid' })

    const first = data.users.recordSignInRequest(claims('sub-stranger'))
    expect(first.ok && first.request).toMatchObject({ attempts: 1, email: 'sub-stranger@example.test', emailAuthoritative: false })
    clockMs += 1000
    const again = data.users.recordSignInRequest(claims('sub-stranger', 'new@example.test'))
    expect(again.ok && again.request).toMatchObject({ attempts: 2, email: 'new@example.test' })
    expect(data.users.listSignInRequests()).toHaveLength(1)
    expect(data.users.list()).toHaveLength(1)
    expect(data.users.resolveIdentity(claims('sub-stranger'))).toEqual({ kind: 'unknown' })
    expect(data.users.recordSignInRequest({ ...claims(''), subject: '' })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('approves a request into an existing pending user, who becomes active', () => {
    const owner = bootstrapOwner()
    expect(owner).toMatchObject({ status: 'active', role: 'owner', identity: { provider: 'google', email: 'sub-owner@example.test' } })
    expect(owner.version).toBe(2)
    expect(events(owner.id)).toEqual(['created:host', 'identity-bound:host', 'activated:host'])
    expect(data.users.listSignInRequests()).toEqual([])
    expect(data.users.resolveIdentity(claims('sub-owner'))).toMatchObject({ kind: 'active', user: { id: owner.id } })
  })

  it('approves a request into a new active user', () => {
    const ben = approveNew('sub-ben', 'Ben Example', 'researcher')
    expect(ben).toMatchObject({ status: 'active', role: 'researcher', contactEmail: null })
    expect(data.users.approveSignInRequest('x'.repeat(36), { displayName: 'Z', role: 'owner' }, 'host')).toEqual({ ok: false, reason: 'request-not-found' })
    const request = data.users.recordSignInRequest(claims('sub-other'))
    if (!request.ok) throw new Error('refused')
    expect(data.users.approveSignInRequest(request.request.id, { displayName: '', role: 'owner' }, 'host')).toEqual({ ok: false, reason: 'invalid' })
    expect(data.users.approveSignInRequest(request.request.id, { userId: 'n'.repeat(36) }, 'host')).toEqual({ ok: false, reason: 'not-found' })
    expect(data.users.listSignInRequests()).toHaveLength(1)
  })

  it('refuses a second identity for a user and a second user for a subject', () => {
    const ben = approveNew('sub-ben', 'Ben Example', 'researcher')
    const second = data.users.recordSignInRequest(claims('sub-ben-2'))
    if (!second.ok) throw new Error('refused')
    expect(data.users.approveSignInRequest(second.request.id, { userId: ben.id }, 'host')).toEqual({ ok: false, reason: 'already-bound' })

    // A bound subject cannot be queued again, nor bound twice (forced past the repository).
    expect(data.users.recordSignInRequest(claims('sub-ben'))).toEqual({ ok: false, reason: 'identity-in-use' })
    const cy = must(data.users.create({ displayName: 'Cy Example', role: 'researcher' }, 'host'))
    expect(() =>
      data.db
        .prepare(`INSERT INTO user_identities (provider, subject, user_id, email_authoritative, bound_at, last_seen_at) VALUES ('google', 'sub-ben', ?, 0, 'x', 'x')`)
        .run(cy.id)
    ).toThrow()
    expect(() =>
      data.db
        .prepare(`INSERT INTO user_identities (provider, subject, user_id, email_authoritative, bound_at, last_seen_at) VALUES ('google', 'sub-extra', ?, 0, 'x', 'x')`)
        .run(ben.id)
    ).toThrow()
    // A request that became bound in the meantime is refused at approval.
    data.db.prepare('INSERT INTO sign_in_requests (id, provider, subject, email_authoritative, first_seen_at, last_seen_at, attempts) VALUES (?, ?, ?, 0, ?, ?, 1)').run('r'.repeat(36), 'google', 'sub-ben', 'x', 'x')
    expect(data.users.approveSignInRequest('r'.repeat(36), { userId: cy.id }, 'host')).toEqual({ ok: false, reason: 'identity-in-use' })
  })

  it('keeps a disabled user disabled when an identity is bound', () => {
    bootstrapOwner()
    const ben = must(data.users.create({ displayName: 'Ben Example', role: 'researcher' }, 'host'))
    const disabled = must(data.users.setStatus(ben.id, 'disabled', 'host', ben.version))
    const request = data.users.recordSignInRequest(claims('sub-ben'))
    if (!request.ok) throw new Error('refused')
    const bound = must(data.users.approveSignInRequest(request.request.id, { userId: ben.id }, 'host', disabled.version))
    expect(bound.status).toBe('disabled')
    expect(data.users.resolveIdentity(claims('sub-ben'))).toEqual({ kind: 'disabled', userId: ben.id })
  })

  it('dismisses requests', () => {
    const request = data.users.recordSignInRequest(claims('sub-x'))
    if (!request.ok) throw new Error('refused')
    expect(data.users.dismissSignInRequest(request.request.id)).toBe(true)
    expect(data.users.dismissSignInRequest(request.request.id)).toBe(false)
  })
})

describe('resolving identities', () => {
  it('matches by subject, never by email', () => {
    const owner = bootstrapOwner()
    // Same email, different subject: unknown.
    expect(data.users.resolveIdentity(claims('sub-impostor', 'sub-owner@example.test'))).toEqual({ kind: 'unknown' })
    // Same subject, changed email: still the same user, claim updated.
    clockMs += 60_000
    const resolved = data.users.resolveIdentity(claims('sub-owner', 'ana.new@example.test', 'Ana E.'))
    expect(resolved).toMatchObject({ kind: 'active', user: { id: owner.id, identity: { email: 'ana.new@example.test' } } })
    expect(data.users.get(owner.id)?.lastSignInAt).toBe(new Date(clockMs).toISOString())
    expect(data.users.list()).toHaveLength(1)
    expect(data.users.listSignInRequests()).toEqual([])
  })

  it('reports pending and disabled users without signing them in', () => {
    const owner = bootstrapOwner()
    const ben = approveNew('sub-ben', 'Ben Example', 'researcher')
    must(data.users.setStatus(ben.id, 'disabled', 'host', ben.version))
    expect(data.users.resolveIdentity(claims('sub-ben'))).toEqual({ kind: 'disabled', userId: ben.id })
    expect(data.users.get(ben.id)?.lastSignInAt).toBeNull()
    expect(data.users.getAuthState(owner.id)).toEqual({ status: 'active', role: 'owner', authVersion: 1 })
    expect(data.users.getAuthState('n'.repeat(36))).toBeNull()
  })
})

describe('sign-in request queue', () => {
  it('is bounded: prunes old requests first, then refuses new subjects', () => {
    for (let i = 0; i < MAX_SIGN_IN_REQUESTS; i += 1) expect(data.users.recordSignInRequest(claims(`sub-${i}`)).ok).toBe(true)
    expect(data.users.recordSignInRequest(claims('sub-extra'))).toEqual({ ok: false, reason: 'full' })
    // A known subject still refreshes.
    expect(data.users.recordSignInRequest(claims('sub-0')).ok).toBe(true)
    expect(data.users.listSignInRequests()).toHaveLength(MAX_SIGN_IN_REQUESTS)
    expect(data.users.list()).toEqual([])

    clockMs += 15 * 86_400_000
    expect(data.users.recordSignInRequest(claims('sub-extra')).ok).toBe(true)
    expect(data.users.listSignInRequests()).toHaveLength(1)
  })
})

describe('roles, status and the last-owner guard', () => {
  it('refuses demoting or disabling the last active owner, and allows it with another', () => {
    const owner = bootstrapOwner()
    expect(data.users.setRole(owner.id, 'researcher', 'host', owner.version)).toEqual({ ok: false, reason: 'last-owner' })
    expect(data.users.setStatus(owner.id, 'disabled', 'host', owner.version)).toEqual({ ok: false, reason: 'last-owner' })
    expect(data.users.get(owner.id)).toEqual(owner)

    // A pending owner does not count as an active one.
    must(data.users.create({ displayName: 'Cy Example', role: 'owner' }, 'host'))
    expect(data.users.setRole(owner.id, 'researcher', 'host', owner.version)).toEqual({ ok: false, reason: 'last-owner' })

    const second = approveNew('sub-owner-2', 'Dee Example', 'owner')
    const demoted = must(data.users.setRole(owner.id, 'researcher', 'host', owner.version))
    expect(demoted.role).toBe('researcher')
    expect(data.users.setStatus(second.id, 'disabled', 'host', second.version)).toEqual({ ok: false, reason: 'last-owner' })
    expect(data.users.setRole(second.id, 'researcher', 'host', second.version)).toEqual({ ok: false, reason: 'last-owner' })
    must(data.users.setRole(owner.id, 'owner', 'host', demoted.version))
    expect(must(data.users.setStatus(second.id, 'disabled', 'host', second.version)).status).toBe('disabled')
  })

  it('checks expectedVersion and bumps auth_version only where sessions must end', () => {
    bootstrapOwner()
    const ben = approveNew('sub-ben', 'Ben Example', 'researcher')
    expect(ben.authVersion).toBe(1)
    expect(data.users.setRole(ben.id, 'owner', 'host', ben.version + 1)).toEqual({ ok: false, reason: 'stale' })
    expect(data.users.setStatus(ben.id, 'disabled', 'host', 99)).toEqual({ ok: false, reason: 'stale' })

    clockMs += 1000
    const promoted = must(data.users.setRole(ben.id, 'owner', 'host', ben.version))
    expect(promoted).toMatchObject({ authVersion: 2, version: ben.version + 1, updatedAt: new Date(clockMs).toISOString() })
    // The same stale version cannot be applied twice (concurrent change).
    expect(data.users.setRole(ben.id, 'researcher', 'host', ben.version)).toEqual({ ok: false, reason: 'stale' })

    const disabled = must(data.users.setStatus(ben.id, 'disabled', 'host', promoted.version))
    expect(disabled).toMatchObject({ authVersion: 3, status: 'disabled' })
    const back = must(data.users.setStatus(ben.id, 'active', 'host', disabled.version))
    expect(back).toMatchObject({ authVersion: 4, status: 'active' })
    const revoked = must(data.users.revokeSessions(ben.id, 'host'))
    expect(revoked.authVersion).toBe(5)
    expect(data.users.getAuthState(ben.id)).toEqual({ status: 'active', role: 'owner', authVersion: 5 })
    expect(events(ben.id)).toEqual([
      'created:host',
      'identity-bound:host',
      'activated:host',
      'role-changed:host',
      'disabled:host',
      'activated:host',
      'sessions-revoked:host'
    ])
  })

  it('re-enables a user without an identity as pending and refuses pointless changes', () => {
    bootstrapOwner()
    const cy = must(data.users.create({ displayName: 'Cy Example', role: 'researcher' }, 'host'))
    expect(data.users.setStatus(cy.id, 'active', 'host', cy.version)).toEqual({ ok: false, reason: 'invalid' })
    const disabled = must(data.users.setStatus(cy.id, 'disabled', 'host', cy.version))
    expect(data.users.setStatus(cy.id, 'disabled', 'host', disabled.version)).toEqual({ ok: false, reason: 'invalid' })
    expect(must(data.users.setStatus(cy.id, 'active', 'host', disabled.version)).status).toBe('pending')
    expect(data.users.setRole(cy.id, 'researcher', 'host', 99)).toEqual({ ok: false, reason: 'stale' })
    expect(data.users.setRole('n'.repeat(36), 'owner', 'host', 1)).toEqual({ ok: false, reason: 'not-found' })
    expect(data.users.revokeSessions('n'.repeat(36), 'host')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('keeps a disabled user disabled across closing and reopening', () => {
    bootstrapOwner()
    const ben = approveNew('sub-ben', 'Ben Example', 'researcher')
    must(data.users.setStatus(ben.id, 'disabled', 'host', ben.version))
    data.close()
    data = open()
    expect(data.users.get(ben.id)?.status).toBe('disabled')
    expect(data.users.resolveIdentity(claims('sub-ben'))).toEqual({ kind: 'disabled', userId: ben.id })
    expect(data.users.list()).toHaveLength(2)
  })
})

describe('what leaves the repository', () => {
  it('never carries the subject', () => {
    bootstrapOwner('sub-secret-value')
    data.users.recordSignInRequest(claims('sub-secret-queued'))
    const text = JSON.stringify([data.users.list(), data.users.listSignInRequests(), data.users.resolveIdentity(claims('sub-secret-value'))])
    expect(text).not.toContain('subject')
    expect(text).not.toContain('sub-secret-value"')
    expect(text).not.toContain('sub-secret-queued"')
  })
})
