import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDataServices, type DataServices } from '../../src/main/data-services'
import { AppData } from '../../src/main/database/app-data'
import { ClientOwnershipError } from '../../src/main/database/client-repository'
import {
  accessibleCaseIds,
  accessibleClientIds,
  caseAccess,
  clientAccess,
  localScope,
  MISSING_ID,
  researchSchemaReady,
  ResearchUnavailableError,
  scopeCondition,
  SCOPE_ALL,
  SCOPE_NONE,
  userScope,
  type AccessLevel,
  type ResearchScope
} from '../../src/main/database/research-access'
import type { CaseInput, CaseQuery } from '../../src/shared/case-model'
import type { DirectoryQuery } from '../../src/shared/client-model'
import type { NoteContent } from '../../src/shared/note-content'
import type { AppUser } from '../../src/shared/users'
import { buildLegacyProfile, LEGACY, migrateLegacyProfileForTest } from './helpers/legacy-fixture'
import { MigrationRequiredError } from '../../src/main/database/schema-preflight'
import { activeUser, caseInput, clientInput, newCase, newClient, pendingUser } from './helpers/ownership-helpers'

// Research authorization at the repository and service level (#210): the access function, scoped
// lists, nested-id isolation and the timer rules. Real HTTP is in live-authorization.test.ts.
// Fictional people and records only, in temporary profiles.

// Each test seeds a profile and makes many requests or builds a world of people: allow for a loaded CI machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

let root: string
let data: AppData

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-research-access-'))
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
const services = () => createDataServices(() => data)
const scopeOf = (user: AppUser): ResearchScope => ({ kind: 'user', userId: user.id })
const as = (user: AppUser): DataServices => services().forScope(scopeOf(user))
const everyone: DirectoryQuery = { text: '', status: 'all', sources: [], sort: 'name' }
const allCases: CaseQuery = { clientId: null, archived: 'all', states: [], text: '', sort: 'created' }
const entry = { occurredAt: '2026-10-20T15:30:00.000Z', activity: 'Archive search', body: 'Looked through the parish index.' }
const task = { title: 'Request the register', description: null, dueDate: '2026-11-20' }
const timeEntry = { workDate: '2026-10-28', durationMinutes: 45, activityType: 'research' as const, note: null }
const brief = { objective: 'Find where Rosa was born.', facts: null, people: null, hypotheses: null, questions: null }
const noStop = { activityType: null, note: null, durationMinutesOverride: null }
const doc = (text: string): NoteContent => ({
  format: 'tg-note',
  version: 1,
  blocks: [{ id: 'b0000000-0000-4000-8000-000000000001', type: 'paragraph', indent: 0, content: [{ text }] }]
})

function must<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok, JSON.stringify(result)).toBe(true)
  return result as Extract<T, { ok: true }>
}

function grantClient(clientId: string, grantee: AppUser, owner: AppUser, permission: 'viewer' | 'editor'): void {
  const result = data.ownership.setClientGrant({ clientId, granteeUserId: grantee.id, permission, grantedBy: owner.id })
  expect(result.ok, JSON.stringify(result)).toBe(true)
}

function grantCase(caseId: string, grantee: AppUser, owner: AppUser, permission: 'viewer' | 'editor'): void {
  const result = data.ownership.setCaseGrant({ caseId, granteeUserId: grantee.id, permission, grantedBy: owner.id })
  expect(result.ok, JSON.stringify(result)).toBe(true)
}

function disable(user: AppUser): void {
  const current = data.users.get(user.id)!
  const result = data.users.setStatus(user.id, 'disabled', 'host', current.version)
  expect(result.ok, JSON.stringify(result)).toBe(true)
}

/** A profile with one legacy (unclaimed) client, then every kind of person and grant the rules distinguish. */
function world() {
  data = new AppData(profile())
  // Created while the profile has no users, exactly like pre-ownership data: no client_ownership row.
  const legacyClient = newClient(data, 'Legacy Client', null)
  const legacyCase = newCase(data, legacyClient, 'Legacy case')

  const admin = activeUser(data, 'sub-admin', 'Admin Fictional', 'owner')
  const ana = activeUser(data, 'sub-ana', 'Ana Fictional')
  const beto = activeUser(data, 'sub-beto', 'Beto Fictional')
  const vera = activeUser(data, 'sub-vera', 'Vera Fictional')
  const eli = activeUser(data, 'sub-eli', 'Eli Fictional')
  const cleo = activeUser(data, 'sub-cleo', 'Cleo Fictional')
  const cato = activeUser(data, 'sub-cato', 'Cato Fictional')
  const uma = activeUser(data, 'sub-uma', 'Uma Fictional')
  const dan = activeUser(data, 'sub-dan', 'Dan Fictional')

  const c1 = newClient(data, 'Client One', ana.id)
  const k1 = newCase(data, c1, 'Case One')
  const k2 = newCase(data, c1, 'Case Two')
  const c2 = newClient(data, 'Client Two', beto.id)
  const k3 = newCase(data, c2, 'Case Three')

  grantClient(c1, vera, ana, 'viewer')
  grantClient(c1, eli, ana, 'editor')
  grantCase(k1, cleo, ana, 'viewer')
  grantCase(k1, cato, ana, 'editor')
  grantClient(c1, dan, ana, 'viewer')
  disable(dan)

  return { legacyClient, legacyCase, admin, ana, beto, vera, eli, cleo, cato, uma, dan, c1, k1, k2, c2, k3 }
}

