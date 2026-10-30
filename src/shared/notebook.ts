// Research notebook structure (docs/architecture/research-notebook.md). Types and
// rules only; storage comes with the NotebookRepository (#147).
//
// A notebook belongs to exactly one research case, and the case owns client
// isolation: every section, page and revision carries its `caseId`, and the host
// verifies it against the case before any read or write. Page content is always
// `NoteContent` (note-content.ts), never an editor library's native document.
// No Node imports: the renderer bundles this file.

import type { NoteContent } from './note-content'

export const SECTION_TITLE_MAX = 80
export const PAGE_TITLE_MAX = 120

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
