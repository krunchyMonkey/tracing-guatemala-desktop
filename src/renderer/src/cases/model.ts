// Renderer view of case-model/v1 (#16): the shared rules, plus the plain-language
// labels and sentences the case screens show. Renderer checks are a convenience;
// the host re-runs every rule.

import type { BriefField, BriefIssue } from '../../../shared/case-brief'
import type { CaseIssue, CaseState } from '../../../shared/case-model'

export {
  CASE_GOAL_MAX,
  CASE_STATES,
  CASE_TITLE_MAX,
  CASE_TRANSITIONS,
  OPEN_STATES,
  ORDER_REFERENCE_MAX,
  canTransition,
  checkCase,
  defaultCaseQuery,
  isOverdue,
  localDateString,
  needsConfirmation,
  eventSentence,
  queryCases,
  stateLabels
} from '../../../shared/case-model'
export type {
  CaseEvent,
  CaseField,
  CaseInput,
  CaseIssue,
  CaseMutationResult,
  CaseQuery,
  CaseState,
  ResearchCase
} from '../../../shared/case-model'

/** One line explaining each state, shown beside the controls. */
export const stateHelp: Record<CaseState, string> = {
  intake: 'Recorded, research has not started.',
  active: 'Research is in progress.',
  waiting: 'Paused until someone else replies.',
  delivered: 'A draft or final result was sent outside this app.',
  closed: 'No further work is expected.'
}

/** What the button for moving a case from `from` to `to` says. */
export function transitionLabel(from: CaseState, to: CaseState): string {
  if (to === 'waiting') return 'Waiting on someone'
  if (to === 'delivered') return 'Mark delivered'
  if (to === 'closed') return 'Close case'
  if (from === 'waiting') return 'Resume research'
  if (from === 'intake') return 'Start research'
  return 'Reopen'
}

const dueFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** A 'YYYY-MM-DD' calendar date shown as typed: built from its parts, never through UTC. */
export function formatDueDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return date
  return dueFormat.format(new Date(year, month - 1, day))
}

/** Same shape the host accepts (RFC 9562 UUIDs), so malformed links never reach it. */
const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isCaseId = (value: string | undefined): value is string => value !== undefined && CASE_ID.test(value)

export const issueMessages: Record<CaseIssue['field'], Partial<Record<CaseIssue['code'], string>>> = {
  title: {
    required: 'Give the case a title so you can recognize it in lists.',
    'too-long': 'Keep the title under 160 characters.',
    'invalid-characters': 'The title has a character that can’t be saved. Remove it and try again.'
  },
  goal: {
    'too-long': 'Keep the requested outcome under 4,000 characters.',
    'invalid-characters': 'The requested outcome has a character that can’t be saved.'
  },
  orderReference: {
    'too-long': 'Keep the order reference under 100 characters.',
    'invalid-characters': 'The order reference has a character that can’t be saved.'
  },
  dueDate: {
    'invalid-format': 'Choose a date, or clear the field.',
    'invalid-date': 'That date doesn’t exist. Choose a real date, or clear the field.'
  }
}

export const issueMessage = (issue: CaseIssue): string =>
  issueMessages[issue.field][issue.code] ?? 'Check this field and try again.'

// ---------- research brief (#17) ----------

export { BRIEF_FIELDS, BRIEF_LIMITS, briefIsEmpty, checkCaseBrief, emptyBrief } from '../../../shared/case-brief'
export type {
  BriefField,
  BriefIssue,
  CaseBrief,
  CaseBriefInput,
  CaseBriefMutationResult
} from '../../../shared/case-brief'

/** How each section is named, and the help shown under its label in the form. */
export const briefSections: Record<BriefField, { label: string; hint: string }> = {
  objective: {
    label: 'Working research objective',
    hint: 'What you are trying to establish, in your own words. This can differ from what the client asked for.'
  },
  facts: {
    label: 'Known facts (as reported)',
    hint: 'What the client or your sources have said. Treat it as reported, not verified: the app doesn’t check it.'
  },
  people: {
    label: 'Known people and family context',
    hint: 'Names, relationships, places and dates you already have, one per line works well.'
  },
  hypotheses: {
    label: 'Hypotheses',
    hint: 'Ideas you haven’t proven yet. Keeping them apart from the facts stops a guess from turning into a finding.'
  },
  questions: {
    label: 'Open questions',
    hint: 'What you still need to find out or ask the client.'
  }
}

const BRIEF_LIMITS_TEXT: Record<BriefField, string> = {
  objective: '4,000',
  facts: '10,000',
  people: '10,000',
  hypotheses: '10,000',
  questions: '10,000'
}

export const briefIssueMessage = (issue: BriefIssue): string => {
  const name = briefSections[issue.field].label.toLowerCase()
  const limit = BRIEF_LIMITS_TEXT[issue.field]
  return issue.code === 'too-long'
    ? `Keep “${name}” under ${limit} characters.`
    : `“${name}” has a character that can’t be saved. Remove it and try again.`
}
