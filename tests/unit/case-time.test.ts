import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData, inspectBackup } from '../../src/main/database/app-data'
import { CaseRepository } from '../../src/main/database/case-repository'
import { CaseTimeRepository } from '../../src/main/database/case-time-repository'
import { ClientRepository } from '../../src/main/database/client-repository'
import {
  APPLICATION_ID,
  configureConnection,
  dataDirectory,
  DATABASE_FILE_NAME,
  openAppDatabase
} from '../../src/main/database/connection'
import { getSchemaVersion, migrate, migrations } from '../../src/main/database/migrations'
import type { CaseInput } from '../../src/shared/case-model'
import {
  checkDuration,
  checkTimeEntry,
  compareEntries,
  evaluateTimer,
  formatClock,
  formatMinutes,
  isoWeekStart,
  planStop,
  roundToMinutes,
  summarizeEntries,
  TIME_MAX_MINUTES,
  TIME_NOTE_MAX,
  type StopOptions,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryMutationResult,
  type TimerRecord,
  type TimerResult,
  type TimerSnapshot
} from '../../src/shared/case-time'
import type { ClientInput } from '../../src/shared/client-model'

// Case research hours (#109): the shared rules, the SQLite repository, the timer
// state machine under an injectable clock, migration 7 on a real v6 profile and
// backups. Fictional data only.

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
const entry: TimeEntryInput = { workDate: '2026-10-28', durationMinutes: 90, activityType: 'research', note: 'Read the 1931 register.' }
const noStop: StopOptions = { activityType: null, note: null, durationMinutesOverride: null }
const START = Date.parse('2026-10-29T12:00:00.000Z')
const SEC = 1000
const MIN = 60 * SEC

/** A clock the test moves by hand. */
function handClock() {
  let at = START
  let n = 0
  return {
    now: () => new Date(at),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    advance: (ms: number) => (at += ms),
    set: (ms: number) => (at = ms)
  }
}

function saved(result: TimeEntryMutationResult): TimeEntry {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.entry
}

function ok(result: TimerResult): { timer: TimerSnapshot | null; entry: TimeEntry | null } {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result
}

