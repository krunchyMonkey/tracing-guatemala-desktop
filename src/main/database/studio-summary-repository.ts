import type { DatabaseSync } from 'node:sqlite'
import { localDateString, OPEN_STATES, type CaseState } from '../../shared/case-model'
import {
  addDays,
  compareActivity,
  emptyStateCounts,
  eventActivityLabel,
  hoursRanges,
  JOURNAL_ACTIVITY_LABEL,
  loggedLabel,
  STUDIO_ACTIVE_CASES_LIMIT,
  STUDIO_ACTIVITY_LIMIT,
  STUDIO_DUE_WINDOW_DAYS,
  STUDIO_TASKS_LIMIT,
  type StudioActivity,
  type StudioCase,
  type StudioSummary,
  type StudioTask
} from '../../shared/studio-summary'
import { scopeCondition, type ResearchScope } from './research-access'

// Research Studio summary (studio-summary/v1, #116): read-only aggregate queries for
// the Home dashboard, a handful of joined statements instead of one call per case.
// Archived clients and archived cases are excluded everywhere (the `live` CTE), and
// text bodies are never selected: no journal body, task description, note, email or
// contact column appears below. All SQL is parameterized. "Today" comes from the
// injected clock and is a local calendar date.

interface CaseRow {
  case_id: string
  client_id: string
  title: string
  display_name: string
  state: CaseState
  due_date: string | null
}

interface TaskRow {
  task_id: string
  task_title: string
  task_due: string
  case_id: string
  client_id: string
  title: string
  display_name: string
}

interface ActivityRow {
  kind: 'event' | 'journal' | 'time'
  id: string
  at: string
  event_kind: 'created' | 'state' | 'archived' | 'unarchived' | null
  from_state: CaseState | null
  to_state: CaseState | null
  minutes: number | null
  case_id: string
  client_id: string
  title: string
  display_name: string
}

/** What a case-only grantee sees instead of a client name they may not read (#210). */
const SHARED_CASE_LABEL = 'Shared case'

/**
 * The `live` CTE limited to the cases `scope` may read (#210), with its positional parameters. A case
 * reached only through a case grant shows no client name: client-level access is a separate right.
 */
function liveCte(scope: ResearchScope): { sql: string; params: string[] } {
  const clientRead = scopeCondition(scope, 'cl.id', 'client')
  const caseRead = scopeCondition(scope, 'c.id', 'case')
  return {
    sql: `
  WITH live AS (
    SELECT c.id AS case_id, c.client_id, c.title,
           CASE WHEN ${clientRead.sql} THEN cl.display_name ELSE '${SHARED_CASE_LABEL}' END AS display_name,
           c.state, c.due_date, c.updated_at
    FROM research_cases c JOIN clients cl ON cl.id = c.client_id
    WHERE cl.status = 'active' AND c.archived_at IS NULL AND ${caseRead.sql}
  )`,
    params: [...clientRead.params, ...caseRead.params]
  }
}

const OPEN = `state IN (${OPEN_STATES.map((s) => `'${s}'`).join(', ')})`

const toCase = (r: CaseRow): StudioCase => ({
  caseId: r.case_id,
  clientId: r.client_id,
  caseTitle: r.title,
  clientDisplayName: r.display_name,
  state: r.state,
  dueDate: r.due_date
})

