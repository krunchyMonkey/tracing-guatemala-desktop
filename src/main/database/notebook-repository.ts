import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { emptyNoteContent, NOTE_VERSION, parseStoredNoteContent, serializeNoteContent } from '../../shared/note-content'
import {
  checkPageContent,
  checkPageInput,
  checkSectionInput,
  clampIndex,
  moveItem,
  NOTEBOOK_MAX_SECTIONS,
  PAGE_JSON_MAX,
  SECTION_MAX_PAGES,
  shouldSnapshot,
  tooManyIssue,
  type NotebookFailure,
  type NotebookOutline,
  type NotebookPage,
  type NotebookPageResult,
  type NotebookPageSaveResult,
  type NotebookPageSummary,
  type NotebookSection,
  type NotebookSectionResult,
  type PageInput,
  type PageMove,
  type PageRevision,
  type PageRevisionSummary,
  type PageSave,
  type SectionInput
} from '../../shared/notebook'
import type { RepositoryClock } from './client-repository'

// Case research notebook persistence (docs/architecture/research-notebook.md).
// One notebook per case, created by the first section. Every write runs in one
// BEGIN IMMEDIATE transaction: it reads the case and its client, checks the rules,
// writes and bumps the case's updated_at, so a refused write leaves no trace.
// Order of checks: case not found, then case or client archived (wrong-status),
// then the target must belong to that case (not-found), then archived targets
// (wrong-status; archived sections and pages are read-only until unarchived), then
// input (invalid). Reads work on archived cases. Nothing is ever deleted and no
// case_events row is written. Positions are renumbered densely (0..n-1) on every
// move. Limits: 100 sections per notebook and 500 pages per section; going over is
// `invalid` with a `too-many` issue. All SQL is parameterized and nothing submitted
// is ever echoed back in a failure.
//
// Pages are saved with the version the editor started from: if the page has moved
// on the save is refused with `conflict` and the current page, never overwritten.
// A save keeps an `autosave` snapshot of the new content when the page has none or
// its newest is older than REVISION_INTERVAL_MS; restoring first keeps a
// `restore-point` of the current content, then writes the old content as a new
// version with a `restored` snapshot.

const defaultClock: RepositoryClock = { now: () => new Date(), newId: () => randomUUID() }