function running(result: TimerResult): TimerSnapshot {
  const timer = ok(result).timer
  if (!timer) throw new Error('expected a timer')
  return timer
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  migrate(db)
  return db
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

function seedCase(db: DatabaseSync, title = 'Case A', displayName = 'Ana Ejemplo'): { clientId: string; caseId: string } {
  const client = new ClientRepository(db).create({ ...clientInput, displayName })
  if (!client.ok) throw new Error('fixture client invalid')
  const made = new CaseRepository(db).create(client.client.id, { ...caseInput, title })
  if (!made.ok) throw new Error('fixture case invalid')
  return { clientId: client.client.id, caseId: made.case.id }
}

function seedCaseFor(db: DatabaseSync, clientId: string, title: string): string {
  const made = new CaseRepository(db).create(clientId, { ...caseInput, title })
  if (!made.ok) throw new Error('fixture case invalid')
  return made.case.id
}

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'tg-time-test-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('duration and entry rules', () => {
  it('accepts whole minutes from 1 to 720 and nothing else', () => {
    expect(TIME_MAX_MINUTES).toBe(720)
    for (const minutes of [1, 2, 59, 60, 90, 719, 720]) expect(checkDuration(minutes)).toBeNull()
    for (const minutes of [0, -1, -60, -0.5]) expect(checkDuration(minutes)).toBe(minutes === -0.5 ? 'invalid-format' : 'too-short')
    for (const minutes of [721, 1000, 1e9]) expect(checkDuration(minutes)).toBe('too-long')
    for (const minutes of [1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY]) expect(checkDuration(minutes)).toBe('invalid-format')
    expect(checkDuration('90' as unknown as number)).toBe('invalid-format')
  })

  it('normalizes an entry: trims the note, converts CRLF and turns an empty note into null', () => {
    expect(checkTimeEntry({ ...entry, note: '  a\r\nb  ' }).input).toEqual({ ...entry, note: 'a\nb' })
    expect(checkTimeEntry({ ...entry, note: '   ' }).input).toEqual({ ...entry, note: null })
    expect(checkTimeEntry({ ...entry, activityType: null, note: null }).input).toEqual({ ...entry, activityType: null, note: null })
  })

  it('reports each problem with a field and a code only', () => {
    expect(checkTimeEntry({ ...entry, workDate: '' }).issues).toEqual([{ field: 'workDate', code: 'required' }])
    expect(checkTimeEntry({ ...entry, workDate: '2026-02-30' }).issues).toEqual([{ field: 'workDate', code: 'invalid-date' }])
    expect(checkTimeEntry({ ...entry, workDate: '28/10/2026' }).issues).toEqual([{ field: 'workDate', code: 'invalid-format' }])
    expect(checkTimeEntry({ ...entry, durationMinutes: 0 }).issues).toEqual([{ field: 'durationMinutes', code: 'too-short' }])
    expect(checkTimeEntry({ ...entry, durationMinutes: 721 }).issues).toEqual([{ field: 'durationMinutes', code: 'too-long' }])
    expect(checkTimeEntry({ ...entry, durationMinutes: 1.5 }).issues).toEqual([{ field: 'durationMinutes', code: 'invalid-format' }])
    expect(checkTimeEntry({ ...entry, activityType: 'billing' as never }).issues).toEqual([{ field: 'activityType', code: 'invalid-value' }])
    expect(checkTimeEntry({ ...entry, note: 'x'.repeat(TIME_NOTE_MAX + 1) }).issues).toEqual([{ field: 'note', code: 'too-long' }])
    expect(checkTimeEntry({ ...entry, note: 'x'.repeat(TIME_NOTE_MAX) }).issues).toEqual([])
    expect(checkTimeEntry({ ...entry, note: 'bad\u0000' }).issues).toEqual([{ field: 'note', code: 'invalid-characters' }])
    const all = checkTimeEntry({ workDate: 'x', durationMinutes: -5, activityType: 'x' as never, note: 'a\u0001' })
    expect(all.input).toBeNull()
    expect(all.issues.map((i) => i.field)).toEqual(['workDate', 'durationMinutes', 'activityType', 'note'])
    expect(JSON.stringify(all.issues)).not.toContain('a\u0001')
  })

  it('rounds timer seconds to the nearest minute and formats times', () => {
    expect([0, 29, 30, 89, 90, 91, 3599, 3600].map(roundToMinutes)).toEqual([0, 0, 1, 1, 2, 2, 60, 60])
    expect([1, 59, 60, 61, 125, 720].map(formatMinutes)).toEqual(['0:01', '0:59', '1:00', '1:01', '2:05', '12:00'])
    expect([0, 59, 60, 3723, -5].map(formatClock)).toEqual(['0:00:00', '0:00:59', '0:01:00', '1:02:03', '0:00:00'])
  })

  it('sorts newest work date first', () => {
    const e = (id: string, workDate: string, createdAt: string) => ({ id, workDate, createdAt }) as TimeEntry
    const sorted = [e('a', '2026-10-01', '1'), e('b', '2026-10-03', '1'), e('c', '2026-10-03', '2')].sort(compareEntries)
    expect(sorted.map((x) => x.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('week and month totals', () => {
  it('finds the Monday of the ISO week across month and year ends', () => {
    expect(isoWeekStart('2026-10-29')).toBe('2026-10-26') // Thursday
    expect(isoWeekStart('2026-10-26')).toBe('2026-10-26')
    expect(isoWeekStart('2026-11-01')).toBe('2026-10-26') // Sunday
    expect(isoWeekStart('2027-01-01')).toBe('2026-12-28')
    expect(isoWeekStart('2024-03-01')).toBe('2024-02-26')
  })

  it('adds up total, this ISO week and this calendar month by local date', () => {
    const rows = [
      { workDate: '2026-10-29', durationMinutes: 60 },
      { workDate: '2026-10-26', durationMinutes: 30 }, // Monday of this week
      { workDate: '2026-11-01', durationMinutes: 15 }, // Sunday of this week, next month
      { workDate: '2026-10-25', durationMinutes: 45 }, // Sunday before
      { workDate: '2026-10-01', durationMinutes: 120 },
      { workDate: '2026-09-30', durationMinutes: 10 }
    ]
    expect(summarizeEntries(rows, '2026-10-29')).toEqual({ totalMinutes: 280, weekMinutes: 105, monthMinutes: 255 })
    expect(summarizeEntries([], '2026-10-29')).toEqual({ totalMinutes: 0, weekMinutes: 0, monthMinutes: 0 })
  })
})

describe('evaluateTimer and planStop', () => {
  const base: TimerRecord = {
    caseId: '00000000-0000-4000-8000-0000000000aa',
    state: 'running',
    accumulatedSeconds: 600,
    segmentStartedAt: new Date(START).toISOString(),
    lastHeartbeatAt: new Date(START).toISOString(),
    startedAt: new Date(START - 10 * MIN).toISOString(),
    version: 3
  }
  const at = (ms: number) => new Date(START + ms)

  it('counts accumulated time plus the running segment, and a paused timer only its accumulated time', () => {
    expect(evaluateTimer(base, at(90 * SEC))).toMatchObject({ elapsedSeconds: 690, needsReview: false, suggestedSeconds: null })
    const paused: TimerRecord = { ...base, state: 'paused', segmentStartedAt: null }
    expect(evaluateTimer(paused, at(5 * 3600 * 1000))).toMatchObject({ state: 'paused', elapsedSeconds: 600, needsReview: false })
  })

  it('flags a stale heartbeat (over 5 minutes) and suggests only the time up to the last heartbeat', () => {
    expect(evaluateTimer({ ...base, lastHeartbeatAt: at(60 * SEC).toISOString() }, at(5 * MIN + 60 * SEC)).needsReview).toBe(false)
    const flagged = evaluateTimer({ ...base, lastHeartbeatAt: at(120 * SEC).toISOString() }, at(2 * 3600 * 1000))
    expect(flagged).toMatchObject({ needsReview: true, reviewReason: 'heartbeat-gap', suggestedSeconds: 600 + 120 })
    expect(flagged.elapsedSeconds).toBe(720)
  })

  it('flags a wall clock that moved backwards, before the segment or before the last heartbeat', () => {
    const beforeSegment = evaluateTimer(base, at(-1 * SEC))
    expect(beforeSegment).toMatchObject({ needsReview: true, reviewReason: 'clock-moved-back', suggestedSeconds: 600 })
    const heartbeat = { ...base, lastHeartbeatAt: at(100 * SEC).toISOString() }
    expect(evaluateTimer(heartbeat, at(50 * SEC))).toMatchObject({ needsReview: true, reviewReason: 'clock-moved-back', suggestedSeconds: 700 })
  })

  it('flags more than 12 hours and caps the suggestion at 12 hours', () => {
    const long = { ...base, accumulatedSeconds: 0, lastHeartbeatAt: at(12 * 3600 * 1000).toISOString() }
    expect(evaluateTimer(long, at(12 * 3600 * 1000 + SEC))).toMatchObject({ needsReview: true, reviewReason: 'too-long', suggestedSeconds: 43200 })
    const exactly = { ...base, accumulatedSeconds: 0, lastHeartbeatAt: at(12 * 3600 * 1000).toISOString() }
    expect(evaluateTimer(exactly, at(12 * 3600 * 1000)).needsReview).toBe(false)
  })

  it('plans a stop: rounds to the minute, refuses under 30 seconds and needs the reviewed minutes after an interruption', () => {
    const plan = (record: TimerRecord, ms: number, options: StopOptions = noStop) => planStop(record, at(ms), options)
    expect(plan({ ...base, accumulatedSeconds: 0 }, 29 * SEC)).toEqual({ ok: false, reason: 'too-short' })
    expect(plan({ ...base, accumulatedSeconds: 0 }, 30 * SEC)).toMatchObject({ ok: true, minutes: 1 })
    expect(plan({ ...base, accumulatedSeconds: 0 }, 89 * SEC)).toMatchObject({ ok: true, minutes: 1 })
    expect(plan({ ...base, accumulatedSeconds: 0 }, 90 * SEC)).toMatchObject({ ok: true, minutes: 2 })
    expect(plan({ ...base, accumulatedSeconds: 0, lastHeartbeatAt: at(12 * 3600 * 1000).toISOString() }, 12 * 3600 * 1000)).toMatchObject({ ok: true, minutes: 720 })

    const stale = { ...base, lastHeartbeatAt: at(60 * SEC).toISOString() }
    expect(plan(stale, 3 * 3600 * 1000)).toMatchObject({ ok: false, reason: 'needs-review' })
    expect(plan(stale, 3 * 3600 * 1000, { ...noStop, durationMinutesOverride: 15 })).toMatchObject({ ok: true, minutes: 15 })
    // Interrupted 20 seconds in: the reviewed minutes still save; without them it stays a review, not "too short".
    const earlyStale = { ...base, accumulatedSeconds: 0, lastHeartbeatAt: at(20 * SEC).toISOString() }
    expect(plan(earlyStale, 3 * 3600 * 1000)).toMatchObject({ ok: false, reason: 'needs-review' })
    expect(plan(earlyStale, 3 * 3600 * 1000, { ...noStop, durationMinutesOverride: 60 })).toMatchObject({ ok: true, minutes: 60 })
    expect(plan(stale, 3 * 3600 * 1000, { ...noStop, durationMinutesOverride: 0 })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(plan(stale, 3 * 3600 * 1000, { ...noStop, durationMinutesOverride: 721 })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(plan(base, SEC, { ...noStop, note: 'x'.repeat(TIME_NOTE_MAX + 1) })).toMatchObject({ ok: false, reason: 'invalid' })
  })
})

describe('CaseTimeRepository entries', () => {
  it('creates, lists newest first, edits and deletes entries', () => {
    const db = memoryDb()
    const clock = handClock()
    const repo = new CaseTimeRepository(db, clock)
    const { caseId } = seedCase(db)
    expect(repo.list(caseId)).toEqual([])
    expect(repo.list('00000000-0000-4000-8000-0000000000ff')).toEqual([])

    const first = saved(repo.create(caseId, { ...entry, note: '  trimmed  ' }))
    expect(first).toMatchObject({ caseId, workDate: '2026-10-28', durationMinutes: 90, activityType: 'research', note: 'trimmed', source: 'manual' })
    clock.advance(SEC)
    const later = saved(repo.create(caseId, { ...entry, workDate: '2026-10-30', durationMinutes: 30, activityType: null, note: null }))
    clock.advance(SEC)
    const sameDay = saved(repo.create(caseId, { ...entry, workDate: '2026-10-30', durationMinutes: 5 }))
    expect(repo.list(caseId).map((e) => e.id)).toEqual([sameDay.id, later.id, first.id])

    clock.advance(SEC)
    const edited = saved(repo.update(caseId, first.id, { ...entry, durationMinutes: 120, activityType: 'writing', note: null }))
    expect(edited).toMatchObject({ id: first.id, durationMinutes: 120, activityType: 'writing', note: null, source: 'manual', createdAt: first.createdAt })
    expect(edited.updatedAt).not.toBe(first.updatedAt)

    expect(repo.delete(caseId, later.id)).toEqual({ ok: true, entry: later })
    expect(repo.list(caseId).map((e) => e.id)).toEqual([sameDay.id, first.id])
    expect(repo.delete(caseId, later.id)).toEqual({ ok: false, reason: 'not-found' })
    expect(count(db, 'case_time_entries')).toBe(2)
  })

  it('rejects invalid input with issues and writes nothing', () => {
    const db = memoryDb()
    const repo = new CaseTimeRepository(db, handClock())
    const { caseId } = seedCase(db)
    const one = saved(repo.create(caseId, entry))
    for (const durationMinutes of [0, -30, 721, 1.5, Number.NaN]) {
      expect(repo.create(caseId, { ...entry, durationMinutes })).toMatchObject({ ok: false, reason: 'invalid' })
      expect(repo.update(caseId, one.id, { ...entry, durationMinutes })).toMatchObject({ ok: false, reason: 'invalid' })
    }
    expect(repo.create(caseId, { ...entry, durationMinutes: 720 }).ok).toBe(true)
    expect(count(db, 'case_time_entries')).toBe(2)
    expect(repo.list(caseId).find((e) => e.id === one.id)).toEqual(one)
  })

  it('scopes everything to the case and its client: entries never show under another case or client', () => {
    const db = memoryDb()
    const repo = new CaseTimeRepository(db, handClock())
    const a = seedCase(db, 'Case A', 'Ana Ejemplo')
    const a2 = seedCaseFor(db, a.clientId, 'Case A2')
    const b = seedCase(db, 'Case B', 'Beto Ejemplar')
    const inA = saved(repo.create(a.caseId, entry))
    saved(repo.create(b.caseId, { ...entry, durationMinutes: 45 }))

    expect(repo.list(a2).map((e) => e.id)).toEqual([])
    expect(repo.list(b.caseId).map((e) => e.durationMinutes)).toEqual([45])
    expect(repo.list(a.caseId)).toEqual([inA])
    for (const other of [b.caseId, a2]) {
      expect(repo.update(other, inA.id, entry)).toEqual({ ok: false, reason: 'not-found' })
      expect(repo.delete(other, inA.id)).toEqual({ ok: false, reason: 'not-found' })
    }
    expect(repo.list(a.caseId)).toEqual([inA])
    expect(summarizeEntries(repo.list(a.caseId), '2026-10-29').totalMinutes).toBe(90)
    expect(summarizeEntries(repo.list(b.caseId), '2026-10-29').totalMinutes).toBe(45)
  })

  it('stores the case’s client on each entry and refuses a mismatched or direct bad row', () => {
    const db = memoryDb()
    const repo = new CaseTimeRepository(db, handClock())
    const a = seedCase(db, 'Case A', 'Ana Ejemplo')
    const b = seedCase(db, 'Case B', 'Beto Ejemplar')
    const one = saved(repo.create(a.caseId, entry))
    expect(db.prepare('SELECT client_id FROM case_time_entries WHERE id = ?').get(one.id)).toEqual({ client_id: a.clientId })
    const insert = (caseId: string, clientId: string, minutes = 10) =>
      db
        .prepare(
          `INSERT INTO case_time_entries (id, case_id, client_id, work_date, duration_minutes, source, created_at, updated_at)
           VALUES (?, ?, ?, '2026-10-28', ?, 'manual', 'x', 'x')`
        )
        .run(crypto.randomUUID(), caseId, clientId, minutes)
    expect(() => insert(a.caseId, b.clientId)).toThrow(/client must be the case client/)
    expect(() => insert(a.caseId, a.clientId, 0)).toThrow()
    expect(() => insert(a.caseId, a.clientId, 721)).toThrow()
    expect(() => db.prepare('UPDATE case_time_entries SET case_id = ? WHERE id = ?').run(b.caseId, one.id)).toThrow(/immutable/)
    expect(() => db.prepare('UPDATE case_time_entries SET client_id = ? WHERE id = ?').run(b.clientId, one.id)).toThrow(/immutable/)
    expect(() => db.prepare('UPDATE case_time_entries SET source = ? WHERE id = ?').run('timer', one.id)).toThrow(/immutable/)
    expect(() => db.prepare("UPDATE case_time_entries SET activity_type = 'billing' WHERE id = ?").run(one.id)).toThrow()
  })

  it('treats archived cases and archived clients as read-only but keeps history visible', () => {
    const db = memoryDb()
    const repo = new CaseTimeRepository(db, handClock())
    const cases = new CaseRepository(db)
    const clients = new ClientRepository(db)
    const a = seedCase(db, 'Case A', 'Ana Ejemplo')
    const b = seedCase(db, 'Case B', 'Beto Ejemplar')
    const inA = saved(repo.create(a.caseId, entry))
    const inB = saved(repo.create(b.caseId, entry))

    expect(repo.create('00000000-0000-4000-8000-0000000000ff', entry)).toEqual({ ok: false, reason: 'not-found' })
    cases.archive(a.caseId)
    clients.archive(b.clientId)
    for (const [caseId, id] of [
      [a.caseId, inA.id],
      [b.caseId, inB.id]
    ] as const) {
      expect(repo.create(caseId, entry)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(repo.update(caseId, id, entry)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(repo.delete(caseId, id)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(repo.list(caseId)).toHaveLength(1)
    }
    cases.unarchive(a.caseId)
    expect(repo.update(a.caseId, inA.id, { ...entry, durationMinutes: 5 }).ok).toBe(true)
  })

  it('stores special characters verbatim and never builds SQL from input', () => {
    const db = memoryDb()
    const repo = new CaseTimeRepository(db, handClock())
    const { caseId } = seedCase(db)
    const note = 'Niño “Ángel” <script>alert(1)</script> \'; DROP TABLE case_time_entries; -- 🌽'
    saved(repo.create(caseId, { ...entry, note }))
    expect(repo.list(caseId)[0]?.note).toBe(note)
    expect(count(db, 'case_time_entries')).toBe(1)
  })
})

describe('CaseTimeRepository timer', () => {
  function setup() {
    const db = memoryDb()
    const clock = handClock()
    const repo = new CaseTimeRepository(db, clock)
    const a = seedCase(db, 'Case A', 'Ana Ejemplo')
    const b = seedCase(db, 'Case B', 'Beto Ejemplar')
    return { db, clock, repo, a, b }
  }

  it('has no timer at first; start, pause, resume and stop-and-save keep the count and save one entry', () => {
    const { db, clock, repo, a } = setup()
    expect(repo.getActiveTimer()).toBeNull()

    const started = running(repo.start(a.caseId))
    expect(started).toMatchObject({ caseId: a.caseId, state: 'running', version: 1, elapsedSeconds: 0, needsReview: false })
    clock.advance(100 * SEC)
    expect(repo.getActiveTimer()).toMatchObject({ elapsedSeconds: 100 })

    const paused = running(repo.pause(1))
    expect(paused).toMatchObject({ state: 'paused', version: 2, elapsedSeconds: 100 })
    clock.advance(3600 * 1000) // an hour paused counts for nothing
    expect(repo.getActiveTimer()).toMatchObject({ state: 'paused', elapsedSeconds: 100 })

    const resumed = running(repo.resume(2))
    expect(resumed).toMatchObject({ state: 'running', version: 3, elapsedSeconds: 100 })
    clock.advance(80 * SEC)
    expect(repo.getActiveTimer()).toMatchObject({ elapsedSeconds: 180 })

    const done = ok(repo.stopAndSave(3, { activityType: 'analysis', note: ' compared registers ', durationMinutesOverride: null }))
    expect(done.timer).toBeNull()
    expect(done.entry).toMatchObject({ caseId: a.caseId, durationMinutes: 3, activityType: 'analysis', note: 'compared registers', source: 'timer', workDate: '2026-10-29' })
    expect(repo.getActiveTimer()).toBeNull()
    expect(repo.list(a.caseId)).toEqual([done.entry])
    expect(count(db, 'case_active_timer')).toBe(0)
  })

  it('refuses a stale version so repeated clicks never act twice', () => {
    const { db, clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(120 * SEC)
    expect(ok(repo.pause(1)).timer?.version).toBe(2)
    for (const stale of [repo.pause(1), repo.resume(1), repo.stopAndSave(1, noStop), repo.discard(1), repo.heartbeat(1)]) {
      expect(stale).toMatchObject({ ok: false, reason: 'conflict', timer: { version: 2, state: 'paused' } })
    }
    expect(repo.getActiveTimer()).toMatchObject({ version: 2, state: 'paused' })

    ok(repo.resume(2))
    const first = ok(repo.stopAndSave(3, noStop))
    expect(first.entry).not.toBeNull()
    // The same click arriving again finds no timer: nothing is saved twice.
    expect(repo.stopAndSave(3, noStop)).toEqual({ ok: false, reason: 'not-found' })
    expect(repo.pause(3)).toEqual({ ok: false, reason: 'not-found' })
    expect(count(db, 'case_time_entries')).toBe(1)
  })

  it('answers pausing a paused timer or resuming a running one with wrong-status and no change', () => {
    const { clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(10 * SEC)
    expect(repo.resume(1)).toEqual({ ok: false, reason: 'wrong-status' })
    repo.pause(1)
    expect(repo.pause(2)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(repo.getActiveTimer()).toMatchObject({ version: 2 })
  })

  it('allows one timer at a time: another case is refused with the existing timer; the same case returns it unchanged', () => {
    const { clock, repo, a, b } = setup()
    const first = running(repo.start(a.caseId))
    clock.advance(5 * SEC)
    expect(repo.start(a.caseId)).toMatchObject({ ok: true, timer: { version: 1, startedAt: first.startedAt } })
    expect(repo.start(b.caseId)).toMatchObject({ ok: false, reason: 'other-case-timer', timer: { caseId: a.caseId } })
    expect(repo.getActiveTimer()).toMatchObject({ caseId: a.caseId, version: 1 })
    expect(repo.start('00000000-0000-4000-8000-0000000000ff')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('switches cases only by stopping and saving first, then starting', () => {
    const { clock, repo, a, b } = setup()
    repo.start(a.caseId)
    for (let i = 0; i < 10; i++) {
      clock.advance(MIN)
      repo.heartbeat(1)
    }
    const refusal = repo.start(b.caseId)
    expect(refusal.ok).toBe(false)
    const stopped = ok(repo.stopAndSave(1, noStop))
    expect(stopped.entry).toMatchObject({ caseId: a.caseId, durationMinutes: 10 })
    expect(running(repo.start(b.caseId))).toMatchObject({ caseId: b.caseId, version: 1 })
    expect(repo.list(a.caseId)).toHaveLength(1)
    expect(repo.list(b.caseId)).toEqual([])
  })

  it('refuses to save under 30 seconds but lets it be discarded', () => {
    const { db, clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(29 * SEC)
    expect(repo.stopAndSave(1, noStop)).toEqual({ ok: false, reason: 'too-short' })
    expect(repo.stopAndSave(1, { ...noStop, durationMinutesOverride: 10 })).toEqual({ ok: false, reason: 'too-short' })
    expect(repo.getActiveTimer()).toMatchObject({ version: 1 })
    expect(ok(repo.discard(1))).toMatchObject({ timer: null, entry: null })
    expect(repo.getActiveTimer()).toBeNull()
    expect(count(db, 'case_time_entries')).toBe(0)
  })

  it('rounds to the nearest minute and caps at 12 hours', () => {
    const { clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(89 * SEC)
    expect(ok(repo.stopAndSave(1, noStop)).entry?.durationMinutes).toBe(1)
    repo.start(a.caseId)
    clock.advance(91 * SEC)
    expect(ok(repo.stopAndSave(1, noStop)).entry?.durationMinutes).toBe(2)
  })

  it('rejects invalid stop options without touching the timer', () => {
    const { clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(120 * SEC)
    for (const options of [
      { ...noStop, note: 'x'.repeat(TIME_NOTE_MAX + 1) },
      { ...noStop, note: 'bad\u0000' },
      { ...noStop, activityType: 'billing' as never },
      { ...noStop, durationMinutesOverride: 0 },
      { ...noStop, durationMinutesOverride: -4 },
      { ...noStop, durationMinutesOverride: 721 },
      { ...noStop, durationMinutesOverride: 2.5 }
    ]) {
      expect(repo.stopAndSave(1, options)).toMatchObject({ ok: false, reason: 'invalid' })
    }
    expect(repo.getActiveTimer()).toMatchObject({ version: 1 })
    expect(repo.list(a.caseId)).toEqual([])
  })

  it('flags a missing heartbeat for review, never auto-saves it, and counts only the observed time', () => {
    const { db, clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(60 * SEC)
    expect(ok(repo.heartbeat(1)).timer).toMatchObject({ needsReview: false, elapsedSeconds: 60 })
    clock.advance(30 * SEC)
    repo.heartbeat(1)
    clock.advance(8 * 3600 * 1000) // the laptop slept overnight

    const flagged = repo.getActiveTimer()
    expect(flagged).toMatchObject({ needsReview: true, reviewReason: 'heartbeat-gap', suggestedSeconds: 90, version: 1 })
    // Nothing was committed by looking at it.
    expect(count(db, 'case_time_entries')).toBe(0)
    // A heartbeat must not launder the gap.
    expect(ok(repo.heartbeat(1)).timer).toMatchObject({ needsReview: true, suggestedSeconds: 90 })
    expect(repo.getActiveTimer()).toMatchObject({ needsReview: true, suggestedSeconds: 90 })
    // Pause, resume and a plain stop are blocked until it is reviewed.
    expect(repo.pause(1)).toMatchObject({ ok: false, reason: 'needs-review', timer: { suggestedSeconds: 90 } })
    expect(repo.stopAndSave(1, noStop)).toMatchObject({ ok: false, reason: 'needs-review' })
    expect(count(db, 'case_time_entries')).toBe(0)

    const reviewed = ok(repo.stopAndSave(1, { activityType: 'research', note: null, durationMinutesOverride: 2 }))
    expect(reviewed.entry).toMatchObject({ durationMinutes: 2, source: 'timer', workDate: '2026-10-29' })
    expect(repo.getActiveTimer()).toBeNull()
  })

  it('lets a flagged timer be discarded', () => {
    const { clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(6 * MIN)
    expect(repo.getActiveTimer()?.needsReview).toBe(true)
    expect(ok(repo.discard(1)).timer).toBeNull()
  })

  it('flags a wall clock that moved backwards and does not count the negative time', () => {
    const { clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(200 * SEC)
    repo.heartbeat(1)
    clock.set(START - 2 * 3600 * 1000) // clock set back two hours
    expect(repo.getActiveTimer()).toMatchObject({ needsReview: true, reviewReason: 'clock-moved-back', suggestedSeconds: 200 })
    expect(repo.pause(1)).toMatchObject({ ok: false, reason: 'needs-review' })
    expect(ok(repo.heartbeat(1)).timer?.needsReview).toBe(true)
    expect(repo.getActiveTimer()?.suggestedSeconds).toBe(200)
  })

  it('flags a timer past 12 hours even with steady heartbeats, suggesting at most 12 hours', () => {
    const { clock, repo, a } = setup()
    repo.start(a.caseId)
    for (let i = 0; i < 12 * 60; i++) {
      clock.advance(MIN)
      repo.heartbeat(1)
    }
    expect(repo.getActiveTimer()).toMatchObject({ needsReview: false, elapsedSeconds: 12 * 3600 })
    clock.advance(2 * MIN)
    repo.heartbeat(1)
    expect(repo.getActiveTimer()).toMatchObject({ needsReview: true, reviewReason: 'too-long', suggestedSeconds: 12 * 3600 })
    expect(repo.stopAndSave(1, noStop)).toMatchObject({ ok: false, reason: 'needs-review' })
  })

  it('does not review a paused timer however long it stays paused', () => {
    const { clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(90 * SEC)
    repo.pause(1)
    clock.advance(72 * 3600 * 1000)
    expect(repo.getActiveTimer()).toMatchObject({ needsReview: false, state: 'paused', elapsedSeconds: 90 })
    expect(ok(repo.resume(2)).timer).toMatchObject({ needsReview: false, elapsedSeconds: 90 })
  })

  it('keeps the timer when the case is archived, refuses to save or resume it, and still allows discarding', () => {
    const { db, clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(120 * SEC)
    repo.pause(1)
    new CaseRepository(db).archive(a.caseId)
    expect(repo.getActiveTimer()).toMatchObject({ caseId: a.caseId })
    expect(repo.resume(2)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(repo.stopAndSave(2, noStop)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(repo.start(a.caseId)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(ok(repo.discard(2)).timer).toBeNull()
    expect(count(db, 'case_time_entries')).toBe(0)
  })

  it('is stored as at most one row with consistent state', () => {
    const { db, repo, a, b } = setup()
    repo.start(a.caseId)
    const insert = (id: number, caseId: string, state: string, segment: string | null) =>
      db
        .prepare(
          `INSERT INTO case_active_timer (id, case_id, client_id, state, accumulated_seconds, segment_started_at, last_heartbeat_at, started_at, version)
           SELECT ?, c.id, c.client_id, ?, 0, ?, 'x', 'x', 1 FROM research_cases c WHERE c.id = ?`
        )
        .run(id, state, segment, caseId)
    expect(() => insert(2, b.caseId, 'running', 'x')).toThrow()
    expect(() => insert(1, b.caseId, 'running', 'x')).toThrow()
    db.exec('DELETE FROM case_active_timer')
    expect(() => insert(1, b.caseId, 'running', null)).toThrow()
    expect(() => insert(1, b.caseId, 'paused', 'x')).toThrow()
    expect(() => insert(1, b.caseId, 'idle', null)).toThrow()
    expect(() => insert(1, b.caseId, 'paused', null)).not.toThrow()
  })

  it('rolls the entry back if the timer cannot be removed (one transaction)', () => {
    const { db, clock, repo, a } = setup()
    repo.start(a.caseId)
    clock.advance(120 * SEC)
    db.exec('CREATE TRIGGER block_timer_delete BEFORE DELETE ON case_active_timer BEGIN SELECT RAISE(ABORT, \'blocked\'); END')
    expect(() => repo.stopAndSave(1, noStop)).toThrow()
    expect(count(db, 'case_time_entries')).toBe(0)
    expect(repo.getActiveTimer()).toMatchObject({ version: 1, caseId: a.caseId })
    db.exec('DROP TRIGGER block_timer_delete')
    expect(ok(repo.stopAndSave(1, noStop)).entry).not.toBeNull()
  })
})

describe('timer across a restart', () => {
  it('keeps a running and a paused timer when the database is closed and reopened', () => {
    const clock = handClock()
    const first = openAppDatabase(userData, () => clock.now())
    const { caseId } = seedCase(first.db)
    const repo = new CaseTimeRepository(first.db, clock)
    repo.start(caseId)
    clock.advance(100 * SEC)
    repo.heartbeat(1)
    first.db.close()

    // The host comes back 30 seconds later: the heartbeat is recent, the count continues.
    clock.advance(30 * SEC)
    const second = openAppDatabase(userData, () => clock.now())
    const again = new CaseTimeRepository(second.db, clock)
    expect(again.getActiveTimer()).toMatchObject({ caseId, state: 'running', version: 1, needsReview: false, elapsedSeconds: 130 })
    again.pause(1)
    second.db.close()

    clock.advance(24 * 3600 * 1000)
    const third = openAppDatabase(userData, () => clock.now())
    const paused = new CaseTimeRepository(third.db, clock).getActiveTimer()
    expect(paused).toMatchObject({ caseId, state: 'paused', version: 2, needsReview: false, elapsedSeconds: 130 })
    third.db.close()
  })

  it('asks for review when the host was down for longer than five minutes while running', () => {
    const clock = handClock()
    const first = openAppDatabase(userData, () => clock.now())
    const { caseId } = seedCase(first.db)
    new CaseTimeRepository(first.db, clock).start(caseId)
    clock.advance(45 * SEC)
    new CaseTimeRepository(first.db, clock).heartbeat(1)
    first.db.close()

    clock.advance(9 * 3600 * 1000)
    const second = openAppDatabase(userData, () => clock.now())
    const repo = new CaseTimeRepository(second.db, clock)
    expect(repo.getActiveTimer()).toMatchObject({ needsReview: true, reviewReason: 'heartbeat-gap', suggestedSeconds: 45 })
    expect(count(second.db, 'case_time_entries')).toBe(0)
    second.db.close()
  })
})

describe('migration 7 (case_time_entries, case_active_timer)', () => {
  const v6 = migrations.slice(0, 6)

  function buildV6Profile(): string {
    const dir = dataDirectory(userData)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, DATABASE_FILE_NAME)
    const db = new DatabaseSync(file)
    configureConnection(db)
    migrate(db, {}, v6)
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    const { caseId } = seedCase(db, 'Existing case', 'Active Client')
    db.prepare(
      `INSERT INTO case_tasks (id, case_id, title, description, status, due_date, completed_at, created_at, updated_at)
       VALUES (?, ?, 'Existing task', NULL, 'pending', NULL, NULL, 'x', 'x')`
    ).run(crypto.randomUUID(), caseId)
    expect(getSchemaVersion(db)).toBe(6)
    db.close()
    return file
  }

  const dump = (db: DatabaseSync) => ({
    clients: db.prepare('SELECT * FROM clients ORDER BY id').all(),
    cases: db.prepare('SELECT * FROM research_cases ORDER BY id').all(),
    events: db.prepare('SELECT * FROM case_events ORDER BY rowid').all(),
    tasks: db.prepare('SELECT * FROM case_tasks ORDER BY id').all()
  })

  it('upgrades a real v6 database: everything identical, no hours or timer, copy written first', () => {
    const file = buildV6Profile()
    const old = new DatabaseSync(file)
    const before = dump(old)
    old.close()
    expect(before.cases).toHaveLength(1)
    expect(before.tasks).toHaveLength(1)

    const opened = openAppDatabase(userData, () => new Date('2026-10-29T12:00:00.000Z'))
    try {
      expect(opened.migration).toEqual({ from: 6, to: migrations.length })
      expect(migrations[6]?.name).toBe('case_time')
      expect(dump(opened.db)).toEqual(before)
      expect(count(opened.db, 'case_time_entries')).toBe(0)
      expect(count(opened.db, 'case_active_timer')).toBe(0)
      expect(opened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect((opened.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')

      const repo = new CaseTimeRepository(opened.db)
      const caseId = (before.cases as { id: string }[])[0]!.id
      expect(repo.create(caseId, entry).ok).toBe(true)
      expect(repo.start(caseId).ok).toBe(true)
    } finally {
      opened.db.close()
    }

    const copies = readdirSync(join(dataDirectory(userData), 'pre-migration'))
    expect(copies).toEqual([`${DATABASE_FILE_NAME}.v6.2026-10-29T12-00-00-000Z.sqlite`])
    const copy = new DatabaseSync(join(dataDirectory(userData), 'pre-migration', copies[0]!), { readOnly: true })
    expect(getSchemaVersion(copy)).toBe(6)
    copy.close()
  })

  it('upgrades an empty-history database from v1 through every migration', () => {
    const db = new DatabaseSync(':memory:')
    configureConnection(db)
    migrate(db, {}, migrations.slice(0, 1))
    expect(migrate(db)).toEqual({ from: 1, to: migrations.length })
    expect(count(db, 'case_time_entries')).toBe(0)
  })
})

describe('backup and restore with hours', () => {
  let root: string
  let data: AppData

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-time-backup-'))
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

  function seed(title: string): string {
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

  it('keeps entries and a paused timer through a backup round trip, replacing changes made since', () => {
    const kept = seed('Kept')
    saved(data.time.create(kept, entry))
    saved(data.time.create(kept, { ...entry, workDate: '2026-10-27', durationMinutes: 15, activityType: null, note: null }))
    data.time.start(kept)
    const paused = running(data.time.pause(1))
    const listed = data.time.list(kept)
    const file = join(root, 'backup.tgbackup')
    expect(data.createBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })

    const later = seed('Later')
    saved(data.time.create(later, entry))
    data.time.discard(paused.version)
    saved(data.time.create(kept, { ...entry, durationMinutes: 1 }))

    data.restoreBackup(file)
    expect(data.time.list(kept)).toEqual(listed)
    expect(data.time.list(later)).toEqual([])
    expect(count(data.db, 'case_time_entries')).toBe(2)
    expect(data.time.getActiveTimer()).toMatchObject({ caseId: kept, state: 'paused', version: 2 })
    expect(data.time.create(kept, entry).ok).toBe(true)
  })

  it('restores a v6 backup into the current schema, with cases and no hours', () => {
    const file = join(root, 'old.tgbackup')
    const old = new DatabaseSync(file)
    configureConnection(old)
    migrate(old, {}, migrations.slice(0, 6))
    old.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    const { caseId } = seedCase(old, 'Older case', 'Older Backup Client')
    old.exec('PRAGMA journal_mode = DELETE')
    old.close()
    expect(inspectBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: 6 })

    const current = seed('Current case')
    saved(data.time.create(current, entry))
    data.time.start(current)

    expect(data.restoreBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })
    expect(count(data.db, 'case_time_entries')).toBe(0)
    expect(data.time.getActiveTimer()).toBeNull()
    expect(data.time.create(caseId, entry).ok).toBe(true)
    expect(existsSync(join(dataDirectory(join(root, 'profile')), 'pre-restore'))).toBe(true)
  })
})
