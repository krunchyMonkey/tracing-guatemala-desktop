// Case research hours rules (case-time/v1, docs/case-research-hours.md): saved time
// entries (manual or from the timer) and the single recoverable pending timer.
// Shared by the host's repository (authoritative) and the browser (instant
// feedback, demo). No Node imports: the renderer bundles this file. Work dates are
// local calendar dates (YYYY-MM-DD), compared as plain calendar values.
// Activity types are provisional until the researcher review (#21).

import { checkDateOnly, daysBetween } from './case-model'

export const TIME_MIN_MINUTES = 1
/** 12 hours: anything longer must be split or reviewed by hand. */
export const TIME_MAX_MINUTES = 720
export const TIME_NOTE_MAX = 500
/** A timer session shorter than this cannot be saved (it can be discarded). */
export const TIMER_MIN_SECONDS = 30
export const TIMER_MAX_SECONDS = TIME_MAX_MINUTES * 60
/** A running timer whose last heartbeat is older than this needs review. */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000
/** How often the open page tells the host the timer is still being watched. */
export const HEARTBEAT_INTERVAL_MS = 30 * 1000

export const ACTIVITY_TYPES = ['research', 'correspondence', 'analysis', 'writing', 'other'] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]
export type TimeSource = 'timer' | 'manual'

export interface TimeEntry {
  id: string
  caseId: string
  /** 'YYYY-MM-DD' local calendar date, no time zone. */
  workDate: string
  durationMinutes: number
  activityType: ActivityType | null
  note: string | null
  source: TimeSource
  createdAt: string
  updatedAt: string
}

/** What the browser may send for an entry. Strict: ids, source and write times are never accepted. */
export interface TimeEntryInput {
  workDate: string
  durationMinutes: number
  activityType: ActivityType | null
  note: string | null
}

export type TimeIssueCode =
  | 'required'
  | 'too-long'
  | 'too-short'
  | 'invalid-characters'
  | 'invalid-format'
  | 'invalid-date'
  | 'invalid-value'

/** A rule outcome. Carries only a field name and a code, never the submitted value. */
export interface TimeIssue {
  field: keyof TimeEntryInput
  code: TimeIssueCode
}

export interface TimeEntryCheck {
  input: TimeEntryInput | null
  issues: TimeIssue[]
}

export type TimeEntryMutationResult =
  | { ok: true; entry: TimeEntry }
  | { ok: false; reason: 'invalid'; issues: TimeIssue[] }
  /** The case, or the entry within that case, does not exist. */
  | { ok: false; reason: 'not-found' }
  /** The case or its client is archived. */
  | { ok: false; reason: 'wrong-status' }

const CONTROL_CHARS = /\p{Cc}/u

/** Whole minutes only, 1 to 720. Null when fine. */
export function checkDuration(minutes: number): 'invalid-format' | 'too-short' | 'too-long' | null {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes)) return 'invalid-format'
  if (minutes < TIME_MIN_MINUTES) return 'too-short'
  if (minutes > TIME_MAX_MINUTES) return 'too-long'
  return null
}

export function checkActivityType(value: unknown): value is ActivityType | null {
  return value === null || (typeof value === 'string' && (ACTIVITY_TYPES as readonly string[]).includes(value))
}

function checkNote(raw: string | null): { note: string | null; problem: 'too-long' | 'invalid-characters' | null } {
  const trimmed = (raw ?? '').replace(/\r\n/g, '\n').trim()
  const note = trimmed === '' ? null : trimmed
  if (note === null) return { note, problem: null }
  if (note.length > TIME_NOTE_MAX) return { note, problem: 'too-long' }
  if (CONTROL_CHARS.test(note.replace(/[\n\t]/g, ''))) return { note, problem: 'invalid-characters' }
  return { note, problem: null }
}

/** Normalize and validate an entry draft. `input` is null whenever there is an issue. */
export function checkTimeEntry(raw: TimeEntryInput): TimeEntryCheck {
  const issues: TimeIssue[] = []
  const issue = (field: TimeIssue['field'], code: TimeIssueCode) => issues.push({ field, code })

  const workDate = (raw.workDate ?? '').trim()
  if (workDate === '') issue('workDate', 'required')
  else {
    const problem = checkDateOnly(workDate)
    if (problem) issue('workDate', problem)
  }

  const durationProblem = checkDuration(raw.durationMinutes)
  if (durationProblem) issue('durationMinutes', durationProblem)

  const activityType = raw.activityType ?? null
  if (!checkActivityType(activityType)) issue('activityType', 'invalid-value')

  const { note, problem } = checkNote(raw.note)
  if (problem) issue('note', problem)

  return {
    issues,
    input: issues.length > 0 ? null : { workDate, durationMinutes: raw.durationMinutes, activityType, note }
  }
}

