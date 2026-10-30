import { emptyNoteContent, serializeNoteContent } from '../../../shared/note-content'
import {
  checkPageContent,
  checkPageInput,
  checkSectionInput,
  clampIndex,
  compareByPosition,
  moveItem,
  NOTEBOOK_MAX_SECTIONS,
  PAGE_JSON_MAX,
  SECTION_MAX_PAGES,
  shouldSnapshot,
  tooManyIssue,
  type NotebookFailure,
  type NotebookPage,
  type NotebookPageResult,
  type NotebookPageSaveResult,
  type NotebookPageSummary,
  type NotebookSection,
  type NotebookSectionResult,
  type PageRevision,
  type PageRevisionSummary
} from '../../../shared/notebook'
import type { NotebookApi } from '../runtime/notebookApi'
import type { DemoNotebookFixtures } from './sampleData'

// The browser demo's research notebooks (#147): fictional sections, pages and
// history held in this page's memory only, so a refresh starts again from the
// sample set. Same shared rules and order of checks as the host's repository
// (src/main/database/notebook-repository.ts, which documents them): case not
// found, case or client archived, target belongs to the case, archived target,
// then input; stale saves come back as `conflict` with the current page. It never
// touches SQLite or the Live API.

/** The demo's clock (demoApi.ts DemoClock), spelled out so this file stays free of the runtime. */
export interface NotebookClock {
  now: () => Date
  newId: () => string
}

export type DemoNotebookData = DemoNotebookFixtures

/** What the notebook needs from the demo's cases: existence, the write check, and the case's updated time. */
export interface DemoNotebookCases {
  exists(caseId: string): boolean
  /** Null when the case can be written to; otherwise the refusal. */
  writable(caseId: string): Promise<NotebookFailure | null>
  touch(caseId: string, at: string): void
}

const NOT_FOUND: NotebookFailure = { ok: false, reason: 'not-found' }
const WRONG_STATUS: NotebookFailure = { ok: false, reason: 'wrong-status' }

