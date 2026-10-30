import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData, inspectBackup } from '../../src/main/database/app-data'
import { CaseBriefRepository } from '../../src/main/database/case-brief-repository'
import { CaseJournalRepository } from '../../src/main/database/case-journal-repository'
import { CaseRepository } from '../../src/main/database/case-repository'
import { ClientRepository } from '../../src/main/database/client-repository'
import {
  APPLICATION_ID,
  configureConnection,
  dataDirectory,
  DATABASE_FILE_NAME,
  openAppDatabase
} from '../../src/main/database/connection'
import { NoteRepository } from '../../src/main/database/note-repository'
import { getSchemaVersion, migrate, MigrationFailedError, migrations } from '../../src/main/database/migrations'
import {
  checkJournalEntry,
  compareJournalEntries,
  isJournalEntryEdited,
  JOURNAL_ACTIVITY_MAX,
  JOURNAL_BODY_MAX,
  type JournalEntry,
  type JournalEntryInput,
  type JournalMutationResult
} from '../../src/shared/case-journal'
import type { CaseInput } from '../../src/shared/case-model'
import type { ClientInput } from '../../src/shared/client-model'

// Case research journal (#18): the shared rules, the SQLite repository, migration 5
// on a real v4 profile and backups. Fictional data only.

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
const NOW = START
const entry: JournalEntryInput = {
  occurredAt: '2026-10-20T15:30:00.000Z',
  activity: 'Archive search',
  body: 'Looked through the 1931 parish index.\nNothing under Ejemplo.'
}

/** A clock that moves one second per reading, so "updated" checks are deterministic. */
function steppingClock() {
  let second = 0
  let n = 0
  return {
    now: () => new Date(START.getTime() + 1000 * second++),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  }
}

