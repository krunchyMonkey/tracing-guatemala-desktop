// Research Studio summary (studio-summary/v1, #116): one read-only aggregate for the
// Home dashboard, so the page makes a single call instead of one per case. Shared by
// the host's repository (SQL, authoritative) and the demo (buildStudioSummary over
// in-memory fixtures). No Node imports: the renderer bundles this file.
//
// Privacy: every list item carries only ids, titles, the client's display name, a state,
// dates and a short fixed label. Note, journal and task bodies, emails and contacts never
// appear. Archived clients and archived cases are excluded everywhere. Dates are local
// calendar dates (YYYY-MM-DD) compared as plain calendar values, never through UTC.

import {
  CASE_STATES,
  eventSentence,
  localDateString,
  OPEN_STATES,
  type CaseEvent,
  type CaseState,
  type ResearchCase
} from './case-model'
import type { CaseTask } from './case-tasks'
import { isoWeekStart, type TimeEntry } from './case-time'

export const STUDIO_ACTIVE_CASES_LIMIT = 6
export const STUDIO_TASKS_LIMIT = 8
export const STUDIO_ACTIVITY_LIMIT = 8
/** "Due soon" on the dashboard covers today and this many days after it. */
export const STUDIO_DUE_WINDOW_DAYS = 7

/** Identifies a case and its client on every list item, so a row never needs a second lookup. */
export interface StudioCaseRef {
  caseId: string
  clientId: string
  caseTitle: string
  clientDisplayName: string
}

export interface StudioCase extends StudioCaseRef {
  state: CaseState
  dueDate: string | null
}

export interface StudioTask extends StudioCaseRef {
  taskId: string
  title: string
  dueDate: string
  overdue: boolean
}

export type StudioActivityKind = 'journal' | 'event' | 'time'

export interface StudioActivity extends StudioCaseRef {
  /** Unique within the list, e.g. 'journal:<id>'. */
  id: string
  kind: StudioActivityKind
  /** ISO timestamp of when it was recorded. */
  at: string
  /** Short fixed text: "Journal entry", "Research started", "Logged 1h 30m". Never entry text. */
  label: string
}

export interface StudioSummary {
  /** The local date the figures were computed for (YYYY-MM-DD). */
  today: string
  counts: {
    activeClients: number
    openCases: number
    /** Every state, for cases that are not archived. */
    casesByState: Record<CaseState, number>
    overdueTasks: number
    /** Pending tasks due from today through STUDIO_DUE_WINDOW_DAYS days later. */
    tasksDueSoon: number
  }
  continueCase: StudioCase | null
  activeCases: StudioCase[]
  upcomingTasks: StudioTask[]
  recentActivity: StudioActivity[]
  hours: { weekMinutes: number; monthMinutes: number }
}

// ---------- dates ----------

/** A YYYY-MM-DD date moved by whole calendar days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const moved = new Date(Date.UTC(y, m - 1, d + days))
  return `${String(moved.getUTCFullYear()).padStart(4, '0')}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`
}

/** The calendar ranges the hours figures cover; the week runs Monday to Sunday. */
export function hoursRanges(today: string): { weekStart: string; weekEnd: string; monthPrefix: string } {
  const weekStart = isoWeekStart(today)
  return { weekStart, weekEnd: addDays(weekStart, 6), monthPrefix: today.slice(0, 7) }
}

// ---------- labels ----------

export const JOURNAL_ACTIVITY_LABEL = 'Journal entry'

/** "Logged 1h 30m", "Logged 45m", "Logged 2h". */
export function loggedLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `Logged ${[h > 0 ? `${h}h` : '', m > 0 || h === 0 ? `${m}m` : ''].filter(Boolean).join(' ')}`
}

export function eventActivityLabel(event: Pick<CaseEvent, 'kind' | 'fromState' | 'toState'>): string {
  return eventSentence(event)
}

/** "12h 30m" / "45m" for a total, without the "Logged" prefix. */
export function hoursLabel(minutes: number): string {
  return loggedLabel(minutes).replace(/^Logged /, '')
}

/** Newest first; ties by kind then id so the order is the same in SQL and in memory. */
export function compareActivity(a: StudioActivity, b: StudioActivity): number {
  return b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
}

/** Which state "Continue researching" prefers, best first. */
export const CONTINUE_ORDER: readonly CaseState[] = ['active', 'waiting', 'intake']

