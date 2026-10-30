import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData, inspectBackup } from '../../src/main/database/app-data'
import { CaseBriefRepository } from '../../src/main/database/case-brief-repository'
import { CaseRepository } from '../../src/main/database/case-repository'
import { ClientRepository } from '../../src/main/database/client-repository'
import {
  APPLICATION_ID,
  configureConnection,
  dataDirectory,
  DATABASE_FILE_NAME,
  openAppDatabase
} from '../../src/main/database/connection'
import { getSchemaVersion, migrate, MigrationFailedError, migrations } from '../../src/main/database/migrations'
import {
  BRIEF_FIELDS,
  BRIEF_LIMITS,
  briefIsEmpty,
  checkCaseBrief,
  emptyBrief,
  type CaseBriefInput,
  type CaseBriefMutationResult
} from '../../src/shared/case-brief'
import type { CaseInput } from '../../src/shared/case-model'
import type { ClientInput } from '../../src/shared/client-model'

// Case research briefs (#17): the shared rules, the SQLite repository, migration 4
// on a real v3 profile and backups. Fictional data only.

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

const brief: CaseBriefInput = {
  objective: 'Establish where Rosa was born.',
  facts: 'The client says she was born in 1931.\nNo document seen yet.',
  people: 'Rosa Ejemplo (grandmother).',
  hypotheses: 'She may have been born in Totonicapán.',
  questions: 'Which parish book covers 1931?'
}

const nothing: CaseBriefInput = { objective: null, facts: null, people: null, hypotheses: null, questions: null }

const START = new Date('2026-10-29T12:00:00.000Z')

/** A clock that moves one second per reading, so "updated" checks are deterministic. */
function steppingClock() {
  let second = 0
  return { now: () => new Date(START.getTime() + 1000 * second++), newId: () => crypto.randomUUID() }
}