function saved(result: JournalMutationResult): JournalEntry {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.entry
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
  userData = mkdtempSync(join(tmpdir(), 'tg-journal-test-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('checkJournalEntry', () => {
  it('trims, turns an empty activity into null, converts CRLF to LF and normalizes the time', () => {
    const { input, issues } = checkJournalEntry(
      { occurredAt: '2026-10-20T09:30:00-06:00', activity: '   ', body: '  line one\r\nline two\r\n  ' },
      NOW
    )
    expect(issues).toEqual([])
    expect(input).toEqual({ occurredAt: '2026-10-20T15:30:00.000Z', activity: null, body: 'line one\nline two' })
    expect(checkJournalEntry({ ...entry, activity: '  Record analysis  ' }, NOW).input?.activity).toBe('Record analysis')
    expect(checkJournalEntry({ ...entry, activity: null }, NOW).input?.activity).toBeNull()
  })

  it('requires a body', () => {
    for (const body of ['', '   ', '\r\n\t']) {
      expect(checkJournalEntry({ ...entry, body }, NOW)).toEqual({ input: null, issues: [{ field: 'body', code: 'required' }] })
    }
  })

  it('limits the body to 10,000 and the activity to 60 characters, counted after trimming', () => {
    expect(JOURNAL_BODY_MAX).toBe(10_000)
    expect(JOURNAL_ACTIVITY_MAX).toBe(60)
    expect(checkJournalEntry({ ...entry, body: `  ${'x'.repeat(10_000)}  ` }, NOW).issues).toEqual([])
    expect(checkJournalEntry({ ...entry, body: 'x'.repeat(10_001) }, NOW).issues).toEqual([{ field: 'body', code: 'too-long' }])
    expect(checkJournalEntry({ ...entry, activity: ` ${'a'.repeat(60)} ` }, NOW).issues).toEqual([])
    expect(checkJournalEntry({ ...entry, activity: 'a'.repeat(61) }, NOW).issues).toEqual([{ field: 'activity', code: 'too-long' }])
  })

  it('rejects control characters but keeps new lines and tabs in the body', () => {
    expect(checkJournalEntry({ ...entry, body: 'a\tb\nc' }, NOW).input?.body).toBe('a\tb\nc')
    for (const bad of ['bad\u0000text', 'bad\u001btext', 'lone\rreturn']) {
      expect(checkJournalEntry({ ...entry, body: bad }, NOW).issues).toEqual([{ field: 'body', code: 'invalid-characters' }])
    }
    for (const bad of ['two\nlines', 'tab\there', 'nul\u0000']) {
      expect(checkJournalEntry({ ...entry, activity: bad }, NOW).issues).toEqual([{ field: 'activity', code: 'invalid-characters' }])
    }
  })

  it('accepts back-dated entries and a moment up to a day ahead, but not further', () => {
    expect(checkJournalEntry({ ...entry, occurredAt: '1999-01-01T00:00:00.000Z' }, NOW).issues).toEqual([])
    expect(checkJournalEntry({ ...entry, occurredAt: '2026-10-30T11:00:00.000Z' }, NOW).issues).toEqual([])
    expect(checkJournalEntry({ ...entry, occurredAt: '2026-10-30T12:00:00.001Z' }, NOW).issues).toEqual([
      { field: 'occurredAt', code: 'in-future' }
    ])
    expect(checkJournalEntry({ ...entry, occurredAt: '2031-01-01T00:00:00.000Z' }, NOW).issues).toEqual([
      { field: 'occurredAt', code: 'in-future' }
    ])
  })

  it('rejects an unreadable time', () => {
    for (const occurredAt of ['', 'yesterday', '2026-13-45']) {
      expect(checkJournalEntry({ ...entry, occurredAt }, NOW).issues).toEqual([{ field: 'occurredAt', code: 'invalid-format' }])
    }
  })

  it('reports every problem at once and never carries the submitted text', () => {
    const marker = 'SECRET-MARKER-18'
    const { input, issues } = checkJournalEntry({ occurredAt: 'nope', activity: `${marker}${'x'.repeat(60)}`, body: `${marker}\u0000` }, NOW)
    expect(input).toBeNull()
    expect(issues).toEqual([
      { field: 'body', code: 'invalid-characters' },
      { field: 'activity', code: 'too-long' },
      { field: 'occurredAt', code: 'invalid-format' }
    ])
    expect(JSON.stringify(issues)).not.toContain(marker)
  })

  it('keeps accents, quotes, emoji and markup-like text exactly as typed', () => {
    const text = 'Niño “Ángel” O’Brien — <script>alert(1)</script> & "quotes" \'single\' 🌽'
    expect(checkJournalEntry({ ...entry, body: text, activity: 'Búsqueda “A” <b>' }, NOW).input).toMatchObject({
      body: text,
      activity: 'Búsqueda “A” <b>'
    })
  })
})

describe('compareJournalEntries', () => {
  const make = (id: string, occurredAt: string, createdAt: string): JournalEntry => ({
    id,
    caseId: 'c',
    occurredAt,
    activity: null,
    body: 'x',
    createdAt,
    updatedAt: createdAt
  })

  it('orders by when it happened, then when it was written, then id, newest first', () => {
    const list = [
      make('a', '2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z'),
      make('b', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'),
      make('c', '2026-10-03T00:00:00.000Z', '2026-10-04T00:00:00.000Z'),
      make('d', '2026-10-03T00:00:00.000Z', '2026-10-04T00:00:00.000Z'),
      make('e', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')
    ]
    expect([...list].sort(compareJournalEntries).map((e) => e.id)).toEqual(['d', 'c', 'b', 'e', 'a'])
    expect([...list].reverse().sort(compareJournalEntries).map((e) => e.id)).toEqual(['d', 'c', 'b', 'e', 'a'])
  })

  it('marks an entry edited when its updated time differs from its created time', () => {
    const base = make('a', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    expect(isJournalEntryEdited(base)).toBe(false)
    expect(isJournalEntryEdited({ ...base, updatedAt: '2026-10-02T00:00:00.000Z' })).toBe(true)
  })
})

describe('CaseJournalRepository', () => {
  let db: DatabaseSync
  let clients: ClientRepository
  let cases: CaseRepository
  let journal: CaseJournalRepository
  let notes: NoteRepository
  let caseA: string
  let caseA2: string
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
  const noteRows = () => db.prepare('SELECT * FROM client_notes ORDER BY rowid').all()
  const journalRows = () => db.prepare('SELECT * FROM case_journal_entries ORDER BY rowid').all()

  beforeEach(() => {
    db = memoryDb()
    const clock = steppingClock()
    clients = new ClientRepository(db, clock)
    cases = new CaseRepository(db, clock)
    notes = new NoteRepository(db, clock)
    journal = new CaseJournalRepository(db, clock)
    clientA = newClient('Ana Ejemplo')
    clientB = newClient('Ana Ejemplar')
    caseA = newCase(clientA, 'Case A')
    caseA2 = newCase(clientA, 'Case A2')
    caseB = newCase(clientB, 'Case B')
  })

  afterEach(() => db.close())

  it('lists nothing for a case without entries and for an unknown case', () => {
    expect(journal.list(caseA)).toEqual([])
    expect(journal.list(crypto.randomUUID())).toEqual([])
  })

  it('creates an entry, reads it back and stores it normalized', () => {
    const created = saved(journal.create(caseA, { occurredAt: '2026-10-20T09:30:00-06:00', activity: '  ', body: ' one\r\ntwo ' }))
    expect(created).toMatchObject({ caseId: caseA, occurredAt: '2026-10-20T15:30:00.000Z', activity: null, body: 'one\ntwo' })
    expect(created.id).toHaveLength(36)
    expect(created.createdAt).toBe(created.updatedAt)
    expect(isJournalEntryEdited(created)).toBe(false)
    expect(journal.list(caseA)).toEqual([created])
    expect(db.prepare('SELECT activity FROM case_journal_entries').get()).toEqual({ activity: null })
  })

  it('lists newest first by when it happened, so back-dated entries sit in the right place', () => {
    const middle = saved(journal.create(caseA, { ...entry, occurredAt: '2026-10-10T10:00:00.000Z' }))
    const newest = saved(journal.create(caseA, { ...entry, occurredAt: '2026-10-25T10:00:00.000Z' }))
    const oldest = saved(journal.create(caseA, { ...entry, occurredAt: '2026-09-01T10:00:00.000Z' }))
    expect(journal.list(caseA).map((e) => e.id)).toEqual([newest.id, middle.id, oldest.id])
  })

  it('breaks ties by when each was written, then id, newest first, matching the shared comparator', () => {
    const first = saved(journal.create(caseA, entry))
    const second = saved(journal.create(caseA, entry))
    const third = saved(journal.create(caseA, entry))
    expect(journal.list(caseA).map((e) => e.id)).toEqual([third.id, second.id, first.id])
    // Editing does not move an entry in the tie order.
    saved(journal.update(caseA, first.id, { ...entry, body: 'edited' }))
    expect(journal.list(caseA).map((e) => e.id)).toEqual([third.id, second.id, first.id])
    const listed = journal.list(caseA)
    expect([...listed].reverse().sort(compareJournalEntries)).toEqual(listed)

    // Same occurredAt and createdAt: the id decides.
    db.prepare('UPDATE case_journal_entries SET created_at = ?').run('2026-10-29T12:00:00.000Z')
    const byId = journal.list(caseA)
    expect(byId.map((e) => e.id)).toEqual([...byId.map((e) => e.id)].sort().reverse())
    expect([...byId].reverse().sort(compareJournalEntries)).toEqual(byId)
  })

  it('updates an entry in place, keeping its id, case and created time', () => {
    const created = saved(journal.create(caseA, entry))
    const updated = saved(journal.update(caseA, created.id, { occurredAt: '2026-10-21T08:00:00.000Z', activity: null, body: 'Rewritten.' }))
    expect(updated).toMatchObject({
      id: created.id,
      caseId: caseA,
      createdAt: created.createdAt,
      occurredAt: '2026-10-21T08:00:00.000Z',
      activity: null,
      body: 'Rewritten.'
    })
    expect(updated.updatedAt > created.updatedAt).toBe(true)
    expect(isJournalEntryEdited(updated)).toBe(true)
    expect(journal.list(caseA)).toEqual([updated])
    expect(count(db, 'case_journal_entries')).toBe(1)
  })

  it('stores special characters verbatim', () => {
    const text = 'Niño “Ángel” <script>alert(1)</script> \'; DROP TABLE case_journal_entries; -- 🌽'
    const created = saved(journal.create(caseA, { ...entry, body: text, activity: 'Búsqueda “A” <b>' }))
    expect(created.body).toBe(text)
    expect(journal.list(caseA)[0]).toMatchObject({ body: text, activity: 'Búsqueda “A” <b>' })
    expect(count(db, 'case_journal_entries')).toBe(1)
  })

  it('bumps the case’s updated time on create and update, writes no case event and changes nothing else', () => {
    const before = cases.get(caseA)!
    const events = eventRows()
    const created = saved(journal.create(caseA, entry))
    const afterCreate = cases.get(caseA)!
    expect(afterCreate.updatedAt).toBe(created.updatedAt)
    expect(afterCreate.updatedAt > before.updatedAt).toBe(true)
    expect({ ...afterCreate, updatedAt: before.updatedAt }).toEqual(before)

    const updated = saved(journal.update(caseA, created.id, { ...entry, body: 'again' }))
    expect(cases.get(caseA)!.updatedAt).toBe(updated.updatedAt)
    expect(eventRows()).toEqual(events)
  })

  it('returns not-found for an unknown case and stores nothing', () => {
    expect(journal.create(crypto.randomUUID(), entry)).toEqual({ ok: false, reason: 'not-found' })
    expect(journal.update(crypto.randomUUID(), crypto.randomUUID(), entry)).toEqual({ ok: false, reason: 'not-found' })
    expect(count(db, 'case_journal_entries')).toBe(0)
  })

  it('returns issue codes for invalid input, writes nothing and never echoes values', () => {
    const marker = 'SECRET-MARKER-18'
    const created = saved(journal.create(caseA, entry))
    const caseBefore = caseRows()
    const rowsBefore = journalRows()
    const bad = { occurredAt: 'nope', activity: `${marker}\u0000`, body: `${marker}${'x'.repeat(10_000)}` }
    for (const result of [journal.create(caseA, bad), journal.update(caseA, created.id, bad)]) {
      expect(result).toEqual({
        ok: false,
        reason: 'invalid',
        issues: [
          { field: 'body', code: 'too-long' },
          { field: 'activity', code: 'invalid-characters' },
          { field: 'occurredAt', code: 'invalid-format' }
        ]
      })
      expect(JSON.stringify(result)).not.toContain(marker)
    }
    expect(journal.create(caseA, { ...entry, occurredAt: '2031-01-01T00:00:00.000Z' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [{ field: 'occurredAt', code: 'in-future' }]
    })
    expect(journalRows()).toEqual(rowsBefore)
    expect(caseRows()).toEqual(caseBefore)
  })

  it('treats an entry id from another case as not found and leaves that entry unchanged', () => {
    const inB = saved(journal.create(caseB, entry))
    const rowsBefore = journalRows()
    const caseBBefore = cases.get(caseB)
    expect(journal.update(caseA, inB.id, { ...entry, body: 'hijacked' })).toEqual({ ok: false, reason: 'not-found' })
    expect(journal.update(caseA, crypto.randomUUID(), entry)).toEqual({ ok: false, reason: 'not-found' })
    // A sibling case of the same client counts as another case too.
    const inA = saved(journal.create(caseA, entry))
    expect(journal.update(caseA2, inA.id, { ...entry, body: 'hijacked' })).toEqual({ ok: false, reason: 'not-found' })
    expect(journal.list(caseB)).toEqual([inB])
    expect(journal.list(caseA)).toEqual([inA])
    expect(journalRows().slice(0, rowsBefore.length)).toEqual(rowsBefore)
    expect(cases.get(caseB)).toEqual(caseBBefore)
  })

  it('checks in order: case, then archived, then entry, then input', () => {
    const created = saved(journal.create(caseA, entry))
    const bad = { occurredAt: 'nope', activity: null, body: '' }
    // Unknown case beats everything.
    expect(journal.update(crypto.randomUUID(), crypto.randomUUID(), bad)).toEqual({ ok: false, reason: 'not-found' })
    // Wrong entry beats invalid input.
    expect(journal.update(caseA, crypto.randomUUID(), bad)).toEqual({ ok: false, reason: 'not-found' })
    // Archived beats a missing entry and invalid input.
    cases.archive(caseA)
    expect(journal.update(caseA, crypto.randomUUID(), bad)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(journal.update(caseA, created.id, bad)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(journal.create(caseA, bad)).toEqual({ ok: false, reason: 'wrong-status' })
  })

  it('refuses writes for an archived case, keeps entries readable, and works again after unarchiving', () => {
    const created = saved(journal.create(caseA, entry))
    cases.archive(caseA)
    const before = { cases: caseRows(), rows: journalRows(), events: eventRows() }
    expect(journal.create(caseA, entry)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(journal.update(caseA, created.id, { ...entry, body: 'changed' })).toEqual({ ok: false, reason: 'wrong-status' })
    expect({ cases: caseRows(), rows: journalRows(), events: eventRows() }).toEqual(before)
    expect(journal.list(caseA)).toEqual([created])
    cases.unarchive(caseA)
    expect(journal.update(caseA, created.id, { ...entry, body: 'changed' }).ok).toBe(true)
    expect(journal.create(caseA, entry).ok).toBe(true)
  })

  it('refuses writes when the client is archived, and works again after the client is restored', () => {
    const created = saved(journal.create(caseA, entry))
    clients.archive(clientA)
    expect(journal.create(caseA, entry)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(journal.update(caseA, created.id, entry)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(journal.list(caseA)).toEqual([created])
    expect(count(db, 'case_journal_entries')).toBe(1)
    clients.restore(clientA)
    expect(journal.create(caseA, entry).ok).toBe(true)
  })

  it('keeps the entries of different cases apart, including two cases of one client', () => {
    const a = saved(journal.create(caseA, { ...entry, body: 'in A' }))
    const a2 = saved(journal.create(caseA2, { ...entry, body: 'in A2' }))
    const b = saved(journal.create(caseB, { ...entry, body: 'in B' }))
    expect(journal.list(caseA)).toEqual([a])
    expect(journal.list(caseA2)).toEqual([a2])
    expect(journal.list(caseB)).toEqual([b])
    saved(journal.update(caseA, a.id, { ...entry, body: 'A changed' }))
    expect(journal.list(caseA2)).toEqual([a2])
    expect(journal.list(caseB)).toEqual([b])
  })

  it('never touches the client notes or contact log', () => {
    const note = notes.create(clientA, { kind: 'note', occurredAt: '2026-10-20T10:00:00.000Z', channel: null, direction: null, body: 'A client note.' })
    expect(note.ok).toBe(true)
    const before = noteRows()
    const created = saved(journal.create(caseA, entry))
    saved(journal.update(caseA, created.id, { ...entry, body: 'edited' }))
    cases.archive(caseA2)
    journal.create(caseA2, entry)
    expect(noteRows()).toEqual(before)
    expect(notes.list(clientA).map((n) => n.body)).toEqual(['A client note.'])
    expect(JSON.stringify(notes.list(clientA))).not.toContain('edited')
  })

  it('does not put journal text in case or brief records', () => {
    const marker = 'JOURNAL-ONLY-TEXT'
    saved(journal.create(caseA, { ...entry, body: marker, activity: marker }))
    expect(JSON.stringify(cases.get(caseA))).not.toContain(marker)
    expect(JSON.stringify(cases.list({ text: '', states: [], archived: 'all', clientId: null, sort: 'updated' }))).not.toContain(marker)
    expect(JSON.stringify(new CaseBriefRepository(db).get(caseA))).not.toContain(marker)
  })

  it('rolls back the whole write when the case update fails', () => {
    const created = saved(journal.create(caseA, entry))
    db.exec(`CREATE TRIGGER fail_case_update BEFORE UPDATE ON research_cases BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    expect(() => journal.create(caseA, entry)).toThrow(/boom/)
    expect(() => journal.update(caseA, created.id, { ...entry, body: 'changed' })).toThrow(/boom/)
    expect(journal.list(caseA)).toEqual([created])
    db.exec('DROP TRIGGER fail_case_update')
    expect(journal.create(caseA, entry).ok).toBe(true)
  })

  describe('database guarantees', () => {
    const insert = (overrides: Record<string, string | null> = {}) => {
      const values = {
        id: crypto.randomUUID(),
        case_id: caseA,
        occurred_at: '2026-10-20T15:30:00.000Z',
        activity: null,
        body: 'text',
        created_at: 'x',
        updated_at: 'x',
        ...overrides
      }
      const columns = Object.keys(values)
      db.prepare(`INSERT INTO case_journal_entries (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
        ...(Object.values(values) as (string | null)[])
      )
    }

    it('rejects an entry for an unknown case and a duplicate id', () => {
      expect(() => insert({ case_id: crypto.randomUUID() })).toThrow(/FOREIGN KEY/)
      const id = crypto.randomUUID()
      insert({ id })
      expect(() => insert({ id })).toThrow(/UNIQUE|PRIMARY/)
    })

    it('enforces column rules on its own', () => {
      expect(() => insert({ id: 'short' })).toThrow(/CHECK/)
      expect(() => insert({ body: '' })).toThrow(/CHECK/)
      expect(() => insert({ body: 'x'.repeat(10_001) })).toThrow(/CHECK/)
      expect(() => insert({ body: null })).toThrow(/NOT NULL/)
      expect(() => insert({ activity: '' })).toThrow(/CHECK/)
      expect(() => insert({ activity: 'a'.repeat(61) })).toThrow(/CHECK/)
      expect(() => insert({ occurred_at: null })).toThrow(/NOT NULL/)
      insert({ body: 'x'.repeat(10_000), activity: 'a'.repeat(60) })
      expect(count(db, 'case_journal_entries')).toBe(1)
    })

    it('never deletes entries, and cases with entries cannot be deleted', () => {
      const created = saved(journal.create(caseA, entry))
      expect(() => db.prepare('DELETE FROM case_journal_entries WHERE id = ?').run(created.id)).toThrow(/never deleted/)
      expect(() => db.prepare('DELETE FROM case_journal_entries').run()).toThrow(/never deleted/)
      expect(() => db.prepare('DELETE FROM research_cases WHERE id = ?').run(caseA)).toThrow(/never deleted/)
      expect(journal.list(caseA)).toEqual([created])
    })

    it('keeps an entry’s id and case fixed', () => {
      const created = saved(journal.create(caseA, entry))
      expect(() => db.prepare('UPDATE case_journal_entries SET case_id = ? WHERE id = ?').run(caseB, created.id)).toThrow(/immutable/)
      expect(() => db.prepare('UPDATE case_journal_entries SET id = ? WHERE id = ?').run(crypto.randomUUID(), created.id)).toThrow(/immutable/)
      expect(journal.list(caseA)).toEqual([created])
      expect(journal.list(caseB)).toEqual([])
    })

    it('has the lookup index', () => {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'case_journal_entries'").all() as { name: string }[]).map(
        (r) => r.name
      )
      expect(names).toContain('case_journal_entries_case_idx')
    })
  })
})

describe('persistence', () => {
  it('keeps entries across closing and reopening, with their order and the case’s updated time', () => {
    const first = new AppData(userData)
    const client = first.clients.create(clientInput)
    if (!client.ok) throw new Error('fixture client invalid')
    const created = first.cases.create(client.client.id, caseInput)
    if (!created.ok) throw new Error('fixture case invalid')
    const caseId = created.case.id
    saved(first.journal.create(caseId, entry))
    saved(first.journal.create(caseId, { ...entry, occurredAt: '2026-10-01T00:00:00.000Z', activity: null, body: 'Backdated.' }))
    const edited = saved(first.journal.create(caseId, entry))
    saved(first.journal.update(caseId, edited.id, { ...entry, body: 'Edited.' }))
    const listed = first.journal.list(caseId)
    const caseAfter = first.cases.get(caseId)
    first.close()

    const second = new AppData(userData)
    try {
      expect(second.journal.list(caseId)).toEqual(listed)
      expect(listed.map((e) => e.body)).toEqual(['Edited.', 'Looked through the 1931 parish index.\nNothing under Ejemplo.', 'Backdated.'])
      expect(second.cases.get(caseId)).toEqual(caseAfter)
    } finally {
      second.close()
    }
  })
})

describe('migration 5 (case_journal_entries)', () => {
  const v4 = migrations.slice(0, 4)

  /** A real profile database as the v4 app left it: migrations 1-4, with fictional clients, notes, cases, events and briefs. */
  function buildV4Profile(): string {
    const dir = dataDirectory(userData)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, DATABASE_FILE_NAME)
    const db = new DatabaseSync(file)
    configureConnection(db)
    migrate(db, {}, v4)
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
    new CaseBriefRepository(db).save(one.case.id, { objective: 'Find Rosa.', facts: null, people: null, hypotheses: 'Maybe Totonicapán.', questions: null })
    cases.archive(two.case.id)
    clients.archive(archived.client.id)
    expect(getSchemaVersion(db)).toBe(4)
    db.close()
    return file
  }

  const dump = (db: DatabaseSync) => ({
    clients: db.prepare('SELECT * FROM clients ORDER BY id').all(),
    notes: db.prepare('SELECT * FROM client_notes ORDER BY id').all(),
    cases: db.prepare('SELECT * FROM research_cases ORDER BY id').all(),
    events: db.prepare('SELECT * FROM case_events ORDER BY rowid').all(),
    briefs: db.prepare('SELECT * FROM case_briefs ORDER BY case_id').all()
  })

  it('upgrades a real v4 database: everything identical, no entries, copy written first', () => {
    const file = buildV4Profile()
    const old = new DatabaseSync(file)
    const before = dump(old)
    old.close()
    expect(before.cases).toHaveLength(2)
    expect(before.briefs).toHaveLength(1)

    const opened = openAppDatabase(userData, () => new Date('2026-10-29T12:00:00.000Z'))
    try {
      expect(opened.migration).toEqual({ from: 4, to: migrations.length })
      expect(migrations[4]?.name).toBe('case_journal_entries')
      expect(dump(opened.db)).toEqual(before)
      expect(count(opened.db, 'case_journal_entries')).toBe(0)
      expect(opened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect((opened.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')

      // Old cases take entries; archived ones refuse.
      const repo = new CaseJournalRepository(opened.db)
      const rows = before.cases as { id: string; archived_at: string | null }[]
      const active = rows.find((c) => !c.archived_at)!
      const archived = rows.find((c) => c.archived_at)!
      expect(repo.create(active.id, entry).ok).toBe(true)
      expect(repo.create(archived.id, entry)).toEqual({ ok: false, reason: 'wrong-status' })
    } finally {
      opened.db.close()
    }

    const copies = readdirSync(join(dataDirectory(userData), 'pre-migration'))
    expect(copies).toEqual([`${DATABASE_FILE_NAME}.v4.2026-10-29T12-00-00-000Z.sqlite`])
    const copy = new DatabaseSync(join(dataDirectory(userData), 'pre-migration', copies[0]!), { readOnly: true })
    expect(getSchemaVersion(copy)).toBe(4)
    expect(dump(copy)).toEqual(before)
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%journal%'").all()).toEqual([])
    copy.close()
  })

  it('leaves the database at v4 when migration 5 fails part-way', () => {
    const file = buildV4Profile()
    const db = new DatabaseSync(file)
    configureConnection(db)
    db.exec('CREATE TABLE case_journal_entries (in_the_way TEXT)')
    expect(() => migrate(db)).toThrow(MigrationFailedError)
    expect(getSchemaVersion(db)).toBe(4)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'case_journal_entries_%'").all()).toEqual([])
    db.close()
  })
})

describe('backup and restore with journal entries', () => {
  let root: string
  let data: AppData

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-journal-backup-'))
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

  it('keeps entries through a backup round trip, replacing entries written since', () => {
    const kept = seedCase('Kept')
    const one = saved(data.journal.create(kept, entry))
    const two = saved(data.journal.create(kept, { ...entry, occurredAt: '2026-09-01T00:00:00.000Z', body: 'Backdated.' }))
    const listed = data.journal.list(kept)
    const file = join(root, 'backup.tgbackup')
    expect(data.createBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })

    saved(data.journal.update(kept, one.id, { ...entry, body: 'Written after the backup.' }))
    const later = seedCase('Later')
    saved(data.journal.create(later, entry))

    data.restoreBackup(file)
    expect(data.journal.list(kept)).toEqual(listed)
    expect(listed.map((e) => e.id)).toEqual([one.id, two.id])
    expect(data.journal.list(later)).toEqual([])
    expect(count(data.db, 'case_journal_entries')).toBe(2)
    // The restored repository works.
    expect(data.journal.create(kept, entry).ok).toBe(true)
  })

  it('restores a v4 backup into the current schema, with cases and no entries', () => {
    const file = join(root, 'old.tgbackup')
    const old = new DatabaseSync(file)
    configureConnection(old)
    migrate(old, {}, migrations.slice(0, 4))
    old.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    const client = new ClientRepository(old).create({ ...clientInput, displayName: 'Older Backup Client' })
    if (!client.ok) throw new Error('fixture client invalid')
    const oldCase = new CaseRepository(old).create(client.client.id, caseInput)
    if (!oldCase.ok) throw new Error('fixture case invalid')
    old.exec('PRAGMA journal_mode = DELETE')
    old.close()
    expect(inspectBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: 4 })

    const current = seedCase('Current case')
    saved(data.journal.create(current, entry))

    expect(data.restoreBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })
    expect(count(data.db, 'case_journal_entries')).toBe(0)
    expect(data.journal.list(oldCase.case.id)).toEqual([])
    expect(data.journal.create(oldCase.case.id, entry).ok).toBe(true)
    expect(existsSync(join(dataDirectory(join(root, 'profile')), 'pre-restore'))).toBe(true)
  })
})
