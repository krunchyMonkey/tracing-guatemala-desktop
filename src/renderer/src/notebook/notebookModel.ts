import { compareByPosition, type NotebookOutline, type NotebookPageSummary } from '../../../shared/notebook'

// Plain helpers for the notebook screens: what to show where, and which index the host
// expects. The host numbers moves among ALL siblings (archived ones keep their place),
// while the person only sees the active ones, so moves are translated here.

export type OutlineSection = NotebookOutline['sections'][number]

export const FIRST_SECTION_TITLE = 'Research notes'
export const FIRST_PAGE_TITLE = 'First page'
export const NEW_PAGE_TITLE = 'Untitled page'
export const NEW_SECTION_TITLE = 'New section'

/** Sections and their pages in display order (archived ones included). */
export function orderedOutline(outline: NotebookOutline): OutlineSection[] {
  return [...outline.sections]
    .sort(compareByPosition)
    .map((section) => ({ ...section, pages: [...section.pages].sort(compareByPosition) }))
}

export const activeSections = (sections: OutlineSection[]): OutlineSection[] => sections.filter((s) => s.archivedAt === null)

export const activePages = (section: OutlineSection): NotebookPageSummary[] => section.pages.filter((p) => p.archivedAt === null)

export interface ArchivedEntry {
  section: OutlineSection
  /** True when the whole section is archived; otherwise only `pages` are. */
  sectionArchived: boolean
  pages: NotebookPageSummary[]
}

/** Archived sections (with all their pages) and archived pages of active sections. */
export function archivedEntries(sections: OutlineSection[]): ArchivedEntry[] {
  const entries: ArchivedEntry[] = []
  for (const section of sections) {
    if (section.archivedAt !== null) entries.push({ section, sectionArchived: true, pages: section.pages })
    else {
      const pages = section.pages.filter((p) => p.archivedAt !== null)
      if (pages.length > 0) entries.push({ section, sectionArchived: false, pages })
    }
  }
  return entries
}

export function findPage(sections: OutlineSection[], pageId: string): { section: OutlineSection; page: NotebookPageSummary } | null {
  for (const section of sections) {
    const page = section.pages.find((p) => p.id === pageId)
    if (page) return { section, page }
  }
  return null
}

/** The first page a person can write on, for opening the notebook. */
export function firstOpenPage(sections: OutlineSection[]): NotebookPageSummary | null {
  for (const section of activeSections(sections)) {
    const page = activePages(section)[0]
    if (page) return page
  }
  return null
}

/**
 * The host index for moving `id` one step up or down among the visible (active) siblings:
 * the full-list index of the neighbour it swaps with. Null at either end.
 */
export function stepIndex<T extends { id: string; archivedAt: string | null }>(all: T[], id: string, direction: -1 | 1): number | null {
  const visible = all.filter((item) => item.archivedAt === null)
  const at = visible.findIndex((item) => item.id === id)
  const neighbour = visible[at + direction]
  if (at < 0 || !neighbour) return null
  return all.findIndex((item) => item.id === neighbour.id)
}