function savedBrief(result: CaseBriefMutationResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.brief
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
  userData = mkdtempSync(join(tmpdir(), 'tg-brief-test-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('checkCaseBrief', () => {
  it('trims, turns empty sections into null and converts CRLF to LF', () => {
    const { input, issues } = checkCaseBrief({
      objective: '  A goal  ',
      facts: 'line one\r\nline two\r\n',
      people: '   ',
      hypotheses: '',
      questions: null
    })
    expect(issues).toEqual([])
    expect(input).toEqual({ objective: 'A goal', facts: 'line one\nline two', people: null, hypotheses: null, questions: null })
  })

  it('accepts an entirely empty brief', () => {
    expect(checkCaseBrief(nothing)).toEqual({ input: nothing, issues: [] })
    expect(briefIsEmpty(nothing)).toBe(true)
    expect(briefIsEmpty({ ...nothing, facts: 'x' })).toBe(false)
  })

  it.each(BRIEF_FIELDS)('limits %s to its maximum length, counted after trimming', (field) => {
    const limit = BRIEF_LIMITS[field]
    expect(checkCaseBrief({ ...nothing, [field]: `  ${'x'.repeat(limit)}  ` }).issues).toEqual([])
    expect(checkCaseBrief({ ...nothing, [field]: 'x'.repeat(limit + 1) })).toEqual({
      input: null,
      issues: [{ field, code: 'too-long' }]
    })
  })

  it('uses 4,000 for the objective and 10,000 for every other section', () => {
    expect(BRIEF_LIMITS).toEqual({ objective: 4000, facts: 10000, people: 10000, hypotheses: 10000, questions: 10000 })
  })

  it.each(BRIEF_FIELDS)('rejects control characters in %s but keeps new lines and tabs', (field) => {
    expect(checkCaseBrief({ ...nothing, [field]: 'a\tb\nc' }).issues).toEqual([])
    expect(checkCaseBrief({ ...nothing, [field]: 'bad\u0000text' }).issues).toEqual([{ field, code: 'invalid-characters' }])
    expect(checkCaseBrief({ ...nothing, [field]: 'bad\u001btext' }).issues).toEqual([{ field, code: 'invalid-characters' }])
    expect(checkCaseBrief({ ...nothing, [field]: 'lone\rreturn' }).issues).toEqual([{ field, code: 'invalid-characters' }])
  })

  it('reports every problem at once and never carries the submitted text', () => {
    const marker = 'SECRET-MARKER-17'
    const { input, issues } = checkCaseBrief({
      ...nothing,
      objective: `${marker}${'x'.repeat(4000)}`,
      facts: `${marker}\u0000`
    })
    expect(input).toBeNull()
    expect(issues).toEqual([
      { field: 'objective', code: 'too-long' },
      { field: 'facts', code: 'invalid-characters' }
    ])
    expect(JSON.stringify(issues)).not.toContain(marker)
  })

  it('keeps accents, quotes, emoji and markup-like text exactly as typed', () => {
    const text = 'Niño “Ángel” O’Brien — <script>alert(1)</script> & "quotes" \'single\' 🌽'
    expect(checkCaseBrief({ ...nothing, people: text }).input?.people).toBe(text)
  })
})

describe('CaseBriefRepository', () => {
  let db: DatabaseSync
  let clients: ClientRepository
  let cases: CaseRepository
  let briefs: CaseBriefRepository
  let caseA: string
  let caseB: string
  let clientA: string
  let clientB: string

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

  beforeEach(() => {
    db = memoryDb()
    const clock = steppingClock()
    clients = new ClientRepository(db, clock)
    cases = new CaseRepository(db, clock)
    briefs = new CaseBriefRepository(db, clock)
    clientA = newClient('Ana Ejemplo')
    clientB = newClient('Ana Ejemplar')
    caseA = newCase(clientA, 'Case A')
    caseB = newCase(clientB, 'Case B')
  })

  afterEach(() => db.close())

  it('returns an all-empty brief for an existing case without one, and null for an unknown case', () => {
    expect(briefs.get(caseA)).toEqual(emptyBrief(caseA))
    expect(briefs.get(caseA)?.updatedAt).toBeNull()
    expect(briefs.get(crypto.randomUUID())).toBeNull()
    expect(count(db, 'case_briefs')).toBe(0)
  })

  it('saves, reads back and then replaces the brief (upsert), keeping one row', () => {
    const first = savedBrief(briefs.save(caseA, brief))
    expect(first).toMatchObject({ caseId: caseA, ...brief })
    expect(first.updatedAt).not.toBeNull()
    expect(briefs.get(caseA)).toEqual(first)

    const second = savedBrief(briefs.save(caseA, { ...nothing, questions: 'Only a question now.' }))
    expect(second).toMatchObject({ ...nothing, questions: 'Only a question now.' })
    expect(second.updatedAt! > first.updatedAt!).toBe(true)
    expect(count(db, 'case_briefs')).toBe(1)

    const emptied = savedBrief(briefs.save(caseA, nothing))
    expect(briefIsEmpty(emptied)).toBe(true)
    expect(emptied.updatedAt).not.toBeNull()
    expect(count(db, 'case_briefs')).toBe(1)
  })

  it('normalizes what it stores', () => {
    const saved = savedBrief(briefs.save(caseA, { ...nothing, facts: '  one\r\ntwo  ', people: '   ' }))
    expect(saved.facts).toBe('one\ntwo')
    expect(saved.people).toBeNull()
    expect(db.prepare('SELECT people FROM case_briefs').get()).toEqual({ people: null })
  })

  it('stores special characters verbatim', () => {
    const text = 'Niño “Ángel” <script>alert(1)</script> \'; DROP TABLE case_briefs; -- 🌽'
    expect(savedBrief(briefs.save(caseA, { ...nothing, hypotheses: text })).hypotheses).toBe(text)
    expect(briefs.get(caseA)?.hypotheses).toBe(text)
    expect(count(db, 'case_briefs')).toBe(1)
  })

  it('bumps the case’s updated time, but writes no case event and changes nothing else', () => {
    const before = cases.get(caseA)!
    const events = eventRows()
    const saved = savedBrief(briefs.save(caseA, brief))
    const after = cases.get(caseA)!
    expect(after.updatedAt).toBe(saved.updatedAt)
    expect(after.updatedAt > before.updatedAt).toBe(true)
    expect({ ...after, updatedAt: before.updatedAt }).toEqual(before)
    expect(eventRows()).toEqual(events)
  })

  it('returns not-found for an unknown case and stores nothing', () => {
    expect(briefs.save(crypto.randomUUID(), brief)).toEqual({ ok: false, reason: 'not-found' })
    expect(count(db, 'case_briefs')).toBe(0)
  })

  it('returns issue codes for invalid input, stores nothing and never echoes values', () => {
    const marker = 'SECRET-MARKER-17'
    savedBrief(briefs.save(caseA, brief))
    const cases0 = caseRows()
    const result = briefs.save(caseA, { ...brief, facts: `${marker}\u0000`, questions: 'x'.repeat(10_001) })
    expect(result).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'facts', code: 'invalid-characters' },
        { field: 'questions', code: 'too-long' }
      ]
    })
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(briefs.get(caseA)).toMatchObject(brief)
    expect(caseRows()).toEqual(cases0)
  })

  it('refuses a save for an archived case, even for invalid input, changing nothing', () => {
    savedBrief(briefs.save(caseA, brief))
    cases.archive(caseA)
    const before = { cases: caseRows(), brief: briefs.get(caseA), events: eventRows() }
    expect(briefs.save(caseA, { ...brief, facts: 'changed' })).toEqual({ ok: false, reason: 'wrong-status' })
    expect(briefs.save(caseA, { ...nothing, facts: '\u0000' })).toEqual({ ok: false, reason: 'wrong-status' })
    expect({ cases: caseRows(), brief: briefs.get(caseA), events: eventRows() }).toEqual(before)
    // Reading still works, and saving works again after unarchiving.
    expect(briefs.get(caseA)).toMatchObject(brief)
    cases.unarchive(caseA)
    expect(briefs.save(caseA, { ...brief, facts: 'changed' }).ok).toBe(true)
  })

  it('refuses a save when the client is archived, and works again after the client is restored', () => {
    clients.archive(clientA)
    expect(briefs.save(caseA, brief)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(count(db, 'case_briefs')).toBe(0)
    clients.restore(clientA)
    expect(briefs.save(caseA, brief).ok).toBe(true)
  })

  it('keeps briefs of different cases and clients apart', () => {
    savedBrief(briefs.save(caseA, brief))
    const caseBBefore = cases.get(caseB)
    expect(briefs.get(caseB)).toEqual(emptyBrief(caseB))
    savedBrief(briefs.save(caseB, { ...nothing, facts: 'Belongs to B.' }))
    expect(briefs.get(caseA)).toMatchObject(brief)
    expect(briefs.get(caseB)).toMatchObject({ ...nothing, facts: 'Belongs to B.' })
    expect(cases.get(caseB)!.updatedAt > caseBBefore!.updatedAt).toBe(true)
    // A second case of the same client has its own brief too.
    const caseA2 = newCase(clientA, 'Case A2')
    expect(briefs.get(caseA2)).toEqual(emptyBrief(caseA2))
  })

  it('rolls back the whole save when the case update fails', () => {
    db.exec(`CREATE TRIGGER fail_case_update BEFORE UPDATE ON research_cases BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    expect(() => briefs.save(caseA, brief)).toThrow(/boom/)
    expect(count(db, 'case_briefs')).toBe(0)
    db.exec('DROP TRIGGER fail_case_update')
    expect(briefs.save(caseA, brief).ok).toBe(true)
  })

  describe('database guarantees', () => {
    const insert = (overrides: Record<string, string | null> = {}) => {
      const values = {
        case_id: caseA,
        objective: null,
        facts: null,
        people: null,
        hypotheses: null,
        questions: null,
        created_at: 'x',
        updated_at: 'x',
        ...overrides
      }
      const columns = Object.keys(values)
      db.prepare(`INSERT INTO case_briefs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
        ...(Object.values(values) as (string | null)[])
      )
    }

    it('rejects a brief for an unknown case and a second brief for one case', () => {
      expect(() => insert({ case_id: crypto.randomUUID() })).toThrow(/FOREIGN KEY/)
      insert()
      expect(() => insert()).toThrow(/UNIQUE|PRIMARY/)
    })

    it('enforces column rules on its own', () => {
      expect(() => insert({ objective: '' })).toThrow(/CHECK/)
      expect(() => insert({ objective: 'x'.repeat(4001) })).toThrow(/CHECK/)
      for (const column of ['facts', 'people', 'hypotheses', 'questions']) {
        expect(() => insert({ [column]: '' })).toThrow(/CHECK/)
        expect(() => insert({ [column]: 'x'.repeat(10_001) })).toThrow(/CHECK/)
      }
      insert({ objective: 'x'.repeat(4000), facts: 'x'.repeat(10_000) })
      expect(count(db, 'case_briefs')).toBe(1)
    })

    it('never deletes briefs, cases or clients with a brief', () => {
      savedBrief(briefs.save(caseA, brief))
      expect(() => db.prepare('DELETE FROM case_briefs WHERE case_id = ?').run(caseA)).toThrow(/never deleted/)
      expect(() => db.prepare('DELETE FROM case_briefs').run()).toThrow(/never deleted/)
      expect(() => db.prepare('DELETE FROM research_cases WHERE id = ?').run(caseA)).toThrow(/never deleted/)
      expect(briefs.get(caseA)).toMatchObject(brief)
    })

    it('keeps a brief with its case', () => {
      savedBrief(briefs.save(caseA, brief))
      expect(() => db.prepare('UPDATE case_briefs SET case_id = ? WHERE case_id = ?').run(caseB, caseA)).toThrow(/belongs to one case/)
      expect(briefs.get(caseA)).toMatchObject(brief)
      expect(briefs.get(caseB)).toEqual(emptyBrief(caseB))
    })
  })
})

