import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CaseRepository } from '../../src/main/database/case-repository'
import { ClientRepository } from '../../src/main/database/client-repository'
import { configureConnection } from '../../src/main/database/connection'
import { migrate } from '../../src/main/database/migrations'
import { NotebookRepository } from '../../src/main/database/notebook-repository'
import { createDemoNotebook } from '../../src/renderer/src/demo/demoNotebook'
import { buildDemoCases, demoCaseIds } from '../../src/renderer/src/demo/sampleData'
import type { NotebookApi } from '../../src/renderer/src/runtime/notebookApi'
import { checkNoteContent, noteContentToPlainText, type NoteBlock, type NoteContent } from '../../src/shared/note-content'
import { REVISION_INTERVAL_MS, type NotebookPage, type NotebookSection } from '../../src/shared/notebook'

// Demo notebook parity (#147): the in-memory adapter follows the same rules, order of
// checks and numbering as the SQLite repository, so the same script gives the same
// answers on both. Fictional data only.

const START = new Date('2026-10-30T12:00:00.000Z')

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

/** The demo notebook over the sample fixtures, with every sample case writable (the cases wiring is in DemoNotebookCases.test.tsx). */
function demoNotebook(): { api: NotebookApi; clock: ReturnType<typeof manualClock> } {
  const clock = manualClock()
  const known = new Set(buildDemoCases(START).cases.map((c) => c.id))
  const api = createDemoNotebook(
    buildDemoCases(START).notebook,
    {
      exists: (id) => known.has(id),
      writable: async (id) => (known.has(id) ? null : { ok: false, reason: 'not-found' }),
      touch: () => {}
    },
    clock
  )
  return { api, clock }
}

/** The repository behind the same async interface, for the parity script. */
function repositoryNotebook(): { api: NotebookApi; clock: ReturnType<typeof manualClock>; caseId: string } {
  const db = new DatabaseSync(':memory:')
  configureConnection(db)
  migrate(db)
  // Ids of the client and case come from their own clock, so they cannot collide with the notebook's.
  let setupId = 0
  const setup = { now: () => START, newId: () => `11111111-0000-4000-8000-${String(++setupId).padStart(12, '0')}` }
  const client = new ClientRepository(db, setup).create({
    displayName: 'Ana Ejemplo',
    source: 'direct',
    sourceDetail: null,
    fiverrUsername: null,
    email: null,
    otherContact: null,
    preferredContactChannel: 'unspecified'
  })
  if (!client.ok) throw new Error('fixture client invalid')
  const created = new CaseRepository(db, setup).create(client.client.id, { title: 'Parity case', goal: null, orderReference: null, dueDate: null })
  if (!created.ok) throw new Error('fixture case invalid')
  const clock = manualClock()
  const repo = new NotebookRepository(db, clock)
  const api = {
    getNotebook: async (c) => repo.getOutline(c),
    createNotebookSection: async (c, i) => repo.createSection(c, i),
    renameNotebookSection: async (c, s, i) => repo.renameSection(c, s, i),
    moveNotebookSection: async (c, s, t) => repo.moveSection(c, s, t),
    archiveNotebookSection: async (c, s) => repo.archiveSection(c, s),
    unarchiveNotebookSection: async (c, s) => repo.unarchiveSection(c, s),
    createNotebookPage: async (c, s, i) => repo.createPage(c, s, i),
    getNotebookPage: async (c, p) => repo.getPage(c, p),
    renameNotebookPage: async (c, p, i) => repo.renamePage(c, p, i),
    moveNotebookPage: async (c, p, m) => repo.movePage(c, p, m),
    archiveNotebookPage: async (c, p) => repo.archivePage(c, p),
    unarchiveNotebookPage: async (c, p) => repo.unarchivePage(c, p),
    saveNotebookPage: async (c, p, s) => repo.savePage(c, p, s),
    listPageRevisions: async (c, p) => repo.listRevisions(c, p),
    getPageRevision: async (c, p, r) => repo.getRevision(c, p, r),
    restorePageRevision: async (c, p, r, v) => repo.restoreRevision(c, p, r, v)
  } satisfies NotebookApi
  return { api, clock, caseId: created.case.id }
}

