import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { localDateString } from '../../shared/case-model'
import {
  checkTimeEntry,
  compareEntries,
  evaluateTimer,
  heartbeatRecord,
  newTimerRecord,
  normalizeNote,
  pausedRecord,
  planStop,
  resumedRecord,
  type ActivityType,
  type StopOptions,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryMutationResult,
  type TimerRecord,
  type TimerResult,
  type TimerSnapshot,
  type TimerState,
  type TimeSource
} from '../../shared/case-time'
import type { RepositoryClock } from './client-repository'

// Case research hours persistence (case-time/v1): saved time entries and the one
// pending timer. Every write runs in one BEGIN IMMEDIATE transaction that reads
// the case and its client, checks the rules and writes, so a refused write leaves
// no trace. Every query is scoped by case id AND client id. Order of checks:
// case not found, then case or client archived, then the entry (or timer) must
// exist, then the timer's version, then input. All SQL is parameterized and
// nothing submitted is ever echoed back. The timer's version bumps on every state
// change, so a repeated or stale request returns a conflict instead of acting twice.
// A heartbeat is not a state change and keeps the version.

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

interface EntryRow {
  id: string
  case_id: string
  client_id: string
  work_date: string
  duration_minutes: number
  activity_type: ActivityType | null
  note: string | null
  source: TimeSource
  created_at: string
  updated_at: string
}

interface TimerRow {
  case_id: string
  client_id: string
  state: TimerState
  accumulated_seconds: number
  segment_started_at: string | null
  last_heartbeat_at: string
  started_at: string
  version: number
}

