// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime } from '../../src/renderer/src/runtime/AppRuntime'
import type { NotebookAdapters } from '../../src/renderer/src/notebook/NotebookAdapters'
import { plainTextAdapter } from '../../src/renderer/src/notebook/adapters/plain/plainTextAdapter'
import { createFakeEditorAdapter, type FakeEditorAdapter } from './notebook/fakeEditorAdapter'

// Adapter replacement at the integration level (Release A, #145): the whole App runs the
// same notebook journey (start, add a section and a page, write, save, switch pages, look at
// the history) once with the in-memory fake editor and once with the plain-text editor, both
// injected through App's `notebookAdapters` prop. What the host stores (NoteContent, outline,
// history) must be identical, so a replacement editor needs no domain or database change.
// Block ids are random per run and are left out of the comparison. Fictional data only.

const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }
const FIRST_TEXT = 'Searched the baptism index.'
const SECOND_TEXT = 'Married in the parish church.'

interface Provider {
  name: string
  adapters: () => { adapters: NotebookAdapters; fake: FakeEditorAdapter | null }
}

const providers: Provider[] = [
  {
    name: 'in-memory fake editor',
    adapters: () => {
      const fake = createFakeEditorAdapter()
      return { adapters: { editor: fake, canvas: null }, fake }
    }
  },
  { name: 'plain-text editor', adapters: () => ({ adapters: { editor: plainTextAdapter, canvas: null }, fake: null }) }
]

interface Persisted {
  outline: { section: string; pages: { title: string; version: number; content: unknown }[] }[]
  history: { reason: string; version: number }[]
}

/** Drops the random block ids: everything else about the stored content must match. */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'id').map(([key, v]) => [key, withoutIds(v)]))
  return value
}

const nav = () => within(screen.getByRole('navigation', { name: 'Notebook' }))
const results = new Map<string, Persisted>()

afterEach(cleanup)
beforeEach(() => {
  window.location.hash = ''
})