/** Newest work date first, then newest created, then id. */
export function compareEntries(a: TimeEntry, b: TimeEntry): number {
  return b.workDate.localeCompare(a.workDate) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
}

/** Whole minutes from a number of seconds, to the nearest minute (30 s rounds up). */
export function roundToMinutes(seconds: number): number {
  return Math.round(seconds / 60)
}

/** "2:05" for 125 minutes. */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  return `${h}:${String(minutes % 60).padStart(2, '0')}`
}

/** "1:02:03" for 3723 seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  return `${h}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** Monday of the ISO week containing the YYYY-MM-DD date, as YYYY-MM-DD. */
export function isoWeekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(y, m - 1, d))
  const sinceMonday = (utc.getUTCDay() + 6) % 7
  utc.setUTCDate(utc.getUTCDate() - sinceMonday)
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`
}

export interface TimeTotals {
  totalMinutes: number
  weekMinutes: number
  monthMinutes: number
}

/**
 * Totals for the entries given (callers pass one case's entries only). The week
 * is the ISO week (Monday to Sunday) and the month the calendar month of local
 * today.
 */
export function summarizeEntries(entries: readonly Pick<TimeEntry, 'workDate' | 'durationMinutes'>[], localToday: string): TimeTotals {
  const weekStart = isoWeekStart(localToday)
  const month = localToday.slice(0, 7)
  let totalMinutes = 0
  let weekMinutes = 0
  let monthMinutes = 0
  for (const entry of entries) {
    totalMinutes += entry.durationMinutes
    const sinceWeekStart = daysBetween(weekStart, entry.workDate)
    if (sinceWeekStart >= 0 && sinceWeekStart <= 6) weekMinutes += entry.durationMinutes
    if (entry.workDate.startsWith(month)) monthMinutes += entry.durationMinutes
  }
  return { totalMinutes, weekMinutes, monthMinutes }
}

// ---------------------------------------------------------------------------
// The pending timer

export type TimerState = 'running' | 'paused'

/** The stored timer row, as the repository reads it. */
export interface TimerRecord {
  caseId: string
  state: TimerState
  accumulatedSeconds: number
  /** ISO time the running segment began; null while paused. */
  segmentStartedAt: string | null
  lastHeartbeatAt: string
  startedAt: string
  version: number
}

export type ReviewReason = 'heartbeat-gap' | 'clock-moved-back' | 'too-long'

/** What the browser sees: elapsed time is computed by the host, never trusted from the browser. */
export interface TimerSnapshot {
  caseId: string
  state: TimerState
  version: number
  startedAt: string
  /** Seconds counted so far at the moment of this reply (the suggestion while needsReview). */
  elapsedSeconds: number
  /** True when the host cannot vouch for the running time; the person must review it. */
  needsReview: boolean
  reviewReason: ReviewReason | null
  /** Seconds that were observed (never includes the unobserved gap); null unless needsReview. */
  suggestedSeconds: number | null
}

/**
 * The timer as of `now`. A running timer is flagged for review (never auto-saved)
 * when its heartbeat is stale, the wall clock moved backwards, or it ran past 12
 * hours. The suggestion is the counted time up to the last heartbeat only.
 */
export function evaluateTimer(record: TimerRecord, now: Date): TimerSnapshot {
  const base = { caseId: record.caseId, state: record.state, version: record.version, startedAt: record.startedAt }
  if (record.state === 'paused' || record.segmentStartedAt === null) {
    return { ...base, elapsedSeconds: record.accumulatedSeconds, needsReview: false, reviewReason: null, suggestedSeconds: null }
  }
  const nowMs = now.getTime()
  const segmentMs = Date.parse(record.segmentStartedAt)
  const heartbeatMs = Date.parse(record.lastHeartbeatAt)
  const elapsed = record.accumulatedSeconds + Math.max(0, Math.floor((nowMs - segmentMs) / 1000))

  let reviewReason: ReviewReason | null = null
  if (nowMs < segmentMs || nowMs < heartbeatMs) reviewReason = 'clock-moved-back'
  else if (nowMs - heartbeatMs > HEARTBEAT_STALE_MS) reviewReason = 'heartbeat-gap'
  else if (elapsed > TIMER_MAX_SECONDS) reviewReason = 'too-long'

  if (reviewReason === null) return { ...base, elapsedSeconds: elapsed, needsReview: false, reviewReason: null, suggestedSeconds: null }
  const observed = record.accumulatedSeconds + Math.max(0, Math.floor((heartbeatMs - segmentMs) / 1000))
  const suggestedSeconds = Math.min(observed, TIMER_MAX_SECONDS)
  return { ...base, elapsedSeconds: suggestedSeconds, needsReview: true, reviewReason, suggestedSeconds }
}

export interface StopOptions {
  activityType: ActivityType | null
  note: string | null
  /** The reviewed minutes; required when the timer needs review. */
  durationMinutesOverride: number | null
}

export type TimerResult =
  | { ok: true; timer: TimerSnapshot | null; entry: TimeEntry | null }
  /** The version is stale (the timer was changed elsewhere, or this was a repeated click). */
  | { ok: false; reason: 'conflict'; timer: TimerSnapshot | null }
  /** Start only: a timer already exists for another case. */
  | { ok: false; reason: 'other-case-timer'; timer: TimerSnapshot }
  | { ok: false; reason: 'invalid'; issues: TimeIssue[] }
  /** No timer, or no such case. */
  | { ok: false; reason: 'not-found' }
  /** The case or its client is archived, or the timer is already in the requested state. */
  | { ok: false; reason: 'wrong-status' }
  /** The running time can't be vouched for: review it first (stop with the reviewed minutes, or discard). */
  | { ok: false; reason: 'needs-review'; timer: TimerSnapshot }
  /** Under 30 seconds: discard it instead. */
  | { ok: false; reason: 'too-short' }

/** Validates the stop options (the entry range check applies to a reviewed duration). */
export function checkStopOptions(options: StopOptions): TimeIssue[] {
  const issues: TimeIssue[] = []
  if (!checkActivityType(options.activityType)) issues.push({ field: 'activityType', code: 'invalid-value' })
  const { problem } = checkNote(options.note)
  if (problem) issues.push({ field: 'note', code: problem })
  if (options.durationMinutesOverride !== null) {
    const durationProblem = checkDuration(options.durationMinutesOverride)
    if (durationProblem) issues.push({ field: 'durationMinutes', code: durationProblem })
  }
  return issues
}

/** Normalized note for storing (trimmed, null when empty). Call after checkStopOptions. */
export function normalizeNote(raw: string | null): string | null {
  return checkNote(raw).note
}

// Pure transitions, shared by the SQLite repository and the demo's in-memory timer.

export function newTimerRecord(caseId: string, now: Date): TimerRecord {
  const at = now.toISOString()
  return { caseId, state: 'running', accumulatedSeconds: 0, segmentStartedAt: at, lastHeartbeatAt: at, startedAt: at, version: 1 }
}

/** Pausing counts the running segment so far. Callers refuse it first when the timer needs review. */
export function pausedRecord(record: TimerRecord, now: Date): TimerRecord {
  return {
    ...record,
    state: 'paused',
    accumulatedSeconds: evaluateTimer(record, now).elapsedSeconds,
    segmentStartedAt: null,
    lastHeartbeatAt: now.toISOString(),
    version: record.version + 1
  }
}

export function resumedRecord(record: TimerRecord, now: Date): TimerRecord {
  const at = now.toISOString()
  return { ...record, state: 'running', segmentStartedAt: at, lastHeartbeatAt: at, version: record.version + 1 }
}

/** A heartbeat only records that the page is still watching; it is not a state change, so the version stays. */
export function heartbeatRecord(record: TimerRecord, now: Date): TimerRecord {
  return { ...record, lastHeartbeatAt: now.toISOString() }
}

export type StopPlan =
  | { ok: true; minutes: number; workedAt: Date }
  | { ok: false; reason: 'invalid'; issues: TimeIssue[] }
  | { ok: false; reason: 'needs-review'; timer: TimerSnapshot }
  | { ok: false; reason: 'too-short' }

/**
 * What stopping and saving would record. A timer that needs review is only saved
 * with the reviewed minutes. Under 30 seconds of counted time is never saved.
 * `workedAt` decides the work date: the last observed moment.
 */
export function planStop(record: TimerRecord, now: Date, options: StopOptions): StopPlan {
  const issues = checkStopOptions(options)
  if (issues.length > 0) return { ok: false, reason: 'invalid', issues }
  const snapshot = evaluateTimer(record, now)
  if (snapshot.needsReview && options.durationMinutesOverride === null) return { ok: false, reason: 'needs-review', timer: snapshot }
  // A reviewed duration is the person's own figure, so the 30-second floor only guards counted time.
  const reviewed = snapshot.needsReview && options.durationMinutesOverride !== null
  if (!reviewed && snapshot.elapsedSeconds < TIMER_MIN_SECONDS) return { ok: false, reason: 'too-short' }
  const minutes = options.durationMinutesOverride ?? Math.max(TIME_MIN_MINUTES, roundToMinutes(snapshot.elapsedSeconds))
  return { ok: true, minutes, workedAt: snapshot.needsReview ? new Date(Date.parse(record.lastHeartbeatAt)) : now }
}
