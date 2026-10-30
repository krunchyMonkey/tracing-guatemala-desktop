// Research notebook structure (docs/architecture/research-notebook.md). Types and
// rules, shared by the host's NotebookRepository (#147, authoritative) and the
// browser demo, so both refuse and number things the same way.
//
// A notebook belongs to exactly one research case, and the case owns client
// isolation: every section, page and revision carries its `caseId`, and the host
// verifies it against the case before any read or write. Page content is always
// `NoteContent` (note-content.ts), never an editor library's native document.
// No Node imports: the renderer bundles this file.

import { checkNoteContent, type NoteContent, type NoteContentIssueCode } from './note-content'

export const SECTION_TITLE_MAX = 80
export const PAGE_TITLE_MAX = 120
/** Limits per notebook / per section; a write past them is refused as `invalid` with a `too-many` issue. */
export const NOTEBOOK_MAX_SECTIONS = 100
export const SECTION_MAX_PAGES = 500
/** A stored page (its JSON) may not exceed this; the database enforces it too. */
export const PAGE_JSON_MAX = 1_048_576
/** A save appends an autosave revision when the newest one is at least this old. */
export const REVISION_INTERVAL_MS = 5 * 60_000

export interface NotebookSection {
  id: string
  notebookId: string
  caseId: string
  title: string
  /** Order among siblings, ascending. */
  position: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface NotebookPageSummary {
  id: string
  sectionId: string
  caseId: string
  title: string
  position: number
  /** Increments on every saved change; used to detect stale writes. */
  version: number
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface NotebookPage extends NotebookPageSummary {
  content: NoteContent
}

/** The sections and pages of a case's notebook. `notebookId` is null until the first section exists. */
export interface NotebookOutline {
  caseId: string
  notebookId: string | null
  sections: (NotebookSection & { pages: NotebookPageSummary[] })[]
}

export interface PageRevisionSummary {
  id: string
  pageId: string
  caseId: string
  version: number
  title: string
  reason: 'autosave' | 'restore-point' | 'restored'
  createdAt: string
}

export interface PageRevision extends PageRevisionSummary {
  content: NoteContent
}

export type NotebookTitleIssueCode = 'required' | 'too-long' | 'invalid-characters'

/** A rule outcome. Carries only a field name and a code, never the submitted value. */
export interface NotebookTitleIssue {
  field: 'title'
  code: NotebookTitleIssueCode
}

export interface NotebookTitleCheck {
  title: string | null
  issues: NotebookTitleIssue[]
}

const CONTROL_CHARS = /\p{Cc}/u

/** Trim and validate a section or page title. `title` is null whenever there is an issue. */
export function checkNotebookTitle(raw: string, max: number): NotebookTitleCheck {
  const title = raw.trim()
  const issues: NotebookTitleIssue[] = []
  if (title === '') issues.push({ field: 'title', code: 'required' })
  else if (title.length > max) issues.push({ field: 'title', code: 'too-long' })
  else if (CONTROL_CHARS.test(title)) issues.push({ field: 'title', code: 'invalid-characters' })
  return issues.length > 0 ? { title: null, issues } : { title, issues }
}

/** Ascending by position; ties by id so the order is stable. */
export function compareByPosition(a: { position: number; id: string }, b: { position: number; id: string }): number {
  return a.position - b.position || a.id.localeCompare(b.id)
}

/** A copy of `list` with the item at `fromIndex` moved to `toIndex`. Out-of-range indexes change nothing. */
export function moveItem<T>(list: readonly T[], fromIndex: number, toIndex: number): T[] {
  const copy = [...list]
  const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < copy.length
  if (!inRange(fromIndex) || !inRange(toIndex) || fromIndex === toIndex) return copy
  const [item] = copy.splice(fromIndex, 1)
  copy.splice(toIndex, 0, item as T)
  return copy
}

// ---------- writes: inputs, results and the rules the repository and the demo share ----------

/** What the browser may send. All strict: ids, versions and times are never accepted here. */
export interface SectionInput {
  title: string
}

export interface PageInput {
  title: string
}

/** Move a page to `toIndex` (0-based, clamped) among the pages of `sectionId`, which may be another section of the same case. */
export interface PageMove {
  sectionId: string
  toIndex: number
}

/** Save content on top of `baseVersion`; refused with `conflict` when the page has moved on. */
export interface PageSave {
  baseVersion: number
  content: NoteContent
}

/** A rule outcome. Carries only a field and a code (and a block position), never submitted values. */
export type NotebookIssue =
  | NotebookTitleIssue
  | { field: 'limit'; code: 'too-many' }
  | { field: 'content'; code: NoteContentIssueCode; blockIndex?: number }

export type NotebookFailure =
  | { ok: false; reason: 'invalid'; issues: NotebookIssue[] }
  | { ok: false; reason: 'not-found' | 'wrong-status' }

export type NotebookSectionResult = { ok: true; section: NotebookSection } | NotebookFailure
export type NotebookPageResult = { ok: true; page: NotebookPage } | NotebookFailure
/** Saves and restores can also lose to a newer version; the current page comes back so nothing is lost. */
export type NotebookPageSaveResult = NotebookPageResult | { ok: false; reason: 'conflict'; page: NotebookPage }

export function checkSectionInput(raw: SectionInput): { input: SectionInput | null; issues: NotebookIssue[] } {
  const { title, issues } = checkNotebookTitle(raw.title, SECTION_TITLE_MAX)
  return title === null ? { input: null, issues } : { input: { title }, issues }
}

export function checkPageInput(raw: PageInput): { input: PageInput | null; issues: NotebookIssue[] } {
  const { title, issues } = checkNotebookTitle(raw.title, PAGE_TITLE_MAX)
  return title === null ? { input: null, issues } : { input: { title }, issues }
}

/** checkNoteContent with issues in the notebook's shape. `content` is the canonical copy. */
export function checkPageContent(raw: unknown): { content: NoteContent | null; issues: NotebookIssue[] } {
  const check = checkNoteContent(raw)
  if (check.content) return { content: check.content, issues: [] }
  return {
    content: null,
    issues: check.issues.map((i) => ({ field: 'content', code: i.code, ...(i.blockIndex === undefined ? {} : { blockIndex: i.blockIndex }) }))
  }
}

export const tooManyIssue = (): NotebookIssue => ({ field: 'limit', code: 'too-many' })

/** Whether a save should keep a snapshot: the page has none yet, or its newest is old enough. */
export function shouldSnapshot(lastRevisionAt: string | null, now: Date): boolean {
  if (lastRevisionAt === null) return true
  const last = Date.parse(lastRevisionAt)
  return Number.isNaN(last) || now.getTime() - last >= REVISION_INTERVAL_MS
}

/** `toIndex` limited to 0..`max` (the last valid index). */
export const clampIndex = (toIndex: number, max: number): number => Math.max(0, Math.min(Math.trunc(toIndex), max))