function toEntry(row: EntryRow): TimeEntry {
  return {
    id: row.id,
    caseId: row.case_id,
    workDate: row.work_date,
    durationMinutes: row.duration_minutes,
    activityType: row.activity_type,
    note: row.note,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toRecord(row: TimerRow): TimerRecord {
  return {
    caseId: row.case_id,
    state: row.state,
    accumulatedSeconds: row.accumulated_seconds,
    segmentStartedAt: row.segment_started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    version: row.version
  }
}

interface CaseScope {
  clientId: string
}

export class CaseTimeRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  // ---- entries --------------------------------------------------------------

  /** Newest work date first; empty for an unknown case. Only this case's entries (and its client's). */
  list(caseId: string): TimeEntry[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM case_time_entries e JOIN research_cases c ON c.id = e.case_id AND c.client_id = e.client_id
         WHERE e.case_id = ?`
      )
      .all(caseId) as unknown as EntryRow[]
    return rows.map(toEntry).sort(compareEntries)
  }

  create(caseId: string, raw: TimeEntryInput): TimeEntryMutationResult {
    return this.transaction(() => {
      const scope = this.checkCase(caseId)
      if ('ok' in scope) return scope
      const { input, issues } = checkTimeEntry(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }
      const now = this.clock.now().toISOString()
      const entry = this.insertEntry(caseId, scope.clientId, input, 'manual', now)
      this.touchCase(caseId, now)
      return { ok: true, entry }
    })
  }

  update(caseId: string, entryId: string, raw: TimeEntryInput): TimeEntryMutationResult {
    return this.transaction(() => {
      const scope = this.checkCase(caseId)
      if ('ok' in scope) return scope
      if (!this.entryRow(caseId, scope.clientId, entryId)) return { ok: false, reason: 'not-found' }
      const { input, issues } = checkTimeEntry(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const now = this.clock.now().toISOString()
      this.db
        .prepare(
          `UPDATE case_time_entries SET work_date = ?, duration_minutes = ?, activity_type = ?, note = ?, updated_at = ?
           WHERE id = ? AND case_id = ? AND client_id = ?`
        )
        .run(input.workDate, input.durationMinutes, input.activityType, input.note, now, entryId, caseId, scope.clientId)
      this.touchCase(caseId, now)
      return { ok: true, entry: toEntry(this.entryRow(caseId, scope.clientId, entryId)!) }
    })
  }

  /** Removes the entry for good and returns it as it was. The browser asks for confirmation first. */
  delete(caseId: string, entryId: string): TimeEntryMutationResult {
    return this.transaction(() => {
      const scope = this.checkCase(caseId)
      if ('ok' in scope) return scope
      const row = this.entryRow(caseId, scope.clientId, entryId)
      if (!row) return { ok: false, reason: 'not-found' }
      this.db.prepare('DELETE FROM case_time_entries WHERE id = ? AND case_id = ? AND client_id = ?').run(entryId, caseId, scope.clientId)
      this.touchCase(caseId, this.clock.now().toISOString())
      return { ok: true, entry: toEntry(row) }
    })
  }

  // ---- the pending timer ----------------------------------------------------

  /** The pending timer as of now, flagged for review when its running time can't be vouched for; or null. */
  getActiveTimer(): TimerSnapshot | null {
    const row = this.timerRow()
    return row ? evaluateTimer(toRecord(row), this.clock.now()) : null
  }

  /** Starts a timer on the case. The same case's existing timer is returned unchanged; another case's is a refusal. */
  start(caseId: string): TimerResult {
    return this.timerTransaction(() => {
      const scope = this.checkCase(caseId)
      if ('ok' in scope) return scope
      const now = this.clock.now()
      const existing = this.timerRow()
      if (existing) {
        const snapshot = evaluateTimer(toRecord(existing), now)
        return existing.case_id === caseId && existing.client_id === scope.clientId
          ? { ok: true, timer: snapshot, entry: null }
          : { ok: false, reason: 'other-case-timer', timer: snapshot }
      }
      const record = newTimerRecord(caseId, now)
      this.db
        .prepare(
          `INSERT INTO case_active_timer (id, case_id, client_id, state, accumulated_seconds, segment_started_at, last_heartbeat_at, started_at, version)
           VALUES (1, ?, ?, 'running', 0, ?, ?, ?, 1)`
        )
        .run(caseId, scope.clientId, record.segmentStartedAt, record.lastHeartbeatAt, record.startedAt)
      return { ok: true, timer: evaluateTimer(record, now), entry: null }
    })
  }

  pause(version: number): TimerResult {
    return this.timerTransaction(() => {
      const found = this.expectTimer(version)
      if ('ok' in found) return found
      const { record, now } = found
      if (record.state === 'paused') return { ok: false, reason: 'wrong-status' }
      const snapshot = evaluateTimer(record, now)
      if (snapshot.needsReview) return { ok: false, reason: 'needs-review', timer: snapshot }
      return this.saveTimer(pausedRecord(record, now), now)
    })
  }

  resume(version: number): TimerResult {
    return this.timerTransaction(() => {
      const found = this.expectTimer(version)
      if ('ok' in found) return found
      const { record, now } = found
      if (record.state === 'running') return { ok: false, reason: 'wrong-status' }
      const blocked = this.checkCase(record.caseId)
      if ('ok' in blocked) return blocked
      return this.saveTimer(resumedRecord(record, now), now)
    })
  }

  /** Records the page is still watching a running timer. A timer that needs review is never refreshed: that would hide the gap. */
  heartbeat(version: number): TimerResult {
    return this.timerTransaction(() => {
      const found = this.expectTimer(version)
      if ('ok' in found) return found
      const { record, now } = found
      const snapshot = evaluateTimer(record, now)
      if (record.state === 'paused' || snapshot.needsReview) return { ok: true, timer: snapshot, entry: null }
      const next = heartbeatRecord(record, now)
      this.db.prepare('UPDATE case_active_timer SET last_heartbeat_at = ? WHERE id = 1 AND version = ?').run(next.lastHeartbeatAt, version)
      return { ok: true, timer: evaluateTimer(next, now), entry: null }
    })
  }

  /** Inserts the entry and deletes the timer in one transaction. */
  stopAndSave(version: number, options: StopOptions): TimerResult {
    return this.timerTransaction(() => {
      const found = this.expectTimer(version)
      if ('ok' in found) return found
      const { record, now } = found
      const scope = this.checkCase(record.caseId)
      if ('ok' in scope) return scope
      const plan = planStop(record, now, options)
      if (!plan.ok) return plan

      const at = now.toISOString()
      const entry = this.insertEntry(
        record.caseId,
        scope.clientId,
        {
          workDate: localDateString(plan.workedAt),
          durationMinutes: plan.minutes,
          activityType: options.activityType,
          note: normalizeNote(options.note)
        },
        'timer',
        at
      )
      this.db.prepare('DELETE FROM case_active_timer WHERE id = 1').run()
      this.touchCase(record.caseId, at)
      return { ok: true, timer: null, entry }
    })
  }

  /** Throws the pending time away. Allowed whatever the timer's state or the case's status. */
  discard(version: number): TimerResult {
    return this.timerTransaction(() => {
      const found = this.expectTimer(version)
      if ('ok' in found) return found
      this.db.prepare('DELETE FROM case_active_timer WHERE id = 1').run()
      return { ok: true, timer: null, entry: null }
    })
  }

  // ---- internals ------------------------------------------------------------

  private transaction(work: () => TimeEntryMutationResult): TimeEntryMutationResult {
    return this.inTransaction(work)
  }

  private timerTransaction(work: () => TimerResult): TimerResult {
    return this.inTransaction(work)
  }

  private inTransaction<T>(work: () => T): T {
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

  /** The case's client when the case can be written to; otherwise the refusal. */
  private checkCase(caseId: string): CaseScope | { ok: false; reason: 'not-found' | 'wrong-status' } {
    const row = this.db
      .prepare(
        `SELECT c.client_id AS client_id, c.archived_at AS case_archived_at, k.status AS client_status
         FROM research_cases c JOIN clients k ON k.id = c.client_id WHERE c.id = ?`
      )
      .get(caseId) as { client_id: string; case_archived_at: string | null; client_status: string } | undefined
    if (!row) return { ok: false, reason: 'not-found' }
    if (row.client_status !== 'active' || row.case_archived_at !== null) return { ok: false, reason: 'wrong-status' }
    return { clientId: row.client_id }
  }

  private touchCase(caseId: string, at: string): void {
    this.db.prepare('UPDATE research_cases SET updated_at = ? WHERE id = ?').run(at, caseId)
  }

  private insertEntry(caseId: string, clientId: string, input: TimeEntryInput, source: TimeSource, at: string): TimeEntry {
    const id = this.clock.newId()
    this.db
      .prepare(
        `INSERT INTO case_time_entries (id, case_id, client_id, work_date, duration_minutes, activity_type, note, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, caseId, clientId, input.workDate, input.durationMinutes, input.activityType, input.note, source, at, at)
    return toEntry(this.entryRow(caseId, clientId, id)!)
  }

  private entryRow(caseId: string, clientId: string, entryId: string): EntryRow | undefined {
    return this.db
      .prepare('SELECT * FROM case_time_entries WHERE id = ? AND case_id = ? AND client_id = ?')
      .get(entryId, caseId, clientId) as EntryRow | undefined
  }

  private timerRow(): TimerRow | undefined {
    return this.db.prepare('SELECT * FROM case_active_timer WHERE id = 1').get() as TimerRow | undefined
  }

  /** The timer when it exists and `version` is current; otherwise the refusal. */
  private expectTimer(version: number): { record: TimerRecord; now: Date } | Extract<TimerResult, { ok: false }> {
    const row = this.timerRow()
    const now = this.clock.now()
    if (!row) return { ok: false, reason: 'not-found' }
    const record = toRecord(row)
    if (record.version !== version) return { ok: false, reason: 'conflict', timer: evaluateTimer(record, now) }
    return { record, now }
  }

  private saveTimer(next: TimerRecord, now: Date): TimerResult {
    this.db
      .prepare(
        `UPDATE case_active_timer SET state = ?, accumulated_seconds = ?, segment_started_at = ?, last_heartbeat_at = ?, version = ?
         WHERE id = 1 AND version = ?`
      )
      .run(next.state, next.accumulatedSeconds, next.segmentStartedAt, next.lastHeartbeatAt, next.version, next.version - 1)
    return { ok: true, timer: evaluateTimer(next, now), entry: null }
  }
}