export function emptyStateCounts(): Record<CaseState, number> {
  return Object.fromEntries(CASE_STATES.map((s) => [s, 0])) as Record<CaseState, number>
}

// ---------- in-memory build (demo) ----------

export interface StudioSource {
  clients: { id: string; status: 'active' | 'archived'; displayName: string }[]
  cases: ResearchCase[]
  events: CaseEvent[]
  journal: { id: string; caseId: string; createdAt: string }[]
  tasks: CaseTask[]
  timeEntries: TimeEntry[]
}

/** The same summary the host's SQL produces, computed from in-memory records. */
export function buildStudioSummary(source: StudioSource, now: Date): StudioSummary {
  const today = localDateString(now)
  const soonEnd = addDays(today, STUDIO_DUE_WINDOW_DAYS)
  const { weekStart, weekEnd, monthPrefix } = hoursRanges(today)

  const activeClients = new Map(source.clients.filter((c) => c.status === 'active').map((c) => [c.id, c.displayName]))
  const live = source.cases.filter((c) => c.archivedAt === null && activeClients.has(c.clientId))
  const liveById = new Map(live.map((c) => [c.id, c]))
  const ref = (c: ResearchCase): StudioCaseRef => ({
    caseId: c.id,
    clientId: c.clientId,
    caseTitle: c.title,
    clientDisplayName: activeClients.get(c.clientId) ?? ''
  })
  const asCase = (c: ResearchCase): StudioCase => ({ ...ref(c), state: c.state, dueDate: c.dueDate })

  const open = live.filter((c) => OPEN_STATES.includes(c.state))
  const openIds = new Set(open.map((c) => c.id))
  const byRecent = (a: ResearchCase, b: ResearchCase) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)

  const casesByState = emptyStateCounts()
  for (const c of live) casesByState[c.state] += 1

  const pending = source.tasks.filter((t) => t.status === 'pending' && t.dueDate !== null && openIds.has(t.caseId))
  const continueCase =
    CONTINUE_ORDER.map((state) => open.filter((c) => c.state === state).sort(byRecent)[0]).find((c) => c !== undefined) ?? null

  const upcomingTasks = [...pending]
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, STUDIO_TASKS_LIMIT)
    .map((t): StudioTask => {
      const c = liveById.get(t.caseId)!
      return { ...ref(c), taskId: t.id, title: t.title, dueDate: t.dueDate!, overdue: t.dueDate! < today }
    })

  const activity: StudioActivity[] = []
  for (const e of source.events) {
    const c = liveById.get(e.caseId)
    if (c) activity.push({ ...ref(c), id: `event:${e.id}`, kind: 'event', at: e.occurredAt, label: eventActivityLabel(e) })
  }
  for (const j of source.journal) {
    const c = liveById.get(j.caseId)
    if (c) activity.push({ ...ref(c), id: `journal:${j.id}`, kind: 'journal', at: j.createdAt, label: JOURNAL_ACTIVITY_LABEL })
  }
  for (const t of source.timeEntries) {
    const c = liveById.get(t.caseId)
    if (c) activity.push({ ...ref(c), id: `time:${t.id}`, kind: 'time', at: t.createdAt, label: loggedLabel(t.durationMinutes) })
  }

  let weekMinutes = 0
  let monthMinutes = 0
  for (const t of source.timeEntries) {
    if (!liveById.has(t.caseId)) continue
    if (t.workDate >= weekStart && t.workDate <= weekEnd) weekMinutes += t.durationMinutes
    if (t.workDate.startsWith(monthPrefix)) monthMinutes += t.durationMinutes
  }

  return {
    today,
    counts: {
      activeClients: activeClients.size,
      openCases: open.length,
      casesByState,
      overdueTasks: pending.filter((t) => t.dueDate! < today).length,
      tasksDueSoon: pending.filter((t) => t.dueDate! >= today && t.dueDate! <= soonEnd).length
    },
    continueCase: continueCase ? asCase(continueCase) : null,
    activeCases: [...open].sort(byRecent).slice(0, STUDIO_ACTIVE_CASES_LIMIT).map(asCase),
    upcomingTasks,
    recentActivity: activity.sort(compareActivity).slice(0, STUDIO_ACTIVITY_LIMIT),
    hours: { weekMinutes, monthMinutes }
  }
}
