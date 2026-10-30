import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData, BackupInvalidError, inspectBackup, RestoreFailedError } from '../../src/main/database/app-data'
import { CaseRepository } from '../../src/main/database/case-repository'
import { ClientRepository } from '../../src/main/database/client-repository'
import {
  APPLICATION_ID,
  configureConnection,
  dataDirectory,
  DATABASE_FILE_NAME,
  openAppDatabase
} from '../../src/main/database/connection'
import {
  DatabaseTooNewError,
  getSchemaVersion,
  migrate,
  MigrationFailedError,
  migrations
} from '../../src/main/database/migrations'
import { NoteRepository } from '../../src/main/database/note-repository'
import {
  canTransition,
  CASE_STATES,
  type CaseInput,
  type CaseMutationResult,
  type CaseQuery,
  type CaseState,
  type ResearchCase
} from '../../src/shared/case-model'
import type { ClientInput, DirectoryQuery, NoteInput } from '../../src/shared/client-model'

// Research cases through the real SQLite repositories, in memory and in
// temporary profile folders. Fictional data only.

const clientInput: ClientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: 'fictional_buyer_01',
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
}

const caseInput: CaseInput = {
  title: 'Maternal grandparents',
  goal: 'Find where my grandmother Rosa was born.\nAnd her parents’ names.',
  orderReference: 'FO-EXAMPLE-0042',
  dueDate: '2026-11-15'
}

const noteInput: NoteInput = {
  kind: 'note',
  occurredAt: '2026-10-20T10:00:00.000Z',
  channel: null,
  direction: null,
  body: 'Fictional research note.'
}

const everything: CaseQuery = { clientId: null, archived: 'all', states: [], text: '', sort: 'created' }
const START = new Date('2026-10-29T12:00:00.000Z')

/** A clock that moves one second per reading, so ordering and "updated" checks are deterministic. */
function steppingClock() {
  let second = 0
  return { now: () => new Date(START.getTime() + 1000 * second++), newId: () => crypto.randomUUID() }
}

function expectOk(result: CaseMutationResult): ResearchCase {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.case
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  migrate(db)
  return db
}

