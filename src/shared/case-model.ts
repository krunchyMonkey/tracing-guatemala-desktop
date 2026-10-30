import { foldText } from './client-model'

// Research case rules (case-model/v1, docs/case-data-model.md): shapes, field
// validation, the lifecycle transition matrix and list filtering. Shared by the
// host's repository (authoritative) and the browser (instant feedback, demo).
// No Node imports: the renderer bundles this file.

export type CaseState = 'intake' | 'active' | 'waiting' | 'delivered' | 'closed'
export const CASE_STATES: readonly CaseState[] = ['intake', 'active', 'waiting', 'delivered', 'closed']
export const OPEN_STATES: readonly CaseState[] = ['intake', 'active', 'waiting']

export const CASE_TITLE_MAX = 160
export const CASE_GOAL_MAX = 4_000
export const ORDER_REFERENCE_MAX = 100

export interface ResearchCase {
  id: string
  clientId: string
  title: string
  goal: string | null
  orderReference: string | null
  /** 'YYYY-MM-DD' local calendar date, no time zone. */
  dueDate: string | null
  state: CaseState
  stateChangedAt: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

/** What the browser may send. Strict: id, client, state and timestamps are never accepted here. */
export interface CaseInput {
  title: string
  goal: string | null
  orderReference: string | null
  dueDate: string | null
}

export type CaseEventKind = 'created' | 'state' | 'archived' | 'unarchived'

export interface CaseEvent {
  id: string
  caseId: string
  kind: CaseEventKind
  fromState: CaseState | null
  toState: CaseState | null
  occurredAt: string
}

export type CaseField = keyof CaseInput
export type CaseIssueCode = 'required' | 'too-long' | 'invalid-characters' | 'invalid-format' | 'invalid-date'

/** A rule outcome. Carries only a field name and a code, never the submitted value. */
export interface CaseIssue {
  field: CaseField
  code: CaseIssueCode
}

export interface CaseCheck {
  input: CaseInput | null
  issues: CaseIssue[]
}

export interface CaseQuery {
  /** null = all clients */
  clientId: string | null
  /** The case's own archive flag. */
  archived: 'active' | 'archived' | 'all'
  /** Empty = any state. */
  states: CaseState[]
  text: string
  sort: 'due' | 'updated' | 'created' | 'title'
}

export type CaseMutationResult =
  | { ok: true; case: ResearchCase }
  | { ok: false; reason: 'invalid'; issues: CaseIssue[] }
  | { ok: false; reason: 'not-found' }
  /** The client is archived (create), or the case or its client is archived (any change). */
  | { ok: false; reason: 'client-archived' | 'wrong-status' }
  /** The state change is not in the transition matrix (includes "to the same state"). */
  | { ok: false; reason: 'invalid-transition' }

// ---------- validation (§3) ----------

const CONTROL_CHARS = /\p{Cc}/u
const DUE_DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/

function optional(value: string | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** Normalize and validate a case draft. `input` is null whenever there is an issue. */
export function checkCase(raw: CaseInput): CaseCheck {
  const issues: CaseIssue[] = []
  const issue = (field: CaseField, code: CaseIssueCode) => issues.push({ field, code })

  const title = raw.title.trim().replace(/\s+/g, ' ')
  const goal = optional(raw.goal === null ? null : raw.goal.replace(/\r\n/g, '\n'))
  const orderReference = optional(raw.orderReference)
  const dueDate = optional(raw.dueDate)

  if (title === '') issue('title', 'required')
  else if (title.length > CASE_TITLE_MAX) issue('title', 'too-long')
  else if (CONTROL_CHARS.test(title)) issue('title', 'invalid-characters')

  if (goal !== null && goal.length > CASE_GOAL_MAX) issue('goal', 'too-long')
  else if (goal !== null && CONTROL_CHARS.test(goal.replace(/[\n\t]/g, ''))) issue('goal', 'invalid-characters')

  if (orderReference !== null && orderReference.length > ORDER_REFERENCE_MAX) issue('orderReference', 'too-long')
  else if (orderReference !== null && CONTROL_CHARS.test(orderReference)) issue('orderReference', 'invalid-characters')

  if (dueDate !== null) {
    const parts = DUE_DATE_SHAPE.exec(dueDate)
    if (!parts) issue('dueDate', 'invalid-format')
    else {
      const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])] as [number, number, number]
      if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) issue('dueDate', 'invalid-date')
    }
  }

  return { issues, input: issues.length > 0 ? null : { title, goal, orderReference, dueDate } }
}

// ---------- lifecycle (§4) ----------

export const CASE_TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  intake: ['active', 'waiting', 'closed'],
  active: ['waiting', 'delivered', 'closed'],
  waiting: ['active', 'delivered', 'closed'],
  delivered: ['active', 'closed'],
  closed: ['active']
}

export const canTransition = (from: CaseState, to: CaseState): boolean => CASE_TRANSITIONS[from]?.includes(to) ?? false

/** Transitions the UI must confirm. The host enforces only the matrix. */
export const CONFIRMED_TRANSITIONS: ReadonlySet<string> = new Set([
  'intake>closed',
  'active>delivered',
  'active>closed',
  'waiting>delivered',
  'waiting>closed',
  'delivered>active',
  'delivered>closed',
  'closed>active'
])

export const needsConfirmation = (from: CaseState, to: CaseState): boolean => CONFIRMED_TRANSITIONS.has(`${from}>${to}`)

// ---------- dates ----------

/** Local calendar date as YYYY-MM-DD, never through UTC. */
export function localDateString(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Overdue is for display only: an open, unarchived case whose due date is before local today. */
export function isOverdue(
  researchCase: Pick<ResearchCase, 'dueDate' | 'state' | 'archivedAt'>,
  localToday: string
): boolean {
  return (
    researchCase.dueDate !== null &&
    researchCase.archivedAt === null &&
    OPEN_STATES.includes(researchCase.state) &&
    researchCase.dueDate < localToday
  )
}

// ---------- list query ----------

export const defaultCaseQuery: CaseQuery = { clientId: null, archived: 'active', states: [], text: '', sort: 'due' }

const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function queryCases(cases: ResearchCase[], query: CaseQuery): ResearchCase[] {
  const needle = foldText(query.text)
  const matches = cases.filter((researchCase) => {
    if (query.clientId !== null && researchCase.clientId !== query.clientId) return false
    if (query.archived === 'active' && researchCase.archivedAt !== null) return false
    if (query.archived === 'archived' && researchCase.archivedAt === null) return false
    if (query.states.length > 0 && !query.states.includes(researchCase.state)) return false
    if (needle === '') return true
    return [researchCase.title, researchCase.orderReference].some(
      (field) => field !== null && foldText(field).includes(needle)
    )
  })

  const byTitle = (a: ResearchCase, b: ResearchCase) =>
    titleCollator.compare(a.title, b.title) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

  return matches.sort((a, b) => {
    if (query.sort === 'due') {
      if (a.dueDate !== b.dueDate) {
        if (a.dueDate === null) return 1
        if (b.dueDate === null) return -1
        return a.dueDate.localeCompare(b.dueDate)
      }
      return byTitle(a, b)
    }
    if (query.sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt) || byTitle(a, b)
    if (query.sort === 'created') return b.createdAt.localeCompare(a.createdAt) || byTitle(a, b)
    return byTitle(a, b)
  })
}
