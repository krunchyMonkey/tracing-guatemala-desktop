// Case task rules (case-tasks/v1, docs/case-data-model.md §7): the researcher's
// next steps on one case, with optional date-only deadlines. Shared by the host's
// repository (authoritative) and the browser (instant feedback, demo). No Node
// imports: the renderer bundles this file. Dates are local calendar dates
// (YYYY-MM-DD) compared as plain calendar values, never through UTC.

import { checkDateOnly, daysBetween } from './case-model'

export const TASK_TITLE_MAX = 160
export const TASK_DESCRIPTION_MAX = 2_000
/** A pending task due within this many days after today is "due soon". */
export const TASK_DUE_SOON_DAYS = 3

export type TaskStatus = 'pending' | 'completed'

export interface CaseTask {
  id: string
  caseId: string
  title: string
  description: string | null
  status: TaskStatus
  /** 'YYYY-MM-DD' local calendar date, no time zone. */
  dueDate: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

/** What the browser may send. Strict: ids, status and write times are never accepted here. */
export interface CaseTaskInput {
  title: string
  description: string | null
  dueDate: string | null
}

export type CaseTaskIssueCode = 'required' | 'too-long' | 'invalid-characters' | 'invalid-format' | 'invalid-date'

/** A rule outcome. Carries only a field name and a code, never the submitted value. */
export interface CaseTaskIssue {
  field: keyof CaseTaskInput
  code: CaseTaskIssueCode
}

export interface CaseTaskCheck {
  input: CaseTaskInput | null
  issues: CaseTaskIssue[]
}

export type CaseTaskMutationResult =
  | { ok: true; task: CaseTask }
  | { ok: false; reason: 'invalid'; issues: CaseTaskIssue[] }
  /** The case, or the task within that case, does not exist. */
  | { ok: false; reason: 'not-found' }
  /** The case or its client is archived, or the task is already in the requested status. */
  | { ok: false; reason: 'wrong-status' }

export type TaskDueStatus = 'overdue' | 'due-today' | 'due-soon' | 'later' | 'none'

const CONTROL_CHARS = /\p{Cc}/u

/** Normalize and validate a task draft. `input` is null whenever there is an issue. */
export function checkCaseTask(raw: CaseTaskInput): CaseTaskCheck {
  const issues: CaseTaskIssue[] = []
  const issue = (field: CaseTaskIssue['field'], code: CaseTaskIssueCode) => issues.push({ field, code })

  const title = raw.title.trim().replace(/\s+/g, ' ')
  const trimmedDescription = (raw.description ?? '').replace(/\r\n/g, '\n').trim()
  const description = trimmedDescription === '' ? null : trimmedDescription
  const trimmedDue = (raw.dueDate ?? '').trim()
  const dueDate = trimmedDue === '' ? null : trimmedDue

  if (title === '') issue('title', 'required')
  else if (title.length > TASK_TITLE_MAX) issue('title', 'too-long')
  else if (CONTROL_CHARS.test(title)) issue('title', 'invalid-characters')

  if (description !== null) {
    if (description.length > TASK_DESCRIPTION_MAX) issue('description', 'too-long')
    else if (CONTROL_CHARS.test(description.replace(/[\n\t]/g, ''))) issue('description', 'invalid-characters')
  }

  if (dueDate !== null) {
    const problem = checkDateOnly(dueDate)
    if (problem) issue('dueDate', problem)
  }

  return { issues, input: issues.length > 0 ? null : { title, description, dueDate } }
}

/** How urgent a task is against local today (YYYY-MM-DD). Completed and undated tasks are 'none'. */
export function taskDueStatus(task: Pick<CaseTask, 'status' | 'dueDate'>, localToday: string): TaskDueStatus {
  if (task.status === 'completed' || task.dueDate === null) return 'none'
  const days = daysBetween(localToday, task.dueDate)
  if (days < 0) return 'overdue'
  if (days === 0) return 'due-today'
  return days <= TASK_DUE_SOON_DAYS ? 'due-soon' : 'later'
}

/** Whole calendar days from local today until the due date (negative when past); null without a date. */
export function daysUntilDue(task: Pick<CaseTask, 'dueDate'>, localToday: string): number | null {
  return task.dueDate === null ? null : daysBetween(localToday, task.dueDate)
}

/** Pending first, then due date (earliest first, undated last), then oldest first. */
export function compareTasks(a: CaseTask, b: CaseTask): number {
  if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1
    if (b.dueDate === null) return -1
    return a.dueDate.localeCompare(b.dueDate)
  }
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}