const rows = (db: DatabaseSync, sql: string, ...params: string[]) => db.prepare(sql).all(...params)
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'tg-cases-test-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('CaseRepository', () => {
  let db: DatabaseSync
  let clients: ClientRepository
  let cases: CaseRepository
  let clientA: string
  let clientB: string

  function newClient(name: string): string {
    const created = clients.create({ ...clientInput, displayName: name, fiverrUsername: null, preferredContactChannel: 'unspecified' })
    if (!created.ok) throw new Error('fixture client invalid')
    return created.client.id
  }

  /** A case of client A that is in `state`, reached along allowed transitions only. */
  function caseIn(state: CaseState): ResearchCase {
    const path: Record<CaseState, CaseState[]> = {
      intake: [],
      active: ['active'],
      waiting: ['waiting'],
      delivered: ['active', 'delivered'],
      closed: ['closed']
    }
    let current = expectOk(cases.create(clientA, caseInput))
    for (const step of path[state]) current = expectOk(cases.setState(current.id, step))
    expect(current.state).toBe(state)
    return current
  }

  const snapshot = () => ({
    cases: rows(db, 'SELECT * FROM research_cases ORDER BY id'),
    events: rows(db, 'SELECT * FROM case_events ORDER BY rowid')
  })

  beforeEach(() => {
    db = memoryDb()
    const clock = steppingClock()
    clients = new ClientRepository(db, clock)
    cases = new CaseRepository(db, clock)
    clientA = newClient('Ana Ejemplo')
    clientB = newClient('Bea Muestra')
  })

  describe('create, read and edit', () => {
    it('starts a case in intake with a created event, normalized and tied to its client', () => {
      const created = expectOk(
        cases.create(clientA, { title: '  Maternal   grandparents ', goal: ' Find Rosa.\r\nThanks ', orderReference: ' FO-EXAMPLE-0042 ', dueDate: '2028-02-29' })
      )
      expect(created).toMatchObject({
        clientId: clientA,
        title: 'Maternal grandparents',
        goal: 'Find Rosa.\nThanks',
        orderReference: 'FO-EXAMPLE-0042',
        dueDate: '2028-02-29',
        state: 'intake',
        archivedAt: null
      })
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(created.stateChangedAt).toBe(created.createdAt)
      expect(created.updatedAt).toBe(created.createdAt)
      expect(cases.get(created.id)).toEqual(created)
      expect(cases.listEvents(created.id)).toEqual([
        { id: expect.any(String), caseId: created.id, kind: 'created', fromState: null, toState: 'intake', occurredAt: created.createdAt }
      ])
    })

    it('stores optional fields as null', () => {
      const created = expectOk(cases.create(clientA, { title: 'Minimal', goal: '  ', orderReference: '', dueDate: null }))
      expect(created).toMatchObject({ goal: null, orderReference: null, dueDate: null })
    })

    it('returns null, nothing or not-found for unknown ids', () => {
      const unknown = crypto.randomUUID()
      expect(cases.get(unknown)).toBeNull()
      expect(cases.listEvents(unknown)).toEqual([])
      expect(cases.update(unknown, caseInput)).toEqual({ ok: false, reason: 'not-found' })
      expect(cases.setState(unknown, 'active')).toEqual({ ok: false, reason: 'not-found' })
      expect(cases.archive(unknown)).toEqual({ ok: false, reason: 'not-found' })
      expect(cases.unarchive(unknown)).toEqual({ ok: false, reason: 'not-found' })
    })

    it('refuses a case for an unknown client without storing anything', () => {
      expect(cases.create(crypto.randomUUID(), caseInput)).toEqual({ ok: false, reason: 'not-found' })
      expect(count(db, 'research_cases')).toBe(0)
      expect(count(db, 'case_events')).toBe(0)
    })

    it('returns issue codes for invalid input, stores nothing and never echoes values', () => {
      const marker = 'Fictional Secret Surname'
      const result = cases.create(clientA, { title: ' ', goal: marker.repeat(300), orderReference: marker, dueDate: '2026-02-29' })
      expect(result).toEqual({
        ok: false,
        reason: 'invalid',
        issues: [
          { field: 'title', code: 'required' },
          { field: 'goal', code: 'too-long' },
          { field: 'dueDate', code: 'invalid-date' }
        ]
      })
      expect(JSON.stringify(result)).not.toContain(marker)
      expect(count(db, 'research_cases')).toBe(0)
      expect(count(db, 'case_events')).toBe(0)
    })

    it('edits fields only: keeps id, client, state and creation time, moves updatedAt, writes no event', () => {
      const created = caseIn('active')
      const before = cases.listEvents(created.id)
      const updated = expectOk(cases.update(created.id, { title: 'Paternal line', goal: null, orderReference: null, dueDate: '2026-12-01' }))
      expect(updated).toMatchObject({
        id: created.id,
        clientId: clientA,
        title: 'Paternal line',
        goal: null,
        orderReference: null,
        dueDate: '2026-12-01',
        state: 'active',
        stateChangedAt: created.stateChangedAt,
        createdAt: created.createdAt
      })
      expect(updated.updatedAt > created.updatedAt).toBe(true)
      expect(cases.listEvents(created.id)).toEqual(before)
    })

    it('leaves the case untouched when an edit is invalid', () => {
      const created = expectOk(cases.create(clientA, caseInput))
      const before = snapshot()
      expect(cases.update(created.id, { ...caseInput, title: '', dueDate: 'next friday' })).toEqual({
        ok: false,
        reason: 'invalid',
        issues: [
          { field: 'title', code: 'required' },
          { field: 'dueDate', code: 'invalid-format' }
        ]
      })
      expect(snapshot()).toEqual(before)
    })

    it('lists with the shared filters and sorts, in a single client or across all', () => {
      const early = expectOk(cases.create(clientA, { ...caseInput, title: 'Zeta line', dueDate: '2026-11-30' }))
      const late = expectOk(cases.create(clientB, { ...caseInput, title: 'Alfa line', dueDate: '2026-11-01', orderReference: 'FO-EXAMPLE-0099' }))
      const undated = expectOk(cases.create(clientA, { ...caseInput, title: 'Mid line', dueDate: null }))
      expectOk(cases.setState(undated.id, 'active'))

      expect(cases.list({ ...everything, sort: 'due' }).map((c) => c.id)).toEqual([late.id, early.id, undated.id])
      expect(cases.list({ ...everything, sort: 'title' }).map((c) => c.title)).toEqual(['Alfa line', 'Mid line', 'Zeta line'])
      expect(cases.list({ ...everything, clientId: clientA, sort: 'title' }).map((c) => c.id)).toEqual([undated.id, early.id])
      expect(cases.list({ ...everything, states: ['active'] }).map((c) => c.id)).toEqual([undated.id])
      expect(cases.list({ ...everything, text: 'fo-example-0099' }).map((c) => c.id)).toEqual([late.id])
      expect(cases.list({ ...everything, sort: 'updated' })[0]!.id).toBe(undated.id)
    })
  })

  describe('state changes', () => {
    const pairs = CASE_STATES.flatMap((from) => CASE_STATES.map((to) => [from, to] as const))

    it.each(pairs)('%s -> %s', (from, to) => {
      const researchCase = caseIn(from)
      const eventsBefore = cases.listEvents(researchCase.id)
      const result = cases.setState(researchCase.id, to)

      if (canTransition(from, to)) {
        const changed = expectOk(result)
        expect(changed.state).toBe(to)
        expect(changed.stateChangedAt).toBe(changed.updatedAt)
        expect(changed.stateChangedAt > researchCase.stateChangedAt).toBe(true)
        expect(changed.createdAt).toBe(researchCase.createdAt)
        const events = cases.listEvents(researchCase.id)
        expect(events).toHaveLength(eventsBefore.length + 1)
        expect(events[0]).toMatchObject({ kind: 'state', fromState: from, toState: to, occurredAt: changed.stateChangedAt })
        expect(events.slice(1)).toEqual(eventsBefore)
      } else {
        expect(result).toEqual({ ok: false, reason: 'invalid-transition' })
        expect(cases.get(researchCase.id)).toEqual(researchCase)
        expect(cases.listEvents(researchCase.id)).toEqual(eventsBefore)
      }
    })

    it('refuses an unknown state without any change', () => {
      const created = caseIn('intake')
      const before = snapshot()
      expect(cases.setState(created.id, 'paused' as CaseState)).toEqual({ ok: false, reason: 'invalid-transition' })
      expect(snapshot()).toEqual(before)
    })

    it('lists the whole history newest first', () => {
      const created = caseIn('intake')
      for (const to of ['active', 'waiting', 'delivered', 'closed'] as const) expectOk(cases.setState(created.id, to))
      expectOk(cases.archive(created.id))
      expectOk(cases.unarchive(created.id))
      expect(cases.listEvents(created.id).map((e) => `${e.kind}:${e.fromState ?? '-'}>${e.toState ?? '-'}`)).toEqual([
        'unarchived:->-',
        'archived:->-',
        'state:delivered>closed',
        'state:waiting>delivered',
        'state:active>waiting',
        'state:intake>active',
        'created:->intake'
      ])
    })
  })

  describe('archive and unarchive', () => {
    it.each(CASE_STATES)('keeps the %s state through archive and unarchive, one event each', (state) => {
      const researchCase = caseIn(state)
      const eventsBefore = cases.listEvents(researchCase.id).length

      const archived = expectOk(cases.archive(researchCase.id))
      expect(archived).toMatchObject({ state, stateChangedAt: researchCase.stateChangedAt })
      expect(archived.archivedAt).not.toBeNull()
      expect(archived.updatedAt).toBe(archived.archivedAt)
      expect(cases.listEvents(researchCase.id)).toHaveLength(eventsBefore + 1)
      expect(cases.listEvents(researchCase.id)[0]).toMatchObject({ kind: 'archived', fromState: null, toState: null })

      const reopened = expectOk(cases.unarchive(researchCase.id))
      expect(reopened).toMatchObject({ state, stateChangedAt: researchCase.stateChangedAt, archivedAt: null })
      expect(reopened.updatedAt > archived.updatedAt).toBe(true)
      expect(cases.listEvents(researchCase.id)).toHaveLength(eventsBefore + 2)
      expect(cases.listEvents(researchCase.id)[0]).toMatchObject({ kind: 'unarchived' })
    })

    it('refuses to archive twice or to unarchive an open case, without events', () => {
      const researchCase = caseIn('active')
      expect(cases.unarchive(researchCase.id)).toEqual({ ok: false, reason: 'wrong-status' })
      expectOk(cases.archive(researchCase.id))
      const before = snapshot()
      expect(cases.archive(researchCase.id)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(snapshot()).toEqual(before)
    })

    it('refuses edits and state changes on an archived case, before looking at transition or input', () => {
      const researchCase = caseIn('active')
      expectOk(cases.archive(researchCase.id))
      const before = snapshot()
      expect(cases.update(researchCase.id, caseInput)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(cases.update(researchCase.id, { ...caseInput, title: '' })).toEqual({ ok: false, reason: 'wrong-status' })
      expect(cases.setState(researchCase.id, 'waiting')).toEqual({ ok: false, reason: 'wrong-status' })
      expect(cases.setState(researchCase.id, 'intake')).toEqual({ ok: false, reason: 'wrong-status' })
      expect(snapshot()).toEqual(before)
      expect(cases.list({ ...everything, archived: 'active' })).toEqual([])
      expect(cases.list({ ...everything, archived: 'archived' }).map((c) => c.id)).toEqual([researchCase.id])

      expectOk(cases.unarchive(researchCase.id))
      expect(cases.setState(researchCase.id, 'waiting').ok).toBe(true)
    })

    it('checks the transition before the input', () => {
      const closed = caseIn('closed')
      expect(cases.setState(closed.id, 'waiting')).toEqual({ ok: false, reason: 'invalid-transition' })
    })
  })

  describe('archived clients', () => {
    it('refuses a new case for an archived client, with nothing stored, even for invalid input', () => {
      expect(clients.archive(clientA).ok).toBe(true)
      expect(cases.create(clientA, caseInput)).toEqual({ ok: false, reason: 'client-archived' })
      expect(cases.create(clientA, { ...caseInput, title: '' })).toEqual({ ok: false, reason: 'client-archived' })
      expect(count(db, 'research_cases')).toBe(0)
      expect(count(db, 'case_events')).toBe(0)
    })

    it('makes every change to an existing case wrong-status, and works again after the client is restored', () => {
      const open = caseIn('active')
      const archivedCase = expectOk(cases.archive(caseIn('intake').id))
      expect(clients.archive(clientA).ok).toBe(true)
      const before = snapshot()

      expect(cases.update(open.id, caseInput)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(cases.update(open.id, { ...caseInput, title: '' })).toEqual({ ok: false, reason: 'wrong-status' })
      expect(cases.setState(open.id, 'waiting')).toEqual({ ok: false, reason: 'wrong-status' })
      expect(cases.setState(open.id, 'intake')).toEqual({ ok: false, reason: 'wrong-status' })
      expect(cases.archive(open.id)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(cases.unarchive(archivedCase.id)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(snapshot()).toEqual(before)

      // Reading stays possible.
      expect(cases.get(open.id)?.title).toBe(caseInput.title)
      expect(cases.list({ ...everything, clientId: clientA })).toHaveLength(2)

      expect(clients.restore(clientA).ok).toBe(true)
      expect(cases.update(open.id, { ...caseInput, title: 'Edited after restore' }).ok).toBe(true)
      expect(cases.setState(open.id, 'waiting').ok).toBe(true)
      expect(cases.unarchive(archivedCase.id).ok).toBe(true)
      expect(cases.create(clientA, caseInput).ok).toBe(true)
    })

    it('changes no case row and writes no event when its client is archived', () => {
      caseIn('waiting')
      caseIn('intake')
      const before = snapshot()
      expect(clients.archive(clientA).ok).toBe(true)
      expect(snapshot()).toEqual(before)
      expect(clients.restore(clientA).ok).toBe(true)
      expect(snapshot()).toEqual(before)
    })
  })

  describe('isolation between clients', () => {
    it('never lists, returns or reports events of one client’s case under another client', () => {
      const a = expectOk(cases.create(clientA, { ...caseInput, title: 'Case of A' }))
      const b = expectOk(cases.create(clientB, { ...caseInput, title: 'Case of B' }))
      expectOk(cases.setState(a.id, 'active'))

      expect(cases.list({ ...everything, clientId: clientA }).map((c) => c.id)).toEqual([a.id])
      expect(cases.list({ ...everything, clientId: clientB }).map((c) => c.id)).toEqual([b.id])
      expect(cases.list({ ...everything, clientId: crypto.randomUUID() })).toEqual([])
      expect(cases.get(a.id)?.clientId).toBe(clientA)
      expect(cases.get(b.id)?.clientId).toBe(clientB)

      expect(cases.listEvents(a.id).every((e) => e.caseId === a.id)).toBe(true)
      expect(cases.listEvents(a.id)).toHaveLength(2)
      expect(cases.listEvents(b.id)).toHaveLength(1)
      expect(cases.listEvents(b.id).map((e) => e.caseId)).toEqual([b.id])
    })

    it('keeps a changed case with its own client', () => {
      const a = expectOk(cases.create(clientA, caseInput))
      expectOk(cases.update(a.id, { ...caseInput, title: 'Edited' }))
      expectOk(cases.archive(a.id))
      expect(cases.get(a.id)?.clientId).toBe(clientA)
      expect(cases.list({ ...everything, clientId: clientB })).toEqual([])
    })
  })

  describe('atomicity', () => {
    it('leaves no case behind when its event cannot be written, and keeps working', () => {
      const first = expectOk(cases.create(clientA, caseInput))
      const existingEventId = cases.listEvents(first.id)[0]!.id
      // The case row gets a fresh id, then its created event reuses an existing event id.
      const ids = [crypto.randomUUID(), existingEventId]
      const clash = new CaseRepository(db, { now: () => START, newId: () => ids.shift()! })
      expect(() => clash.create(clientA, caseInput)).toThrow()
      expect(count(db, 'research_cases')).toBe(1)
      expect(count(db, 'case_events')).toBe(1)
      expect(cases.create(clientA, caseInput).ok).toBe(true)
    })

    it('rolls back the row change when the event insert fails', () => {
      const researchCase = caseIn('active')
      const existingEventId = cases.listEvents(researchCase.id)[0]!.id
      const clash = new CaseRepository(db, { now: () => new Date(START.getTime() + 999_000), newId: () => existingEventId })
      const before = snapshot()
      expect(() => clash.setState(researchCase.id, 'waiting')).toThrow()
      expect(() => clash.archive(researchCase.id)).toThrow()
      expect(snapshot()).toEqual(before)
      expect(cases.setState(researchCase.id, 'waiting').ok).toBe(true)
    })
  })

  describe('database guarantees', () => {
    function insertCase(overrides: Record<string, string | null> = {}) {
      const values = {
        id: crypto.randomUUID(),
        client_id: clientA,
        title: 'Direct insert',
        goal: null,
        order_reference: null,
        due_date: null,
        state: 'intake',
        state_changed_at: 'x',
        created_at: 'x',
        updated_at: 'x',
        archived_at: null,
        ...overrides
      }
      const columns = Object.keys(values)
      db.prepare(`INSERT INTO research_cases (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
        ...(Object.values(values) as (string | null)[])
      )
      return values.id
    }

    it('rejects a case for an unknown client, whatever the app does', () => {
      expect(() => insertCase({ client_id: crypto.randomUUID() })).toThrow(/FOREIGN KEY/)
      expect(insertCase()).toBeTruthy()
    })

    it('enforces column rules on its own', () => {
      expect(() => insertCase({ title: '' })).toThrow(/CHECK/)
      expect(() => insertCase({ title: 'x'.repeat(161) })).toThrow(/CHECK/)
      expect(() => insertCase({ goal: '' })).toThrow(/CHECK/)
      expect(() => insertCase({ goal: 'x'.repeat(4001) })).toThrow(/CHECK/)
      expect(() => insertCase({ order_reference: 'x'.repeat(101) })).toThrow(/CHECK/)
      expect(() => insertCase({ due_date: 'next friday' })).toThrow(/CHECK/)
      expect(() => insertCase({ state: 'paused' })).toThrow(/CHECK/)
      expect(() => insertCase({ id: 'short' })).toThrow(/CHECK/)
      expect(insertCase({ due_date: '2026-11-15', goal: 'x'.repeat(4000), title: 'x'.repeat(160) })).toBeTruthy()
    })

    it('never deletes cases or events', () => {
      const created = expectOk(cases.create(clientA, caseInput))
      expect(() => db.prepare('DELETE FROM research_cases WHERE id = ?').run(created.id)).toThrow(/never deleted/)
      expect(() => db.prepare('DELETE FROM research_cases').run()).toThrow(/never deleted/)
      expect(() => db.prepare('DELETE FROM case_events WHERE case_id = ?').run(created.id)).toThrow(/append-only/)
      expect(() => db.prepare('DELETE FROM clients WHERE id = ?').run(clientA)).toThrow(/never deleted/)
      expect(cases.get(created.id)).toEqual(created)
    })

    it('keeps case and client ids immutable', () => {
      const created = expectOk(cases.create(clientA, caseInput))
      expect(() => db.prepare('UPDATE research_cases SET id = ? WHERE id = ?').run(crypto.randomUUID(), created.id)).toThrow(/immutable/)
      expect(() => db.prepare('UPDATE research_cases SET client_id = ? WHERE id = ?').run(clientB, created.id)).toThrow(/immutable/)
      expect(cases.get(created.id)).toEqual(created)
    })

    it('keeps events append-only and consistent', () => {
      const created = expectOk(cases.create(clientA, caseInput))
      const event = cases.listEvents(created.id)[0]!
      expect(() => db.prepare("UPDATE case_events SET kind = 'archived' WHERE id = ?").run(event.id)).toThrow(/append-only/)
      expect(() => db.prepare('UPDATE case_events SET occurred_at = ? WHERE id = ?').run('y', event.id)).toThrow(/append-only/)

      const insertEvent = (kind: string, from: string | null, to: string | null, caseId = created.id) =>
        db
          .prepare('INSERT INTO case_events (id, case_id, kind, from_state, to_state, occurred_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(crypto.randomUUID(), caseId, kind, from, to, 'x')
      expect(() => insertEvent('state', null, 'active')).toThrow(/CHECK/)
      expect(() => insertEvent('state', 'intake', null)).toThrow(/CHECK/)
      expect(() => insertEvent('archived', 'intake', null)).toThrow(/CHECK/)
      expect(() => insertEvent('created', null, null)).toThrow(/CHECK/)
      expect(() => insertEvent('renamed', null, null)).toThrow(/CHECK/)
      expect(() => insertEvent('archived', null, null, crypto.randomUUID())).toThrow(/FOREIGN KEY/)
      expect(() => insertEvent('archived', null, null)).not.toThrow()
    })
  })
})

describe('persistence', () => {
  it('keeps cases, states, archive flags and events across closing and reopening', () => {
    let data = new AppData(userData)
    const client = data.clients.create(clientInput)
    if (!client.ok) throw new Error('fixture client invalid')
    const created = expectOk(data.cases.create(client.client.id, caseInput))
    expectOk(data.cases.setState(created.id, 'active'))
    expectOk(data.cases.setState(created.id, 'delivered'))
    const other = expectOk(data.cases.create(client.client.id, { ...caseInput, title: 'Archived order' }))
    expectOk(data.cases.archive(other.id))
    const casesBefore = data.cases.list(everything)
    const eventsBefore = data.cases.listEvents(created.id)
    data.close()

    data = new AppData(userData)
    try {
      expect(data.cases.list(everything)).toEqual(casesBefore)
      expect(data.cases.get(created.id)).toMatchObject({ state: 'delivered', archivedAt: null })
      expect(data.cases.get(other.id)?.archivedAt).not.toBeNull()
      expect(data.cases.listEvents(created.id)).toEqual(eventsBefore)
      expect(eventsBefore.map((e) => e.kind)).toEqual(['state', 'state', 'created'])
    } finally {
      data.close()
    }
  })
})

describe('migration 3 (research_cases)', () => {
  const v2 = migrations.slice(0, 2)

  /** A real profile database as the v2 app left it: migrations 1-2 only, with fictional clients, notes and an archived client. */
  function buildV2Profile(): string {
    const dir = dataDirectory(userData)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, DATABASE_FILE_NAME)
    const db = new DatabaseSync(file)
    configureConnection(db)
    migrate(db, {}, v2)
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    const clients = new ClientRepository(db)
    const notes = new NoteRepository(db)
    const ids = ['Ana Ejemplo', 'Bea Muestra', 'Carlos Ficticio'].map((displayName) => {
      const created = clients.create({ ...clientInput, displayName, fiverrUsername: null, preferredContactChannel: 'unspecified' })
      if (!created.ok) throw new Error('fixture client invalid')
      return created.client.id
    })
    notes.create(ids[0]!, noteInput)
    notes.create(ids[1]!, { ...noteInput, kind: 'contact', channel: 'email', direction: 'inbound', body: 'Fictional contact.' })
    clients.archive(ids[2]!)
    expect(getSchemaVersion(db)).toBe(2)
    db.close()
    return file
  }

  const dump = (db: DatabaseSync) => ({
    clients: db.prepare('SELECT * FROM clients ORDER BY id').all(),
    notes: db.prepare('SELECT * FROM client_notes ORDER BY id').all()
  })

  it('upgrades a real v2 database: clients and notes identical, no cases, no orphans, copy written first', () => {
    const file = buildV2Profile()
    const old = new DatabaseSync(file)
    const before = dump(old)
    old.close()
    expect(before.clients).toHaveLength(3)
    expect(before.notes).toHaveLength(3)

    const opened = openAppDatabase(userData, () => new Date('2026-10-29T12:00:00.000Z'))
    try {
      expect(opened.migration).toEqual({ from: 2, to: migrations.length })
      expect(getSchemaVersion(opened.db)).toBe(migrations.length)
      expect(dump(opened.db)).toEqual(before)
      expect(count(opened.db, 'research_cases')).toBe(0)
      expect(count(opened.db, 'case_events')).toBe(0)
      expect(opened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect((opened.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    } finally {
      opened.db.close()
    }

    const copies = readdirSync(join(dataDirectory(userData), 'pre-migration'))
    expect(copies).toEqual([`${DATABASE_FILE_NAME}.v2.2026-10-29T12-00-00-000Z.sqlite`])
    const copy = new DatabaseSync(join(dataDirectory(userData), 'pre-migration', copies[0]!), { readOnly: true })
    expect(getSchemaVersion(copy)).toBe(2)
    expect(dump(copy)).toEqual(before)
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%case%'").all()).toEqual([])
    copy.close()
  })

  it('lets the upgraded database take cases for its old clients', () => {
    buildV2Profile()
    const data = new AppData(userData)
    try {
      const [first] = data.clients.list({ text: 'Ana', status: 'all', sources: [], sort: 'name' })
      expect(expectOk(data.cases.create(first!.id, caseInput)).clientId).toBe(first!.id)
      const archived = data.clients.list({ text: 'Carlos', status: 'archived', sources: [], sort: 'name' })[0]!
      expect(data.cases.create(archived.id, caseInput)).toEqual({ ok: false, reason: 'client-archived' })
    } finally {
      data.close()
    }
  })

  it('leaves the database at v2 when migration 3 fails part-way', () => {
    const file = buildV2Profile()
    const db = new DatabaseSync(file)
    configureConnection(db)
    const before = dump(db)
    const broken = [...v2, { version: 3, name: 'research_cases', sql: `${migrations[2]!.sql}; SELECT * FROM missing_table;` }]

    expect(() => migrate(db, {}, broken)).toThrow(MigrationFailedError)
    expect(getSchemaVersion(db)).toBe(2)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%case%'").all()).toEqual([])
    expect(dump(db)).toEqual(before)
    // The same database still upgrades with the real migration afterwards.
    expect(migrate(db)).toEqual({ from: 2, to: migrations.length })
    db.close()
  })

  it('refuses a database from a newer app version without changing it', () => {
    const db = memoryDb()
    db.exec(`PRAGMA user_version = ${migrations.length + 1}`)
    expect(() => migrate(db)).toThrow(DatabaseTooNewError)
    expect(getSchemaVersion(db)).toBe(migrations.length + 1)
  })
})

describe('backup and restore with cases', () => {
  let root: string
  let data: AppData

  const everyoneClients: DirectoryQuery = { text: '', status: 'all', sources: [], sort: 'name' }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-cases-backup-'))
    data = new AppData(join(root, 'profile'), () => new Date('2026-10-29T12:00:00.000Z'))
  })

  afterEach(() => {
    try {
      data.close()
    } catch {
      // Already closed by the test.
    }
    rmSync(root, { recursive: true, force: true })
  })

  function seedCase(title = caseInput.title): ResearchCase {
    const existing = data.clients.list(everyoneClients)[0]
    let clientId = existing?.id
    if (!clientId) {
      const created = data.clients.create(clientInput)
      if (!created.ok) throw new Error('fixture client invalid')
      clientId = created.client.id
    }
    return expectOk(data.cases.create(clientId, { ...caseInput, title }))
  }

  it('keeps cases and events through a backup round trip', () => {
    const kept = seedCase('Kept case')
    expectOk(data.cases.setState(kept.id, 'active'))
    expectOk(data.cases.setState(kept.id, 'delivered'))
    const archived = seedCase('Archived kept case')
    expectOk(data.cases.archive(archived.id))
    const casesBefore = data.cases.list(everything)
    const eventsBefore = data.cases.listEvents(kept.id)

    const file = join(root, 'backup.tgbackup')
    expect(data.createBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })

    // Change the data, then restore the backup.
    seedCase('Added after backup')
    expectOk(data.cases.setState(kept.id, 'closed'))
    expect(data.cases.list(everything)).toHaveLength(3)

    expect(data.restoreBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })
    expect(data.cases.list(everything)).toEqual(casesBefore)
    expect(data.cases.listEvents(kept.id)).toEqual(eventsBefore)
    expect(data.cases.get(archived.id)?.archivedAt).not.toBeNull()
    // The restored repositories work.
    expect(expectOk(data.cases.setState(kept.id, 'closed')).state).toBe('closed')
  })

  it('restores a v2 backup into the current schema with zero cases, replacing current cases', () => {
    const file = join(root, 'old.tgbackup')
    const old = new DatabaseSync(file)
    configureConnection(old)
    migrate(old, {}, migrations.slice(0, 2))
    old.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    const oldClient = new ClientRepository(old).create({ ...clientInput, displayName: 'Older Backup Client' })
    if (!oldClient.ok) throw new Error('fixture client invalid')
    old.exec('PRAGMA journal_mode = DELETE')
    old.close()
    expect(inspectBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: 2 })

    seedCase('Current case')
    expect(data.cases.list(everything)).toHaveLength(1)

    expect(data.restoreBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })
    expect(data.cases.list(everything)).toEqual([])
    expect(count(data.db, 'case_events')).toBe(0)
    expect(data.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(expectOk(data.cases.create(oldClient.client.id, caseInput)).clientId).toBe(oldClient.client.id)
  })

  it('rejects a backup from a newer schema as too-new, changing nothing', () => {
    const kept = seedCase()
    const file = join(root, 'future.tgbackup')
    data.createBackup(file)
    const future = new DatabaseSync(file)
    future.exec(`PRAGMA user_version = ${migrations.length + 1}`)
    future.close()

    expect(() => inspectBackup(file)).toThrow(new BackupInvalidError('too-new'))
    expect(() => data.restoreBackup(file)).toThrow(new BackupInvalidError('too-new'))
    expect(data.cases.list(everything)).toEqual([kept])
    expect(existsSync(join(dataDirectory(join(root, 'profile')), 'pre-restore'))).toBe(false)
  })

  it('keeps the current cases when a restore is rolled back', () => {
    seedCase('Backup case')
    const file = join(root, 'backup.tgbackup')
    data.createBackup(file)
    const current = seedCase('Only in current data')
    expectOk(data.cases.setState(current.id, 'active'))
    const casesBefore = data.cases.list(everything)
    const eventsBefore = data.cases.listEvents(current.id)

    expect(() =>
      data.restoreBackup(file, {
        verify: () => {
          throw new Error('forced failure')
        }
      })
    ).toThrow(RestoreFailedError)
    expect(data.cases.list(everything)).toEqual(casesBefore)
    expect(data.cases.listEvents(current.id)).toEqual(eventsBefore)
    expect(expectOk(data.cases.setState(current.id, 'waiting')).state).toBe('waiting')
  })
})