/** One long script touching every call, refusals included. Each step's answer is recorded. */
async function script(api: NotebookApi, clock: { advance: (ms: number) => void }, caseId: string, otherCaseId: string): Promise<unknown[]> {
  const out: unknown[] = []
  const log = async <T>(p: Promise<T>): Promise<T> => {
    const value = await p
    out.push(value)
    return value
  }
  const sec = (r: unknown) => (r as { section: NotebookSection }).section
  const pg = (r: unknown) => (r as { page: NotebookPage }).page

  await log(api.getNotebook(caseId))
  await log(api.createNotebookSection(caseId, { title: '   ' }))
  const a = sec(await log(api.createNotebookSection(caseId, { title: ' Archive visits ' })))
  const b = sec(await log(api.createNotebookSection(caseId, { title: 'Interviews' })))
  const c = sec(await log(api.createNotebookSection(caseId, { title: 'Sources' })))
  await log(api.moveNotebookSection(caseId, c.id, 0))
  await log(api.moveNotebookSection(caseId, a.id, 99))
  await log(api.renameNotebookSection(caseId, b.id, { title: 'x'.repeat(81) }))
  await log(api.renameNotebookSection(caseId, b.id, { title: 'Interviews 2' }))
  const p1 = pg(await log(api.createNotebookPage(caseId, a.id, { title: 'First visit' })))
  const p2 = pg(await log(api.createNotebookPage(caseId, a.id, { title: 'Second visit' })))
  const q1 = pg(await log(api.createNotebookPage(caseId, b.id, { title: 'Call' })))
  await log(api.createNotebookPage(caseId, a.id, { title: '' }))
  await log(api.renameNotebookPage(caseId, p2.id, { title: 'Second trip' }))
  await log(api.moveNotebookPage(caseId, p2.id, { sectionId: a.id, toIndex: 0 }))
  await log(api.moveNotebookPage(caseId, p1.id, { sectionId: b.id, toIndex: 5 }))
  await log(api.getNotebook(caseId))

  clock.advance(1000)
  await log(api.saveNotebookPage(caseId, p1.id, { baseVersion: 1, content: doc(paragraph(1, 'First.')) }))
  await log(api.saveNotebookPage(caseId, p1.id, { baseVersion: 1, content: doc(paragraph(1, 'Stale.')) }))
  await log(api.saveNotebookPage(caseId, p1.id, { baseVersion: 2, content: doc(paragraph(1, 'First.')) }))
  await log(api.saveNotebookPage(caseId, p1.id, { baseVersion: 2, content: doc(paragraph(1, 'x'), paragraph(1, 'y')) }))
  await log(
    api.saveNotebookPage(caseId, p1.id, {
      baseVersion: 2,
      content: { format: 'tg-note', version: 1, blocks: [{ id: blockId(1), type: 'script' }] } as unknown as NoteContent
    })
  )
  clock.advance(REVISION_INTERVAL_MS - 1)
  await log(api.saveNotebookPage(caseId, p1.id, { baseVersion: 2, content: doc(paragraph(1, 'Second.')) }))
  clock.advance(1)
  await log(api.saveNotebookPage(caseId, p1.id, { baseVersion: 3, content: doc(paragraph(1, 'Third.')) }))
  const revisions = (await log(api.listPageRevisions(caseId, p1.id))) as { id: string }[]
  await log(api.getPageRevision(caseId, p1.id, revisions[1]!.id))
  await log(api.getPageRevision(otherCaseId, p1.id, revisions[1]!.id))
  clock.advance(1000)
  await log(api.restorePageRevision(caseId, p1.id, revisions[1]!.id, 3))
  await log(api.restorePageRevision(caseId, p1.id, revisions[1]!.id, 4))
  await log(api.restorePageRevision(caseId, p1.id, otherCaseId, 5))
  await log(api.listPageRevisions(caseId, p1.id))

  await log(api.archiveNotebookPage(caseId, p1.id))
  await log(api.archiveNotebookPage(caseId, p1.id))
  await log(api.saveNotebookPage(caseId, p1.id, { baseVersion: 5, content: doc() }))
  await log(api.renameNotebookPage(caseId, p1.id, { title: 'nope' }))
  await log(api.unarchiveNotebookPage(caseId, p1.id))
  await log(api.unarchiveNotebookPage(caseId, p1.id))
  await log(api.archiveNotebookSection(caseId, c.id))
  await log(api.archiveNotebookSection(caseId, c.id))
  await log(api.createNotebookPage(caseId, c.id, { title: 'nope' }))
  await log(api.moveNotebookPage(caseId, q1.id, { sectionId: c.id, toIndex: 0 }))
  await log(api.moveNotebookSection(caseId, c.id, 0))
  await log(api.unarchiveNotebookSection(caseId, c.id))

  // Ids from this case under another case, and unknown ids.
  await log(api.getNotebookPage(otherCaseId, p1.id))
  await log(api.renameNotebookSection(otherCaseId, a.id, { title: 'x' }))
  await log(api.moveNotebookPage(caseId, p1.id, { sectionId: otherCaseId, toIndex: 0 }))
  await log(api.getNotebook(otherCaseId))
  await log(api.getNotebookPage(caseId, otherCaseId))
  await log(api.getNotebook(caseId))
  return out
}

