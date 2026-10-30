import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData, inspectBackup } from '../../src/main/database/app-data'
import { CaseBriefRepository } from '../../src/main/database/case-brief-repository'
import { CaseJournalRepository } from '../../src/main/database/case-journal-repository'
import { CaseRepository } from '../../src/main/database/case-repository'
import { CaseTaskRepository } from '../../src/main/database/case-task-repository'
import { ClientRepository } from '../../src/main/database/client-repository'
import {
  APPLICATION_ID,
  configureConnection,
  dataDirectory,
  DATABASE_FILE_NAME,
  openAppDatabase
} from '../../src/main/database/connection'
import { getSchemaVersion, migrate, MigrationFailedError, migrations } from '../../src/main/database/migrations'
import { checkDateOnly, daysBetween, localDateString, type CaseInput } from '../../src/shared/case-model'
import {
  checkCaseTask,
  compareTasks,
  daysUntilDue,
  TASK_DESCRIPTION_MAX,
  TASK_TITLE_MAX,
  taskDueStatus,
  type CaseTask,
  type CaseTaskInput,
  type CaseTaskMutationResult
} from '../../src/shared/case-tasks'
import type { ClientInput } from '../../src/shared/client-model'

// Case tasks (#19): the shared rules, local-date handling, the SQLite repository,
// migration 6 on a real v5 profile and backups. Fictional data only.

const clientInput: ClientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: null,
  email: null,
  otherContact: null,
  preferredContactChannel: 'unspecified'
}

const caseInput: CaseInput = { title: 'Maternal grandparents', goal: 'Find Rosa’s parents.', orderReference: null, dueDate: null }
const START = new Date('2026-10-29T12:00:00.000Z')
const task: CaseTaskInput = { title: 'Request the 1931 register', description: 'Ask the municipal archive.', dueDate: '2026-11-05' }

function steppingClock() {
  let second = 0
  let n = 0
  return {
    now: () => new Date(START.getTime() + 1000 * second++),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  }
}

