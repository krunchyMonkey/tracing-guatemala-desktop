// Case summary export (#20): turns ONE case's data into a Markdown document the
// researcher can keep or share. Pure: no DOM, no Node, no network, no storage. The
// browser gathers the data with the case's own scoped calls and saves the result
// with a download; nothing here (or in the host) writes anything.
//
// Privacy by construction: the summary carries the client's display name only.
// `CaseSummaryData.client` has no field for an email, Fiverr username, other
// contact or notes, so they cannot be included by mistake. `checkSummaryScope` is a
// second line of defence against mixing in another case's or client's records.

import type { CaseBrief } from './case-brief'
import { BRIEF_FIELDS, briefIsEmpty } from './case-brief'
import type { JournalEntry } from './case-journal'
import { compareJournalEntries } from './case-journal'
import { eventSentence, isOverdue, stateLabels, type CaseEvent, type ResearchCase } from './case-model'
import type { CaseTask } from './case-tasks'
import { compareTasks, taskDueStatus } from './case-tasks'

export interface CaseSummaryData {
  /** The client's id and display name only. Never contact details or notes. */
  client: { id: string; displayName: string }
  case: ResearchCase
  brief: CaseBrief | null
  journal: JournalEntry[]
  tasks: CaseTask[]
  events: CaseEvent[]
}

export interface CaseSummaryOptions {
  generatedAt: Date
  /** The researcher's local calendar date (YYYY-MM-DD), for the overdue check. */
  localToday: string
  /** True for the browser demo: the file says its data is fictional. */
  demo: boolean
  /** IANA zone for date and time text; the local zone when omitted (tests pin it). */
  timeZone?: string
}

export const DEMO_SUMMARY_LINE = 'Fictional demo data — not a real client.'
export const HYPOTHESIS_PREFIX = 'Hypothesis — not established:'

/**
 * True only when everything in `data` belongs to the one case and its one client.
 * Defence in depth: the calls are already scoped, this refuses a mix-up anyway.
 */
export function checkSummaryScope(data: CaseSummaryData): boolean {
  const caseId = data.case.id
  return (
    data.client.id === data.case.clientId &&
    (data.brief === null || data.brief.caseId === caseId) &&
    data.journal.every((entry) => entry.caseId === caseId) &&
    data.tasks.every((task) => task.caseId === caseId) &&
    data.events.every((event) => event.caseId === caseId)
  )
}

// ---------- escaping ----------

// Markers that would turn a line into a heading, quote, list, table, code fence,
// rule or numbered list. A single leading backslash makes the character literal.
const LEADING_MARKER = /^(\s*)([#>\-+*=|`_~])/
const LEADING_NUMBER = /^(\s*\d+)([.)])/

/**
 * One line of user text made safe for the document: a leading Markdown marker is
 * backslash-escaped and `<` becomes `&lt;` so no HTML reaches a renderer. The
 * words themselves stay exactly as typed.
 */
export function escapeLine(line: string): string {
  return line.replace(/</g, '&lt;').replace(LEADING_MARKER, '$1\\$2').replace(LEADING_NUMBER, '$1\\$2')
}

/** Multi-line user text, every line escaped; line breaks normalized to \n. */
export function escapeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(escapeLine)
    .join('\n')
}

/** A single-line field: line breaks collapse to spaces, then escaped. */
const escapeInline = (text: string): string => escapeLine(text.replace(/\s*[\r\n]+\s*/g, ' ').trim())

// ---------- dates ----------

function dateTimeText(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date)
}

function dateText(iso: string, timeZone: string | undefined): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(date)
}

// Date-only values (due dates) are calendar dates, not instants: they are written
// as the stored YYYY-MM-DD and never converted through a time zone.

// ---------- composing ----------

const BRIEF_HEADINGS: Record<(typeof BRIEF_FIELDS)[number], string> = {
  objective: 'Working objective',
  facts: 'Known facts (as reported — not verified)',
  people: 'Known people and family context',
  hypotheses: 'Hypotheses',
  questions: 'Open questions'
}

/** "Hypothesis — not established:" in front of every paragraph, so a guess can't read as a finding. */
function hypothesisParagraphs(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => {
      const [first = '', ...rest] = paragraph.split('\n')
      // The prefix starts the line, so the first line needs no marker escape.
      return [`${HYPOTHESIS_PREFIX} ${first.replace(/</g, '&lt;')}`, ...rest.map(escapeLine)].join('\n')
    })
    .join('\n\n')
}