describe.each(providers)('the same notebook journey with the $name', ({ name, adapters: make }) => {
  it('starts a notebook, adds a section and a page, writes, saves, switches pages and shows the history', async () => {
    const data = createDemoApi(buildDemoData(), appInfo)
    const cases = createDemoCases(buildDemoCases(), data.getClient, defaultClock)
    const runtime: AppRuntime = {
      mode: 'live',
      switcher: { kind: 'unavailable', reason: 'not-available' },
      data,
      backup: { createBackup: vi.fn(), chooseBackupToRestore: vi.fn(), restoreBackup: vi.fn() } as never,
      cases
    }
    const { adapters, fake } = make()
    const caseId = demoCaseIds.maternal

    /** Types at the end of the open page, the way each editor is driven. */
    const write = (text: string) => {
      if (fake) fake.sessions.at(-1)!.type(text)
      else {
        const box = screen.getByLabelText('Page text') as HTMLTextAreaElement
        fireEvent.input(box, { target: { value: box.value + text } })
      }
    }
    const shown = () => (fake ? JSON.stringify(fake.sessions.at(-1)!.getContent()) : (screen.getByLabelText('Page text') as HTMLTextAreaElement).value)
    const saved = async (title: string, text: string) => {
      await waitFor(
        async () => {
          const outline = (await cases.getNotebook(caseId))!
          const entry = outline.sections.flatMap((s) => s.pages).find((p) => p.title === title)!
          expect(JSON.stringify((await cases.getNotebookPage(caseId, entry.id))!.content)).toContain(text)
        },
        { timeout: 4000 }
      )
    }

    window.location.hash = `#/cases/${caseId}/notebook`
    render(<App runtime={runtime} notebookAdapters={adapters} />)

    // Start.
    fireEvent.click(await screen.findByRole('button', { name: 'Start your research notebook' }))
    await screen.findByRole('link', { name: 'First page' })
    await waitFor(() => expect(screen.getByLabelText('Page title')).toBeTruthy())

    // Write on the first page; it is saved by itself.
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Formatting' })).toBeTruthy())
    write(FIRST_TEXT)
    await saved('First page', FIRST_TEXT)

    // Add a section and a page in it, rename the page, write there.
    fireEvent.click(nav().getByRole('button', { name: '+ New section' }))
    fireEvent.change(nav().getByLabelText('New section name'), { target: { value: 'Parish books' } })
    fireEvent.click(nav().getByRole('button', { name: 'Add section' }))
    await nav().findByRole('button', { name: /^Parish books/ })
    fireEvent.click(nav().getByRole('button', { name: 'Options for section Parish books' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Options for section Parish books' })).getByRole('button', { name: 'Add a page' }))
    const title = (await screen.findByDisplayValue('Untitled page')) as HTMLInputElement
    fireEvent.change(title, { target: { value: 'Marriages' } })
    fireEvent.blur(title)
    await nav().findByRole('link', { name: 'Marriages' })
    await waitFor(() => expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('Marriages'))
    write(SECOND_TEXT)

    // Switch back: the second page is saved on the way out, the first one shows what was written.
    fireEvent.click(nav().getByRole('link', { name: 'First page' }))
    await waitFor(() => expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('First page'))
    await waitFor(() => expect(shown()).toContain(FIRST_TEXT))
    expect(shown()).not.toContain(SECOND_TEXT)
    await saved('Marriages', SECOND_TEXT)

    // History of the first page: its first save is there and can be read.
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    const history = await screen.findByRole('dialog', { name: 'Page history' })
    const versions = await within(history).findAllByRole('button', { name: /Autosave · version 2/ })
    expect(versions).toHaveLength(1)
    fireEvent.click(versions[0]!)
    await waitFor(() => expect(within(within(history).getByRole('region', { name: 'Preview' })).getByText(FIRST_TEXT)).toBeTruthy())
    fireEvent.click(within(history).getByRole('button', { name: 'Close' }))

    // What the host holds.
    const outline = (await cases.getNotebook(caseId))!
    const persisted: Persisted = { outline: [], history: [] }
    for (const section of outline.sections) {
      const pages = []
      for (const entry of section.pages) {
        const page = (await cases.getNotebookPage(caseId, entry.id))!
        pages.push({ title: page.title, version: page.version, content: withoutIds(page.content) })
        if (page.title === 'First page') persisted.history = (await cases.listPageRevisions(caseId, entry.id)).map((r) => ({ reason: r.reason, version: r.version }))
      }
      persisted.outline.push({ section: section.title, pages })
    }
    results.set(name, persisted)

    expect(persisted.outline.map((s) => [s.section, s.pages.map((p) => p.title)])).toEqual([
      ['Research notes', ['First page']],
      ['Parish books', ['Marriages']]
    ])
    expect(persisted.history).toEqual([{ reason: 'autosave', version: 2 }])
  })
})

describe('replacing the editor', () => {
  it('stores identical content, outline and history whichever editor wrote it', () => {
    expect([...results.keys()].sort()).toEqual(providers.map((p) => p.name).sort())
    const [fakeResult, plainResult] = [results.get('in-memory fake editor')!, results.get('plain-text editor')!]
    expect(plainResult).toEqual(fakeResult)
    // And it is the NoteContent the journey wrote: one paragraph per page, nothing editor-specific.
    expect(fakeResult.outline[0]!.pages[0]!.content).toEqual({
      format: 'tg-note',
      version: 1,
      blocks: [{ type: 'paragraph', indent: 0, content: [{ text: FIRST_TEXT }] }]
    })
    expect(fakeResult.outline[1]!.pages[0]!.content).toEqual({
      format: 'tg-note',
      version: 1,
      blocks: [{ type: 'paragraph', indent: 0, content: [{ text: SECOND_TEXT }] }]
    })
  })
})