interface SectionRow {
  id: string
  notebook_id: string
  case_id: string
  title: string
  position: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface PageRow {
  id: string
  section_id: string
  case_id: string
  title: string
  position: number
  version: number
  content: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface RevisionRow {
  id: string
  page_id: string
  case_id: string
  version: number
  title: string
  content: string
  reason: PageRevision['reason']
  created_at: string
}

const toSection = (row: SectionRow): NotebookSection => ({
  id: row.id,
  notebookId: row.notebook_id,
  caseId: row.case_id,
  title: row.title,
  position: row.position,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const toPageSummary = (row: PageRow): NotebookPageSummary => ({
  id: row.id,
  sectionId: row.section_id,
  caseId: row.case_id,
  title: row.title,
  position: row.position,
  version: row.version,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const toPage = (row: PageRow): NotebookPage => ({ ...toPageSummary(row), content: parseStoredNoteContent(row.content) })

const toRevisionSummary = (row: RevisionRow): PageRevisionSummary => ({
  id: row.id,
  pageId: row.page_id,
  caseId: row.case_id,
  version: row.version,
  title: row.title,
  reason: row.reason,
  createdAt: row.created_at
})

const SUMMARY_COLUMNS = 'id, section_id, case_id, title, position, version, archived_at, created_at, updated_at'
const NOT_FOUND: NotebookFailure = { ok: false, reason: 'not-found' }
const WRONG_STATUS: NotebookFailure = { ok: false, reason: 'wrong-status' }

export class NotebookRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: RepositoryClock = defaultClock
  ) {}

  // ---------- reads ----------

  /** Null for an unknown case; `notebookId: null` and no sections until the first section exists. */
  getOutline(caseId: string): NotebookOutline | null {
    if (!this.db.prepare('SELECT 1 FROM research_cases WHERE id = ?').get(caseId)) return null
    const notebook = this.db.prepare('SELECT id FROM case_notebooks WHERE case_id = ?').get(caseId) as { id: string } | undefined
    if (!notebook) return { caseId, notebookId: null, sections: [] }

    const sections = this.db
      .prepare('SELECT * FROM notebook_sections WHERE case_id = ? ORDER BY position, id')
      .all(caseId) as unknown as SectionRow[]
    const pages = this.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM notebook_pages WHERE case_id = ? ORDER BY position, id`)
      .all(caseId) as unknown as PageRow[]
    return {
      caseId,
      notebookId: notebook.id,
      sections: sections.map((s) => ({ ...toSection(s), pages: pages.filter((p) => p.section_id === s.id).map(toPageSummary) }))
    }
  }

  getPage(caseId: string, pageId: string): NotebookPage | null {
    const row = this.pageRow(caseId, pageId)
    return row ? toPage(row) : null
  }

  /** Newest first; empty for an unknown case or page. */
  listRevisions(caseId: string, pageId: string): PageRevisionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, page_id, case_id, version, title, '' AS content, reason, created_at
         FROM notebook_page_revisions WHERE page_id = ? AND case_id = ? ORDER BY created_at DESC, rowid DESC`
      )
      .all(pageId, caseId) as unknown as RevisionRow[]
    return rows.map(toRevisionSummary)
  }

  getRevision(caseId: string, pageId: string, revisionId: string): PageRevision | null {
    const row = this.revisionRow(caseId, pageId, revisionId)
    return row ? { ...toRevisionSummary(row), content: parseStoredNoteContent(row.content) } : null
  }

  // ---------- sections ----------

  createSection(caseId: string, raw: SectionInput): NotebookSectionResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const { input, issues } = checkSectionInput(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const now = this.clock.now().toISOString()
      const notebookId = this.ensureNotebook(caseId, now)
      const { n } = this.db.prepare('SELECT count(*) AS n FROM notebook_sections WHERE notebook_id = ?').get(notebookId) as { n: number }
      if (n >= NOTEBOOK_MAX_SECTIONS) return { ok: false, reason: 'invalid', issues: [tooManyIssue()] }

      const id = this.clock.newId()
      this.db
        .prepare(
          `INSERT INTO notebook_sections (id, notebook_id, case_id, title, position, archived_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(id, notebookId, caseId, input.title, n, now, now)
      this.touch(caseId, now)
      return this.foundSection(caseId, id)
    })
  }

  renameSection(caseId: string, sectionId: string, raw: SectionInput): NotebookSectionResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const section = this.sectionRow(caseId, sectionId)
      if (!section) return NOT_FOUND
      if (section.archived_at !== null) return WRONG_STATUS
      const { input, issues } = checkSectionInput(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const now = this.clock.now().toISOString()
      this.db.prepare('UPDATE notebook_sections SET title = ?, updated_at = ? WHERE id = ? AND case_id = ?').run(input.title, now, sectionId, caseId)
      this.touch(caseId, now)
      return this.foundSection(caseId, sectionId)
    })
  }

  /** `toIndex` is clamped to the last section. Archived sections keep their place in the order. */
  moveSection(caseId: string, sectionId: string, toIndex: number): NotebookSectionResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const section = this.sectionRow(caseId, sectionId)
      if (!section) return NOT_FOUND
      if (section.archived_at !== null) return WRONG_STATUS

      const ids = (
        this.db.prepare('SELECT id FROM notebook_sections WHERE notebook_id = ? ORDER BY position, id').all(section.notebook_id) as { id: string }[]
      ).map((r) => r.id)
      const moved = moveItem(ids, ids.indexOf(sectionId), clampIndex(toIndex, ids.length - 1))
      const now = this.clock.now().toISOString()
      this.renumber('notebook_sections', moved)
      this.db.prepare('UPDATE notebook_sections SET updated_at = ? WHERE id = ?').run(now, sectionId)
      this.touch(caseId, now)
      return this.foundSection(caseId, sectionId)
    })
  }

  archiveSection(caseId: string, sectionId: string): NotebookSectionResult {
    return this.setSectionArchived(caseId, sectionId, true)
  }

  unarchiveSection(caseId: string, sectionId: string): NotebookSectionResult {
    return this.setSectionArchived(caseId, sectionId, false)
  }

  // ---------- pages ----------

  createPage(caseId: string, sectionId: string, raw: PageInput): NotebookPageResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const section = this.sectionRow(caseId, sectionId)
      if (!section) return NOT_FOUND
      if (section.archived_at !== null) return WRONG_STATUS
      const { input, issues } = checkPageInput(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }
      const { n } = this.db.prepare('SELECT count(*) AS n FROM notebook_pages WHERE section_id = ?').get(sectionId) as { n: number }
      if (n >= SECTION_MAX_PAGES) return { ok: false, reason: 'invalid', issues: [tooManyIssue()] }

      const now = this.clock.now().toISOString()
      const id = this.clock.newId()
      this.db
        .prepare(
          `INSERT INTO notebook_pages
             (id, section_id, case_id, title, position, version, content, content_version, archived_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)`
        )
        .run(id, sectionId, caseId, input.title, n, serializeNoteContent(emptyNoteContent()), NOTE_VERSION, now, now)
      this.touch(caseId, now)
      return this.foundPage(caseId, id)
    })
  }

  /** Does not change the page's version: only content saves do. */
  renamePage(caseId: string, pageId: string, raw: PageInput): NotebookPageResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const page = this.pageRow(caseId, pageId)
      if (!page) return NOT_FOUND
      if (page.archived_at !== null) return WRONG_STATUS
      const { input, issues } = checkPageInput(raw)
      if (!input) return { ok: false, reason: 'invalid', issues }

      const now = this.clock.now().toISOString()
      this.db.prepare('UPDATE notebook_pages SET title = ?, updated_at = ? WHERE id = ? AND case_id = ?').run(input.title, now, pageId, caseId)
      this.touch(caseId, now)
      return this.foundPage(caseId, pageId)
    })
  }

  /** To another section of the same case (not archived) or within one; `toIndex` is clamped. Both sections are renumbered. */
  movePage(caseId: string, pageId: string, raw: PageMove): NotebookPageResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const page = this.pageRow(caseId, pageId)
      if (!page) return NOT_FOUND
      const target = this.sectionRow(caseId, raw.sectionId)
      if (!target) return NOT_FOUND
      if (page.archived_at !== null || target.archived_at !== null) return WRONG_STATUS

      const pageIdsOf = (sectionId: string): string[] =>
        (this.db.prepare('SELECT id FROM notebook_pages WHERE section_id = ? ORDER BY position, id').all(sectionId) as { id: string }[]).map((r) => r.id)
      const sameSection = target.id === page.section_id
      const source = pageIdsOf(page.section_id)
      const targetIds = sameSection ? source : pageIdsOf(target.id)
      if (!sameSection && targetIds.length >= SECTION_MAX_PAGES) return { ok: false, reason: 'invalid', issues: [tooManyIssue()] }

      const now = this.clock.now().toISOString()
      if (sameSection) {
        this.renumber('notebook_pages', moveItem(source, source.indexOf(pageId), clampIndex(raw.toIndex, source.length - 1)))
      } else {
        const rest = source.filter((id) => id !== pageId)
        const placed = [...targetIds]
        placed.splice(clampIndex(raw.toIndex, targetIds.length), 0, pageId)
        this.db.prepare('UPDATE notebook_pages SET section_id = ? WHERE id = ? AND case_id = ?').run(target.id, pageId, caseId)
        this.renumber('notebook_pages', rest)
        this.renumber('notebook_pages', placed)
      }
      this.db.prepare('UPDATE notebook_pages SET updated_at = ? WHERE id = ?').run(now, pageId)
      this.touch(caseId, now)
      return this.foundPage(caseId, pageId)
    })
  }

  archivePage(caseId: string, pageId: string): NotebookPageResult {
    return this.setPageArchived(caseId, pageId, true)
  }

  unarchivePage(caseId: string, pageId: string): NotebookPageResult {
    return this.setPageArchived(caseId, pageId, false)
  }

  /** Identical content changes nothing (no version, no snapshot). A stale `baseVersion` returns `conflict` with the current page. */
  savePage(caseId: string, pageId: string, raw: PageSave): NotebookPageSaveResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const page = this.pageRow(caseId, pageId)
      if (!page) return NOT_FOUND
      if (page.archived_at !== null) return WRONG_STATUS
      if (raw.baseVersion !== page.version) return { ok: false, reason: 'conflict', page: toPage(page) }
      const { content, issues } = checkPageContent(raw.content)
      if (!content) return { ok: false, reason: 'invalid', issues }
      const serialized = serializeNoteContent(content)
      if (serialized.length > PAGE_JSON_MAX) return { ok: false, reason: 'invalid', issues: [{ field: 'content', code: 'content-too-long' }] }
      if (serialized === page.content) return { ok: true, page: toPage(page) }

      const now = this.clock.now()
      const at = now.toISOString()
      const version = page.version + 1
      this.db
        .prepare('UPDATE notebook_pages SET content = ?, content_version = ?, version = ?, updated_at = ? WHERE id = ? AND case_id = ?')
        .run(serialized, NOTE_VERSION, version, at, pageId, caseId)
      if (shouldSnapshot(this.newestRevisionAt(pageId), now)) {
        this.addRevision(caseId, pageId, version, page.title, serialized, 'autosave', at)
      }
      this.touch(caseId, at)
      return this.foundPage(caseId, pageId)
    })
  }

  /** Makes an earlier revision's content the page's newest version. The title is kept. */
  restoreRevision(caseId: string, pageId: string, revisionId: string, baseVersion: number): NotebookPageSaveResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const page = this.pageRow(caseId, pageId)
      if (!page) return NOT_FOUND
      const revision = this.revisionRow(caseId, pageId, revisionId)
      if (!revision) return NOT_FOUND
      if (page.archived_at !== null) return WRONG_STATUS
      if (baseVersion !== page.version) return { ok: false, reason: 'conflict', page: toPage(page) }

      const at = this.clock.now().toISOString()
      const version = page.version + 1
      const restored = serializeNoteContent(parseStoredNoteContent(revision.content))
      this.addRevision(caseId, pageId, page.version, page.title, page.content, 'restore-point', at)
      this.db
        .prepare('UPDATE notebook_pages SET content = ?, content_version = ?, version = ?, updated_at = ? WHERE id = ? AND case_id = ?')
        .run(restored, NOTE_VERSION, version, at, pageId, caseId)
      this.addRevision(caseId, pageId, version, page.title, restored, 'restored', at)
      this.touch(caseId, at)
      return this.foundPage(caseId, pageId)
    })
  }

  // ---------- internals ----------

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Null when the case exists and can be written to; otherwise the refusal. */
  private checkCase(caseId: string): NotebookFailure | null {
    const row = this.db
      .prepare(
        `SELECT c.archived_at AS case_archived_at, k.status AS client_status
         FROM research_cases c JOIN clients k ON k.id = c.client_id WHERE c.id = ?`
      )
      .get(caseId) as { case_archived_at: string | null; client_status: string } | undefined
    if (!row) return NOT_FOUND
    if (row.client_status !== 'active' || row.case_archived_at !== null) return WRONG_STATUS
    return null
  }

  /** The case's notebook id, creating the notebook if the case has none yet. */
  private ensureNotebook(caseId: string, now: string): string {
    const existing = this.db.prepare('SELECT id FROM case_notebooks WHERE case_id = ?').get(caseId) as { id: string } | undefined
    if (existing) {
      this.db.prepare('UPDATE case_notebooks SET updated_at = ? WHERE id = ?').run(now, existing.id)
      return existing.id
    }
    const id = this.clock.newId()
    this.db
      .prepare(
        `INSERT INTO case_notebooks (id, case_id, client_id, created_at, updated_at)
         SELECT ?, id, client_id, ?, ? FROM research_cases WHERE id = ?`
      )
      .run(id, now, now, caseId)
    return id
  }

  private touch(caseId: string, at: string): void {
    this.db.prepare('UPDATE research_cases SET updated_at = ? WHERE id = ?').run(at, caseId)
    this.db.prepare('UPDATE case_notebooks SET updated_at = ? WHERE case_id = ?').run(at, caseId)
  }

  /** Positions 0..n-1 in the order of `ids`. */
  private renumber(table: 'notebook_sections' | 'notebook_pages', ids: readonly string[]): void {
    const update = this.db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`)
    ids.forEach((id, index) => update.run(index, id))
  }

  private sectionRow(caseId: string, sectionId: string): SectionRow | undefined {
    return this.db.prepare('SELECT * FROM notebook_sections WHERE id = ? AND case_id = ?').get(sectionId, caseId) as SectionRow | undefined
  }

  private pageRow(caseId: string, pageId: string): PageRow | undefined {
    return this.db.prepare('SELECT * FROM notebook_pages WHERE id = ? AND case_id = ?').get(pageId, caseId) as PageRow | undefined
  }

  private revisionRow(caseId: string, pageId: string, revisionId: string): RevisionRow | undefined {
    return this.db
      .prepare('SELECT * FROM notebook_page_revisions WHERE id = ? AND page_id = ? AND case_id = ?')
      .get(revisionId, pageId, caseId) as RevisionRow | undefined
  }

  private newestRevisionAt(pageId: string): string | null {
    const row = this.db
      .prepare('SELECT created_at FROM notebook_page_revisions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(pageId) as { created_at: string } | undefined
    return row?.created_at ?? null
  }

  private addRevision(
    caseId: string,
    pageId: string,
    version: number,
    title: string,
    content: string,
    reason: PageRevision['reason'],
    at: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO notebook_page_revisions (id, page_id, case_id, version, title, content, content_version, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.clock.newId(), pageId, caseId, version, title, content, NOTE_VERSION, reason, at)
  }

  private setSectionArchived(caseId: string, sectionId: string, archive: boolean): NotebookSectionResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const section = this.sectionRow(caseId, sectionId)
      if (!section) return NOT_FOUND
      if ((section.archived_at !== null) === archive) return WRONG_STATUS

      const now = this.clock.now().toISOString()
      this.db.prepare('UPDATE notebook_sections SET archived_at = ?, updated_at = ? WHERE id = ? AND case_id = ?').run(archive ? now : null, now, sectionId, caseId)
      this.touch(caseId, now)
      return this.foundSection(caseId, sectionId)
    })
  }

  private setPageArchived(caseId: string, pageId: string, archive: boolean): NotebookPageResult {
    return this.transaction(() => {
      const blocked = this.checkCase(caseId)
      if (blocked) return blocked
      const page = this.pageRow(caseId, pageId)
      if (!page) return NOT_FOUND
      if ((page.archived_at !== null) === archive) return WRONG_STATUS

      const now = this.clock.now().toISOString()
      this.db.prepare('UPDATE notebook_pages SET archived_at = ?, updated_at = ? WHERE id = ? AND case_id = ?').run(archive ? now : null, now, pageId, caseId)
      this.touch(caseId, now)
      return this.foundPage(caseId, pageId)
    })
  }

  private foundSection(caseId: string, sectionId: string): NotebookSectionResult {
    const row = this.sectionRow(caseId, sectionId)
    return row ? { ok: true, section: toSection(row) } : NOT_FOUND
  }

  private foundPage(caseId: string, pageId: string): NotebookPageResult {
    const row = this.pageRow(caseId, pageId)
    return row ? { ok: true, page: toPage(row) } : NOT_FOUND
  }
}