/** Indents continuation lines so a multi-line text stays inside its list item. */
const inItem = (text: string): string => text.replace(/\n/g, '\n  ')

/**
 * The Markdown summary for one case. Throws, producing no output, when `data`
 * mixes records from another case or client.
 */
export function composeCaseSummary(data: CaseSummaryData, options: CaseSummaryOptions): string {
  if (!checkSummaryScope(data)) throw new Error('The summary data does not all belong to one case.')

  const { case: researchCase, brief } = data
  const zone = options.timeZone
  const out: string[] = []
  const section = (heading: string, body: string) => out.push(`## ${heading}\n\n${body}`)

  out.push(`# Case summary: ${escapeInline(researchCase.title)}`)
  if (options.demo) out.push(DEMO_SUMMARY_LINE)

  const meta = [`- Client: ${escapeInline(data.client.displayName)}`, `- State: ${stateLabels[researchCase.state]}`]
  if (researchCase.archivedAt !== null) meta.push(`- Archived: yes, since ${dateText(researchCase.archivedAt, zone)}`)
  if (researchCase.orderReference !== null) meta.push(`- Order reference: ${escapeInline(researchCase.orderReference)}`)
  if (researchCase.dueDate !== null) {
    meta.push(
      `- Due date: ${researchCase.dueDate}${isOverdue(researchCase, options.localToday) ? ' (overdue)' : ''}`
    )
  }
  meta.push(
    `- Created: ${dateTimeText(researchCase.createdAt, zone)}`,
    `- Last updated: ${dateTimeText(researchCase.updatedAt, zone)}`,
    `- Generated: ${dateTimeText(options.generatedAt.toISOString(), zone)}`
  )
  out.push(meta.join('\n'))

  section("Client's requested outcome", researchCase.goal ? escapeText(researchCase.goal) : 'Not recorded.')

  const parts: string[] = []
  if (brief !== null && !briefIsEmpty(brief)) {
    for (const field of BRIEF_FIELDS) {
      const text = brief[field]
      if (text === null || text.trim() === '') continue
      const body = field === 'hypotheses' ? hypothesisParagraphs(text) : escapeText(text)
      if (body !== '') parts.push(`### ${BRIEF_HEADINGS[field]}\n\n${body}`)
    }
  }
  section('Research brief', parts.length > 0 ? parts.join('\n\n') : 'No research brief yet.')

  const tasks = [...data.tasks].sort(compareTasks)
  const taskLines = tasks.map((task) => {
    const done = task.status === 'completed'
    const note = done
      ? task.completedAt !== null
        ? ` — completed ${dateText(task.completedAt, zone)}`
        : ' — completed'
      : task.dueDate === null
        ? ' — no deadline'
        : ` — due ${task.dueDate}${taskDueStatus(task, options.localToday) === 'overdue' ? ' (overdue)' : ''}`
    const head = `- [${done ? 'x' : ' '}] ${escapeInline(task.title)}${note}`
    return task.description ? `${head}\n  ${inItem(escapeText(task.description))}` : head
  })
  section('Next steps', taskLines.length > 0 ? taskLines.join('\n') : 'No tasks.')

  const entries = [...data.journal].sort(compareJournalEntries)
  section(
    'Research journal',
    entries.length > 0
      ? entries
          .map((entry) => {
            const activity = entry.activity ? ` — ${escapeInline(entry.activity)}` : ''
            return `### ${dateText(entry.occurredAt, zone)}${activity}\n\n${escapeText(entry.body)}`
          })
          .join('\n\n')
      : 'No journal entries yet.'
  )

  const events = [...data.events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
  section(
    'Case history',
    events.length > 0
      ? events.map((event) => `- ${dateTimeText(event.occurredAt, zone)}: ${eventSentence(event)}`).join('\n')
      : 'No history yet.'
  )

  return `${out.join('\n\n')}\n`
}

// ---------- file name ----------

const FILE_SLUG_MAX = 50

/** `case-summary-<slug>-<YYYY-MM-DD>.md`: ASCII only, no path separators or reserved characters. */
export function summaryFileName(caseTitle: string, localToday: string): string {
  const slug = caseTitle
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FILE_SLUG_MAX)
    .replace(/-+$/g, '')
  const date = /^\d{4}-\d{2}-\d{2}$/.test(localToday) ? localToday : 'undated'
  return `case-summary-${slug === '' ? 'case' : slug}-${date}.md`
}