export function createDemoNotebook(initial: DemoNotebookData, cases: DemoNotebookCases, clock: NotebookClock): NotebookApi {
  let notebooks = structuredClone(initial.notebooks)
  let sections = structuredClone(initial.sections)
  let pages = structuredClone(initial.pages)
  let revisions = structuredClone(initial.revisions)

  const summaryOf = (page: NotebookPage): NotebookPageSummary => ({
    id: page.id,
    sectionId: page.sectionId,
    caseId: page.caseId,
    title: page.title,
    position: page.position,
    version: page.version,
    archivedAt: page.archivedAt,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt
  })
  const revisionSummaryOf = (r: PageRevision): PageRevisionSummary => ({
    id: r.id,
    pageId: r.pageId,
    caseId: r.caseId,
    version: r.version,
    title: r.title,
    reason: r.reason,
    createdAt: r.createdAt
  })

  const reply = async <T>(work: () => T): Promise<T> => structuredClone(work())

  const sectionsOf = (caseId: string) => sections.filter((s) => s.caseId === caseId).sort(compareByPosition)
  const pagesIn = (sectionId: string) => pages.filter((p) => p.sectionId === sectionId).sort(compareByPosition)
  const findSection = (caseId: string, id: string) => sections.find((s) => s.id === id && s.caseId === caseId)
  const findPage = (caseId: string, id: string) => pages.find((p) => p.id === id && p.caseId === caseId)

  /** Positions 0..n-1 in the order of `ids`. */
  const renumber = (ids: readonly string[]) => {
    ids.forEach((id, position) => {
      sections = sections.map((s) => (s.id === id ? { ...s, position } : s))
      pages = pages.map((p) => (p.id === id ? { ...p, position } : p))
    })
  }
  const patchSection = (id: string, patch: Partial<NotebookSection>) => {
    sections = sections.map((s) => (s.id === id ? { ...s, ...patch } : s))
  }
  const patchPage = (id: string, patch: Partial<NotebookPage>) => {
    pages = pages.map((p) => (p.id === id ? { ...p, ...patch } : p))
  }
  const sectionResult = (caseId: string, id: string): NotebookSectionResult => {
    const section = findSection(caseId, id)
    return section ? structuredClone({ ok: true as const, section }) : NOT_FOUND
  }
  const pageResult = (caseId: string, id: string): NotebookPageResult => {
    const page = findPage(caseId, id)
    return page ? structuredClone({ ok: true as const, page }) : NOT_FOUND
  }
  const addRevision = (page: NotebookPage, version: number, reason: PageRevision['reason'], at: string) => {
    revisions = [
      ...revisions,
      { id: clock.newId(), pageId: page.id, caseId: page.caseId, version, title: page.title, reason, createdAt: at, content: structuredClone(page.content) }
    ]
  }
  // Newest first; revisions are only ever appended, so the later one wins a tie.
  const revisionsOf = (caseId: string, pageId: string) =>
    revisions
      .map((revision, index) => ({ revision, index }))
      .filter(({ revision }) => revision.pageId === pageId && revision.caseId === caseId)
      .sort((a, b) => b.revision.createdAt.localeCompare(a.revision.createdAt) || b.index - a.index)
      .map(({ revision }) => revision)

  async function setSectionArchived(caseId: string, sectionId: string, archive: boolean): Promise<NotebookSectionResult> {
    const blocked = await cases.writable(caseId)
    if (blocked) return blocked
    const section = findSection(caseId, sectionId)
    if (!section) return NOT_FOUND
    if ((section.archivedAt !== null) === archive) return WRONG_STATUS
    const at = clock.now().toISOString()
    patchSection(sectionId, { archivedAt: archive ? at : null, updatedAt: at })
    cases.touch(caseId, at)
    return sectionResult(caseId, sectionId)
  }

  async function setPageArchived(caseId: string, pageId: string, archive: boolean): Promise<NotebookPageResult> {
    const blocked = await cases.writable(caseId)
    if (blocked) return blocked
    const page = findPage(caseId, pageId)
    if (!page) return NOT_FOUND
    if ((page.archivedAt !== null) === archive) return WRONG_STATUS
    const at = clock.now().toISOString()
    patchPage(pageId, { archivedAt: archive ? at : null, updatedAt: at })
    cases.touch(caseId, at)
    return pageResult(caseId, pageId)
  }

  return {
    getNotebook: (caseId) =>
      reply(() => {
        if (!cases.exists(caseId)) return null
        const notebook = notebooks.find((n) => n.caseId === caseId)
        if (!notebook) return { caseId, notebookId: null, sections: [] }
        return {
          caseId,
          notebookId: notebook.id,
          sections: sectionsOf(caseId).map((s) => ({
            ...s,
            pages: pagesIn(s.id).map(summaryOf)
          }))
        }
      }),

    async createNotebookSection(caseId, raw) {
      const blocked = await cases.writable(caseId)
      if (blocked) return blocked
      const { input, issues } = checkSectionInput(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }
      const existing = sectionsOf(caseId)
      if (existing.length >= NOTEBOOK_MAX_SECTIONS) return { ok: false, reason: 'invalid', issues: [tooManyIssue()] }

      const at = clock.now().toISOString()
      let notebook = notebooks.find((n) => n.caseId === caseId)
      if (!notebook) {
        notebook = { id: clock.newId(), caseId }
        notebooks = [...notebooks, notebook]
      }
      const section: NotebookSection = {
        id: clock.newId(),
        notebookId: notebook.id,
        caseId,
        title: input.title,
        position: existing.length,
        archivedAt: null,
        createdAt: at,
        updatedAt: at
      }
      sections = [...sections, section]
      cases.touch(caseId, at)
      return structuredClone({ ok: true as const, section })
    },

    async renameNotebookSection(caseId, sectionId, raw) {
      const blocked = await cases.writable(caseId)
      if (blocked) return blocked
      const section = findSection(caseId, sectionId)
      if (!section) return NOT_FOUND
      if (section.archivedAt !== null) return WRONG_STATUS
      const { input, issues } = checkSectionInput(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }
      const at = clock.now().toISOString()
      patchSection(sectionId, { title: input.title, updatedAt: at })
      cases.touch(caseId, at)
      return sectionResult(caseId, sectionId)
    },

    async moveNotebookSection(caseId, sectionId, toIndex) {
      const blocked = await cases.writable(caseId)
      if (blocked) return blocked
      const section = findSection(caseId, sectionId)
      if (!section) return NOT_FOUND
      if (section.archivedAt !== null) return WRONG_STATUS
      const ids = sectionsOf(caseId).map((s) => s.id)
      renumber(moveItem(ids, ids.indexOf(sectionId), clampIndex(toIndex, ids.length - 1)))
      const at = clock.now().toISOString()
      patchSection(sectionId, { updatedAt: at })
      cases.touch(caseId, at)
      return sectionResult(caseId, sectionId)
    },

    archiveNotebookSection: (caseId, sectionId) => setSectionArchived(caseId, sectionId, true),
    unarchiveNotebookSection: (caseId, sectionId) => setSectionArchived(caseId, sectionId, false),

    async createNotebookPage(caseId, sectionId, raw) {
      const blocked = await cases.writable(caseId)
      if (blocked) return blocked
      const section = findSection(caseId, sectionId)
      if (!section) return NOT_FOUND
      if (section.archivedAt !== null) return WRONG_STATUS
      const { input, issues } = checkPageInput(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }
      const existing = pagesIn(sectionId)
      if (existing.length >= SECTION_MAX_PAGES) return { ok: false, reason: 'invalid', issues: [tooManyIssue()] }

      const at = clock.now().toISOString()
      const page: NotebookPage = {
        id: clock.newId(),
        sectionId,
        caseId,
        title: input.title,
        position: existing.length,
        version: 1,
        archivedAt: null,
        createdAt: at,
        updatedAt: at,
        content: emptyNoteContent()
      }
      pages = [...pages, page]
      cases.touch(caseId, at)
      return structuredClone({ ok: true as const, page })
    },

    getNotebookPage: (caseId, pageId) => reply(() => findPage(caseId, pageId) ?? null),

    async renameNotebookPage(caseId, pageId, raw) {
      const blocked = await cases.writable(caseId)
      if (blocked) return blocked
      const page = findPage(caseId, pageId)
      if (!page) return NOT_FOUND
      if (page.archivedAt !== null) return WRONG_STATUS
      const { input, issues } = checkPageInput(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }
      const at = clock.now().toISOString()
      patchPage(pageId, { title: input.title, updatedAt: at })
      cases.touch(caseId, at)
      return pageResult(caseId, pageId)
    },

    async moveNotebookPage(caseId, pageId, move) {
      const blocked = await cases.writable(caseId)
      if (blocked) return blocked
      const page = findPage(caseId, pageId)
      if (!page) return NOT_FOUND
      const target = findSection(caseId, move.sectionId)
      if (!target) return NOT_FOUND
      if (page.archivedAt !== null || target.archivedAt !== null) return WRONG_STATUS

      const source = pagesIn(page.sectionId).map((p) => p.id)
      if (target.id === page.sectionId) {
        renumber(moveItem(source, source.indexOf(pageId), clampIndex(move.toIndex, source.length - 1)))
      } else {
        const targetIds = pagesIn(target.id).map((p) => p.id)
        if (targetIds.length >= SECTION_MAX_PAGES) return { ok: false, reason: 'invalid', issues: [tooManyIssue()] }
        const placed = [...targetIds]
        placed.splice(clampIndex(move.toIndex, targetIds.length), 0, pageId)
        patchPage(pageId, { sectionId: target.id })
        renumber(source.filter((id) => id !== pageId))
        renumber(placed)
      }
      const at = clock.now().toISOString()
      patchPage(pageId, { updatedAt: at })
      cases.touch(caseId, at)
      return pageResult(caseId, pageId)
    },

    archiveNotebookPage: (caseId, pageId) => setPageArchived(caseId, pageId, true),
    unarchiveNotebookPage: (caseId, pageId) => setPageArchived(caseId, pageId, false),

    async saveNotebookPage(caseId, pageId, raw): Promise<NotebookPageSaveResult> {
      const blocked = await cases.writable(caseId)
      if (blocked) return blocked
      const page = findPage(caseId, pageId)
      if (!page) return NOT_FOUND
      if (page.archivedAt !== null) return WRONG_STATUS
      if (raw.baseVersion !== page.version) return structuredClone({ ok: false as const, reason: 'conflict' as const, page })
      const { content, issues } = checkPageContent(raw.content)
      if (!content) return { ok: false, reason: 'invalid', issues }
      const serialized = serializeNoteContent(content)
      if (serialized.length > PAGE_JSON_MAX) return { ok: false, reason: 'invalid', issues: [{ field: 'content', code: 'content-too-long' }] }
      if (serialized === serializeNoteContent(page.content)) return pageResult(caseId, pageId)

      const now = clock.now()
      const at = now.toISOString()
      const version = page.version + 1
      patchPage(pageId, { content, version, updatedAt: at })
      const newest = revisionsOf(caseId, pageId)[0]
      if (shouldSnapshot(newest?.createdAt ?? null, now)) addRevision(findPage(caseId, pageId)!, version, 'autosave', at)
      cases.touch(caseId, at)
      return pageResult(caseId, pageId)
    },

    listPageRevisions: (caseId, pageId) =>
      reply(() => revisionsOf(caseId, pageId).map(revisionSummaryOf)),

    getPageRevision: (caseId, pageId, revisionId) =>
      reply(() => revisionsOf(caseId, pageId).find((r) => r.id === revisionId) ?? null),

    async restorePageRevision(caseId, pageId, revisionId, baseVersion): Promise<NotebookPageSaveResult> {
      const blocked = await cases.writable(caseId)
      if (blocked) return blocked
      const page = findPage(caseId, pageId)
      if (!page) return NOT_FOUND
      const revision = revisionsOf(caseId, pageId).find((r) => r.id === revisionId)
      if (!revision) return NOT_FOUND
      if (page.archivedAt !== null) return WRONG_STATUS
      if (baseVersion !== page.version) return structuredClone({ ok: false as const, reason: 'conflict' as const, page })

      const at = clock.now().toISOString()
      const version = page.version + 1
      addRevision(page, page.version, 'restore-point', at)
      patchPage(pageId, { content: structuredClone(revision.content), version, updatedAt: at })
      addRevision(findPage(caseId, pageId)!, version, 'restored', at)
      cases.touch(caseId, at)
      return pageResult(caseId, pageId)
    }
  }
}
