import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppData, inspectBackup } from '../../src/main/database/app-data'
import { CaseRepository } from '../../src/main/database/case-repository'
import { ClientRepository } from '../../src/main/database/client-repository'
import { APPLICATION_ID, configureConnection, dataDirectory, openAppDatabase } from '../../src/main/database/connection'
import { getSchemaVersion, migrate, migrations } from '../../src/main/database/migrations'
import { NotebookRepository } from '../../src/main/database/notebook-repository'
import type { CaseInput } from '../../src/shared/case-model'
import type { ClientInput } from '../../src/shared/client-model'
import {
  NOTEBOOK_MAX_SECTIONS,
  REVISION_INTERVAL_MS,
  SECTION_MAX_PAGES,
  shouldSnapshot,
  type NotebookPage,
  type NotebookPageResult,
  type NotebookSection,
  type NotebookSectionResult
} from '../../src/shared/notebook'
import { emptyNoteContent, serializeNoteContent, type NoteBlock, type NoteContent } from '../../src/shared/note-content'

// Research notebook storage (#147): the SQLite repository on real migrations,
// the database triggers, a host restart, migration 8 on a real v7 profile and
// backups. Fictional data only.

const clientInput: ClientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: null,
  email: null,
  otherContact: null,
  preferredContactChannel: 'unspecified'
}
const caseInput: CaseInput = { title: 'Paternal line', goal: null, orderReference: null, dueDate: null }

const START = new Date('2026-10-29T12:00:00.000Z')

/** A clock the test moves by hand; ids are sequential and valid UUIDs. */
function manualClock() {
  let at = START.getTime()
  let n = 0
  return {
    now: () => new Date(at),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    advance: (ms: number) => {
      at += ms
    }
  }
}

const blockId = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const paragraph = (n: number, text: string): NoteBlock => ({ id: blockId(n), type: 'paragraph', indent: 0, content: [{ text }] })
const doc = (...blocks: NoteBlock[]): NoteContent => ({ format: 'tg-note', version: 1, blocks })