export class StudioSummaryRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: { now: () => Date } = { now: () => new Date() }
  ) {}

  /**
   * The dashboard figures for local today (the injected clock's date), counting only what `scope` may
   * read (#210). Scope is required; trusted internal callers pass SCOPE_ALL explicitly.
   */
  summary(scope: ResearchScope, now: Date = this.clock.now()): StudioSummary {
    const today = localDateString(now)
    const soonEnd = addDays(today, STUDIO_DUE_WINDOW_DAYS)
    const { weekStart, weekEnd, monthPrefix } = hoursRanges(today)
    const one = <T>(sql: string, params: (string | number)[]) => this.db.prepare(sql).get(...params) as unknown as T
    const all = <T>(sql: string, params: (string | number)[]) => this.db.prepare(sql).all(...params) as unknown as T[]
    // Every statement below starts with the scoped `live` CTE; its parameters come first, then the statement's own.
    const LIVE = liveCte(scope)

    const clientRead = scopeCondition(scope, 'id', 'client')
    const activeClients = one<{ n: number }>(`SELECT count(*) AS n FROM clients WHERE status = 'active' AND ${clientRead.sql}`, clientRead.params).n

    const casesByState = emptyStateCounts()
    for (const row of all<{ state: CaseState; n: number }>(`${LIVE.sql} SELECT state, count(*) AS n FROM live GROUP BY state`, LIVE.params)) {
      casesByState[row.state] = row.n
    }

    const taskCounts = one<{ overdue: number; soon: number }>(
      `${LIVE.sql}
       SELECT coalesce(sum(t.due_date < ?), 0) AS overdue,
              coalesce(sum(t.due_date >= ? AND t.due_date <= ?), 0) AS soon
       FROM case_tasks t JOIN live l ON l.case_id = t.case_id
       WHERE t.status = 'pending' AND t.due_date IS NOT NULL AND l.${OPEN}`,
      [...LIVE.params, today, today, soonEnd]
    )

    const caseColumns = 'case_id, client_id, title, display_name, state, due_date'
    const continueRow = one<CaseRow | undefined>(
      `${LIVE.sql} SELECT ${caseColumns} FROM live WHERE ${OPEN}
       ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, updated_at DESC, case_id LIMIT 1`,
      LIVE.params
    )
    const activeCases = all<CaseRow>(
      `${LIVE.sql} SELECT ${caseColumns} FROM live WHERE ${OPEN} ORDER BY updated_at DESC, case_id LIMIT ?`,
      [...LIVE.params, STUDIO_ACTIVE_CASES_LIMIT]
    ).map(toCase)

    const upcomingTasks = all<TaskRow>(
      `${LIVE.sql}
       SELECT t.id AS task_id, t.title AS task_title, t.due_date AS task_due,
              l.case_id, l.client_id, l.title, l.display_name
       FROM case_tasks t JOIN live l ON l.case_id = t.case_id
       WHERE t.status = 'pending' AND t.due_date IS NOT NULL AND l.${OPEN}
       ORDER BY t.due_date, t.created_at, t.id LIMIT ?`,
      [...LIVE.params, STUDIO_TASKS_LIMIT]
    ).map(
      (r): StudioTask => ({
        caseId: r.case_id,
        clientId: r.client_id,
        caseTitle: r.title,
        clientDisplayName: r.display_name,
        taskId: r.task_id,
        title: r.task_title,
        dueDate: r.task_due,
        overdue: r.task_due < today
      })
    )

    const recentActivity = all<ActivityRow>(
      `${LIVE.sql}
       SELECT * FROM (
         SELECT 'event' AS kind, e.id, e.occurred_at AS at, e.kind AS event_kind, e.from_state, e.to_state,
                NULL AS minutes, l.case_id, l.client_id, l.title, l.display_name
         FROM case_events e JOIN live l ON l.case_id = e.case_id
         UNION ALL
         SELECT 'journal', j.id, j.created_at, NULL, NULL, NULL, NULL, l.case_id, l.client_id, l.title, l.display_name
         FROM case_journal_entries j JOIN live l ON l.case_id = j.case_id
         UNION ALL
         SELECT 'time', t.id, t.created_at, NULL, NULL, NULL, t.duration_minutes, l.case_id, l.client_id, l.title, l.display_name
         FROM case_time_entries t JOIN live l ON l.case_id = t.case_id
       ) ORDER BY at DESC, kind, id LIMIT ?`,
      [...LIVE.params, STUDIO_ACTIVITY_LIMIT]
    )
      .map(
        (r): StudioActivity => ({
          id: `${r.kind}:${r.id}`,
          kind: r.kind,
          at: r.at,
          label:
            r.kind === 'journal'
              ? JOURNAL_ACTIVITY_LABEL
              : r.kind === 'time'
                ? loggedLabel(r.minutes ?? 0)
                : eventActivityLabel({ kind: r.event_kind ?? 'state', fromState: r.from_state, toState: r.to_state }),
          caseId: r.case_id,
          clientId: r.client_id,
          caseTitle: r.title,
          clientDisplayName: r.display_name
        })
      )
      .sort(compareActivity)

    const hours = one<{ week: number; month: number }>(
      `${LIVE.sql}
       SELECT coalesce(sum(CASE WHEN t.work_date BETWEEN ? AND ? THEN t.duration_minutes END), 0) AS week,
              coalesce(sum(CASE WHEN substr(t.work_date, 1, 7) = ? THEN t.duration_minutes END), 0) AS month
       FROM case_time_entries t JOIN live l ON l.case_id = t.case_id`,
      [...LIVE.params, weekStart, weekEnd, monthPrefix]
    )

    return {
      today,
      counts: {
        activeClients,
        openCases: OPEN_STATES.reduce((sum, s) => sum + casesByState[s], 0),
        casesByState,
        overdueTasks: taskCounts.overdue,
        tasksDueSoon: taskCounts.soon
      },
      continueCase: continueRow ? toCase(continueRow) : null,
      activeCases,
      upcomingTasks,
      recentActivity,
      hours: { weekMinutes: hours.week, monthMinutes: hours.month }
    }
  }
}
