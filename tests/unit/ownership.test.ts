import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData } from '../../src/main/database/app-data'
import { ClientOwnershipError } from '../../src/main/database/client-repository'
import { configureConnection } from '../../src/main/database/connection'
import {
  claimConfirmationPhrase,
  MAX_UNCLAIMED_LIMIT,
  OwnershipRepository,
  type BackupEvidence,
  type ClaimPreview
} from '../../src/main/database/ownership-repository'
import { diffManifests, manifestOf, OWNERSHIP_TABLES } from './helpers/db-manifest'
import { buildLegacyProfile, fid, LEGACY } from './helpers/legacy-fixture'
import { activeUser, clientInput, disabledUser, newCase, newClient, pendingUser, UNOWNED } from './helpers/ownership-helpers'

// Ownership, grants and the host-only legacy claim (#209). Fictional people and records only,
// in temporary profiles. Nothing here enforces access (that is #210); it proves what is stored,
// what is refused, and that a claim is atomic, audited and never partial.

let root: string
let data: AppData

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-ownership-test-'))
})

afterEach(() => {
  try {
    data?.close()
  } catch {
    // Already closed.
  }
  rmSync(root, { recursive: true, force: true })
})

const profile = () => join(root, 'profile')
const count = (sql: string, ...params: string[]) => (data.db.prepare(sql).get(...params) as { n: number }).n
const NEW_TABLES = [...OWNERSHIP_TABLES]
const MISSING = fid(999_999)

function refusal(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    if (error instanceof ClientOwnershipError) return error.reason
    throw error
  }
  throw new Error('expected the create to be refused')
}

function tableCounts(): Record<string, number> {
  return Object.fromEntries(NEW_TABLES.map((t) => [t, count(`SELECT count(*) AS n FROM ${t}`)]))
}