describe('the effective access function', () => {
  it('gives exactly the right level to every kind of person on a client', () => {
    const w = world()
    const level = (user: AppUser, clientId = w.c1): AccessLevel => clientAccess(data.db, scopeOf(user), clientId)
    expect(level(w.ana)).toBe('write') // owner
    expect(level(w.vera)).toBe('read') // client viewer
    expect(level(w.eli)).toBe('write') // client editor
    expect(level(w.cleo)).toBe('none') // case viewer only: no client-level access
    expect(level(w.cato)).toBe('none') // case editor only: no client-level access
    expect(level(w.uma)).toBe('none') // unrelated
    expect(level(w.admin)).toBe('none') // app-level owner role is not research access
    expect(level(w.dan)).toBe('none') // disabled grantee
    expect(level(w.beto)).toBe('none') // owner of a different client
    expect(level(w.beto, w.c2)).toBe('write')
    expect(level(w.ana, w.c2)).toBe('none')
  })

  it('gives exactly the right level to every kind of person on a case', () => {
    const w = world()
    const level = (user: AppUser, caseId: string): AccessLevel => caseAccess(data.db, scopeOf(user), caseId)
    expect(level(w.ana, w.k1)).toBe('write')
    expect(level(w.vera, w.k1)).toBe('read')
    expect(level(w.vera, w.k2)).toBe('read') // a client grant covers every case of the client
    expect(level(w.eli, w.k2)).toBe('write')
    expect(level(w.cleo, w.k1)).toBe('read') // case viewer sees that case only
    expect(level(w.cleo, w.k2)).toBe('none')
    expect(level(w.cato, w.k1)).toBe('write')
    expect(level(w.cato, w.k2)).toBe('none')
    expect(level(w.uma, w.k1)).toBe('none')
    expect(level(w.admin, w.k1)).toBe('none')
    expect(level(w.dan, w.k1)).toBe('none')
    expect(level(w.ana, w.k3)).toBe('none')
  })

  it('takes the highest permission when a client viewer also holds a case editor grant', () => {
    const w = world()
    grantCase(w.k2, w.vera, w.ana, 'editor')
    expect(caseAccess(data.db, scopeOf(w.vera), w.k2)).toBe('write')
    expect(caseAccess(data.db, scopeOf(w.vera), w.k1)).toBe('read')
    // The case grant does not widen the client-level right.
    expect(clientAccess(data.db, scopeOf(w.vera), w.c1)).toBe('read')
  })

  it('seals unclaimed legacy records from every user, the app owner included', () => {
    const w = world()
    for (const user of [w.admin, w.ana, w.beto, w.vera, w.eli, w.cleo, w.cato, w.uma]) {
      expect(clientAccess(data.db, scopeOf(user), w.legacyClient)).toBe('none')
      expect(caseAccess(data.db, scopeOf(user), w.legacyCase)).toBe('none')
    }
    expect(clientAccess(data.db, SCOPE_ALL, w.legacyClient)).toBe('write')
    expect(clientAccess(data.db, SCOPE_NONE, w.legacyClient)).toBe('none')
  })

  it('stops a grant working when the record owner is disabled, and the owner too', () => {
    const w = world()
    const oscar = activeUser(data, 'sub-oscar', 'Oscar Fictional')
    const gwen = activeUser(data, 'sub-gwen', 'Gwen Fictional')
    const c3 = newClient(data, 'Client Three', oscar.id)
    const k4 = newCase(data, c3, 'Case Four')
    grantClient(c3, gwen, oscar, 'editor')
    expect(clientAccess(data.db, scopeOf(gwen), c3)).toBe('write')
    expect(caseAccess(data.db, scopeOf(gwen), k4)).toBe('write')
    disable(oscar)
    expect(clientAccess(data.db, scopeOf(gwen), c3)).toBe('none')
    expect(caseAccess(data.db, scopeOf(gwen), k4)).toBe('none')
    expect(clientAccess(data.db, scopeOf(oscar), c3)).toBe('none')
    expect(caseAccess(data.db, scopeOf(oscar), k4)).toBe('none')
    void w
  })

  it('never turns a role change into a grant, in either direction', () => {
    const w = world()
    const before = data.users.get(w.uma.id)!
    must(data.users.setRole(w.uma.id, 'owner', 'host', before.version))
    expect(clientAccess(data.db, scopeOf(w.uma), w.c1)).toBe('none')
    expect(caseAccess(data.db, scopeOf(w.uma), w.k1)).toBe('none')
    const promoted = data.users.get(w.uma.id)!
    must(data.users.setRole(w.uma.id, 'researcher', 'host', promoted.version))
    expect(clientAccess(data.db, scopeOf(w.ana), w.c1)).toBe('write')
    expect(data.ownership.listGrants({ clientId: w.c1 }).map((g) => g.granteeUserId)).not.toContain(w.uma.id)
  })

  it('keeps access for archived clients and cases (writes are refused by their status, not by access)', () => {
    const w = world()
    must(data.cases.archive(w.k2))
    must(data.clients.archive(w.c1))
    expect(clientAccess(data.db, scopeOf(w.ana), w.c1)).toBe('write')
    expect(clientAccess(data.db, scopeOf(w.vera), w.c1)).toBe('read')
    expect(caseAccess(data.db, scopeOf(w.cleo), w.k1)).toBe('read')
    expect(as(w.vera).clients.get(w.c1)).toMatchObject({ id: w.c1, status: 'archived' })
    expect(as(w.ana).clients.update(w.c1, clientInput('Renamed'))).toEqual({ ok: false, reason: 'wrong-status' })
    expect(as(w.eli).clients.update(w.c1, clientInput('Renamed'))).toEqual({ ok: false, reason: 'wrong-status' })
    expect(as(w.vera).clients.update(w.c1, clientInput('Renamed'))).toEqual({ ok: false, reason: 'not-found' })
    expect(as(w.uma).clients.get(w.c1)).toBeNull()
  })

  it('agrees between the SQL fragments used for lists and the id checks', () => {
    const w = world()
    for (const user of [w.admin, w.ana, w.beto, w.vera, w.eli, w.cleo, w.cato, w.uma, w.dan]) {
      for (const need of ['read', 'write'] as const) {
        const clientSql = accessibleClientIds(user.id, need)
        const fromSql = (data.db.prepare(clientSql.sql).all(...clientSql.params) as { client_id: string }[]).map((r) => r.client_id).sort()
        const fromChecks = [w.legacyClient, w.c1, w.c2].filter((id) => clientAccess(data.db, scopeOf(user), id) === 'write' || (need === 'read' && clientAccess(data.db, scopeOf(user), id) === 'read')).sort()
        expect(fromSql, `${user.displayName} clients ${need}`).toEqual(fromChecks)
        const caseSql = accessibleCaseIds(user.id, need)
        const casesFromSql = (data.db.prepare(caseSql.sql).all(...caseSql.params) as { id: string }[]).map((r) => r.id).sort()
        const casesFromChecks = [w.legacyCase, w.k1, w.k2, w.k3].filter((id) => caseAccess(data.db, scopeOf(user), id) === 'write' || (need === 'read' && caseAccess(data.db, scopeOf(user), id) === 'read')).sort()
        expect(casesFromSql, `${user.displayName} cases ${need}`).toEqual(casesFromChecks)
      }
    }
  })

  it('builds trivial conditions for the all and none scopes', () => {
    expect(scopeCondition(SCOPE_ALL, 'id', 'client')).toEqual({ sql: '1', params: [] })
    expect(scopeCondition(SCOPE_NONE, 'id', 'case')).toEqual({ sql: '0', params: [] })
  })
})

