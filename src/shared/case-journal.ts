// Case research journal rules (case-journal/v1, docs/case-data-model.md): the
// researcher's dated log of work on one case, kept apart from the client's notes
// and contact history. Shared by the host's repository (authoritative) and the
// browser (instant feedback, demo). No Node imports: the renderer bundles this file.

import { FUTURE_TOLERANCE_MS } from './client-model'

export const JOURNAL_BODY_MAX = 10_000
export const JOURNAL_ACTIVITY_MAX = 60

/** A dated entry in a case's research log. */
export interface JournalEntry {
  id: string
  caseId: string
  /** When the work happened (UTC ISO); may be back-dated. */
  occurredAt: string
  /** Free-text kind of work, e.g. "Archive search"; null when not given. */
  activity: string | null
  body: string
  createdAt: string
  updatedAt: string
}

/** What the browser may send. Strict: ids and write times are never accepted here. */
export interface JournalEntryInput {
  occurredAt: string
  activity: string | null
  body: string
}

export type JournalIssueCode = 'required' | 'too-long' | 'invalid-characters' | 'invalid-format' | 'in-future'

/** A rule outcome. Carries only a field name and a code, never the submitted value. */
export interface JournalIssue {
  field: keyof JournalEntryInput
  code: JournalIssueCode
}

export interface JournalCheck {
  input: JournalEntryInput | null
  issues: JournalIssue[]
}

export type JournalMutationResult =
  | { ok: true; entry: JournalEntry }
  | { ok: false; reason: 'invalid'; issues: JournalIssue[] }
  /** The case, or the entry within that case, does not exist. */
  | { ok: false; reason: 'not-found' }
  /** The case or its client is archived. */
  | { ok: false; reason: 'wrong-status' }

const CONTROL_CHARS = /\p{Cc}/u

/** Suggestions only; the activity field accepts any short text. Provisional list. */
export const JOURNAL_ACTIVITY_SUGGESTIONS = [
  'Archive search',
  'Record analysis',
  'Online database search',
  'Client communication',
  'Document review',
  'Source evaluation',
  'Writing the report'
] as const

/** Normalize and validate a journal entry. `input` is null whenever there is an issue. */
export function checkJournalEntry(raw: JournalEntryInput, now: Date = new Date()): JournalCheck {
  const issues: JournalIssue[] = []

  const body = raw.body.replace(/\r\n/g, '\n').trim()
  if (body === '') issues.push({ field: 'body', code: 'required' })
  else if (body.length > JOURNAL_BODY_MAX) issues.push({ field: 'body', code: 'too-long' })
  else if (CONTROL_CHARS.test(body.replace(/[\n\t]/g, ''))) issues.push({ field: 'body', code: 'invalid-characters' })

  const trimmedActivity = (raw.activity ?? '').trim()
  const activity = trimmedActivity === '' ? null : trimmedActivity
  if (activity !== null) {
    if (activity.length > JOURNAL_ACTIVITY_MAX) issues.push({ field: 'activity', code: 'too-long' })
    else if (CONTROL_CHARS.test(activity)) issues.push({ field: 'activity', code: 'invalid-characters' })
  }

  const occurred = new Date(raw.occurredAt)
  if (Number.isNaN(occurred.getTime())) issues.push({ field: 'occurredAt', code: 'invalid-format' })
  else if (occurred.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) issues.push({ field: 'occurredAt', code: 'in-future' })

  if (issues.length > 0) return { input: null, issues }
  return { issues, input: { occurredAt: occurred.toISOString(), activity, body } }
}

/** Newest first; ties keep the order they were written in, newest first. */
export function compareJournalEntries(a: JournalEntry, b: JournalEntry): number {
  return b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
}

export const isJournalEntryEdited = (entry: JournalEntry): boolean => entry.updatedAt !== entry.createdAt