function section(result: NotebookSectionResult): NotebookSection {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.section
}
function page(result: { ok: boolean }): NotebookPage {
  const r = result as NotebookPageResult
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`)
  return r.page
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  migrate(db)
  return db
}
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

describe('NotebookRepository', () => {
  let db: DatabaseSync
  let clock: ReturnType<typeof manualClock>
  let clients: ClientRepository
  let cases: CaseRepository
  let nb: NotebookRepository
  let clientId: string
  let caseId: string

  const newCase = (forClient = clientId, title = 'Another case'): string => {
    const created = cases.create(forClient, { ...caseInput, title })
    if (!created.ok) throw new Error('fixture case invalid')
    return created.case.id
  }
  const newClient = (displayName: string): string => {
    const created = clients.create({ ...clientInput, displayName })
    if (!created.ok) throw new Error('fixture client invalid')
    return created.client.id
  }
  const titles = (id = caseId) => nb.getOutline(id)!.sections.map((s) => [s.title, s.pages.map((p) => p.title)])

  beforeEach(() => {
    db = memoryDb()
    clock = manualClock()
    clients = new ClientRepository(db, clock)
    cases = new CaseRepository(db, clock)
    nb = new NotebookRepository(db, clock)
    clientId = newClient('Ana Ejemplo')
    caseId = newCase(clientId, 'Paternal line')
  })

  afterEach(() => db.close())

  describe('outline and creation', () => {
    it('answers null for an unknown case and an empty outline before the first section', () => {
      expect(nb.getOutline(clock.newId())).toBeNull()
      expect(nb.getOutline(caseId)).toEqual({ caseId, notebookId: null, sections: [] })
      expect(count(db, 'case_notebooks')).toBe(0)
    })

    it('creates the notebook with the first section and appends sections and pages in order', () => {
      const a = section(nb.createSection(caseId, { title: '  Archive visits  ' }))
      const b = section(nb.createSection(caseId, { title: 'Interviews' }))
      expect(a).toMatchObject({ caseId, title: 'Archive visits', position: 0, archivedAt: null })
      expect(b.position).toBe(1)
      expect(b.notebookId).toBe(a.notebookId)
      expect(count(db, 'case_notebooks')).toBe(1)

      const p1 = page(nb.createPage(caseId, a.id, { title: 'First visit' }))
      const p2 = page(nb.createPage(caseId, a.id, { title: 'Second visit' }))
      expect(p1).toMatchObject({ sectionId: a.id, caseId, position: 0, version: 1, archivedAt: null, content: emptyNoteContent() })
      expect(p2.position).toBe(1)

      const outline = nb.getOutline(caseId)!
      expect(outline.notebookId).toBe(a.notebookId)
      expect(titles()).toEqual([
        ['Archive visits', ['First visit', 'Second visit']],
        ['Interviews', []]
      ])
      // The outline carries no page content.
      expect(Object.keys(outline.sections[0]!.pages[0]!)).not.toContain('content')
      expect(nb.getPage(caseId, p1.id)).toEqual(p1)
    })

    it('bumps the case updated time and writes no case events', () => {
      const before = cases.get(caseId)!
      const events = count(db, 'case_events')
      clock.advance(1000)
      section(nb.createSection(caseId, { title: 'Archive visits' }))
      expect(cases.get(caseId)!.updatedAt).toBe('2026-10-29T12:00:01.000Z')
      expect(cases.get(caseId)!.updatedAt > before.updatedAt).toBe(true)
      expect(count(db, 'case_events')).toBe(events)
    })

    it('validates titles with typed issues and no echo', () => {
      for (const [title, code] of [
        ['   ', 'required'],
        ['x'.repeat(81), 'too-long'],
        ['bad\u0000title', 'invalid-characters']
      ] as const) {
        expect(nb.createSection(caseId, { title })).toEqual({ ok: false, reason: 'invalid', issues: [{ field: 'title', code }] })
      }
      const s = section(nb.createSection(caseId, { title: 'Ok' }))
      expect(nb.createPage(caseId, s.id, { title: 'y'.repeat(121) })).toEqual({
        ok: false,
        reason: 'invalid',
        issues: [{ field: 'title', code: 'too-long' }]
      })
      expect(section(nb.createSection(caseId, { title: 'z'.repeat(80) })).title).toHaveLength(80)
      expect(count(db, 'notebook_pages')).toBe(0)
    })

    it('limits sections per notebook and pages per section', () => {
      for (let i = 0; i < NOTEBOOK_MAX_SECTIONS; i += 1) section(nb.createSection(caseId, { title: `S${i}` }))
      expect(nb.createSection(caseId, { title: 'One too many' })).toEqual({
        ok: false,
        reason: 'invalid',
        issues: [{ field: 'limit', code: 'too-many' }]
      })
      const first = nb.getOutline(caseId)!.sections[0]!
      for (let i = 0; i < SECTION_MAX_PAGES; i += 1) page(nb.createPage(caseId, first.id, { title: `P${i}` }))
      expect(nb.createPage(caseId, first.id, { title: 'One too many' })).toMatchObject({ ok: false, reason: 'invalid', issues: [{ code: 'too-many' }] })
      const second = nb.getOutline(caseId)!.sections[1]!
      const lone = page(nb.createPage(caseId, second.id, { title: 'Lone' }))
      expect(nb.movePage(caseId, lone.id, { sectionId: first.id, toIndex: 0 })).toMatchObject({ ok: false, reason: 'invalid' })
      expect(nb.getPage(caseId, lone.id)!.sectionId).toBe(second.id)
    })
  })

  describe('renaming, moving and archiving', () => {
    let a: NotebookSection
    let b: NotebookSection
    let c: NotebookSection

    beforeEach(() => {
      a = section(nb.createSection(caseId, { title: 'A' }))
      b = section(nb.createSection(caseId, { title: 'B' }))
      c = section(nb.createSection(caseId, { title: 'C' }))
    })

    it('renames a section and a page without bumping the page version', () => {
      expect(section(nb.renameSection(caseId, a.id, { title: ' Renamed ' })).title).toBe('Renamed')
      const p = page(nb.createPage(caseId, a.id, { title: 'Old' }))
      clock.advance(1000)
      const renamed = page(nb.renamePage(caseId, p.id, { title: 'New' }))
      expect(renamed).toMatchObject({ title: 'New', version: 1, content: p.content })
      expect(renamed.updatedAt > p.updatedAt).toBe(true)
      expect(nb.renameSection(caseId, a.id, { title: '' })).toMatchObject({ ok: false, reason: 'invalid' })
      expect(nb.renamePage(caseId, clock.newId(), { title: 'x' })).toEqual({ ok: false, reason: 'not-found' })
    })

    it('moves sections and renumbers them densely, clamping the index', () => {
      expect(section(nb.moveSection(caseId, c.id, 0)).position).toBe(0)
      expect(titles().map(([t]) => t)).toEqual(['C', 'A', 'B'])
      nb.moveSection(caseId, c.id, 99)
      expect(titles().map(([t]) => t)).toEqual(['A', 'B', 'C'])
      nb.moveSection(caseId, a.id, 1)
      expect(titles().map(([t]) => t)).toEqual(['B', 'A', 'C'])
      expect(nb.getOutline(caseId)!.sections.map((s) => s.position)).toEqual([0, 1, 2])
      // A move to where it already is changes nothing in the order.
      nb.moveSection(caseId, a.id, 1)
      expect(titles().map(([t]) => t)).toEqual(['B', 'A', 'C'])
    })

    it('moves pages within a section and to another section, renumbering both', () => {
      const [p1, p2, p3] = ['p1', 'p2', 'p3'].map((title) => page(nb.createPage(caseId, a.id, { title })))
      const q1 = page(nb.createPage(caseId, b.id, { title: 'q1' }))
      nb.movePage(caseId, p3!.id, { sectionId: a.id, toIndex: 0 })
      expect(titles()[0]).toEqual(['A', ['p3', 'p1', 'p2']])

      const moved = page(nb.movePage(caseId, p1!.id, { sectionId: b.id, toIndex: 0 }))
      expect(moved).toMatchObject({ sectionId: b.id, position: 0, version: 1 })
      expect(titles().slice(0, 2)).toEqual([
        ['A', ['p3', 'p2']],
        ['B', ['p1', 'q1']]
      ])
      nb.movePage(caseId, p2!.id, { sectionId: b.id, toIndex: 99 })
      const outline = nb.getOutline(caseId)!
      expect(outline.sections[0]!.pages.map((p) => p.position)).toEqual([0])
      expect(outline.sections[1]!.pages.map((p) => [p.title, p.position])).toEqual([['p1', 0], ['q1', 1], ['p2', 2]])
      expect(q1.id).toBeTruthy()
      // Content and version survive a move.
      expect(nb.getPage(caseId, p1!.id)).toMatchObject({ version: 1, content: emptyNoteContent() })
    })

    it('archives and unarchives, refusing a repeat, and keeps archived items in the outline', () => {
      const p = page(nb.createPage(caseId, a.id, { title: 'P' }))
      const archived = section(nb.archiveSection(caseId, b.id))
      expect(archived.archivedAt).not.toBeNull()
      expect(nb.archiveSection(caseId, b.id)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(nb.getOutline(caseId)!.sections[1]!.archivedAt).not.toBeNull()
      expect(section(nb.unarchiveSection(caseId, b.id)).archivedAt).toBeNull()
      expect(nb.unarchiveSection(caseId, b.id)).toEqual({ ok: false, reason: 'wrong-status' })

      expect(page(nb.archivePage(caseId, p.id)).archivedAt).not.toBeNull()
      expect(nb.archivePage(caseId, p.id)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(nb.getOutline(caseId)!.sections[0]!.pages).toHaveLength(1)
      expect(page(nb.unarchivePage(caseId, p.id)).archivedAt).toBeNull()
      expect(nb.unarchivePage(caseId, p.id)).toEqual({ ok: false, reason: 'wrong-status' })
    })

    it('treats archived sections and pages as read-only until unarchived', () => {
      const p = page(nb.createPage(caseId, a.id, { title: 'P' }))
      const q = page(nb.createPage(caseId, c.id, { title: 'Q' }))
      nb.archivePage(caseId, p.id)
      expect(nb.renamePage(caseId, p.id, { title: 'x' })).toEqual({ ok: false, reason: 'wrong-status' })
      expect(nb.movePage(caseId, p.id, { sectionId: b.id, toIndex: 0 })).toEqual({ ok: false, reason: 'wrong-status' })
      expect(nb.savePage(caseId, p.id, { baseVersion: 1, content: doc(paragraph(1, 'x')) })).toEqual({ ok: false, reason: 'wrong-status' })

      nb.archiveSection(caseId, b.id)
      expect(nb.createPage(caseId, b.id, { title: 'x' })).toEqual({ ok: false, reason: 'wrong-status' })
      expect(nb.movePage(caseId, q.id, { sectionId: b.id, toIndex: 0 })).toEqual({ ok: false, reason: 'wrong-status' })
      expect(nb.renameSection(caseId, b.id, { title: 'x' })).toEqual({ ok: false, reason: 'wrong-status' })
      expect(nb.moveSection(caseId, b.id, 0)).toEqual({ ok: false, reason: 'wrong-status' })
      expect(nb.getPage(caseId, p.id)).toMatchObject({ title: 'P', version: 1 })
    })
  })

  describe('saving, history and restore', () => {
    let pageId: string
    const one = doc(paragraph(1, 'First draft.'))
    const two = doc(paragraph(1, 'First draft.'), paragraph(2, 'Second paragraph.'))

    beforeEach(() => {
      const s = section(nb.createSection(caseId, { title: 'Visits' }))
      pageId = page(nb.createPage(caseId, s.id, { title: 'Visit' })).id
    })

    it('saves canonical content, bumps the version and keeps the first snapshot', () => {
      const saved = page(nb.savePage(caseId, pageId, { baseVersion: 1, content: doc({ id: blockId(1), type: 'paragraph', indent: 0, content: [{ text: 'Hello ' }, { text: 'world' }] }) }))
      expect(saved.version).toBe(2)
      expect(saved.content.blocks[0]).toMatchObject({ content: [{ text: 'Hello world' }] })
      expect(nb.getPage(caseId, pageId)).toEqual(saved)
      const revisions = nb.listRevisions(caseId, pageId)
      expect(revisions).toHaveLength(1)
      expect(revisions[0]).toMatchObject({ pageId, caseId, version: 2, title: 'Visit', reason: 'autosave' })
      expect(nb.getRevision(caseId, pageId, revisions[0]!.id)).toMatchObject({ content: saved.content })
    })

    it('refuses a stale baseVersion with the current page and changes nothing', () => {
      page(nb.savePage(caseId, pageId, { baseVersion: 1, content: one }))
      const stale = nb.savePage(caseId, pageId, { baseVersion: 1, content: two })
      expect(stale).toMatchObject({ ok: false, reason: 'conflict', page: { id: pageId, version: 2, content: one } })
      expect(nb.savePage(caseId, pageId, { baseVersion: 3, content: two })).toMatchObject({ ok: false, reason: 'conflict' })
      expect(nb.getPage(caseId, pageId)).toMatchObject({ version: 2, content: one })
      expect(nb.listRevisions(caseId, pageId)).toHaveLength(1)
    })

    it('keepPrevious keeps the replaced content as a restore point, only when the content changes', () => {
      page(nb.savePage(caseId, pageId, { baseVersion: 1, content: one }))
      clock.advance(1000)
      // Same content: nothing happens, not even a restore point.
      page(nb.savePage(caseId, pageId, { baseVersion: 2, content: one, keepPrevious: true }))
      expect(nb.listRevisions(caseId, pageId)).toHaveLength(1)
      // A stale base is still a conflict, with or without the flag.
      expect(nb.savePage(caseId, pageId, { baseVersion: 1, content: two, keepPrevious: true })).toMatchObject({ ok: false, reason: 'conflict' })
      expect(nb.listRevisions(caseId, pageId)).toHaveLength(1)

      const saved = page(nb.savePage(caseId, pageId, { baseVersion: 2, content: two, keepPrevious: true }))
      expect(saved).toMatchObject({ version: 3, content: two })
      const revisions = nb.listRevisions(caseId, pageId)
      const kept = revisions.find((r) => r.reason === 'restore-point')!
      expect(kept).toMatchObject({ version: 2 })
      expect(nb.getRevision(caseId, pageId, kept.id)!.content).toEqual(one)
      // Without the flag, no restore point.
      clock.advance(1000)
      page(nb.savePage(caseId, pageId, { baseVersion: 3, content: one }))
      expect(nb.listRevisions(caseId, pageId).filter((r) => r.reason === 'restore-point')).toHaveLength(1)
    })

    it('treats identical content as a no-op: no version, no revision, no update time', () => {
      const first = page(nb.savePage(caseId, pageId, { baseVersion: 1, content: one }))
      clock.advance(10 * REVISION_INTERVAL_MS)
      const again = page(nb.savePage(caseId, pageId, { baseVersion: 2, content: structuredClone(one) }))
      expect(again).toEqual(first)
      expect(nb.listRevisions(caseId, pageId)).toHaveLength(1)
      // A rename does not move the version either, so the next save still uses 2.
      nb.renamePage(caseId, pageId, { title: 'Renamed' })
      expect(page(nb.savePage(caseId, pageId, { baseVersion: 2, content: two })).version).toBe(3)
    })

    it('keeps an autosave snapshot only when the newest is older than the interval', () => {
      expect(REVISION_INTERVAL_MS).toBe(5 * 60_000)
      page(nb.savePage(caseId, pageId, { baseVersion: 1, content: doc(paragraph(1, 'v2')) }))
      clock.advance(REVISION_INTERVAL_MS - 1)
      page(nb.savePage(caseId, pageId, { baseVersion: 2, content: doc(paragraph(1, 'v3')) }))
      expect(nb.listRevisions(caseId, pageId)).toHaveLength(1)
      clock.advance(1)
      page(nb.savePage(caseId, pageId, { baseVersion: 3, content: doc(paragraph(1, 'v4')) }))
      const revisions = nb.listRevisions(caseId, pageId)
      expect(revisions.map((r) => r.version)).toEqual([4, 2])
      expect(revisions.map((r) => r.reason)).toEqual(['autosave', 'autosave'])
      // The snapshot holds the NEW content of the save that made it.
      expect(nb.getRevision(caseId, pageId, revisions[0]!.id)!.content).toEqual(doc(paragraph(1, 'v4')))
    })

    it('shouldSnapshot is true for no revision, an unreadable time and an old revision', () => {
      const now = new Date('2026-10-29T12:10:00.000Z')
      expect(shouldSnapshot(null, now)).toBe(true)
      expect(shouldSnapshot('2026-10-29T12:05:00.000Z', now)).toBe(true)
      expect(shouldSnapshot('2026-10-29T12:05:00.001Z', now)).toBe(false)
      expect(shouldSnapshot('garbage', now)).toBe(true)
    })

    it('restores a revision: a restore point of the current content, then the restored content', () => {
      page(nb.savePage(caseId, pageId, { baseVersion: 1, content: one }))
      clock.advance(REVISION_INTERVAL_MS)
      page(nb.savePage(caseId, pageId, { baseVersion: 2, content: two }))
      const oldest = nb.listRevisions(caseId, pageId).at(-1)!
      clock.advance(1000)

      expect(nb.restoreRevision(caseId, pageId, oldest.id, 2)).toMatchObject({ ok: false, reason: 'conflict', page: { version: 3 } })
      const restored = page(nb.restoreRevision(caseId, pageId, oldest.id, 3))
      expect(restored).toMatchObject({ version: 4, title: 'Visit', content: one })
      const revisions = nb.listRevisions(caseId, pageId)
      expect(revisions.slice(0, 2).map((r) => [r.reason, r.version])).toEqual([
        ['restored', 4],
        ['restore-point', 3]
      ])
      expect(nb.getRevision(caseId, pageId, revisions[1]!.id)!.content).toEqual(two)
      expect(nb.getRevision(caseId, pageId, revisions[0]!.id)!.content).toEqual(one)
      expect(nb.getRevision(caseId, pageId, clock.newId())).toBeNull()
      expect(nb.restoreRevision(caseId, pageId, clock.newId(), 4)).toEqual({ ok: false, reason: 'not-found' })
    })

    it('refuses invalid content with typed issues and never echoes it', () => {
      const secret = 'Maria Secreta lives at 12 Calle Falsa'
      const bad = [
        ['invalid-href', doc({ id: blockId(1), type: 'paragraph', indent: 0, content: [{ text: secret, href: 'javascript:alert(1)' }] })],
        ['duplicate-id', doc(paragraph(1, secret), paragraph(1, 'again'))],
        ['unknown-block-type', { format: 'tg-note', version: 1, blocks: [{ id: blockId(1), type: 'script', content: secret }] }]
      ] as const
      for (const [code, content] of bad) {
        const result = nb.savePage(caseId, pageId, { baseVersion: 1, content: content as unknown as NoteContent })
        expect(result).toMatchObject({ ok: false, reason: 'invalid', issues: [{ field: 'content', code }] })
        expect(JSON.stringify(result)).not.toContain('Secreta')
      }
      expect(nb.getPage(caseId, pageId)).toMatchObject({ version: 1, content: emptyNoteContent() })
      expect(nb.listRevisions(caseId, pageId)).toEqual([])
    })

    it('refuses a page whose stored JSON would pass 1 MiB even within the content limits', () => {
      const runs = Array.from({ length: 500 }, (_, i) => ({ text: 'a', marks: i % 2 === 0 ? (['bold'] as const) : (['italic'] as const) }))
      const blocks = Array.from({ length: 700 }, (_, i): NoteBlock => ({ id: blockId(i + 1), type: 'paragraph', indent: 0, content: runs.map((r) => ({ ...r, marks: [...r.marks] })) }))
      const result = nb.savePage(caseId, pageId, { baseVersion: 1, content: doc(...blocks) })
      expect(serializeNoteContent(doc(...blocks)).length).toBeGreaterThan(1_048_576)
      expect(result).toMatchObject({ ok: false, reason: 'invalid', issues: [{ field: 'content' }] })
    })
  })

  describe('closed cases and clients', () => {
    it('is readable but read-only on an archived case', () => {
      const s = section(nb.createSection(caseId, { title: 'S' }))
      const p = page(nb.createPage(caseId, s.id, { title: 'P' }))
      nb.savePage(caseId, p.id, { baseVersion: 1, content: doc(paragraph(1, 'x')) })
      const revision = nb.listRevisions(caseId, p.id)[0]!
      expect(cases.archive(caseId).ok).toBe(true)
      expectReadOnly(s.id, p.id, revision.id)
      cases.unarchive(caseId)
      expect(nb.renameSection(caseId, s.id, { title: 'Writable again' }).ok).toBe(true)
    })

    it('is readable but read-only when the client is archived', () => {
      const s = section(nb.createSection(caseId, { title: 'S' }))
      const p = page(nb.createPage(caseId, s.id, { title: 'P' }))
      nb.savePage(caseId, p.id, { baseVersion: 1, content: doc(paragraph(1, 'x')) })
      const revision = nb.listRevisions(caseId, p.id)[0]!
      expect(clients.archive(clientId).ok).toBe(true)
      expectReadOnly(s.id, p.id, revision.id)
    })

    function expectReadOnly(sectionId: string, pageId: string, revisionId: string): void {
      const refused = { ok: false, reason: 'wrong-status' }
      const before = dump()
      expect(nb.createSection(caseId, { title: 'New' })).toEqual(refused)
      expect(nb.renameSection(caseId, sectionId, { title: 'New' })).toEqual(refused)
      expect(nb.moveSection(caseId, sectionId, 0)).toEqual(refused)
      expect(nb.archiveSection(caseId, sectionId)).toEqual(refused)
      expect(nb.unarchiveSection(caseId, sectionId)).toEqual(refused)
      expect(nb.createPage(caseId, sectionId, { title: 'New' })).toEqual(refused)
      expect(nb.renamePage(caseId, pageId, { title: 'New' })).toEqual(refused)
      expect(nb.movePage(caseId, pageId, { sectionId, toIndex: 0 })).toEqual(refused)
      expect(nb.archivePage(caseId, pageId)).toEqual(refused)
      expect(nb.unarchivePage(caseId, pageId)).toEqual(refused)
      expect(nb.savePage(caseId, pageId, { baseVersion: 2, content: doc(paragraph(2, 'y')) })).toEqual(refused)
      expect(nb.restoreRevision(caseId, pageId, revisionId, 2)).toEqual(refused)
      expect(dump()).toEqual(before)
      // Reads still work.
      expect(nb.getOutline(caseId)!.sections).toHaveLength(1)
      expect(nb.getPage(caseId, pageId)).toMatchObject({ version: 2 })
      expect(nb.listRevisions(caseId, pageId)).toHaveLength(1)
      expect(nb.getRevision(caseId, pageId, revisionId)).not.toBeNull()
    }

    const dump = () => ({
      cases: db.prepare('SELECT * FROM research_cases ORDER BY id').all(),
      sections: db.prepare('SELECT * FROM notebook_sections ORDER BY id').all(),
      pages: db.prepare('SELECT * FROM notebook_pages ORDER BY id').all(),
      revisions: db.prepare('SELECT * FROM notebook_page_revisions ORDER BY rowid').all()
    })
  })

  describe('isolation between cases and clients', () => {
    it('does not accept ids from another case or another client, and changes nothing', () => {
      const otherClient = newClient('Beatriz Muestra')
      const caseB = newCase(otherClient, 'Case B')
      const sameClientCase = newCase(clientId, 'Case A2')
      const sA = section(nb.createSection(caseId, { title: 'In A' }))
      const pA = page(nb.createPage(caseId, sA.id, { title: 'Page A' }))
      const sB = section(nb.createSection(caseB, { title: 'In B' }))
      nb.savePage(caseId, pA.id, { baseVersion: 1, content: doc(paragraph(1, 'private')) })
      const revision = nb.listRevisions(caseId, pA.id)[0]!
      const snapshot = () => JSON.stringify([db.prepare('SELECT * FROM notebook_sections ORDER BY id').all(), db.prepare('SELECT * FROM notebook_pages ORDER BY id').all(), db.prepare('SELECT * FROM notebook_page_revisions ORDER BY rowid').all()])
      const before = snapshot()
      const missing = { ok: false, reason: 'not-found' }

      for (const other of [caseB, sameClientCase]) {
        expect(nb.getPage(other, pA.id)).toBeNull()
        expect(nb.listRevisions(other, pA.id)).toEqual([])
        expect(nb.getRevision(other, pA.id, revision.id)).toBeNull()
        expect(nb.renameSection(other, sA.id, { title: 'x' })).toEqual(missing)
        expect(nb.moveSection(other, sA.id, 0)).toEqual(missing)
        expect(nb.archiveSection(other, sA.id)).toEqual(missing)
        expect(nb.unarchiveSection(other, sA.id)).toEqual(missing)
        expect(nb.createPage(other, sA.id, { title: 'x' })).toEqual(missing)
        expect(nb.renamePage(other, pA.id, { title: 'x' })).toEqual(missing)
        expect(nb.archivePage(other, pA.id)).toEqual(missing)
        expect(nb.unarchivePage(other, pA.id)).toEqual(missing)
        expect(nb.savePage(other, pA.id, { baseVersion: 2, content: doc(paragraph(9, 'stolen')) })).toEqual(missing)
        expect(nb.restoreRevision(other, pA.id, revision.id, 2)).toEqual(missing)
      }
      // A page of A cannot be moved into B's section, nor B's page into A.
      expect(nb.movePage(caseId, pA.id, { sectionId: sB.id, toIndex: 0 })).toEqual(missing)
      expect(nb.movePage(caseB, pA.id, { sectionId: sB.id, toIndex: 0 })).toEqual(missing)
      expect(nb.getOutline(sameClientCase)).toEqual({ caseId: sameClientCase, notebookId: null, sections: [] })
      expect(snapshot()).toBe(before)
      expect(nb.getOutline(caseB)!.sections.map((s) => s.title)).toEqual(['In B'])
    })
  })

  describe('database triggers', () => {
    it('reject rows that cross cases or clients, even when written directly', () => {
      const otherClient = newClient('Beatriz Muestra')
      const caseB = newCase(otherClient, 'Case B')
      const sA = section(nb.createSection(caseId, { title: 'In A' }))
      const sB = section(nb.createSection(caseB, { title: 'In B' }))
      const pA = page(nb.createPage(caseId, sA.id, { title: 'Page A' }))
      const at = '2026-10-29T12:00:00.000Z'
      const json = serializeNoteContent(emptyNoteContent())
      const id = (n: number) => `99999999-0000-4000-8000-${String(n).padStart(12, '0')}`

      const notebookB = (db.prepare('SELECT id FROM case_notebooks WHERE case_id = ?').get(caseB) as { id: string }).id
      // A notebook must carry its case's client.
      expect(() => db.prepare('INSERT INTO case_notebooks VALUES (?, ?, ?, ?, ?)').run(id(1), newCase(), otherClient, at, at)).toThrow(/client/)
      // A section must carry its notebook's case.
      expect(() => db.prepare('INSERT INTO notebook_sections VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(id(2), notebookB, caseId, 'x', 5, at, at)).toThrow(/case/)
      // A page must carry its section's case, on insert and on moving.
      expect(() => db.prepare('INSERT INTO notebook_pages VALUES (?, ?, ?, ?, ?, 1, ?, 1, NULL, ?, ?)').run(id(3), sB.id, caseId, 'x', 5, json, at, at)).toThrow(/case/)
      expect(() => db.prepare('UPDATE notebook_pages SET section_id = ? WHERE id = ?').run(sB.id, pA.id)).toThrow(/between sections of its case/)
      // A revision must carry its page's case.
      const revisionSql = 'INSERT INTO notebook_page_revisions VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?)'
      expect(() => db.prepare(revisionSql).run(id(4), pA.id, caseB, 'x', json, 'autosave', at)).toThrow(/case/)
      expect(() => db.prepare(revisionSql).run(id(5), pA.id, caseId, 'x', json, 'bogus', at)).toThrow()
      expect(() => db.prepare(revisionSql).run(id(6), pA.id, caseId, 'x', '{not json', 'autosave', at)).toThrow()
      expect(db.prepare(revisionSql).run(id(7), pA.id, caseId, 'x', json, 'restored', at).changes).toBe(1)
      expect(count(db, 'notebook_page_revisions')).toBe(1)
    })

    it('never delete or rewrite keys, and revisions are append-only', () => {
      const s = section(nb.createSection(caseId, { title: 'S' }))
      const p = page(nb.createPage(caseId, s.id, { title: 'P' }))
      nb.savePage(caseId, p.id, { baseVersion: 1, content: doc(paragraph(1, 'x')) })
      const other = newCase(clientId, 'Other')
      const otherId = '99999999-0000-4000-8000-000000000001'

      for (const sql of [
        'DELETE FROM case_notebooks',
        'DELETE FROM notebook_sections',
        'DELETE FROM notebook_pages',
        'DELETE FROM notebook_page_revisions',
        'UPDATE notebook_page_revisions SET title = \'x\'',
        `UPDATE case_notebooks SET case_id = '${other}'`,
        `UPDATE case_notebooks SET id = '${otherId}'`,
        `UPDATE notebook_sections SET case_id = '${other}'`,
        `UPDATE notebook_sections SET id = '${otherId}'`,
        `UPDATE notebook_pages SET case_id = '${other}'`,
        `UPDATE notebook_pages SET id = '${otherId}'`
      ]) {
        expect(() => db.exec(sql), sql).toThrow()
      }
      expect(count(db, 'notebook_pages')).toBe(1)
      expect(count(db, 'notebook_page_revisions')).toBe(1)
    })

    it('enforce the title, position and content checks', () => {
      const s = section(nb.createSection(caseId, { title: 'S' }))
      expect(() => db.prepare('UPDATE notebook_sections SET title = ? WHERE id = ?').run('', s.id)).toThrow()
      expect(() => db.prepare('UPDATE notebook_sections SET position = -1 WHERE id = ?').run(s.id)).toThrow()
      const p = page(nb.createPage(caseId, s.id, { title: 'P' }))
      expect(() => db.prepare('UPDATE notebook_pages SET content = ? WHERE id = ?').run('nope', p.id)).toThrow()
      expect(() => db.prepare('UPDATE notebook_pages SET content = ? WHERE id = ?').run(`"${'x'.repeat(1_048_576)}"`, p.id)).toThrow()
      expect(() => db.prepare('UPDATE notebook_pages SET version = 0 WHERE id = ?').run(p.id)).toThrow()
    })
  })
})

describe('on disk', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'tg-notebook-test-'))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  function seed(data: AppData): string {
    const client = data.clients.create(clientInput)
    if (!client.ok) throw new Error('fixture client invalid')
    const created = data.cases.create(client.client.id, caseInput)
    if (!created.ok) throw new Error('fixture case invalid')
    return created.case.id
  }

  it('keeps the outline, order, content and history across a host restart', () => {
    let data = new AppData(userData)
    const caseId = seed(data)
    const a = section(data.notebook.createSection(caseId, { title: 'A' }))
    const b = section(data.notebook.createSection(caseId, { title: 'B' }))
    data.notebook.moveSection(caseId, b.id, 0)
    const p = page(data.notebook.createPage(caseId, a.id, { title: 'Page' }))
    data.notebook.savePage(caseId, p.id, { baseVersion: 1, content: doc(paragraph(1, 'Kept.')) })
    const outline = data.notebook.getOutline(caseId)
    const saved = data.notebook.getPage(caseId, p.id)
    const revisions = data.notebook.listRevisions(caseId, p.id)
    data.close()

    data = new AppData(userData)
    try {
      expect(data.notebook.getOutline(caseId)).toEqual(outline)
      expect(outline!.sections.map((s) => s.title)).toEqual(['B', 'A'])
      expect(data.notebook.getPage(caseId, p.id)).toEqual(saved)
      expect(data.notebook.listRevisions(caseId, p.id)).toEqual(revisions)
      expect(page(data.notebook.savePage(caseId, p.id, { baseVersion: 2, content: doc(paragraph(1, 'More.')) })).version).toBe(3)
    } finally {
      data.close()
    }
  })

  describe('migration 8', () => {
    function buildV7Profile(): { file: string; caseId: string } {
      const file = join(dataDirectory(userData), 'tracing-guatemala.sqlite')
      const first = openAppDatabase(userData)
      first.db.close()
      const db = new DatabaseSync(first.file)
      db.exec('DROP TABLE notebook_page_revisions; DROP TABLE notebook_pages; DROP TABLE notebook_sections; DROP TABLE case_notebooks; PRAGMA user_version = 7;')
      const clients = new ClientRepository(db)
      const client = clients.create(clientInput)
      if (!client.ok) throw new Error('fixture client invalid')
      const created = new CaseRepository(db).create(client.client.id, caseInput)
      if (!created.ok) throw new Error('fixture case invalid')
      db.close()
      return { file, caseId: created.case.id }
    }

    it('upgrades a real v7 database with cases and gives old cases a working notebook', () => {
      const { file, caseId } = buildV7Profile()
      const old = new DatabaseSync(file)
      expect(getSchemaVersion(old)).toBe(7)
      const cases = old.prepare('SELECT * FROM research_cases ORDER BY id').all()
      old.close()
      expect(migrations[7]?.name).toBe('research_notebooks')

      const opened = openAppDatabase(userData, () => new Date('2026-10-29T12:00:00.000Z'))
      try {
        expect(opened.migration).toEqual({ from: 7, to: migrations.length })
        expect(opened.db.prepare('SELECT * FROM research_cases ORDER BY id').all()).toEqual(cases)
        expect(count(opened.db, 'case_notebooks')).toBe(0)
        expect(opened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        const repo = new NotebookRepository(opened.db)
        expect(repo.getOutline(caseId)).toEqual({ caseId, notebookId: null, sections: [] })
        const s = section(repo.createSection(caseId, { title: 'First section' }))
        expect(page(repo.createPage(caseId, s.id, { title: 'First page' })).version).toBe(1)
      } finally {
        opened.db.close()
      }
    })
  })

  describe('backup and restore', () => {
    let data: AppData

    beforeEach(() => {
      data = new AppData(join(userData, 'profile'), () => new Date('2026-10-29T12:00:00.000Z'))
    })
    afterEach(() => {
      try {
        data.close()
      } catch {
        // Already closed.
      }
    })

    it('round-trips pages and revisions, replacing pages written since', () => {
      const caseId = seed(data)
      const s = section(data.notebook.createSection(caseId, { title: 'Kept' }))
      const p = page(data.notebook.createPage(caseId, s.id, { title: 'Page' }))
      data.notebook.savePage(caseId, p.id, { baseVersion: 1, content: doc(paragraph(1, 'In the backup.')) })
      const outline = data.notebook.getOutline(caseId)
      const saved = data.notebook.getPage(caseId, p.id)
      const revisions = data.notebook.listRevisions(caseId, p.id)
      const revision = data.notebook.getRevision(caseId, p.id, revisions[0]!.id)
      const file = join(userData, 'backup.tgbackup')
      expect(data.createBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })

      data.notebook.savePage(caseId, p.id, { baseVersion: 2, content: doc(paragraph(1, 'After the backup.')) })
      page(data.notebook.createPage(caseId, s.id, { title: 'Written later' }))

      data.restoreBackup(file)
      expect(data.notebook.getOutline(caseId)).toEqual(outline)
      expect(data.notebook.getPage(caseId, p.id)).toEqual(saved)
      expect(data.notebook.listRevisions(caseId, p.id)).toEqual(revisions)
      expect(data.notebook.getRevision(caseId, p.id, revisions[0]!.id)).toEqual(revision)
      expect(count(data.db, 'notebook_pages')).toBe(1)
      // The restored repository works.
      expect(page(data.notebook.savePage(caseId, p.id, { baseVersion: 2, content: doc(paragraph(1, 'Again.')) })).version).toBe(3)
    })

    it('restores a schema-7 backup into the current schema, with no notebook pages', () => {
      const file = join(userData, 'old.tgbackup')
      const old = new DatabaseSync(file)
      configureConnection(old)
      migrate(old, {}, migrations.slice(0, 7))
      old.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
      const client = new ClientRepository(old).create({ ...clientInput, displayName: 'Older Backup Client' })
      if (!client.ok) throw new Error('fixture client invalid')
      const oldCase = new CaseRepository(old).create(client.client.id, caseInput)
      if (!oldCase.ok) throw new Error('fixture case invalid')
      old.exec('PRAGMA journal_mode = DELETE')
      old.close()
      expect(inspectBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: 7 })

      const current = seed(data)
      const s = section(data.notebook.createSection(current, { title: 'Will be replaced' }))
      page(data.notebook.createPage(current, s.id, { title: 'Gone' }))

      expect(data.restoreBackup(file)).toEqual({ clients: 1, notes: 0, schemaVersion: migrations.length })
      expect(count(data.db, 'notebook_pages')).toBe(0)
      expect(data.notebook.getOutline(oldCase.case.id)).toEqual({ caseId: oldCase.case.id, notebookId: null, sections: [] })
      expect(data.notebook.createSection(oldCase.case.id, { title: 'Works' }).ok).toBe(true)
      expect(existsSync(join(dataDirectory(join(userData, 'profile')), 'pre-restore'))).toBe(true)
    })
  })
})