describe('scope resolution and a profile without users', () => {
  it('gives everything to the single operator of a profile with no users, and nothing once users exist', () => {
    data = new AppData(profile())
    const first = newClient(data, 'Solo Client', null)
    expect(localScope(data.db)).toEqual(SCOPE_ALL)
    expect(services().forLocalOperator().clients.get(first)).toMatchObject({ id: first })
    const user = activeUser(data, 'sub-ana', 'Ana Fictional')
    expect(localScope(data.db)).toEqual(SCOPE_NONE)
    const local = services().forLocalOperator()
    expect(local.clients.get(first)).toBeNull()
    expect(local.clients.list(everyone)).toEqual([])
    expect(local.cases.list(allCases)).toEqual([])
    expect(local.studio.summary().counts.activeClients).toBe(0)
    expect(userScope(data.db, user.id)).toEqual({ kind: 'user', userId: user.id })
  })

  it('refuses to create an ownerless client for the none scope and for a user acting as someone else', () => {
    const w = world()
    const refusal = (work: () => unknown): string => {
      try {
        work()
      } catch (error) {
        if (error instanceof ClientOwnershipError) return error.reason
        throw error
      }
      return 'created'
    }
    expect(refusal(() => services().forLocalOperator().clients.create(clientInput('Host Attempt'), { kind: 'unowned' }))).toBe('owner-required')
    expect(refusal(() => as(w.uma).clients.create(clientInput('Impersonated'), { kind: 'user', userId: w.ana.id, actor: w.ana.id }))).toBe('owner-required')
    expect(refusal(() => as(w.uma).clients.create(clientInput('Unowned'), { kind: 'unowned' }))).toBe('owner-required')
    // The none scope still reports invalid input as before, instead of an ownership error.
    expect(services().forLocalOperator().clients.create({ ...clientInput('x'), displayName: '' }, { kind: 'unowned' })).toMatchObject({ ok: false, reason: 'invalid' })
    const own = must(as(w.uma).clients.create(clientInput('Uma Client'), { kind: 'user', userId: w.uma.id, actor: w.uma.id }))
    expect(data.ownership.getClientOwner(own.client.id)).toMatchObject({ ownerUserId: w.uma.id })
  })

  it('fails closed on an incompatible schema: no scope can be resolved', () => {
    data = new AppData(profile())
    expect(researchSchemaReady(data.db)).toBe(true)
    data.db.exec('DROP TABLE case_grants; DROP TABLE client_grants; DROP TABLE ownership_events; DROP TABLE client_ownership;')
    expect(researchSchemaReady(data.db)).toBe(false)
    expect(() => localScope(data.db)).toThrow(ResearchUnavailableError)
    expect(() => userScope(data.db, 'any-user')).toThrow(ResearchUnavailableError)
  })

  it('reserves an id that no record can have', () => {
    const w = world()
    expect(MISSING_ID).toHaveLength(36)
    expect(data.clients.get(MISSING_ID)).toBeNull()
    expect(data.cases.get(MISSING_ID)).toBeNull()
    void w
  })
})