describe('demo notebook', () => {
  it('seeds one fictional case with a small notebook', async () => {
    const { api } = demoNotebook()
    const outline = await api.getNotebook(demoCaseIds.paternal)
    expect(outline).toMatchObject({ caseId: demoCaseIds.paternal, sections: [{ title: 'Archive visits', position: 0, archivedAt: null }] })
    const pages = outline!.sections[0]!.pages
    expect(pages).toHaveLength(1)
    const page = (await api.getNotebookPage(demoCaseIds.paternal, pages[0]!.id))!
    expect(checkNoteContent(page.content).issues).toEqual([])
    expect(page.content.blocks.map((b: NoteBlock) => b.type)).toEqual(['heading', 'paragraph', 'check', 'check', 'check'])
    // Obviously fictional: the text says so and uses the sample surname.
    expect(noteContentToPlainText(page.content)).toMatch(/Fictional notes/)
    expect(noteContentToPlainText(page.content)).toMatch(/Ejemplo/)
    // Other cases start without a notebook; unknown cases answer null.
    expect(await api.getNotebook(demoCaseIds.maternal)).toEqual({ caseId: demoCaseIds.maternal, notebookId: null, sections: [] })
    expect(await api.getNotebook('00000000-0000-4000-8000-0000000000ff')).toBeNull()
  })

  it('gives the same answers as the SQLite repository for the same script', async () => {
    const demo = demoNotebook()
    const repo = repositoryNotebook()
    const unknownCase = '00000000-0000-4000-8000-0000000000aa'
    const fromDemo = await script(demo.api, demo.clock, demoCaseIds.maternal, unknownCase)
    const fromRepo = await script(repo.api, repo.clock, repo.caseId, unknownCase)
    const normalize = (value: unknown, caseId: string) => JSON.parse(JSON.stringify(value).split(caseId).join('<case>')) as unknown
    expect(fromDemo.length).toBeGreaterThan(45)
    expect(normalize(fromDemo, demoCaseIds.maternal)).toEqual(normalize(fromRepo, repo.caseId))
  })

  it('keeps state in memory only: a new adapter starts from the sample set', async () => {
    const first = demoNotebook()
    const created = await first.api.createNotebookSection(demoCaseIds.paternal, { title: 'Added in the demo' })
    expect(created.ok).toBe(true)
    expect((await first.api.getNotebook(demoCaseIds.paternal))!.sections).toHaveLength(2)
    const reload = demoNotebook()
    expect((await reload.api.getNotebook(demoCaseIds.paternal))!.sections).toHaveLength(1)
  })

  it('hands out copies, so the UI cannot change stored pages in place', async () => {
    const { api } = demoNotebook()
    const outline = (await api.getNotebook(demoCaseIds.paternal))!
    const pageId = outline.sections[0]!.pages[0]!.id
    const page = (await api.getNotebookPage(demoCaseIds.paternal, pageId))!
    page.title = 'Changed'
    page.content.blocks.length = 0
    outline.sections[0]!.title = 'Changed'
    expect(await api.getNotebookPage(demoCaseIds.paternal, pageId)).toMatchObject({ title: 'Diocesan archive, first visit' })
    expect((await api.getNotebookPage(demoCaseIds.paternal, pageId))!.content.blocks).toHaveLength(5)
    expect((await api.getNotebook(demoCaseIds.paternal))!.sections[0]!.title).toBe('Archive visits')
  })
})
