import { describe, expect, it } from 'vitest'
import { createDemoApi, type DemoClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds } from '../../src/renderer/src/demo/sampleData'
import type { NoteContent } from '../../src/shared/note-content'

// The demo notebook wired into the demo cases (#147): it is read-only on an archived
// case or client, and a write moves the case's updated time. Fictional data only.

const START = new Date('2026-10-30T12:00:00.000Z')
const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }
const empty: NoteContent = { format: 'tg-note', version: 1, blocks: [] }

function setup() {
  let n = 0
  let at = START.getTime()
  const clock: DemoClock = { now: () => new Date((at += 1000)), newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` }
  const data = createDemoApi(buildDemoData(START), appInfo)
  return { data, cases: createDemoCases(buildDemoCases(START), data.getClient, clock) }
}

describe('demo notebook in the demo cases', () => {
  it('is read-only on an archived case and an archived client, but readable', async () => {
    const { data, cases } = setup()
    const id = demoCaseIds.paternal
    const outline = (await cases.getNotebook(id))!
    const sectionId = outline.sections[0]!.id
    const pageId = outline.sections[0]!.pages[0]!.id
    const refused = { ok: false, reason: 'wrong-status' }

    await cases.archiveCase(id)
    expect(await cases.createNotebookSection(id, { title: 'New' })).toEqual(refused)
    expect(await cases.renameNotebookPage(id, pageId, { title: 'New' })).toEqual(refused)
    expect(await cases.saveNotebookPage(id, pageId, { baseVersion: 1, content: empty })).toEqual(refused)
    expect(await cases.archiveNotebookSection(id, sectionId)).toEqual(refused)
    expect(await cases.getNotebook(id)).toEqual(outline)
    expect(await cases.getNotebookPage(id, pageId)).toMatchObject({ version: 1 })
    await cases.unarchiveCase(id)
    expect((await cases.createNotebookSection(id, { title: 'New' })).ok).toBe(true)

    const other = demoCaseIds.maternal
    await data.archiveClient((await cases.getCase(other))!.clientId)
    expect(await cases.createNotebookSection(other, { title: 'New' })).toEqual(refused)
    expect(await cases.getNotebook(other)).toEqual({ caseId: other, notebookId: null, sections: [] })
    expect(await cases.createNotebookSection(crypto.randomUUID(), { title: 'New' })).toEqual({ ok: false, reason: 'not-found' })
  })

  it('moves the case updated time on a write and not on a refused one', async () => {
    const { cases } = setup()
    const id = demoCaseIds.paternal
    const before = (await cases.getCase(id))!.updatedAt
    await cases.createNotebookSection(id, { title: '   ' })
    expect((await cases.getCase(id))!.updatedAt).toBe(before)
    await cases.createNotebookSection(id, { title: 'Real' })
    expect((await cases.getCase(id))!.updatedAt > before).toBe(true)
  })
})