describe('creating clients with ownership', () => {
  beforeEach(() => {
    data = new AppData(profile())
  })

  it('records the owner, origin and an audit event in the same step', () => {
    const user = activeUser(data, 'sub-ana', 'Ana Fictional')
    const id = newClient(data, 'Client One', user.id)
    expect(data.ownership.getClientOwner(id)).toMatchObject({ ownerUserId: user.id, origin: 'created' })
    expect(data.ownership.listEvents(id)).toEqual([
      expect.objectContaining({ action: 'owned-on-create', clientId: id, caseId: null, subjectUserId: user.id, permission: null, actor: user.id, detail: null })
    ])
  })

  it('lets the host choose an owner explicitly, recorded as a host action', () => {
    const user = activeUser(data, 'sub-ana', 'Ana Fictional')
    const created = data.clients.create(clientInput('Chosen By Host'), { kind: 'user', userId: user.id, actor: 'host' })
    if (!created.ok) throw new Error('not created')
    expect(count('SELECT count(*) AS n FROM client_ownership WHERE assigned_by = ?', 'host')).toBe(1)
    expect(data.ownership.listEvents(created.client.id)[0]).toMatchObject({ actor: 'host', subjectUserId: user.id })
  })

  it.each([
    ['a disabled user', () => disabledUser(data, 'sub-dis', 'Dani Fictional').id],
    ['a pending user', () => pendingUser(data, 'Pia Fictional').id],
    ['a user that does not exist', () => MISSING]
  ])('refuses %s as owner and writes nothing', (_label, owner) => {
    activeUser(data, 'sub-ok', 'Ok Fictional')
    const userId = owner()
    const before = tableCounts()
    const clients = count('SELECT count(*) AS n FROM clients')
    expect(refusal(() => data.clients.create(clientInput('Never Created'), { kind: 'user', userId, actor: userId }))).toBe('owner-unavailable')
    expect(count('SELECT count(*) AS n FROM clients')).toBe(clients)
    expect(tableCounts()).toEqual(before)
  })

  it('allows an unowned client only while the profile has no users, and keeps it unclaimed', () => {
    const id = newClient(data, 'Single Operator Client', null)
    expect(data.ownership.getClientOwner(id)).toBeNull()
    expect(data.ownership.listEvents(id)).toEqual([])
    expect(data.ownership.listUnclaimedClients().map((c) => c.id)).toEqual([id])
  })

  it.each([
    ['an active user', () => activeUser(data, 'sub-a', 'Ana Fictional')],
    ['a pending user', () => pendingUser(data, 'Pia Fictional')]
  ])('refuses an unowned client once there is %s, naming owner-required', (_label, addUser) => {
    addUser()
    expect(refusal(() => data.clients.create(clientInput('Unowned Attempt'), UNOWNED))).toBe('owner-required')
    expect(count('SELECT count(*) AS n FROM clients')).toBe(0)
    expect(tableCounts()).toEqual({ client_ownership: 0, client_grants: 0, case_grants: 0, ownership_events: 0 })
  })

  it('still validates input before touching ownership', () => {
    activeUser(data, 'sub-a', 'Ana Fictional')
    const result = data.clients.create({ ...clientInput('x'), displayName: '   ' }, UNOWNED)
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('rolls the client back when the ownership step fails', () => {
    const user = activeUser(data, 'sub-a', 'Ana Fictional')
    data.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON ownership_events BEGIN SELECT RAISE(ABORT, 'forced'); END")
    expect(() => data.clients.create(clientInput('Half Written'), { kind: 'user', userId: user.id, actor: user.id })).toThrow()
    expect(count('SELECT count(*) AS n FROM clients')).toBe(0)
    expect(count('SELECT count(*) AS n FROM client_ownership')).toBe(0)
  })

  it('gives a case no owner of its own: it is its client owner, before and after a claim', () => {
    const user = activeUser(data, 'sub-a', 'Ana Fictional')
    const clientId = newClient(data, 'Owned Client', user.id)
    const caseId = newCase(data, clientId, 'Derived case')
    expect(data.ownership.getCaseOwner(caseId)).toEqual(data.ownership.getClientOwner(clientId))
    expect(data.ownership.getCaseOwner(MISSING)).toBeNull()
    // No child-level owner column exists anywhere.
    for (const table of ['research_cases', 'case_notebooks', 'notebook_pages', 'case_journal_entries']) {
      const columns = (data.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
      expect(columns.filter((c) => c.includes('owner')), table).toEqual([])
    }
  })

  it('never gives the app-level owner role an ownership or grant', () => {
    const admin = activeUser(data, 'sub-admin', 'Olga Fictional', 'owner')
    const researcher = activeUser(data, 'sub-res', 'Rafa Fictional')
    const promoted = data.users.setRole(researcher.id, 'owner', 'host', researcher.version)
    expect(promoted.ok).toBe(true)
    newClient(data, 'Rafa Client', researcher.id)
    expect(data.ownership.listGrants({ clientId: MISSING })).toEqual([])
    expect(tableCounts()).toEqual({ client_ownership: 1, client_grants: 0, case_grants: 0, ownership_events: 1 })
    expect(count('SELECT count(*) AS n FROM client_ownership WHERE owner_user_id = ?', admin.id)).toBe(0)
  })
})

describe('grants', () => {
  let w: {
    legacyClient: string
    legacyCase: string
    owner: string
    admin: string
    grantee: string
    second: string
    disabled: string
    pending: string
    client: string
    caseId: string
  }

  beforeEach(() => {
    data = new AppData(profile())
    // Created before any user exists, so it stays unclaimed.
    const legacyClient = newClient(data, 'Legacy Client', null)
    const legacyCase = newCase(data, legacyClient, 'Legacy case')
    const admin = activeUser(data, 'sub-admin', 'Olga Fictional', 'owner')
    const owner = activeUser(data, 'sub-owner', 'Rafa Fictional')
    const grantee = activeUser(data, 'sub-grantee', 'Gaby Fictional')
    const second = activeUser(data, 'sub-second', 'Sol Fictional')
    const disabled = disabledUser(data, 'sub-dis', 'Dani Fictional')
    const pending = pendingUser(data, 'Pia Fictional')
    const client = newClient(data, 'Owned Client', owner.id)
    const caseId = newCase(data, client, 'Owned case')
    w = {
      legacyClient,
      legacyCase,
      owner: owner.id,
      admin: admin.id,
      grantee: grantee.id,
      second: second.id,
      disabled: disabled.id,
      pending: pending.id,
      client,
      caseId
    }
  })

  const events = (clientId: string) => data.ownership.listEvents(clientId).filter((e) => e.action !== 'owned-on-create')

  it('creates, changes and revokes a client grant with an audit trail', () => {
    const created = data.ownership.setClientGrant({ clientId: w.client, granteeUserId: w.grantee, permission: 'viewer', grantedBy: w.owner })
    expect(created).toMatchObject({ ok: true, change: 'created', grant: { granteeUserId: w.grantee, permission: 'viewer', grantedBy: w.owner } })

    const changed = data.ownership.setClientGrant({ clientId: w.client, granteeUserId: w.grantee, permission: 'editor', grantedBy: w.owner })
    expect(changed).toMatchObject({ ok: true, change: 'changed', grant: { permission: 'editor' } })
    // The same grantee twice is one row, not a duplicate.
    expect(data.ownership.listGrants({ clientId: w.client })).toHaveLength(1)

    const same = data.ownership.setClientGrant({ clientId: w.client, granteeUserId: w.grantee, permission: 'editor', grantedBy: w.owner })
    expect(same).toMatchObject({ ok: true, change: 'unchanged' })
    expect(events(w.client)).toHaveLength(2)

    expect(data.ownership.revokeClientGrant({ clientId: w.client, granteeUserId: w.grantee, revokedBy: w.owner })).toEqual({ ok: true, revoked: true })
    expect(data.ownership.listGrants({ clientId: w.client })).toEqual([])
    expect(data.ownership.revokeClientGrant({ clientId: w.client, granteeUserId: w.grantee, revokedBy: w.owner })).toEqual({ ok: true, revoked: false })

    expect(events(w.client).map((e) => [e.action, e.permission, e.caseId, e.subjectUserId, e.actor])).toEqual([
      ['grant-created', 'viewer', null, w.grantee, w.owner],
      ['grant-changed', 'editor', null, w.grantee, w.owner],
      ['grant-revoked', 'editor', null, w.grantee, w.owner]
    ])
    expect(events(w.client)[1]?.detail).toEqual({ previousPermission: 'viewer' })
  })

  it('creates, changes and revokes a case grant, keyed to the case', () => {
    expect(data.ownership.setCaseGrant({ caseId: w.caseId, granteeUserId: w.second, permission: 'editor', grantedBy: w.owner })).toMatchObject({ ok: true, change: 'created' })
    expect(data.ownership.setCaseGrant({ caseId: w.caseId, granteeUserId: w.second, permission: 'viewer', grantedBy: w.owner })).toMatchObject({ ok: true, change: 'changed' })
    expect(data.ownership.listGrants({ caseId: w.caseId })).toMatchObject([{ granteeUserId: w.second, permission: 'viewer' }])
    expect(data.ownership.listGrants({ clientId: w.client })).toEqual([])
    expect(data.ownership.revokeCaseGrant({ caseId: w.caseId, granteeUserId: w.second, revokedBy: w.owner })).toEqual({ ok: true, revoked: true })
    expect(data.ownership.listGrants({ caseId: w.caseId })).toEqual([])
    expect(events(w.client).map((e) => [e.action, e.caseId])).toEqual([
      ['grant-created', w.caseId],
      ['grant-changed', w.caseId],
      ['grant-revoked', w.caseId]
    ])
  })

  it('refuses grants on unclaimed, unknown or non-owned resources and writes nothing', () => {
    const before = tableCounts()
    const g = (clientId: string, grantedBy: string, granteeUserId = w.grantee) => data.ownership.setClientGrant({ clientId, granteeUserId, permission: 'viewer', grantedBy })
    const c = (caseId: string, grantedBy: string, granteeUserId = w.grantee) => data.ownership.setCaseGrant({ caseId, granteeUserId, permission: 'viewer', grantedBy })

    expect(g(w.legacyClient, w.owner)).toEqual({ ok: false, reason: 'unclaimed' })
    expect(c(w.legacyCase, w.owner)).toEqual({ ok: false, reason: 'unclaimed' })
    expect(g(MISSING, w.owner)).toEqual({ ok: false, reason: 'not-found' })
    expect(c(MISSING, w.owner)).toEqual({ ok: false, reason: 'not-found' })

    // Only the record owner grants: not another researcher, not the app-level owner, not an unknown id.
    for (const by of [w.grantee, w.admin, MISSING]) {
      expect(g(w.client, by), by).toEqual({ ok: false, reason: 'not-owner' })
      expect(c(w.caseId, by), by).toEqual({ ok: false, reason: 'not-owner' })
    }

    for (const bad of [w.disabled, w.pending, MISSING]) {
      expect(g(w.client, w.owner, bad), bad).toEqual({ ok: false, reason: 'invalid-grantee' })
      expect(c(w.caseId, w.owner, bad), bad).toEqual({ ok: false, reason: 'invalid-grantee' })
    }
    expect(g(w.client, w.owner, w.owner)).toEqual({ ok: false, reason: 'self-grant' })
    expect(c(w.caseId, w.owner, w.owner)).toEqual({ ok: false, reason: 'self-grant' })

    expect(tableCounts()).toEqual(before)
  })

  it('refuses revokes by anyone but the owner, on unclaimed or unknown resources', () => {
    data.ownership.setClientGrant({ clientId: w.client, granteeUserId: w.grantee, permission: 'viewer', grantedBy: w.owner })
    expect(data.ownership.revokeClientGrant({ clientId: w.client, granteeUserId: w.grantee, revokedBy: w.admin })).toEqual({ ok: false, reason: 'not-owner' })
    expect(data.ownership.revokeClientGrant({ clientId: w.legacyClient, granteeUserId: w.grantee, revokedBy: w.owner })).toEqual({ ok: false, reason: 'unclaimed' })
    expect(data.ownership.revokeCaseGrant({ caseId: w.legacyCase, granteeUserId: w.grantee, revokedBy: w.owner })).toEqual({ ok: false, reason: 'unclaimed' })
    expect(data.ownership.revokeClientGrant({ clientId: MISSING, granteeUserId: w.grantee, revokedBy: w.owner })).toEqual({ ok: false, reason: 'not-found' })
    expect(data.ownership.revokeCaseGrant({ caseId: MISSING, granteeUserId: w.grantee, revokedBy: w.owner })).toEqual({ ok: false, reason: 'not-found' })
    expect(data.ownership.listGrants({ clientId: w.client })).toHaveLength(1)
  })

  it('keeps a grant whose person is later disabled, refuses to change it, and still revokes it', () => {
    data.ownership.setClientGrant({ clientId: w.client, granteeUserId: w.grantee, permission: 'viewer', grantedBy: w.owner })
    const user = data.users.get(w.grantee)!
    expect(data.users.setStatus(w.grantee, 'disabled', 'host', user.version).ok).toBe(true)
    expect(data.ownership.setClientGrant({ clientId: w.client, granteeUserId: w.grantee, permission: 'editor', grantedBy: w.owner })).toEqual({ ok: false, reason: 'invalid-grantee' })
    expect(data.ownership.listGrants({ clientId: w.client })).toMatchObject([{ permission: 'viewer' }])
    expect(data.ownership.revokeClientGrant({ clientId: w.client, granteeUserId: w.grantee, revokedBy: w.owner })).toEqual({ ok: true, revoked: true })
  })
})

describe('database rules hold even when the repository is bypassed', () => {
  let ids: { owner: string; other: string; admin: string; disabled: string; client: string; caseId: string; unowned: string; unownedCase: string }

  beforeEach(() => {
    data = new AppData(profile())
    const unowned = newClient(data, 'Unclaimed Client', null)
    const unownedCase = newCase(data, unowned, 'Unclaimed case')
    const admin = activeUser(data, 'sub-admin', 'Olga Fictional', 'owner')
    const owner = activeUser(data, 'sub-owner', 'Rafa Fictional')
    const other = activeUser(data, 'sub-other', 'Gaby Fictional')
    const disabled = disabledUser(data, 'sub-dis', 'Dani Fictional')
    const client = newClient(data, 'Owned Client', owner.id)
    const caseId = newCase(data, client, 'Owned case')
    ids = { owner: owner.id, other: other.id, admin: admin.id, disabled: disabled.id, client, caseId, unowned, unownedCase }
  })

  const run = (sql: string, ...params: (string | null)[]) => data.db.prepare(sql).run(...params)
  const clientGrant = (client: string, grantee: string, by: string, permission = 'viewer') =>
    run('INSERT INTO client_grants (client_id, grantee_user_id, permission, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', client, grantee, permission, by, 'x', 'x')
  const caseGrant = (caseId: string, grantee: string, by: string, permission = 'viewer') =>
    run('INSERT INTO case_grants (case_id, grantee_user_id, permission, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', caseId, grantee, permission, by, 'x', 'x')

  it('rejects owners that are not active users and ownership that points nowhere', () => {
    const insert = (client: string, owner: string) =>
      run("INSERT INTO client_ownership (client_id, owner_user_id, origin, assigned_at, assigned_by) VALUES (?, ?, 'created', 'x', 'host')", client, owner)
    expect(() => insert(ids.unowned, ids.disabled)).toThrow(/active user/)
    expect(() => insert(ids.unowned, MISSING)).toThrow()
    expect(() => insert(MISSING, ids.owner)).toThrow()
    expect(() => run("INSERT INTO client_ownership (client_id, owner_user_id, origin, assigned_at, assigned_by) VALUES (?, ?, 'made-up', 'x', 'host')", ids.unowned, ids.owner)).toThrow()
    expect(() => run("INSERT INTO client_ownership (client_id, owner_user_id, origin, assigned_at, assigned_by) VALUES (?, ?, 'created', 'x', '')", ids.unowned, ids.owner)).toThrow()
    // A client has one owner row.
    expect(() => insert(ids.client, ids.other)).toThrow()
  })

  it('never updates or deletes ownership', () => {
    expect(() => run('UPDATE client_ownership SET owner_user_id = ? WHERE client_id = ?', ids.other, ids.client)).toThrow(/never changed/)
    expect(() => run('UPDATE client_ownership SET assigned_by = ? WHERE client_id = ?', 'host', ids.client)).toThrow(/never changed/)
    expect(() => run('DELETE FROM client_ownership WHERE client_id = ?', ids.client)).toThrow(/never deleted/)
    expect(data.ownership.getClientOwner(ids.client)?.ownerUserId).toBe(ids.owner)
  })

  it('accepts a valid client grant and rejects every invalid one', () => {
    expect(() => clientGrant(ids.client, ids.other, ids.owner, 'owner')).toThrow()
    expect(() => clientGrant(ids.unowned, ids.other, ids.owner)).toThrow(/owned client/)
    expect(() => clientGrant(ids.client, ids.other, ids.admin)).toThrow(/only the owner/)
    expect(() => clientGrant(ids.client, ids.other, ids.other)).toThrow(/only the owner/)
    expect(() => clientGrant(ids.client, ids.owner, ids.owner)).toThrow(/needs no grant/)
    expect(() => clientGrant(ids.client, ids.disabled, ids.owner)).toThrow(/active user/)
    expect(() => clientGrant(ids.client, MISSING, ids.owner)).toThrow()
    expect(() => clientGrant(MISSING, ids.other, ids.owner)).toThrow()
    expect(count('SELECT count(*) AS n FROM client_grants')).toBe(0)

    clientGrant(ids.client, ids.other, ids.owner)
    expect(() => clientGrant(ids.client, ids.other, ids.owner, 'editor')).toThrow() // primary key: no duplicate
    // Only the permission changes.
    run("UPDATE client_grants SET permission = 'editor', updated_at = 'y' WHERE client_id = ?", ids.client)
    expect(() => run('UPDATE client_grants SET grantee_user_id = ? WHERE client_id = ?', ids.admin, ids.client)).toThrow()
    expect(() => run('UPDATE client_grants SET granted_by = ? WHERE client_id = ?', ids.admin, ids.client)).toThrow()
    expect(() => run('UPDATE client_grants SET client_id = ? WHERE grantee_user_id = ?', ids.unowned, ids.other)).toThrow()
    expect(() => run("UPDATE client_grants SET permission = 'owner' WHERE client_id = ?", ids.client)).toThrow()
  })

  it('accepts a valid case grant and rejects every invalid one', () => {
    expect(() => caseGrant(ids.unownedCase, ids.other, ids.owner)).toThrow(/owned client/)
    expect(() => caseGrant(ids.caseId, ids.other, ids.admin)).toThrow(/only the owner/)
    expect(() => caseGrant(ids.caseId, ids.owner, ids.owner)).toThrow(/needs no grant/)
    expect(() => caseGrant(ids.caseId, ids.disabled, ids.owner)).toThrow(/active user/)
    expect(() => caseGrant(MISSING, ids.other, ids.owner)).toThrow()
    expect(count('SELECT count(*) AS n FROM case_grants')).toBe(0)

    caseGrant(ids.caseId, ids.other, ids.owner)
    expect(() => caseGrant(ids.caseId, ids.other, ids.owner, 'editor')).toThrow()
    run("UPDATE case_grants SET permission = 'editor', updated_at = 'y' WHERE case_id = ?", ids.caseId)
    expect(() => run('UPDATE case_grants SET granted_by = ? WHERE case_id = ?', ids.admin, ids.caseId)).toThrow()
    expect(() => run('UPDATE case_grants SET case_id = ? WHERE grantee_user_id = ?', ids.unownedCase, ids.other)).toThrow()
    // A grant row is a permission, not a research record, so it can be deleted.
    expect(run('DELETE FROM case_grants WHERE case_id = ?', ids.caseId).changes).toBe(1)
  })

  it('keeps the audit trail append-only and bounded', () => {
    const insert = (action: string, detail: string | null = null) =>
      run('INSERT INTO ownership_events (id, at, action, client_id, case_id, subject_user_id, permission, actor, detail) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)', randomUUID(), 'x', action, ids.client, ids.owner, 'host', detail)
    insert('grant-created', '{"ok":true}')
    expect(() => insert('something-else')).toThrow()
    expect(() => insert('grant-created', 'not json')).toThrow()
    expect(() => insert('grant-created', JSON.stringify({ pad: 'x'.repeat(4000) }))).toThrow()
    expect(() => run('INSERT INTO ownership_events (id, at, action, client_id, subject_user_id, actor) VALUES (?, ?, ?, ?, ?, ?)', 'short', 'x', 'grant-created', ids.client, ids.owner, 'host')).toThrow()
    expect(() => run('UPDATE ownership_events SET actor = ?', 'someone')).toThrow(/append-only/)
    expect(() => run('DELETE FROM ownership_events')).toThrow(/append-only/)
    expect(count('SELECT count(*) AS n FROM ownership_events WHERE action = ?', 'grant-created')).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Legacy claim, on a fictional v9 profile that this build migrates on open.

describe('legacy claim workflow', () => {
  const T = LEGACY
  let evidenceFile: string

  beforeEach(() => {
    buildLegacyProfile(profile(), 9)
    data = new AppData(profile())
    evidenceFile = join(root, 'evidence.tgbackup')
  })

  function preview(clientId: string, repo: OwnershipRepository = data.ownership): ClaimPreview {
    const result = repo.previewClaim(clientId)
    if (!result.ok) throw new Error(`preview refused: ${result.reason}`)
    return result.preview
  }

  function verified(p: ClaimPreview, file = evidenceFile, repo: OwnershipRepository = data.ownership): BackupEvidence {
    const result = repo.verifyClaimBackup(file, p)
    if (!result.ok) throw new Error(`backup refused: ${result.reason}`)
    return result.evidence
  }

  /** Takes the backup, previews, verifies: everything an operator does before the claim itself. */
  function prepare(clientId: string): { p: ClaimPreview; evidence: BackupEvidence } {
    data.createBackup(evidenceFile)
    const p = preview(clientId)
    return { p, evidence: verified(p) }
  }

  const claimFor = (clientId: string, target: string, p: ClaimPreview, evidence: BackupEvidence, repo: OwnershipRepository = data.ownership) =>
    repo.claimLegacyClient({ clientId, targetUserId: target, scopeToken: p.scopeToken, backup: evidence, confirmation: claimConfirmationPhrase(clientId, target), actor: 'host' })

  const addJournalEntry = (caseId: string, n: number) =>
    data.db
      .prepare('INSERT INTO case_journal_entries (id, case_id, occurred_at, activity, body, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .run(fid(n), caseId, '2026-09-05T10:00:00.000Z', 'Fictional late entry.', '2026-09-05T10:00:00.000Z', '2026-09-05T10:00:00.000Z')

  it('lists unclaimed clients in a bounded, stable order', () => {
    expect(data.ownership.listUnclaimedClients()).toEqual([
      { id: T.clients.ana, displayName: 'Ana Fictional', status: 'active', createdAt: '2026-09-01T10:00:00.000Z', caseCount: 2 },
      { id: T.clients.beto, displayName: 'Beto Fictional', status: 'active', createdAt: '2026-09-02T10:00:00.000Z', caseCount: 2 },
      { id: T.clients.carla, displayName: 'Carla Fictional', status: 'archived', createdAt: '2026-09-03T10:00:00.000Z', caseCount: 1 }
    ])
    expect(data.ownership.listUnclaimedClients({ limit: 2 }).map((c) => c.id)).toEqual([T.clients.ana, T.clients.beto])
    expect(data.ownership.listUnclaimedClients({ limit: 0 })).toHaveLength(1)
    expect(data.ownership.listUnclaimedClients({ limit: -5 })).toHaveLength(1)
    expect(data.ownership.listUnclaimedClients({ limit: 10 ** 9 })).toHaveLength(3)
    expect(MAX_UNCLAIMED_LIMIT).toBe(500)
  })

  it('previews the exact scope of a client tree, archived records included', () => {
    const p = preview(T.clients.ana)
    expect(p).toMatchObject({ clientId: T.clients.ana, clientStatus: 'active', existingGrantCount: 0 })
    expect(p.scopeToken).toMatch(/^[0-9a-f]{64}$/)
    expect(p.counts).toEqual({
      clientNotes: 2,
      researchCases: 2,
      caseEvents: 3,
      caseBriefs: 1,
      caseJournalEntries: 2,
      caseTasks: 2,
      caseTimeEntries: 2,
      caseActiveTimer: 1,
      caseNotebooks: 1,
      notebookSections: 2,
      notebookPages: 3,
      notebookPageRevisions: 3
    })
    expect(p.ids.researchCases).toEqual([T.cases.anaActive, T.cases.anaIntake].sort())
    expect(p.ids.notebookPages).toEqual([T.pages.anaMain, T.pages.anaArchived, T.pages.anaInArchivedSection].sort())
    expect(p.ids.notebookSections).toEqual([T.sections.anaNotes, T.sections.anaArchived].sort())
    expect(p.ids.caseActiveTimer).toEqual(['1'])
    for (const [key, list] of Object.entries(p.ids)) expect(list, key).toHaveLength(p.counts[key as keyof typeof p.counts])

    const beto = preview(T.clients.beto)
    expect(beto.ids.researchCases).toEqual([T.cases.betoDelivered, T.cases.betoArchived].sort())
    expect(beto.counts).toMatchObject({ caseEvents: 3, caseActiveTimer: 0, notebookPages: 1, notebookPageRevisions: 1 })
    expect(preview(T.clients.carla)).toMatchObject({ clientStatus: 'archived', counts: { researchCases: 1, caseEvents: 1, clientNotes: 1, notebookPages: 0 } })
    // The tokens differ per client.
    expect(new Set([p.scopeToken, beto.scopeToken]).size).toBe(2)

    expect(data.ownership.previewClaim(MISSING)).toEqual({ ok: false, reason: 'not-found' })
  })

  it('changes the scope token when a record is added to the tree', () => {
    const before = preview(T.clients.ana)
    addJournalEntry(T.cases.anaActive, 900)
    const after = preview(T.clients.ana)
    expect(after.counts.caseJournalEntries).toBe(3)
    expect(after.scopeToken).not.toBe(before.scopeToken)
    expect(preview(T.clients.beto).scopeToken).toBe(preview(T.clients.beto).scopeToken)
  })

  describe('verifying the backup', () => {
    it('accepts a fresh backup and returns evidence without a path', () => {
      const { p, evidence } = prepare(T.clients.ana)
      expect(evidence.sha256).toBe(createHash('sha256').update(readFileSync(evidenceFile)).digest('hex'))
      expect(evidence.bytes).toBe(statSync(evidenceFile).size)
      expect(evidence.schemaVersion).toBe(10)
      expect(evidence.scopeToken).toBe(p.scopeToken)
      expect(Object.keys(evidence).sort()).toEqual(['bytes', 'schemaVersion', 'scopeToken', 'sha256'])
    })

    it('rejects a file that is not a SQLite database, and a missing file', () => {
      const p = preview(T.clients.ana)
      const text = join(root, 'text.tgbackup')
      writeFileSync(text, 'definitely not a backup '.repeat(100))
      expect(data.ownership.verifyClaimBackup(text, p)).toEqual({ ok: false, reason: 'not-a-backup' })
      expect(data.ownership.verifyClaimBackup(join(root, 'nowhere.tgbackup'), p)).toEqual({ ok: false, reason: 'not-a-backup' })
    })

    it('rejects a damaged file and a backup from a newer schema', () => {
      const p = preview(T.clients.ana)
      data.createBackup(evidenceFile)
      const damaged = join(root, 'damaged.tgbackup')
      const bytes = readFileSync(evidenceFile)
      bytes.fill(0xff, 100, 8192)
      writeFileSync(damaged, bytes)
      expect(data.ownership.verifyClaimBackup(damaged, p)).toEqual({ ok: false, reason: 'damaged' })

      const newer = join(root, 'newer.tgbackup')
      writeFileSync(newer, readFileSync(evidenceFile))
      const db = new DatabaseSync(newer)
      db.exec('PRAGMA user_version = 11')
      db.close()
      expect(data.ownership.verifyClaimBackup(newer, p)).toEqual({ ok: false, reason: 'too-new' })
    })

    it('rejects a backup that does not contain the client', () => {
      const p = preview(T.clients.ana)
      const other = new AppData(join(root, 'other-profile'))
      newClient(other, 'Somebody Else Fictional', null)
      const file = join(root, 'other.tgbackup')
      other.createBackup(file)
      other.close()
      expect(data.ownership.verifyClaimBackup(file, p)).toEqual({ ok: false, reason: 'client-missing' })
    })

    it('rejects a backup taken before records were added to the tree', () => {
      data.createBackup(evidenceFile)
      addJournalEntry(T.cases.anaActive, 901)
      const p = preview(T.clients.ana)
      expect(data.ownership.verifyClaimBackup(evidenceFile, p)).toEqual({ ok: false, reason: 'scope-mismatch' })
      // A client whose tree did not change still verifies against the same backup.
      expect(data.ownership.verifyClaimBackup(evidenceFile, preview(T.clients.beto)).ok).toBe(true)
    })
  })

  describe('claiming', () => {
    const target = () => T.users.researcher

    it('refuses a wrong confirmation phrase and writes nothing', () => {
      const { p, evidence } = prepare(T.clients.ana)
      const before = manifestOf(data.db)
      for (const confirmation of [
        '',
        'yes',
        claimConfirmationPhrase(T.clients.ana, T.users.owner),
        claimConfirmationPhrase(T.clients.beto, target()),
        `${claimConfirmationPhrase(T.clients.ana, target())} `,
        claimConfirmationPhrase(T.clients.ana, target()).toUpperCase()
      ]) {
        const result = data.ownership.claimLegacyClient({ clientId: T.clients.ana, targetUserId: target(), scopeToken: p.scopeToken, backup: evidence, confirmation, actor: 'host' })
        expect(result, confirmation).toEqual({ ok: false, reason: 'confirmation-mismatch' })
      }
      expect(diffManifests(before, manifestOf(data.db))).toEqual([])
      expect(claimConfirmationPhrase('c', 'u')).toBe('claim client c for user u')
    })

    it.each([
      ['a disabled user', () => T.users.disabled],
      ['a pending user', () => T.users.pending],
      ['a user that does not exist', () => MISSING]
    ])('refuses %s as the target', (_label, who) => {
      const { p, evidence } = prepare(T.clients.ana)
      expect(claimFor(T.clients.ana, who(), p, evidence)).toEqual({ ok: false, reason: 'target-unavailable' })
      expect(data.ownership.getClientOwner(T.clients.ana)).toBeNull()
      expect(tableCounts()).toEqual({ client_ownership: 0, client_grants: 0, case_grants: 0, ownership_events: 0 })
    })

    it('refuses malformed evidence and a mismatching scope token', () => {
      const { p, evidence } = prepare(T.clients.ana)
      expect(claimFor(T.clients.ana, target(), p, { ...evidence, sha256: 'not-a-hash' })).toEqual({ ok: false, reason: 'invalid-input' })
      expect(claimFor(T.clients.ana, target(), p, { ...evidence, bytes: 0 })).toEqual({ ok: false, reason: 'invalid-input' })
      // The backup was verified for a different scope than the one being claimed.
      const betoToken = preview(T.clients.beto).scopeToken
      expect(claimFor(T.clients.ana, target(), p, { ...evidence, scopeToken: betoToken })).toEqual({ ok: false, reason: 'scope-changed' })
      expect(claimFor(T.clients.ana, target(), { ...p, scopeToken: betoToken }, evidence)).toEqual({ ok: false, reason: 'scope-changed' })
      expect(claimFor(MISSING, target(), p, evidence)).toEqual({ ok: false, reason: 'not-found' })
      expect(data.ownership.getClientOwner(T.clients.ana)).toBeNull()
    })

    it('refuses when the tree changed after the preview and backup', () => {
      const { p, evidence } = prepare(T.clients.ana)
      addJournalEntry(T.cases.anaIntake, 902)
      expect(claimFor(T.clients.ana, target(), p, evidence)).toEqual({ ok: false, reason: 'scope-changed' })
      expect(data.ownership.getClientOwner(T.clients.ana)).toBeNull()
      expect(count('SELECT count(*) AS n FROM ownership_events')).toBe(0)
    })

    it('claims the whole tree for the target, appends an audit event, and touches nothing else', () => {
      const { p, evidence } = prepare(T.clients.ana)
      const before = manifestOf(data.db)
      const result = claimFor(T.clients.ana, target(), p, evidence)
      expect(result).toMatchObject({ ok: true, owner: { ownerUserId: target(), origin: 'legacy-claim' } })

      // Only the new tables changed: every research record, user, identity and audit row is identical.
      const after = manifestOf(data.db)
      expect(diffManifests(before, after, NEW_TABLES)).toEqual([])
      expect(after.tables['client_ownership']?.rowCount).toBe(1)
      expect(after.tables['ownership_events']?.rowCount).toBe(1)
      expect(after.tables['client_grants']?.rowCount).toBe(0)
      expect(after.tables['case_grants']?.rowCount).toBe(0)

      expect(data.ownership.getClientOwner(T.clients.ana)).toMatchObject({ ownerUserId: target(), origin: 'legacy-claim' })
      // Every case of the claimed client derives that owner, archived ones included; other clients are untouched.
      for (const caseId of [T.cases.anaActive, T.cases.anaIntake]) expect(data.ownership.getCaseOwner(caseId)?.ownerUserId, caseId).toBe(target())
      for (const caseId of [T.cases.betoDelivered, T.cases.betoArchived, T.cases.carlaClosed]) expect(data.ownership.getCaseOwner(caseId), caseId).toBeNull()
      expect(data.ownership.getClientOwner(T.clients.beto)).toBeNull()
      expect(data.ownership.getClientOwner(T.clients.carla)).toBeNull()
      expect(data.ownership.listUnclaimedClients().map((c) => c.id)).toEqual([T.clients.beto, T.clients.carla])
      expect(preview(T.clients.beto).scopeToken).toBe(preview(T.clients.beto).scopeToken)

      // The audit event names the backup by hash and size, never by path or content.
      const events = data.ownership.listEvents(T.clients.ana)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        action: 'legacy-claimed',
        subjectUserId: target(),
        actor: 'host',
        caseId: null,
        detail: { backupSha256: evidence.sha256, backupBytes: evidence.bytes, schemaVersion: 10, scopeToken: p.scopeToken, counts: p.counts }
      })
      const serialized = JSON.stringify(events)
      expect(serialized).not.toContain(root)
      expect(serialized).not.toContain('tgbackup')
      expect(serialized).not.toContain('Fictional')

      // A case added later to the claimed client is owned by the same person.
      const later = newCase(data, T.clients.ana, 'Added after the claim')
      expect(data.ownership.getCaseOwner(later)?.ownerUserId).toBe(target())
    })

    it('rejects a second claim by the same or another user and keeps the first owner', () => {
      const { p, evidence } = prepare(T.clients.ana)
      expect(claimFor(T.clients.ana, target(), p, evidence).ok).toBe(true)
      expect(claimFor(T.clients.ana, target(), p, evidence)).toEqual({ ok: false, reason: 'already-claimed' })
      expect(claimFor(T.clients.ana, T.users.owner, p, evidence)).toEqual({ ok: false, reason: 'already-claimed' })
      expect(data.ownership.previewClaim(T.clients.ana)).toEqual({ ok: false, reason: 'already-claimed' })
      expect(data.ownership.getClientOwner(T.clients.ana)?.ownerUserId).toBe(target())
      expect(data.ownership.listEvents(T.clients.ana)).toHaveLength(1)
    })

    it('refuses to claim a client that was created with an owner', () => {
      const created = newClient(data, 'Created With Owner', T.users.owner)
      expect(data.ownership.previewClaim(created)).toEqual({ ok: false, reason: 'already-claimed' })
      expect(data.ownership.listUnclaimedClients().map((c) => c.id)).not.toContain(created)
    })

    it('succeeds on retry after a refused attempt', () => {
      const { p, evidence } = prepare(T.clients.beto)
      expect(claimFor(T.clients.beto, T.users.disabled, p, evidence).ok).toBe(false)
      expect(data.ownership.claimLegacyClient({ clientId: T.clients.beto, targetUserId: target(), scopeToken: p.scopeToken, backup: evidence, confirmation: 'oops', actor: 'host' }).ok).toBe(false)
      expect(claimFor(T.clients.beto, target(), p, evidence).ok).toBe(true)
      expect(data.ownership.getClientOwner(T.clients.beto)?.ownerUserId).toBe(target())
    })

    it('leaves no ownership and no partial state when the claim is interrupted', () => {
      const { p, evidence } = prepare(T.clients.ana)
      const before = manifestOf(data.db)
      data.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON ownership_events BEGIN SELECT RAISE(ABORT, 'forced'); END")
      expect(() => claimFor(T.clients.ana, target(), p, evidence)).toThrow()
      expect(data.ownership.getClientOwner(T.clients.ana)).toBeNull()
      expect(count('SELECT count(*) AS n FROM client_ownership')).toBe(0)
      data.db.exec('DROP TRIGGER fail_event')
      expect(diffManifests(before, manifestOf(data.db))).toEqual([])
      // And the claim works once the fault is gone.
      expect(claimFor(T.clients.ana, target(), p, evidence).ok).toBe(true)
    })

    it('lets exactly one of two competing connections claim the client', () => {
      const { p, evidence } = prepare(T.clients.ana)
      const second = new DatabaseSync(data.file)
      try {
        configureConnection(second)
        const otherRepo = new OwnershipRepository(second)
        // Both operators previewed and verified before either claimed.
        const otherPreview = preview(T.clients.ana, otherRepo)
        expect(otherPreview.scopeToken).toBe(p.scopeToken)

        const first = claimFor(T.clients.ana, T.users.researcher, p, evidence)
        const late = claimFor(T.clients.ana, T.users.owner, otherPreview, evidence, otherRepo)
        expect(first.ok).toBe(true)
        expect(late).toEqual({ ok: false, reason: 'already-claimed' })
        expect(count('SELECT count(*) AS n FROM client_ownership WHERE client_id = ?', T.clients.ana)).toBe(1)
        expect(data.ownership.getClientOwner(T.clients.ana)?.ownerUserId).toBe(T.users.researcher)

        // A claim cannot start while another connection holds the write lock, and changes nothing.
        const betoPreview = preview(T.clients.beto)
        const betoEvidence = verified(betoPreview)
        second.exec('PRAGMA busy_timeout = 0')
        data.db.exec('BEGIN IMMEDIATE')
        try {
          expect(() => claimFor(T.clients.beto, T.users.owner, betoPreview, betoEvidence, otherRepo)).toThrow()
        } finally {
          data.db.exec('ROLLBACK')
        }
        expect(data.ownership.getClientOwner(T.clients.beto)).toBeNull()
        expect(claimFor(T.clients.beto, T.users.owner, betoPreview, betoEvidence, otherRepo).ok).toBe(true)
        expect(count('SELECT count(*) AS n FROM client_ownership')).toBe(2)
      } finally {
        second.close()
      }
    })
  })
})