describe('scoped lists, duplicates and the studio summary', () => {
  it('lists only the clients a person may read', () => {
    const w = world()
    const names = (user: AppUser) => as(user).clients.list(everyone).map((c) => c.displayName)
    expect(names(w.ana)).toEqual(['Client One'])
    expect(names(w.beto)).toEqual(['Client Two'])
    expect(names(w.vera)).toEqual(['Client One'])
    expect(names(w.eli)).toEqual(['Client One'])
    expect(names(w.cleo)).toEqual([]) // a case grant is not a client grant
    expect(names(w.cato)).toEqual([])
    expect(names(w.uma)).toEqual([])
    expect(names(w.admin)).toEqual([])
    expect(names(w.dan)).toEqual([])
    expect(services().forScope(SCOPE_ALL).clients.list(everyone).map((c) => c.displayName).sort()).toEqual(['Client One', 'Client Two', 'Legacy Client'])
    expect(services().forScope(SCOPE_NONE).clients.list(everyone)).toEqual([])
  })

  it('filters text search to readable clients too', () => {
    const w = world()
    expect(as(w.beto).clients.list({ ...everyone, text: 'Client One' })).toEqual([])
    expect(as(w.ana).clients.list({ ...everyone, text: 'Client One' })).toHaveLength(1)
  })

  it('lists only the readable cases, including with a client filter', () => {
    const w = world()
    const titles = (user: AppUser, clientId: string | null = null) => as(user).cases.list({ ...allCases, clientId }).map((c) => c.title).sort()
    expect(titles(w.ana)).toEqual(['Case One', 'Case Two'])
    expect(titles(w.beto)).toEqual(['Case Three'])
    expect(titles(w.vera)).toEqual(['Case One', 'Case Two'])
    expect(titles(w.cleo)).toEqual(['Case One'])
    expect(titles(w.cato)).toEqual(['Case One'])
    expect(titles(w.uma)).toEqual([])
    expect(titles(w.admin)).toEqual([])
    expect(titles(w.ana, w.c1)).toEqual(['Case One', 'Case Two'])
    expect(titles(w.cleo, w.c1)).toEqual(['Case One'])
    expect(titles(w.uma, w.c1)).toEqual([])
    expect(titles(w.beto, w.c1)).toEqual([])
    expect(titles(w.ana, w.c2)).toEqual([])
    expect(as(w.ana).cases.list({ ...allCases, clientId: w.legacyClient })).toEqual([])
    expect(services().forScope(SCOPE_ALL).cases.list(allCases)).toHaveLength(4)
  })

  it('reports duplicates only among clients the caller may read', () => {
    const w = world()
    const probe = clientInput('Client One')
    expect(as(w.ana).clients.findDuplicates(probe, null).map((d) => d.client.id)).toEqual([w.c1])
    expect(as(w.vera).clients.findDuplicates(probe, null).map((d) => d.client.id)).toEqual([w.c1])
    expect(as(w.beto).clients.findDuplicates(probe, null)).toEqual([])
    expect(as(w.uma).clients.findDuplicates(probe, null)).toEqual([])
    expect(as(w.cleo).clients.findDuplicates(probe, null)).toEqual([])
    expect(as(w.admin).clients.findDuplicates(probe, null)).toEqual([])
    expect(as(w.uma).clients.findDuplicates(clientInput('Legacy Client'), null)).toEqual([])
    expect(services().forScope(SCOPE_ALL).clients.findDuplicates(clientInput('Legacy Client'), null)).toHaveLength(1)
  })

  it('scopes every figure and row of the studio summary', () => {
    const w = world()
    const ana = as(w.ana)
    const beto = as(w.beto)
    must(ana.tasks.create(w.k1, task))
    must(ana.journal.create(w.k1, entry))
    must(ana.time.create(w.k1, timeEntry))
    must(beto.tasks.create(w.k3, task))
    must(beto.journal.create(w.k3, entry))
    must(beto.time.create(w.k3, { ...timeEntry, durationMinutes: 60 }))

    const ids = (summary: ReturnType<DataServices['studio']['summary']>) => ({
      active: summary.activeCases.map((c) => c.caseId).sort(),
      tasks: summary.upcomingTasks.map((t) => t.caseId),
      activity: [...new Set(summary.recentActivity.map((a) => a.caseId))].sort(),
      continue: summary.continueCase?.caseId ?? null
    })
    const mine = ana.studio.summary()
    expect(mine.counts.activeClients).toBe(1)
    expect(mine.counts.openCases).toBe(2)
    expect(ids(mine).active).toEqual([w.k1, w.k2].sort())
    expect(ids(mine).tasks).toEqual([w.k1])
    expect(ids(mine).activity.every((id) => id === w.k1 || id === w.k2)).toBe(true)
    // Hours are summed over the caller's own entries only (45 minutes, in this week or month or neither).
    expect([0, 45]).toContain(mine.hours.monthMinutes)
    expect([0, 45]).toContain(mine.hours.weekMinutes)

    const theirs = beto.studio.summary()
    expect(theirs.counts.activeClients).toBe(1)
    expect(theirs.counts.openCases).toBe(1)
    expect(ids(theirs).active).toEqual([w.k3])
    expect(ids(theirs).tasks).toEqual([w.k3])

    const stranger = as(w.uma).studio.summary()
    expect(stranger.counts).toMatchObject({ activeClients: 0, openCases: 0, overdueTasks: 0, tasksDueSoon: 0 })
    expect(ids(stranger)).toEqual({ active: [], tasks: [], activity: [], continue: null })
    expect(stranger.hours).toEqual({ weekMinutes: 0, monthMinutes: 0 })
    expect(as(w.admin).studio.summary().activeCases).toEqual([])

    const everything = services().forScope(SCOPE_ALL).studio.summary()
    expect(everything.counts.activeClients).toBe(3)
    expect(services().forScope(SCOPE_NONE).studio.summary().activeCases).toEqual([])
  })

  it('shows a case-only grantee the case but no client name or client count', () => {
    const w = world()
    must(as(w.ana).tasks.create(w.k1, task))
    const summary = as(w.cleo).studio.summary()
    expect(summary.counts.activeClients).toBe(0)
    expect(summary.activeCases.map((c) => c.caseId)).toEqual([w.k1])
    expect(JSON.stringify(summary)).not.toContain('Client One')
    expect(summary.activeCases[0]!.clientDisplayName).toBe('Shared case')
    // A client viewer does see the name.
    expect(as(w.vera).studio.summary().activeCases[0]!.clientDisplayName).toBe('Client One')
  })
})