function saved(result: CaseTaskMutationResult): CaseTask {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.task
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  migrate(db)
  return db
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'tg-tasks-test-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('checkDateOnly and daysBetween', () => {
  it('accepts real calendar dates including leap days and rejects the rest', () => {
    for (const ok of ['2026-10-31', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01']) expect(checkDateOnly(ok)).toBeNull()
    for (const bad of ['2026-02-29', '2100-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32'])
      expect(checkDateOnly(bad)).toBe('invalid-date')
    for (const bad of ['10/31/2026', '2026-1-1', '2026-10-31T00:00', 'tomorrow', '26-10-31', '2026-10-31 '])
      expect(checkDateOnly(bad)).toBe('invalid-format')
  })

  it('counts whole calendar days across month, year and leap boundaries', () => {
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
    expect(daysBetween('2026-11-05', '2026-10-31')).toBe(-5)
    expect(daysBetween('2026-10-31', '2026-10-31')).toBe(0)
  })
})

describe('checkCaseTask', () => {
  it('trims, collapses spaces in the title, turns empty optional fields into null and converts CRLF', () => {
    const { input, issues } = checkCaseTask({ title: '  Ask   the\t archive  ', description: '  line one\r\nline two  ', dueDate: ' 2026-11-05 ' })
    expect(issues).toEqual([])
    expect(input).toEqual({ title: 'Ask the archive', description: 'line one\nline two', dueDate: '2026-11-05' })
    expect(checkCaseTask({ title: 'x', description: '   ', dueDate: '  ' }).input).toEqual({ title: 'x', description: null, dueDate: null })
    expect(checkCaseTask({ title: 'x', description: null, dueDate: null }).input).toEqual({ title: 'x', description: null, dueDate: null })
  })

  it('requires a title and limits lengths after trimming', () => {
    expect(TASK_TITLE_MAX).toBe(160)
    expect(TASK_DESCRIPTION_MAX).toBe(2000)
    for (const title of ['', '   ', '\n\t']) expect(checkCaseTask({ ...task, title }).issues).toEqual([{ field: 'title', code: 'required' }])
    expect(checkCaseTask({ ...task, title: ` ${'x'.repeat(160)} ` }).issues).toEqual([])
    expect(checkCaseTask({ ...task, title: 'x'.repeat(161) }).issues).toEqual([{ field: 'title', code: 'too-long' }])
    expect(checkCaseTask({ ...task, description: ` ${'x'.repeat(2000)} ` }).issues).toEqual([])
    expect(checkCaseTask({ ...task, description: 'x'.repeat(2001) }).issues).toEqual([{ field: 'description', code: 'too-long' }])
  })

  it('rejects control characters, keeping new lines and tabs in the description', () => {
    expect(checkCaseTask({ ...task, description: 'a\tb\nc' }).input?.description).toBe('a\tb\nc')
    expect(checkCaseTask({ ...task, title: 'bad\u0000' }).issues).toEqual([{ field: 'title', code: 'invalid-characters' }])
    expect(checkCaseTask({ ...task, description: 'bad\u001b' }).issues).toEqual([{ field: 'description', code: 'invalid-characters' }])
    expect(checkCaseTask({ ...task, description: 'lone\rreturn' }).issues).toEqual([{ field: 'description', code: 'invalid-characters' }])
  })

  it('validates the deadline as a real date, allows past dates, and never carries the submitted text', () => {
    expect(checkCaseTask({ ...task, dueDate: '2024-02-29' }).issues).toEqual([])
    expect(checkCaseTask({ ...task, dueDate: '2020-01-01' }).issues).toEqual([])
    expect(checkCaseTask({ ...task, dueDate: '2026-02-29' }).issues).toEqual([{ field: 'dueDate', code: 'invalid-date' }])
    expect(checkCaseTask({ ...task, dueDate: '31/10/2026' }).issues).toEqual([{ field: 'dueDate', code: 'invalid-format' }])
    const result = checkCaseTask({ title: '', description: 'x'.repeat(2001), dueDate: 'SECRET-DATE' })
    expect(result.input).toBeNull()
    expect(result.issues).toHaveLength(3)
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('keeps accents, quotes and markup-like text exactly as typed', () => {
    const odd = 'Revisar “Ejemplo” <b>año</b> & más 😀'
    expect(checkCaseTask({ ...task, title: odd, description: odd }).input).toMatchObject({ title: odd, description: odd })
  })
})

describe('taskDueStatus (local dates, no UTC)', () => {
  const pending = (dueDate: string | null) => ({ status: 'pending' as const, dueDate })

  it('classifies overdue, today, soon (next 3 days), later and none', () => {
    const today = '2026-10-31'
    expect(taskDueStatus(pending('2026-10-30'), today)).toBe('overdue')
    expect(taskDueStatus(pending('2026-10-31'), today)).toBe('due-today')
    expect(taskDueStatus(pending('2026-11-01'), today)).toBe('due-soon')
    expect(taskDueStatus(pending('2026-11-03'), today)).toBe('due-soon')
    expect(taskDueStatus(pending('2026-11-04'), today)).toBe('later')
    expect(taskDueStatus(pending(null), today)).toBe('none')
  })

  it('handles month, year and leap-year boundaries', () => {
    expect(taskDueStatus(pending('2027-01-01'), '2026-12-31')).toBe('due-soon')
    expect(taskDueStatus(pending('2026-12-31'), '2027-01-01')).toBe('overdue')
    expect(taskDueStatus(pending('2027-01-03'), '2026-12-31')).toBe('due-soon')
    expect(taskDueStatus(pending('2027-01-04'), '2026-12-31')).toBe('later')
    expect(taskDueStatus(pending('2024-02-29'), '2024-02-28')).toBe('due-soon')
    expect(taskDueStatus(pending('2026-03-01'), '2026-02-28')).toBe('due-soon')
    expect(taskDueStatus(pending('2026-03-03'), '2026-02-28')).toBe('due-soon')
    expect(taskDueStatus(pending('2026-03-04'), '2026-02-28')).toBe('later')
  })

  it('never reports completed tasks as urgent', () => {
    expect(taskDueStatus({ status: 'completed', dueDate: '2020-01-01' }, '2026-10-31')).toBe('none')
  })

  it('uses local today, so a due date equal to local today is due-today in any time zone', () => {
    // Local 23:30 on 31 Oct and local 00:30 on 31 Oct fall on different UTC days in
    // many zones; localDateString must still give 2026-10-31 for both.
    const lateEvening = new Date(2026, 9, 31, 23, 30)
    const justAfterMidnight = new Date(2026, 9, 31, 0, 30)
    for (const now of [lateEvening, justAfterMidnight]) {
      expect(localDateString(now)).toBe('2026-10-31')
      expect(taskDueStatus(pending('2026-10-31'), localDateString(now))).toBe('due-today')
    }
    expect(daysUntilDue({ dueDate: '2026-11-02' }, '2026-10-31')).toBe(2)
    expect(daysUntilDue({ dueDate: null }, '2026-10-31')).toBeNull()
  })
})

describe('compareTasks', () => {
  const make = (id: string, over: Partial<CaseTask>): CaseTask => ({
    id,
    caseId: 'c',
    title: id,
    description: null,
    status: 'pending',
    dueDate: null,
    completedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over
  })

  it('puts pending first, then earliest due date, undated last, then oldest, then id', () => {
    const list = [
      make('done', { status: 'completed', completedAt: 'x', dueDate: '2026-01-01' }),
      make('undated', {}),
      make('late', { dueDate: '2026-12-01' }),
      make('early', { dueDate: '2026-10-01' }),
      make('same-b', { dueDate: '2026-11-01', createdAt: '2026-10-02T00:00:00.000Z' }),
      make('same-a2', { dueDate: '2026-11-01', createdAt: '2026-10-01T00:00:00.000Z' }),
      make('same-a1', { dueDate: '2026-11-01', createdAt: '2026-10-01T00:00:00.000Z' })
    ]
    expect([...list].sort(compareTasks).map((t) => t.id)).toEqual(['early', 'same-a1', 'same-a2', 'same-b', 'late', 'undated', 'done'])
  })
})

describe('CaseTaskRepository', () => {
  let db: DatabaseSync
  let clients: ClientRepository
  let cases: CaseRepository
  let tasks: CaseTaskRepository
  let caseA: string
  let caseA2: string
  let caseB: string
  let clientA: string

  function newClient(name: string): string {
    const created = clients.create({ ...clientInput, displayName: name })
    if (!created.ok) throw new Error('fixture client invalid')
    return created.client.id
  }
  function newCase(clientId: string, title: string): string {
    const created = cases.create(clientId, { ...caseInput, title })
    if (!created.ok) throw new Error('fixture case invalid')
    return created.case.id
  }

  const caseRows = () => db.prepare('SELECT * FROM research_cases ORDER BY id').all()
  const eventRows = () => db.prepare('SELECT * FROM case_events ORDER BY rowid').all()
  const taskRows = () => db.prepare('SELECT * FROM case_tasks ORDER BY rowid').all()

  beforeEach(() => {
    db = memoryDb()
    const clock = steppingClock()
    clients = new ClientRepository(db, clock)
    cases = new CaseRepository(db, clock)
    tasks = new CaseTaskRepository(db, clock)
    clientA = newClient('Ana Ejemplo')
    const clientB = newClient('Ana Ejemplar')
    caseA = newCase(clientA, 'Case A')
    caseA2 = newCase(clientA, 'Case A2')
    caseB = newCase(clientB, 'Case B')
  })

  afterEach(() => db.close())

  it('lists nothing for a case without tasks and for an unknown case', () => {
    expect(tasks.list(caseA)).toEqual([])
    expect(tasks.list(crypto.randomUUID())).toEqual([])
  })

  it('creates a pending task, reads it back normalized, and stores nothing from other fields', () => {
    const created = saved(tasks.create(caseA, { title: '  Ask   the archive ', description: ' ', dueDate: '2026-11-05' }))
    expect(created).toMatchObject({ caseId: caseA, title: 'Ask the archive', description: null, status: 'pending', dueDate: '2026-11-05', completedAt: null })
    expect(created.createdAt).toBe(created.updatedAt)
    expect(tasks.list(caseA)).toEqual([created])
  })

  it('accepts a past deadline and no deadline', () => {
    saved(tasks.create(caseA, { ...task, dueDate: '2020-01-01' }))
    saved(tasks.create(caseA, { ...task, dueDate: null }))
    expect(tasks.list(caseA).map((t) => t.dueDate)).toEqual(['2020-01-01', null])
  })

  it('lists pending first by deadline (undated last), then completed, matching compareTasks', () => {
    const late = saved(tasks.create(caseA, { ...task, title: 'late', dueDate: '2026-12-01' }))
    const none = saved(tasks.create(caseA, { ...task, title: 'none', dueDate: null }))
    const early = saved(tasks.create(caseA, { ...task, title: 'early', dueDate: '2026-10-01' }))
    const done = saved(tasks.create(caseA, { ...task, title: 'done', dueDate: '2026-09-01' }))
    saved(tasks.complete(caseA, done.id))
    expect(tasks.list(caseA).map((t) => t.title)).toEqual(['early', 'late', 'none', 'done'])
    expect(tasks.list(caseA).map((t) => t.id)).toEqual([...tasks.list(caseA)].sort(compareTasks).map((t) => t.id))
    expect([late.id, none.id, early.id]).toHaveLength(3)
  })

  it('updates a pending or completed task in place, keeping id, case, status and created time', () => {
    const created = saved(tasks.create(caseA, task))
    const edited = saved(tasks.update(caseA, created.id, { title: 'New title', description: null, dueDate: null }))
    expect(edited).toMatchObject({ id: created.id, caseId: caseA, title: 'New title', description: null, dueDate: null, status: 'pending', createdAt: created.createdAt })
    expect(edited.updatedAt > created.updatedAt).toBe(true)

    const done = saved(tasks.complete(caseA, created.id))
    const editedDone = saved(tasks.update(caseA, created.id, { ...task, title: 'Edited after done' }))
    expect(editedDone).toMatchObject({ status: 'completed', completedAt: done.completedAt, title: 'Edited after done' })
  })

  it('completes and reopens, setting and clearing the completion time', () => {
    const created = saved(tasks.create(caseA, task))
    const done = saved(tasks.complete(caseA, created.id))
    expect(done.status).toBe('completed')
    expect(done.completedAt).toBe(done.updatedAt)
    const reopened = saved(tasks.reopen(caseA, created.id))
    expect(reopened).toMatchObject({ status: 'pending', completedAt: null })
    expect(reopened.createdAt).toBe(created.createdAt)
  })

  it('refuses a duplicate complete or reopen with wrong-status, changing nothing and not touching the case', () => {
    const created = saved(tasks.create(caseA, task))
    expect(tasks.reopen(caseA, created.id)).toEqual({ ok: false, reason: 'wrong-status' })
    saved(tasks.complete(caseA, created.id))
    const before = { tasks: taskRows(), cases: caseRows(), events: eventRows() }
    expect(tasks.complete(caseA, created.id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect({ tasks: taskRows(), cases: caseRows(), events: eventRows() }).toEqual(before)
    saved(tasks.reopen(caseA, created.id))
    const mid = { tasks: taskRows(), cases: caseRows() }
    expect(tasks.reopen(caseA, created.id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect({ tasks: taskRows(), cases: caseRows() }).toEqual(mid)
  })

  it('bumps the case’s updated time on every successful write, writes no case event and changes nothing else', () => {
    const before = cases.get(caseA)!
    const events = eventRows()
    const created = saved(tasks.create(caseA, task))
    expect(cases.get(caseA)!.updatedAt).toBe(created.updatedAt)
    expect({ ...cases.get(caseA)!, updatedAt: before.updatedAt }).toEqual(before)
    for (const act of [
      () => tasks.update(caseA, created.id, { ...task, title: 'again' }),
      () => tasks.complete(caseA, created.id),
      () => tasks.reopen(caseA, created.id)
    ]) {
      const result = saved(act())
      expect(cases.get(caseA)!.updatedAt).toBe(result.updatedAt)
    }
    expect(eventRows()).toEqual(events)
  })

  it('returns not-found for an unknown case and stores nothing', () => {
    const id = crypto.randomUUID()
    expect(tasks.create(id, task)).toEqual({ ok: false, reason: 'not-found' })
    expect(tasks.update(id, id, task)).toEqual({ ok: false, reason: 'not-found' })
    expect(tasks.complete(id, id)).toEqual({ ok: false, reason: 'not-found' })
    expect(tasks.reopen(id, id)).toEqual({ ok: false, reason: 'not-found' })
    expect(count(db, 'case_tasks')).toBe(0)
  })

  it('returns issue codes for invalid input, writes nothing and never echoes values', () => {
    const marker = 'SECRET-MARKER-19'
    const created = saved(tasks.create(caseA, task))
    const before = { rows: taskRows(), cases: caseRows() }
    const bad = { title: ' ', description: `${marker}\u0000`, dueDate: `${marker}` }
    for (const result of [tasks.create(caseA, bad), tasks.update(caseA, created.id, bad)]) {
      expect(result).toEqual({
        ok: false,
        reason: 'invalid',
        issues: [
          { field: 'title', code: 'required' },
          { field: 'description', code: 'invalid-characters' },
          { field: 'dueDate', code: 'invalid-format' }
        ]
      })
      expect(JSON.stringify(result)).not.toContain(marker)
    }
    expect({ rows: taskRows(), cases: caseRows() }).toEqual(before)
  })

  it('treats a task id from another case as not found and leaves both cases untouched', () => {
    const inB = saved(tasks.create(caseB, task))
    const inA = saved(tasks.create(caseA, task))
    const before = { rows: taskRows(), a: cases.get(caseA), a2: cases.get(caseA2), b: cases.get(caseB) }
    for (const [caseId, taskId] of [[caseA, inB.id], [caseA2, inA.id], [caseA, crypto.randomUUID()]] as const) {
      expect(tasks.update(caseId, taskId, task)).toEqual({ ok: false, reason: 'not-found' })
      expect(tasks.complete(caseId, taskId)).toEqual({ ok: false, reason: 'not-found' })
      expect(tasks.reopen(caseId, taskId)).toEqual({ ok: false, reason: 'not-found' })
    }
    expect({ rows: taskRows(), a: cases.get(caseA), a2: cases.get(caseA2), b: cases.get(caseB) }).toEqual(before)
  })

  it('checks in order: case, then archived, then task, then status, then input', () => {
    const created = saved(tasks.create(caseA, task))
    const bad = { title: '', description: null, dueDate: null }
    expect(tasks.update(crypto.randomUUID(), crypto.randomUUID(), bad)).toEqual({ ok: false, reason: 'not-found' })
    expect(tasks.update(caseA, crypto.randomUUID(), bad)).toEqual({ ok: false, reason: 'not-found' })
    expect(tasks.update(caseA, created.id, bad)).toMatchObject({ reason: 'invalid' })
    saved(tasks.complete(caseA, created.id))
    expect(tasks.complete(caseA, crypto.randomUUID())).toEqual({ ok: false, reason: 'not-found' })
    cases.archive(caseA)
    expect(tasks.update(caseA, crypto.randomUUID(), bad)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(tasks.complete(caseA, created.id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(tasks.create(caseA, bad)).toEqual({ ok: false, reason: 'wrong-status' })
  })

  it('refuses every write for an archived case or client, keeps tasks readable, and works again after restoring', () => {
    const created = saved(tasks.create(caseA, task))
    const other = saved(tasks.create(caseA2, task))
    cases.archive(caseA)
    clients.archive(clientA)
    const before = { rows: taskRows(), cases: caseRows(), events: eventRows() }
    for (const id of [caseA, caseA2]) {
      const taskId = id === caseA ? created.id : other.id
      expect(tasks.create(id, task)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(tasks.update(id, taskId, task)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(tasks.complete(id, taskId)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(tasks.reopen(id, taskId)).toEqual({ ok: false, reason: 'wrong-status' })
    }
    expect({ rows: taskRows(), cases: caseRows(), events: eventRows() }).toEqual(before)
    expect(tasks.list(caseA)).toEqual([created])
    clients.restore(clientA)
    expect(tasks.complete(caseA2, other.id).ok).toBe(true)
    cases.unarchive(caseA)
    expect(tasks.complete(caseA, created.id).ok).toBe(true)
  })

  it('keeps the tasks of different cases apart, including two cases of one client', () => {
    const a = saved(tasks.create(caseA, { ...task, title: 'in A' }))
    const a2 = saved(tasks.create(caseA2, { ...task, title: 'in A2' }))
    const b = saved(tasks.create(caseB, { ...task, title: 'in B' }))
    saved(tasks.complete(caseA, a.id))
    expect(tasks.list(caseA).map((t) => t.status)).toEqual(['completed'])
    expect(tasks.list(caseA2)).toEqual([a2])
    expect(tasks.list(caseB)).toEqual([b])
  })

  it('does not put task text in case, brief or journal records', () => {
    const marker = 'TASK-ONLY-TEXT'
    saved(tasks.create(caseA, { title: marker, description: marker, dueDate: null }))
    expect(JSON.stringify(cases.get(caseA))).not.toContain(marker)
    expect(JSON.stringify(new CaseBriefRepository(db).get(caseA))).not.toContain(marker)
    expect(JSON.stringify(new CaseJournalRepository(db).list(caseA))).not.toContain(marker)
  })

  it('rolls back the whole write when the case update fails', () => {
    const created = saved(tasks.create(caseA, task))
    db.exec(`CREATE TRIGGER fail_case_update BEFORE UPDATE ON research_cases BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    expect(() => tasks.create(caseA, task)).toThrow(/boom/)
    expect(() => tasks.complete(caseA, created.id)).toThrow(/boom/)
    expect(tasks.list(caseA)).toEqual([created])
    db.exec('DROP TRIGGER fail_case_update')
    expect(tasks.complete(caseA, created.id).ok).toBe(true)
  })

  describe('database guarantees', () => {
    const insert = (overrides: Record<string, string | null> = {}) => {
      const values = {
        id: crypto.randomUUID(),
        case_id: caseA,
        title: 'text',
        description: null,
        status: 'pending',
        due_date: null,
        completed_at: null,
        created_at: 'x',
        updated_at: 'x',
        ...overrides
      }
      const columns = Object.keys(values)
      db.prepare(`INSERT INTO case_tasks (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
        ...(Object.values(values) as (string | null)[])
      )
    }

    it('rejects an unknown case and a duplicate id', () => {
      expect(() => insert({ case_id: crypto.randomUUID() })).toThrow(/FOREIGN KEY/)
      const id = crypto.randomUUID()
      insert({ id })
      expect(() => insert({ id })).toThrow(/UNIQUE|PRIMARY/)
    })

    it('enforces column rules on its own', () => {
      expect(() => insert({ id: 'short' })).toThrow(/CHECK/)
      expect(() => insert({ title: '' })).toThrow(/CHECK/)
      expect(() => insert({ title: 'x'.repeat(161) })).toThrow(/CHECK/)
      expect(() => insert({ title: null })).toThrow(/NOT NULL/)
      expect(() => insert({ description: '' })).toThrow(/CHECK/)
      expect(() => insert({ description: 'x'.repeat(2001) })).toThrow(/CHECK/)
      expect(() => insert({ status: 'cancelled' })).toThrow(/CHECK/)
      expect(() => insert({ due_date: '31/10/2026' })).toThrow(/CHECK/)
      expect(() => insert({ due_date: '2026-10-3' })).toThrow(/CHECK/)
      insert({ title: 'x'.repeat(160), description: 'x'.repeat(2000), due_date: '2026-10-31' })
      expect(count(db, 'case_tasks')).toBe(1)
    })

    it('keeps completed_at consistent with status', () => {
      expect(() => insert({ status: 'completed', completed_at: null })).toThrow(/CHECK/)
      expect(() => insert({ status: 'pending', completed_at: 'x' })).toThrow(/CHECK/)
      insert({ status: 'completed', completed_at: 'x' })
      const created = saved(tasks.create(caseA, task))
      expect(() => db.prepare("UPDATE case_tasks SET status = 'completed' WHERE id = ?").run(created.id)).toThrow(/CHECK/)
      expect(() => db.prepare("UPDATE case_tasks SET completed_at = 'x' WHERE id = ?").run(created.id)).toThrow(/CHECK/)
    })

    it('never deletes tasks, and cases with tasks cannot be deleted', () => {
      const created = saved(tasks.create(caseA, task))
      expect(() => db.prepare('DELETE FROM case_tasks WHERE id = ?').run(created.id)).toThrow(/never deleted/)
      expect(() => db.prepare('DELETE FROM research_cases WHERE id = ?').run(caseA)).toThrow(/never deleted/)
      expect(tasks.list(caseA)).toEqual([created])
    })

    it('keeps a task’s id and case fixed', () => {
      const created = saved(tasks.create(caseA, task))
      expect(() => db.prepare('UPDATE case_tasks SET case_id = ? WHERE id = ?').run(caseB, created.id)).toThrow(/immutable/)
      expect(() => db.prepare('UPDATE case_tasks SET id = ? WHERE id = ?').run(crypto.randomUUID(), created.id)).toThrow(/immutable/)
      expect(tasks.list(caseA)).toEqual([created])
      expect(tasks.list(caseB)).toEqual([])
    })

    it('has the lookup index', () => {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'case_tasks'").all() as { name: string }[]).map((r) => r.name)
      expect(names).toContain('case_tasks_case_idx')
    })
  })
})

describe('persistence', () => {
  it('keeps tasks across closing and reopening, with order, status and the case’s updated time', () => {
    const first = new AppData(userData)
    const client = first.clients.create(clientInput)
    if (!client.ok) throw new Error('fixture client invalid')
    const created = first.cases.create(client.client.id, caseInput)
    if (!created.ok) throw new Error('fixture case invalid')
    const caseId = created.case.id
    saved(first.tasks.create(caseId, { ...task, title: 'later', dueDate: '2026-12-01' }))
    saved(first.tasks.create(caseId, { ...task, title: 'sooner', dueDate: '2026-11-01' }))
    const done = saved(first.tasks.create(caseId, { ...task, title: 'done', dueDate: null }))
    saved(first.tasks.complete(caseId, done.id))
    const listed = first.tasks.list(caseId)
    const caseAfter = first.cases.get(caseId)
    first.close()

    const second = new AppData(userData)
    try {
      expect(second.tasks.list(caseId)).toEqual(listed)
      expect(listed.map((t) => t.title)).toEqual(['sooner', 'later', 'done'])
      expect(second.cases.get(caseId)).toEqual(caseAfter)
    } finally {
      second.close()
    }
  })
})

describe('migration 6 (case_tasks)', () => {
  const v5 = migrations.slice(0, 5)

  function buildV5Profile(): string {
    const dir = dataDirectory(userData)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, DATABASE_FILE_NAME)
    const db = new DatabaseSync(file)
    configureConnection(db)
    migrate(db, {}, v5)
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    const clients = new ClientRepository(db)
    const cases = new CaseRepository(db)
    const archived = clients.create({ ...clientInput, displayName: 'Archived Client' })
    const active = clients.create({ ...clientInput, displayName: 'Active Client' })
    if (!archived.ok || !active.ok) throw new Error('fixture client invalid')
    const one = cases.create(active.client.id, caseInput)
    const two = cases.create(archived.client.id, { ...caseInput, title: 'Second case' })
    if (!one.ok || !two.ok) throw new Error('fixture case invalid')
    cases.setState(one.case.id, 'active')
    new CaseBriefRepository(db).save(one.case.id, { objective: 'Find Rosa.', facts: null, people: null, hypotheses: null, questions: null })
    new CaseJournalRepository(db).create(one.case.id, { occurredAt: '2026-10-20T15:30:00.000Z', activity: 'Archive search', body: 'Looked at the index.' })
    cases.archive(two.case.id)
    clients.archive(archived.client.id)
    expect(getSchemaVersion(db)).toBe(5)
    db.close()
    return file
  }

  const dump = (db: DatabaseSync) => ({
    clients: db.prepare('SELECT * FROM clients ORDER BY id').all(),
    notes: db.prepare('SELECT * FROM client_notes ORDER BY id').all(),
    cases: db.prepare('SELECT * FROM research_cases ORDER BY id').all(),
    events: db.prepare('SELECT * FROM case_events ORDER BY rowid').all(),
    briefs: db.prepare('SELECT * FROM case_briefs ORDER BY case_id').all(),
    journal: db.prepare('SELECT * FROM case_journal_entries ORDER BY id').all()
  })

  it('upgrades a real v5 database: everything identical, no tasks, copy written first', () => {
    const file = buildV5Profile()
    const old = new DatabaseSync(file)
    const before = dump(old)
    old.close()
    expect(before.cases).toHaveLength(2)
    expect(before.briefs).toHaveLength(1)
    expect(before.journal).toHaveLength(1)

    const opened = openAppDatabase(userData, () => new Date('2026-10-29T12:00:00.000Z'))
    try {
      expect(opened.migration).toEqual({ from: 5, to: migrations.length })
      expect(migrations[5]?.name).toBe('case_tasks')
      expect(dump(opened.db)).toEqual(before)
      expect(count(opened.db, 'case_tasks')).toBe(0)
      expect(opened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect((opened.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')

      const repo = new CaseTaskRepository(opened.db)
      const rows = before.cases as { id: string; archived_at: string | null }[]
      expect(repo.create(rows.find((c) => !c.archived_at)!.id, task).ok).toBe(true)
      expect(repo.create(rows.find((c) => c.archived_at)!.id, task)).toEqual({ ok: false, reason: 'wrong-status' })
    } finally {
      opened.db.close()
    }

    const copies = readdirSync(join(dataDirectory(userData), 'pre-migration'))
    expect(copies).toEqual([`${DATABASE_FILE_NAME}.v5.2026-10-29T12-00-00-000Z.sqlite`])
    const copy = new DatabaseSync(join(dataDirectory(userData), 'pre-migration', copies[0]!), { readOnly: true })
    expect(getSchemaVersion(copy)).toBe(5)
    expect(dump(copy)).toEqual(before)
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%task%'").all()).toEqual([])
    copy.close()
  })

  it('leaves the database at v5 when migration 6 fails part-way', () => {
    const file = buildV5Profile()
    const db = new DatabaseSync(file)
    configureConnection(db)
    db.exec('CREATE TABLE case_tasks (in_the_way TEXT)')
    expect(() => migrate(db)).toThrow(MigrationFailedError)
    expect(getSchemaVersion(db)).toBe(5)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'case_tasks_%'").all()).toEqual([])
    db.close()
  })
})

describe('backup and restore with tasks', () => {
  let root: string
  let data: AppData

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-tasks-backup-'))
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

  function seedCase(title: string): string {
    let clientId = data.clients.list({ text: '', status: 'all', sources: [], sort: 'name' })[0]?.id
    if (!clientId) {
      const created = data.clients.create(clientInput)
      if (!created.ok) throw new Error('fixture client invalid')
      clientId = created.client.id
    }
    const created = data.cases.create(clientId, { ...caseInput, title })
    if (!created.ok) throw new Error('fixture case invalid')
    return created.case.id
  }

  it('keeps tasks through a backup round trip, replacing changes made since', () => {
    const kept = seedCase('Kept')
    const one = saved(data.tasks.create(kept, task))
    saved(data.tasks.create(kept, { ...task, title: 'second', dueDate: null }))
    saved(data.tasks.complete(kept, one.id))
    const listed = data.tasks.list(kept)
    const file = join(root, 'backup.tgbackup')
    expect(data.createBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })

    saved(data.tasks.reopen(kept, one.id))
    const later = seedCase('Later')
    saved(data.tasks.create(later, task))

    data.restoreBackup(file)
    expect(data.tasks.list(kept)).toEqual(listed)
    expect(data.tasks.list(later)).toEqual([])
    expect(count(data.db, 'case_tasks')).toBe(2)
    expect(data.tasks.create(kept, task).ok).toBe(true)
  })

  it('restores a v5 backup into the current schema, with cases and no tasks', () => {
    const file = join(root, 'old.tgbackup')
    const old = new DatabaseSync(file)
    configureConnection(old)
    migrate(old, {}, migrations.slice(0, 5))
    old.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    const client = new ClientRepository(old).create({ ...clientInput, displayName: 'Older Backup Client' })
    if (!client.ok) throw new Error('fixture client invalid')
    const oldCase = new CaseRepository(old).create(client.client.id, caseInput)
    if (!oldCase.ok) throw new Error('fixture case invalid')
    old.exec('PRAGMA journal_mode = DELETE')
    old.close()
    expect(inspectBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: 5 })

    const current = seedCase('Current case')
    saved(data.tasks.create(current, task))

    expect(data.restoreBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })
    expect(count(data.db, 'case_tasks')).toBe(0)
    expect(data.tasks.list(oldCase.case.id)).toEqual([])
    expect(data.tasks.create(oldCase.case.id, task).ok).toBe(true)
    expect(existsSync(join(dataDirectory(join(root, 'profile')), 'pre-restore'))).toBe(true)
  })
})