describe('persistence', () => {
  it('keeps briefs across closing and reopening, and the case’s updated time with them', () => {
    const first = new AppData(userData)
    const client = first.clients.create(clientInput)
    if (!client.ok) throw new Error('fixture client invalid')
    const created = first.cases.create(client.client.id, caseInput)
    if (!created.ok) throw new Error('fixture case invalid')
    const saved = savedBrief(first.briefs.save(created.case.id, brief))
    const caseAfter = first.cases.get(created.case.id)
    first.close()

    const second = new AppData(userData)
    try {
      expect(second.briefs.get(created.case.id)).toEqual(saved)
      expect(second.cases.get(created.case.id)).toEqual(caseAfter)
    } finally {
      second.close()
    }
  })
})

describe('migration 4 (case_briefs)', () => {
  const v3 = migrations.slice(0, 3)

  /** A real profile database as the v3 app left it: migrations 1-3, with fictional clients, notes, cases and events. */
  function buildV3Profile(): string {
    const dir = dataDirectory(userData)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, DATABASE_FILE_NAME)
    const db = new DatabaseSync(file)
    configureConnection(db)
    migrate(db, {}, v3)
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
    cases.archive(two.case.id)
    clients.archive(archived.client.id)
    expect(getSchemaVersion(db)).toBe(3)
    db.close()
    return file
  }

  const dump = (db: DatabaseSync) => ({
    clients: db.prepare('SELECT * FROM clients ORDER BY id').all(),
    cases: db.prepare('SELECT * FROM research_cases ORDER BY id').all(),
    events: db.prepare('SELECT * FROM case_events ORDER BY rowid').all()
  })

  it('upgrades a real v3 database: clients, cases and events identical, no briefs, copy written first', () => {
    const file = buildV3Profile()
    const old = new DatabaseSync(file)
    const before = dump(old)
    old.close()
    expect(before.cases).toHaveLength(2)
    expect(before.events.length).toBeGreaterThan(2)

    const opened = openAppDatabase(userData, () => new Date('2026-10-29T12:00:00.000Z'))
    try {
      expect(opened.migration).toEqual({ from: 3, to: migrations.length })
      expect(migrations[3]?.name).toBe('case_briefs')
      expect(dump(opened.db)).toEqual(before)
      expect(count(opened.db, 'case_briefs')).toBe(0)
      expect(opened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect((opened.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')

      // Old cases take briefs; archived ones refuse.
      const repo = new CaseBriefRepository(opened.db)
      const [active, archived] = [before.cases.find((c) => !(c as { archived_at: string | null }).archived_at), before.cases.find((c) => (c as { archived_at: string | null }).archived_at)] as { id: string }[]
      expect(repo.save(active!.id, brief).ok).toBe(true)
      expect(repo.save(archived!.id, brief)).toEqual({ ok: false, reason: 'wrong-status' })
    } finally {
      opened.db.close()
    }

    const copies = readdirSync(join(dataDirectory(userData), 'pre-migration'))
    expect(copies).toEqual([`${DATABASE_FILE_NAME}.v3.2026-10-29T12-00-00-000Z.sqlite`])
    const copy = new DatabaseSync(join(dataDirectory(userData), 'pre-migration', copies[0]!), { readOnly: true })
    expect(getSchemaVersion(copy)).toBe(3)
    expect(dump(copy)).toEqual(before)
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%brief%'").all()).toEqual([])
    copy.close()
  })

  it('leaves the database at v3 when migration 4 fails part-way', () => {
    const file = buildV3Profile()
    const db = new DatabaseSync(file)
    configureConnection(db)
    db.exec('CREATE TABLE case_briefs (in_the_way TEXT)')
    expect(() => migrate(db)).toThrow(MigrationFailedError)
    expect(getSchemaVersion(db)).toBe(3)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'case_briefs_%'").all()).toEqual([])
    db.close()
  })
})

describe('backup and restore with briefs', () => {
  let root: string
  let data: AppData

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-brief-backup-'))
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
    const client = data.clients.list({ text: '', status: 'all', sources: [], sort: 'name' })[0]
    let clientId = client?.id
    if (!clientId) {
      const created = data.clients.create(clientInput)
      if (!created.ok) throw new Error('fixture client invalid')
      clientId = created.client.id
    }
    const created = data.cases.create(clientId, { ...caseInput, title })
    if (!created.ok) throw new Error('fixture case invalid')
    return created.case.id
  }

  it('keeps briefs through a backup round trip, replacing briefs written since', () => {
    const kept = seedCase('Kept')
    const saved = savedBrief(data.briefs.save(kept, brief))
    const file = join(root, 'backup.tgbackup')
    expect(data.createBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })

    savedBrief(data.briefs.save(kept, { ...nothing, facts: 'Written after the backup.' }))
    const later = seedCase('Later')
    savedBrief(data.briefs.save(later, brief))

    data.restoreBackup(file)
    expect(data.briefs.get(kept)).toEqual(saved)
    expect(data.briefs.get(later)).toBeNull()
    expect(count(data.db, 'case_briefs')).toBe(1)
    // The restored repository works.
    expect(data.briefs.save(kept, brief).ok).toBe(true)
  })

  it('restores a v3 backup into the current schema, with cases and no briefs', () => {
    const file = join(root, 'old.tgbackup')
    const old = new DatabaseSync(file)
    configureConnection(old)
    migrate(old, {}, migrations.slice(0, 3))
    old.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    const client = new ClientRepository(old).create({ ...clientInput, displayName: 'Older Backup Client' })
    if (!client.ok) throw new Error('fixture client invalid')
    const oldCase = new CaseRepository(old).create(client.client.id, caseInput)
    if (!oldCase.ok) throw new Error('fixture case invalid')
    old.exec('PRAGMA journal_mode = DELETE')
    old.close()
    expect(inspectBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: 3 })

    const current = seedCase('Current case')
    savedBrief(data.briefs.save(current, brief))

    expect(data.restoreBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })
    expect(count(data.db, 'case_briefs')).toBe(0)
    expect(data.briefs.get(oldCase.case.id)).toEqual(emptyBrief(oldCase.case.id))
    expect(data.briefs.get(current)).toBeNull()
    expect(data.briefs.save(oldCase.case.id, brief).ok).toBe(true)
    expect(existsSync(join(dataDirectory(join(root, 'profile')), 'pre-restore'))).toBe(true)
  })
})