describe('reads and writes by id', () => {
  it('lets a viewer read everything under the client and change nothing', () => {
    const w = world()
    const ana = as(w.ana)
    const note = must(ana.notes.create(w.c1, { kind: 'note', occurredAt: '2026-10-20T10:00:00.000Z', channel: null, direction: null, body: 'A private note.' }))
    must(ana.briefs.save(w.k1, brief))
    const journal = must(ana.journal.create(w.k1, entry))
    const taskRow = must(ana.tasks.create(w.k1, task))
    const time = must(ana.time.create(w.k1, timeEntry))
    const section = must(ana.notebook.createSection(w.k1, { title: 'Visits' }))
    const page = must(ana.notebook.createPage(w.k1, section.section.id, { title: 'First' }))
    must(ana.notebook.savePage(w.k1, page.page.id, { baseVersion: 1, content: doc('Ana wrote this') }))

    const vera = as(w.vera)
    expect(vera.clients.get(w.c1)).toMatchObject({ id: w.c1 })
    expect(vera.notes.list(w.c1).some((n) => n.id === note.note.id)).toBe(true)
    expect(vera.cases.get(w.k1)).toMatchObject({ id: w.k1 })
    expect(vera.cases.listEvents(w.k1).length).toBeGreaterThan(0)
    expect(vera.briefs.get(w.k1)).toMatchObject({ objective: 'Find where Rosa was born.' })
    expect(vera.journal.list(w.k1).map((j) => j.id)).toEqual([journal.entry.id])
    expect(vera.tasks.list(w.k1).map((t) => t.id)).toEqual([taskRow.task.id])
    expect(vera.time.list(w.k1).map((t) => t.id)).toEqual([time.entry.id])
    expect(vera.notebook.getOutline(w.k1)?.sections).toHaveLength(1)
    expect(vera.notebook.getPage(w.k1, page.page.id)).toMatchObject({ id: page.page.id })
    expect(vera.notebook.listRevisions(w.k1, page.page.id).length).toBeGreaterThan(0)

    const missing = { ok: false, reason: 'not-found' }
    expect(vera.clients.update(w.c1, clientInput('Changed'))).toEqual(missing)
    expect(vera.clients.archive(w.c1)).toEqual(missing)
    expect(vera.notes.create(w.c1, { kind: 'note', occurredAt: '2026-10-20T10:00:00.000Z', channel: null, direction: null, body: 'x' })).toEqual(missing)
    expect(vera.cases.create(w.c1, caseInput('New'))).toEqual(missing)
    expect(vera.cases.update(w.k1, { ...caseInput('Changed') } as CaseInput)).toEqual(missing)
    expect(vera.cases.setState(w.k1, 'active')).toEqual(missing)
    expect(vera.briefs.save(w.k1, brief)).toEqual(missing)
    expect(vera.journal.create(w.k1, entry)).toEqual(missing)
    expect(vera.journal.update(w.k1, journal.entry.id, entry)).toEqual(missing)
    expect(vera.tasks.complete(w.k1, taskRow.task.id)).toEqual(missing)
    expect(vera.time.delete(w.k1, time.entry.id)).toEqual(missing)
    expect(vera.notebook.savePage(w.k1, page.page.id, { baseVersion: 2, content: doc('Vera wrote this') })).toEqual(missing)
    expect(vera.notebook.createSection(w.k1, { title: 'Nope' })).toEqual(missing)

    expect(ana.clients.get(w.c1)).toMatchObject({ displayName: 'Client One', status: 'active' })
    expect(ana.cases.get(w.k1)).toMatchObject({ title: 'Case One', state: 'intake' })
  })

  it('lets an editor write, leaves ownership unchanged and keeps the owner as the owner', () => {
    const w = world()
    const eli = as(w.eli)
    must(eli.clients.update(w.c1, clientInput('Client One Edited')))
    const made = must(eli.cases.create(w.c1, caseInput('Made by editor')))
    must(eli.journal.create(made.case.id, entry))
    must(eli.cases.setState(made.case.id, 'active'))
    expect(data.ownership.getClientOwner(w.c1)).toMatchObject({ ownerUserId: w.ana.id })
    expect(data.ownership.getCaseOwner(made.case.id)).toMatchObject({ ownerUserId: w.ana.id })
    expect(data.ownership.listGrants({ clientId: w.c1 }).map((g) => g.granteeUserId)).not.toContain(w.beto.id)
    expect(as(w.ana).cases.get(made.case.id)).toMatchObject({ title: 'Made by editor' })
  })

  it('lets a case viewer read only that case and a case editor write only there', () => {
    const w = world()
    const ana = as(w.ana)
    must(ana.journal.create(w.k1, entry))
    must(ana.journal.create(w.k2, entry))
    const cleo = as(w.cleo)
    expect(cleo.cases.get(w.k1)).toMatchObject({ id: w.k1 })
    expect(cleo.cases.get(w.k2)).toBeNull()
    expect(cleo.journal.list(w.k1)).toHaveLength(1)
    expect(cleo.journal.list(w.k2)).toEqual([])
    expect(cleo.clients.get(w.c1)).toBeNull()
    expect(cleo.notes.list(w.c1)).toEqual([])
    expect(cleo.journal.create(w.k1, entry)).toEqual({ ok: false, reason: 'not-found' })
    const cato = as(w.cato)
    must(cato.journal.create(w.k1, entry))
    expect(cato.journal.create(w.k2, entry)).toEqual({ ok: false, reason: 'not-found' })
    // Case-only grantees cannot create cases or touch the client.
    expect(cato.cases.create(w.c1, caseInput('Sneaky'))).toEqual({ ok: false, reason: 'not-found' })
    expect(cato.clients.update(w.c1, clientInput('Sneaky'))).toEqual({ ok: false, reason: 'not-found' })
    expect(cato.notes.create(w.c1, { kind: 'note', occurredAt: '2026-10-20T10:00:00.000Z', channel: null, direction: null, body: 'x' })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('answers a denied id exactly like an id that does not exist, for valid and invalid input', () => {
    const w = world()
    const fresh = '11111111-1111-4111-8111-111111111111'
    const probes = (svc: DataServices, id: string) => [
      svc.clients.get(id),
      svc.clients.update(id, clientInput('Changed')),
      svc.clients.update(id, { ...clientInput('x'), displayName: '' }),
      svc.clients.archive(id),
      svc.clients.restore(id),
      svc.notes.list(id),
      svc.cases.create(id, caseInput('New')),
      svc.cases.create(id, { ...caseInput('x'), title: '' }),
      svc.cases.get(id),
      svc.cases.listEvents(id),
      svc.cases.update(id, caseInput('Changed')),
      svc.cases.setState(id, 'active'),
      svc.cases.archive(id),
      svc.cases.unarchive(id),
      svc.briefs.get(id),
      svc.briefs.save(id, brief),
      svc.journal.list(id),
      svc.journal.create(id, entry),
      svc.journal.create(id, { ...entry, body: '' }),
      svc.tasks.list(id),
      svc.tasks.create(id, { ...task, title: '' }),
      svc.time.list(id),
      svc.time.create(id, { ...timeEntry, durationMinutes: 0 }),
      svc.notebook.getOutline(id),
      svc.notebook.createSection(id, { title: 'x' }),
      svc.notebook.getPage(id, fresh)
    ]
    // The reference answers come from the unscoped service asked about an id that really does not exist.
    const reference = probes(services().forScope(SCOPE_ALL), fresh)
    for (const [label, id] of [['client', w.c1], ['case', w.k1], ['legacy client', w.legacyClient], ['legacy case', w.legacyCase]] as const) {
      const denied = probes(as(w.uma), id)
      for (const [index, answer] of denied.entries()) expect(answer, `${label}, probe ${index}`).toEqual(reference[index])
      expect(JSON.stringify(denied), label).not.toContain(id)
    }
  })
})

describe('a pending or never-approved person (#255)', () => {
  it('reaches no client, case, list, search or summary row, and nothing by id', () => {
    const w = world()
    const pia = pendingUser(data, 'Pia Fictional')
    expect(pia.status).toBe('pending')
    // A sign-in request from a stranger is not an app_users row at all: it grants nothing either.
    const request = data.users.recordSignInRequest({ provider: 'google', subject: 'sub-stranger', email: 'stranger@example.test', emailVerified: true, emailAuthoritative: false, name: 'Stranger Fictional' })
    expect(request.ok).toBe(true)
    const nobody: ResearchScope = { kind: 'user', userId: '00000000-0000-4000-8000-000000000199' }

    for (const [label, scope] of [['pending', scopeOf(pia)], ['never approved', nobody]] as const) {
      for (const clientId of [w.c1, w.c2, w.legacyClient]) {
        expect(clientAccess(data.db, scope, clientId), `${label} client`).toBe('none')
      }
      for (const caseId of [w.k1, w.k2, w.k3, w.legacyCase]) {
        expect(caseAccess(data.db, scope, caseId), `${label} case`).toBe('none')
      }
      const own = services().forScope(scope)
      expect(own.clients.list(everyone), label).toEqual([])
      expect(own.clients.list({ ...everyone, text: 'Client' }), label).toEqual([])
      expect(own.clients.get(w.c1), label).toBeNull()
      expect(own.cases.list(allCases), label).toEqual([])
      expect(own.cases.get(w.k1), label).toBeNull()
      expect(own.studio.summary().counts.activeClients, label).toBe(0)
    }
  })
})

describe('a profile migrated from schema 9', () => {
  it('serves nothing from an unmigrated v9 profile: the open refuses before any research is read', () => {
    buildLegacyProfile(profile(), 9)
    expect(() => new AppData(profile())).toThrow(MigrationRequiredError)
  })

  it('seals every migrated client from every user and from the single-operator surfaces until it is reconciled', () => {
    buildLegacyProfile(profile(), 9)
    // Ownership tables and the authorization that reads them arrive together: the only way to
    // v10 is the operator's maintenance command, and this build refuses anything older.
    migrateLegacyProfileForTest(profile(), 9)
    data = new AppData(profile())
    const researcher = data.users.get(LEGACY.users.researcher)!
    const owner = data.users.get(LEGACY.users.owner)!
    expect(researcher.status).toBe('active')
    for (const user of [researcher, owner]) {
      const them = as(user)
      expect(them.clients.list(everyone)).toEqual([])
      expect(them.cases.list(allCases)).toEqual([])
      expect(them.clients.get(LEGACY.clients.ana)).toBeNull()
      expect(them.cases.get(LEGACY.cases.anaActive)).toBeNull()
      expect(them.notebook.getOutline(LEGACY.cases.anaActive)).toBeNull()
      expect(them.studio.summary().activeCases).toEqual([])
    }
    const local = services().forLocalOperator()
    expect(local.clients.list(everyone)).toEqual([])
    expect(local.clients.get(LEGACY.clients.ana)).toBeNull()
    expect(data.clients.list(everyone, SCOPE_ALL)).toHaveLength(3) // still there, just sealed
  })
})

describe('nested records cannot be reached through another case or client', () => {
  it('rejects a child of case K2 addressed through case K1, for a user who may use K1 only', () => {
    const w = world()
    const ana = as(w.ana)
    const j2 = must(ana.journal.create(w.k2, entry)).entry
    const t2 = must(ana.tasks.create(w.k2, task)).task
    const e2 = must(ana.time.create(w.k2, timeEntry)).entry
    const s2 = must(ana.notebook.createSection(w.k2, { title: 'Second case section' })).section
    const p2 = must(ana.notebook.createPage(w.k2, s2.id, { title: 'Second case page' })).page
    must(ana.notebook.savePage(w.k2, p2.id, { baseVersion: 1, content: doc('Private second case') }))
    const rev2 = ana.notebook.listRevisions(w.k2, p2.id)[0]!
    const s1 = must(ana.notebook.createSection(w.k1, { title: 'First case section' })).section
    const p1 = must(ana.notebook.createPage(w.k1, s1.id, { title: 'First case page' })).page

    const cato = as(w.cato) // case editor on K1 only
    const missing = { ok: false, reason: 'not-found' }
    expect(cato.journal.update(w.k1, j2.id, entry)).toEqual(missing)
    expect(cato.tasks.update(w.k1, t2.id, task)).toEqual(missing)
    expect(cato.tasks.complete(w.k1, t2.id)).toEqual(missing)
    expect(cato.time.update(w.k1, e2.id, timeEntry)).toEqual(missing)
    expect(cato.time.delete(w.k1, e2.id)).toEqual(missing)
    expect(cato.notebook.getPage(w.k1, p2.id)).toBeNull()
    expect(cato.notebook.listRevisions(w.k1, p2.id)).toEqual([])
    expect(cato.notebook.getRevision(w.k1, p2.id, rev2.id)).toBeNull()
    expect(cato.notebook.renamePage(w.k1, p2.id, { title: 'Stolen' })).toEqual(missing)
    expect(cato.notebook.savePage(w.k1, p2.id, { baseVersion: 2, content: doc('Overwritten') })).toEqual(missing)
    expect(cato.notebook.restoreRevision(w.k1, p2.id, rev2.id, 2)).toEqual(missing)
    expect(cato.notebook.archivePage(w.k1, p2.id)).toEqual(missing)
    expect(cato.notebook.renameSection(w.k1, s2.id, { title: 'Stolen' })).toEqual(missing)
    expect(cato.notebook.createPage(w.k1, s2.id, { title: 'Planted' })).toEqual(missing)
    expect(cato.notebook.movePage(w.k1, p1.id, { sectionId: s2.id, toIndex: 0 })).toEqual(missing)
    expect(cato.notebook.getOutline(w.k1)?.sections.map((s) => s.id)).toEqual([s1.id])
    expect(cato.journal.list(w.k1).map((j) => j.id)).not.toContain(j2.id)

    // Nothing of K2 changed.
    expect(ana.journal.list(w.k2)).toHaveLength(1)
    expect(ana.tasks.list(w.k2)[0]).toMatchObject({ id: t2.id, status: 'pending', title: task.title })
    expect(ana.time.list(w.k2)).toHaveLength(1)
    expect(ana.notebook.getPage(w.k2, p2.id)).toMatchObject({ title: 'Second case page', version: 2 })
    expect(ana.notebook.getOutline(w.k2)?.sections[0]?.pages.map((p) => p.id)).toEqual([p2.id])
  })

  it('rejects a note of another client addressed through a client the editor may write', () => {
    const w = world()
    const c4 = newClient(data, 'Client Four', w.ana.id)
    const ana = as(w.ana)
    const foreign = must(ana.notes.create(c4, { kind: 'note', occurredAt: '2026-10-20T10:00:00.000Z', channel: null, direction: null, body: 'Private to client four' })).note
    const eli = as(w.eli)
    expect(eli.notes.update(w.c1, foreign.id, { kind: 'note', occurredAt: '2026-10-20T10:00:00.000Z', channel: null, direction: null, body: 'Overwritten' })).toEqual({ ok: false, reason: 'not-found' })
    expect(eli.notes.list(w.c1).map((n) => n.id)).not.toContain(foreign.id)
    expect(ana.notes.list(c4).find((n) => n.id === foreign.id)?.body).toBe('Private to client four')
    expect(eli.notes.list(c4)).toEqual([])
  })
})

describe('the global timer', () => {
  it('shows a timer only to people who can read its case and lets only writers change it', () => {
    const w = world()
    const started = must(as(w.ana).time.start(w.k1))
    const version = started.timer!.version
    const watcher = [w.ana, w.vera, w.eli, w.cleo, w.cato]
    for (const user of watcher) expect(as(user).time.getActiveTimer(), user.displayName).toMatchObject({ caseId: w.k1 })
    for (const user of [w.uma, w.beto, w.admin, w.dan]) expect(as(user).time.getActiveTimer(), user.displayName).toBeNull()
    expect(services().forScope(SCOPE_NONE).time.getActiveTimer()).toBeNull()
    expect(services().forScope(SCOPE_ALL).time.getActiveTimer()).toMatchObject({ caseId: w.k1 })

    // Without write access every timer action looks like "no active timer", and changes nothing.
    const none = { ok: false, reason: 'not-found' }
    for (const user of [w.uma, w.beto, w.admin, w.vera, w.cleo]) {
      const them = as(user)
      expect(them.time.pause(version), user.displayName).toEqual(none)
      expect(them.time.resume(version)).toEqual(none)
      expect(them.time.heartbeat(version)).toEqual(none)
      expect(them.time.stopAndSave(version, noStop)).toEqual(none)
      expect(them.time.discard(version)).toEqual(none)
    }
    expect(as(w.ana).time.getActiveTimer()).toMatchObject({ caseId: w.k1, state: 'running', version })

    // A case editor can act on it.
    const paused = must(as(w.cato).time.pause(version))
    expect(paused.timer).toMatchObject({ state: 'paused' })
    must(as(w.eli).time.discard(paused.timer!.version))
    expect(as(w.ana).time.getActiveTimer()).toBeNull()
  })

  it('needs write access to start, and only says "busy" when a timer the caller cannot read exists', () => {
    const w = world()
    // No write access: the same answer as a case that does not exist.
    expect(as(w.vera).time.start(w.k1)).toEqual({ ok: false, reason: 'not-found' })
    expect(as(w.uma).time.start(w.k1)).toEqual({ ok: false, reason: 'not-found' })
    expect(as(w.uma).time.start('11111111-1111-4111-8111-111111111111')).toEqual({ ok: false, reason: 'not-found' })
    expect(as(w.ana).time.getActiveTimer()).toBeNull()

    must(as(w.ana).time.start(w.k1))
    // Beto cannot read Ana's timer: only "conflict" with no snapshot, and not a word about the case.
    const busy = as(w.beto).time.start(w.k3)
    expect(busy).toEqual({ ok: false, reason: 'conflict', timer: null })
    expect(JSON.stringify(busy)).not.toContain(w.k1)
    // Beto's start on Ana's case, or on an unknown one, is not-found whether or not a timer runs.
    expect(as(w.beto).time.start(w.k1)).toEqual({ ok: false, reason: 'not-found' })
    // Someone who can read the running timer gets the existing outcome with its snapshot.
    const other = as(w.eli).time.start(w.k2)
    expect(other).toMatchObject({ ok: false, reason: 'other-case-timer', timer: { caseId: w.k1 } })
    // The same case is returned unchanged for a writer.
    expect(as(w.cato).time.start(w.k1)).toMatchObject({ ok: true, timer: { caseId: w.k1, version: 1 } })
    expect(data.db.prepare('SELECT count(*) AS n FROM case_active_timer').get()).toEqual({ n: 1 })
  })
})

describe('repository scope parameters are required', () => {
  it('refuses to compile a call that omits the scope', () => {
    const w = world()
    const probe = (): void => {
      // @ts-expect-error scope is required: a missing scope must never mean everyone
      data.clients.list(everyone)
      // @ts-expect-error scope is required
      data.clients.findDuplicates(clientInput('Client One'), null)
      // @ts-expect-error scope is required
      data.cases.list(allCases)
      // @ts-expect-error scope is required
      data.studio.summary()
    }
    expect(typeof probe).toBe('function')
    expect(w.c1).toBeTruthy()
  })

  it('returns nothing for no scope and only the person\'s own rows for a user scope', () => {
    const w = world()
    const mine = scopeOf(w.ana)
    const candidate = clientInput('Client One')

    expect(data.clients.list(everyone, SCOPE_NONE)).toEqual([])
    expect(data.clients.list(everyone, mine).map((c) => c.displayName)).toEqual(['Client One'])
    expect(data.clients.findDuplicates(candidate, null, SCOPE_NONE)).toEqual([])
    expect(data.clients.findDuplicates(candidate, null, scopeOf(w.beto))).toEqual([])
    expect(data.clients.findDuplicates(candidate, null, mine).map((m) => m.client.displayName)).toEqual(['Client One'])

    expect(data.cases.list(allCases, SCOPE_NONE)).toEqual([])
    expect(data.cases.list(allCases, mine).map((c) => c.title).sort()).toEqual(['Case One', 'Case Two'])

    expect(data.studio.summary(SCOPE_NONE).activeCases).toEqual([])
    expect(data.studio.summary(mine).activeCases.length).toBe(2)
  })
})
