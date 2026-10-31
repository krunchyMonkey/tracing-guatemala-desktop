// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds } from '../../src/renderer/src/demo/sampleData'
import type { NotebookAdapters } from '../../src/renderer/src/notebook/NotebookAdapters'
import { NoteContentView } from '../../src/renderer/src/notebook/NoteContentView'
import type { AppRuntime, CaseApi } from '../../src/renderer/src/runtime/AppRuntime'
import type { NoteContent } from '../../src/shared/note-content'
import type { NotebookPage, PageSave } from '../../src/shared/notebook'
import { createFakeEditorAdapter, type FakeEditorAdapter, type FakeEditorSession } from './notebook/fakeEditorAdapter'

// Resilient autosave, conflicts, history and the case workflow bridge (#149) through the
// real screens, with the fake editor injected through App and the demo's in-memory
// notebook standing in for the host. Fictional data only. (The store's timing rules are
// tested on their own in DraftStore.test.tsx.)

const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }
const CASE = demoCaseIds.maternal
const STATUS = '.note-save-status'

function setup(wrap?: (cases: CaseApi) => CaseApi) {
  const data = createDemoApi(buildDemoData(), appInfo)
  const cases = createDemoCases(buildDemoCases(), data.getClient, defaultClock)
  const api = wrap ? wrap(cases) : cases
  const runtime: AppRuntime = {
    mode: 'live',
    switcher: { kind: 'unavailable', reason: 'not-available' },
    data,
    backup: { createBackup: vi.fn(), chooseBackupToRestore: vi.fn(), restoreBackup: vi.fn() } as never,
    cases: api
  }
  const editor = createFakeEditorAdapter()
  const adapters: NotebookAdapters = { editor, canvas: null }
  return { cases, runtime, editor, adapters }
}

type Ctx = ReturnType<typeof setup>

const text = (value: string): NoteContent => ({
  format: 'tg-note',
  version: 1,
  blocks: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'paragraph', indent: 0, content: [{ text: value }] }]
})
const session = (editor: FakeEditorAdapter): FakeEditorSession => editor.sessions.at(-1)!
const contentOf = (s: FakeEditorSession): string => JSON.stringify(s.getContent())
const statusText = (): string => document.querySelector(STATUS)?.textContent ?? ''
const SAVED = /^Saved at \d\d:\d\d$/

/** Hash navigation the router notices (jsdom does not tell it by itself). */
function goTo(hash: string): void {
  act(() => {
    window.location.hash = hash
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

async function openPage(ctx: Ctx, options: { pages?: number; initial?: NoteContent; caseId?: string } = {}) {
  const caseId = options.caseId ?? CASE
  const section = await ctx.cases.createNotebookSection(caseId, { title: 'Parish books' })
  if (!section.ok) throw new Error('setup')
  const pages: NotebookPage[] = []
  for (const title of ['Baptisms', 'Marriages'].slice(0, options.pages ?? 1)) {
    const created = await ctx.cases.createNotebookPage(caseId, section.section.id, { title })
    if (!created.ok) throw new Error('setup')
    pages.push(created.page)
  }
  if (options.initial) {
    const saved = await ctx.cases.saveNotebookPage(caseId, pages[0]!.id, { baseVersion: 1, content: options.initial })
    if (!saved.ok) throw new Error('setup')
    pages[0] = saved.page
  }
  window.location.hash = `#/cases/${caseId}/notebook/${pages[0]!.id}`
  render(<App runtime={ctx.runtime} notebookAdapters={ctx.adapters} />)
  await waitFor(() => expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('Baptisms'))
  await waitFor(() => expect(session(ctx.editor).editable).toBe(true))
  return { ...ctx, pages }
}

/** A host that can be switched off; saves then fail like a lost connection. */
function flaky(initiallyFailing = false) {
  const state = { failing: initiallyFailing, saves: [] as PageSave[] }
  const wrap = (real: CaseApi): CaseApi => ({
    ...real,
    saveNotebookPage: (caseId, pageId, save) => {
      state.saves.push(structuredClone(save))
      return state.failing ? Promise.reject(new Error('offline')) : real.saveNotebookPage(caseId, pageId, save)
    }
  })
  return { state, wrap }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
beforeEach(() => {
  window.location.hash = ''
})

describe('resilient autosave', () => {
  it('keeps typing through a failing host, says "Not saved — retrying", and recovers by itself', async () => {
    const host = flaky(true)
    const { editor, cases, pages } = await openPage(setup(host.wrap))
    session(editor).type('Precious words.')
    await waitFor(() => expect(statusText()).toBe('Not saved — retrying'), { timeout: 3000 })
    expect(contentOf(session(editor))).toContain('Precious words.')
    expect(screen.getByText(/Your text is still here/)).toBeTruthy()
    expect(JSON.stringify((await cases.getNotebookPage(CASE, pages[0]!.id))!.content)).not.toContain('Precious')

    host.state.failing = false
    await waitFor(() => expect(statusText()).toMatch(SAVED), { timeout: 4000 })
    expect(JSON.stringify((await cases.getNotebookPage(CASE, pages[0]!.id))!.content)).toContain('Precious words.')
  })

  it('has a manual "Retry now" and a "Copy my text" while it cannot save', async () => {
    const host = flaky(true)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { editor } = await openPage(setup(host.wrap))
    session(editor).type('Keep this.')
    await screen.findByText('Not saved — retrying', {}, { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: 'Copy my text' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Keep this.')))
    host.state.failing = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    await waitFor(() => expect(statusText()).toMatch(SAVED))
  })

  it('saves what was typed during a save afterwards, on the new version', async () => {
    let release: (() => void) | undefined
    const seen: PageSave[] = []
    const ctx = setup((real) => ({
      ...real,
      saveNotebookPage: (caseId, pageId, save) => {
        seen.push(structuredClone(save))
        if (seen.length > 1) return real.saveNotebookPage(caseId, pageId, save)
        return new Promise((resolve) => {
          release = () => void real.saveNotebookPage(caseId, pageId, save).then(resolve)
        })
      }
    }))
    const { editor, cases, pages } = await openPage(ctx)
    session(editor).type('First.')
    await waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 })
    session(editor).type(' Second.')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(seen).toHaveLength(1)
    release!()
    await waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]!.baseVersion).toBe(2)
    await waitFor(() => expect(statusText()).toMatch(SAVED))
    expect(JSON.stringify((await cases.getNotebookPage(CASE, pages[0]!.id))!.content)).toContain('First. Second.')
  })

  it('keeps a draft when you leave the notebook and another case, and saves it once the host is back', async () => {
    const host = flaky(true)
    const ctx = setup(host.wrap)
    const { editor, cases, pages } = await openPage(ctx, { pages: 2 })
    session(editor).type('Unsaved one.')
    await screen.findByText('Not saved — retrying', {}, { timeout: 3000 })
    // A second page also gets unsaved text.
    fireEvent.click(await screen.findByRole('link', { name: 'Marriages' }))
    await waitFor(() => expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('Marriages'))
    await waitFor(() => expect(session(editor).editable).toBe(true))
    session(editor).type('Unsaved two.')

    goTo(`#/cases/${demoCaseIds.paternal}`)
    await screen.findByRole('heading', { level: 1, name: /Paternal line/ })
    // The reminder is app-wide.
    expect((await screen.findByRole('link', { name: '2 pages not saved yet' })).getAttribute('href')).toMatch(/notebook\//)

    host.state.failing = false
    await waitFor(async () => {
      expect(JSON.stringify((await cases.getNotebookPage(CASE, pages[0]!.id))!.content)).toContain('Unsaved one.')
      expect(JSON.stringify((await cases.getNotebookPage(CASE, pages[1]!.id))!.content)).toContain('Unsaved two.')
    }, { timeout: 8000 })
    await waitFor(() => expect(screen.queryByText(/not saved yet/)).toBeNull())
  }, 15_000)

  it('shows the draft, not the server copy, when you come back to the page', async () => {
    const host = flaky(true)
    const ctx = setup(host.wrap)
    const { editor } = await openPage(ctx, { pages: 2 })
    session(editor).type('Draft text.')
    await screen.findByText('Not saved — retrying', {}, { timeout: 3000 })
    goTo(`#/cases/${CASE}`)
    await screen.findByRole('heading', { level: 1, name: /Maternal grandparents/ })
    const sessionsBefore = editor.sessions.length
    goTo(`#/cases/${CASE}/notebook`)
    await waitFor(() => expect(editor.sessions.length).toBe(sessionsBefore + 1))
    await waitFor(() => expect(session(editor).editable).toBe(true))
    await waitFor(() => expect(contentOf(session(editor))).toContain('Draft text.'))
    expect(statusText()).toBe('Not saved — retrying')
  })

  it('asks before the browser tab is closed only while something is unsaved', async () => {
    const host = flaky(true)
    const { editor } = await openPage(setup(host.wrap))
    const closing = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(closing()).toBe(false)
    session(editor).type('Unsaved.')
    expect(closing()).toBe(true)
    host.state.failing = false
    await waitFor(() => expect(statusText()).toMatch(SAVED), { timeout: 4000 })
    expect(closing()).toBe(false)
  })

  it('says why the host refused the text, in plain words, and stops retrying', async () => {
    const ctx = setup((real) => ({
      ...real,
      saveNotebookPage: async () => ({ ok: false, reason: 'invalid', issues: [{ field: 'content', code: 'content-too-long' }] })
    }))
    const { editor } = await openPage(ctx)
    session(editor).type('Very long.')
    await waitFor(() => expect(statusText()).toMatch(/^Couldn’t save: The page is too long/), { timeout: 3000 })
    expect(statusText()).not.toContain('content-too-long')
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Try saving again' })).toBeTruthy()
  })

  it('turns read-only with a notice when the host says the page can no longer change', async () => {
    const ctx = setup((real) => ({ ...real, saveNotebookPage: async () => ({ ok: false, reason: 'wrong-status' }) }))
    const { editor } = await openPage(ctx)
    session(editor).type('Late words.')
    await waitFor(() => expect(statusText()).toBe('Not saved — read-only'), { timeout: 3000 })
    await waitFor(() => expect(session(editor).editable).toBe(false))
    expect(screen.getByText(/can’t be changed any more/)).toBeTruthy()
    expect(contentOf(session(editor))).toContain('Late words.')
  })
})

describe('conflicts', () => {
  async function conflicted(clipboard?: { writeText: (text: string) => Promise<void> }) {
    const host = flaky()
    if (clipboard) Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
    const ctx = await openPage(setup(host.wrap))
    // Another window saves first.
    const current = (await ctx.cases.getNotebookPage(CASE, ctx.pages[0]!.id))!
    const other = await ctx.cases.saveNotebookPage(CASE, current.id, { baseVersion: current.version, content: text('Saved in the other window.') })
    if (!other.ok) throw new Error('setup')
    session(ctx.editor).type('Local words.')
    const banner = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(banner.textContent).toContain('This page was changed in another window.')
    return { ...ctx, host, banner, otherVersion: other.page.version }
  }

  it('pauses autosave and never overwrites silently', async () => {
    const { host, editor, cases, pages } = await conflicted()
    const before = host.state.saves.length
    session(editor).type(' More.')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(host.state.saves).toHaveLength(before)
    expect(JSON.stringify((await cases.getNotebookPage(CASE, pages[0]!.id))!.content)).toContain('Saved in the other window.')
    expect(session(editor).editable).toBe(false)
  })

  it('Keep my version: re-saves on the other version, asks the host to keep it in history', async () => {
    const { host, editor, cases, pages, otherVersion } = await conflicted()
    fireEvent.click(screen.getByRole('button', { name: 'Keep my version' }))
    await waitFor(() => expect(statusText()).toMatch(SAVED))
    expect(host.state.saves.at(-1)).toMatchObject({ baseVersion: otherVersion, keepPrevious: true })
    expect(screen.queryByRole('alert')).toBeNull()
    const page = (await cases.getNotebookPage(CASE, pages[0]!.id))!
    expect(JSON.stringify(page.content)).toContain('Local words.')
    const history = await cases.listPageRevisions(CASE, pages[0]!.id)
    const kept = history.find((r) => r.reason === 'restore-point')!
    expect(JSON.stringify((await cases.getPageRevision(CASE, pages[0]!.id, kept.id))!.content)).toContain('Saved in the other window.')
    await waitFor(() => expect(session(editor).editable).toBe(true))
  })

  it('Use the saved version: drops the draft and shows the other window\'s text', async () => {
    const { editor, cases, pages, host } = await conflicted()
    const savesBefore = host.state.saves.length
    fireEvent.click(screen.getByRole('button', { name: 'Use the saved version' }))
    await waitFor(() => expect(contentOf(session(editor))).toContain('Saved in the other window.'))
    expect(contentOf(session(editor))).not.toContain('Local words.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(host.state.saves).toHaveLength(savesBefore)
    expect(JSON.stringify((await cases.getNotebookPage(CASE, pages[0]!.id))!.content)).not.toContain('Local words.')
    await waitFor(() => expect(session(editor).editable).toBe(true))
  })

  it('Copy my text puts the plain text of the draft on the clipboard, before choosing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    await conflicted({ writeText })
    fireEvent.click(screen.getByRole('button', { name: 'Copy my text' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0]![0]).toContain('Local words.')
    expect(writeText.mock.calls[0]![0]).not.toContain('Saved in the other window.')
    expect(await screen.findByText('Your text was copied to the clipboard.')).toBeTruthy()
    // Still undecided.
    expect(screen.getByRole('button', { name: 'Keep my version' })).toBeTruthy()
  })

  it('says so when copying is not possible', async () => {
    await conflicted({ writeText: () => Promise.reject(new Error('denied')) })
    fireEvent.click(screen.getByRole('button', { name: 'Copy my text' }))
    expect(await screen.findByText(/Couldn’t copy automatically/)).toBeTruthy()
  })
})

describe('page history', () => {
  async function withHistory(wrap?: (cases: CaseApi) => CaseApi) {
    const ctx = await openPage(setup(wrap), { initial: text('Original text.') })
    return ctx
  }
  const openHistory = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    return screen.findByRole('dialog', { name: 'Page history' })
  }

  it('lists versions, previews one read-only, and restores it after a confirmation', async () => {
    const { editor, cases, pages } = await withHistory()
    session(editor).type(' Newer words.')
    await waitFor(() => expect(statusText()).toMatch(SAVED), { timeout: 4000 })
    const dialog = await openHistory()
    const versions = await within(dialog).findByRole('list', { name: 'Versions' })
    const items = within(versions).getAllByRole('button')
    expect(items).toHaveLength(1)
    expect(items[0]!.textContent).toMatch(/Autosave · version 2/)

    const restoreButton = within(dialog).getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement
    expect(restoreButton.disabled).toBe(true)
    fireEvent.click(items[0]!)
    const preview = await within(dialog).findByText('Original text.')
    expect(within(dialog).getByRole('region', { name: 'Preview' }).contains(preview)).toBe(true)
    await waitFor(() => expect(restoreButton.disabled).toBe(false))

    fireEvent.click(restoreButton)
    const confirm = await screen.findByRole('alertdialog', { name: 'Restore this version?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(contentOf(session(editor))).toContain('Newer words.')

    fireEvent.click(restoreButton)
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore version' }))
    await waitFor(() => expect(contentOf(session(editor))).not.toContain('Newer words.'))
    expect(contentOf(session(editor))).toContain('Original text.')
    const page = (await cases.getNotebookPage(CASE, pages[0]!.id))!
    expect(JSON.stringify(page.content)).toContain('Original text.')
    // The history refreshes: restored + the version before it.
    await waitFor(() => {
      const labels = within(dialog).getAllByRole('button', { name: /version \d/ }).map((b) => b.textContent)
      expect(labels.some((l) => /Restored · version 4/.test(l ?? ''))).toBe(true)
      expect(labels.some((l) => /Before restore · version 3/.test(l ?? ''))).toBe(true)
    })
    // The restored text can be edited and saved on top of the new version.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    session(editor).type(' Again.')
    await waitFor(() => expect(statusText()).toMatch(SAVED), { timeout: 4000 })
    expect((await cases.getNotebookPage(CASE, pages[0]!.id))!.version).toBe(5)
  })

  it('refuses to restore while the page has unsaved text, and says why', async () => {
    const host = flaky()
    const { editor } = await withHistory(host.wrap)
    host.state.failing = true
    session(editor).type(' Unsaved.')
    await screen.findByText('Not saved — retrying', {}, { timeout: 3000 })
    const dialog = await openHistory()
    fireEvent.click(await within(dialog).findByRole('button', { name: /version 2/ }))
    await within(dialog).findByText('Original text.')
    expect((within(dialog).getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).getByText(/isn’t saved yet/)).toBeTruthy()
  })

  it('does not overwrite when the page changed in another window during the restore', async () => {
    const ctx = await withHistory((real) => ({
      ...real,
      restorePageRevision: async (caseId, pageId, revisionId, baseVersion) => {
        // Another window saves just before the restore arrives.
        const current = (await real.getNotebookPage(caseId, pageId))!
        await real.saveNotebookPage(caseId, pageId, { baseVersion: current.version, content: text('Changed elsewhere.') })
        return real.restorePageRevision(caseId, pageId, revisionId, baseVersion)
      }
    }))
    const dialog = await openHistory()
    fireEvent.click(await within(dialog).findByRole('button', { name: /version 2/ }))
    await within(dialog).findByText('Original text.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore this version' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore version' }))
    expect(await within(dialog).findByText(/changed in another window, so nothing was restored/)).toBeTruthy()
    await waitFor(() => expect(contentOf(session(ctx.editor))).toContain('Changed elsewhere.'))
    expect(JSON.stringify((await ctx.cases.getNotebookPage(CASE, ctx.pages[0]!.id))!.content)).toContain('Changed elsewhere.')
  })

  it('can be read on an archived case, but nothing can be restored', async () => {
    const ctx = setup()
    const section = await ctx.cases.createNotebookSection(CASE, { title: 'Parish books' })
    if (!section.ok) throw new Error('setup')
    const created = await ctx.cases.createNotebookPage(CASE, section.section.id, { title: 'Baptisms' })
    if (!created.ok) throw new Error('setup')
    await ctx.cases.saveNotebookPage(CASE, created.page.id, { baseVersion: 1, content: text('Old words.') })
    await ctx.cases.archiveCase(CASE)
    window.location.hash = `#/cases/${CASE}/notebook/${created.page.id}`
    render(<App runtime={ctx.runtime} notebookAdapters={ctx.adapters} />)
    await waitFor(() => expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('Baptisms'))
    const dialog = await openHistory()
    fireEvent.click(await within(dialog).findByRole('button', { name: /version 2/ }))
    await within(dialog).findByText('Old words.')
    expect((within(dialog).getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('NoteContentView', () => {
  it('renders hostile-looking text inert: text, never markup or unsafe links', () => {
    const hostile: NoteContent = {
      format: 'tg-note',
      version: 1,
      blocks: [
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', type: 'heading', level: 1, content: [{ text: '<img src=x onerror=alert(1)> Title' }] },
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          type: 'paragraph',
          indent: 0,
          content: [{ text: '<script>alert(1)</script> ' }, { text: 'click', href: 'javascript:alert(1)' }, { text: ' safe', href: 'https://example.org/a?b=1' }, { text: '<b>bold?</b>', marks: ['bold'] }]
        },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', type: 'bullet', indent: 1, content: [{ text: '<iframe src=//evil></iframe>' }] },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', type: 'check', indent: 0, checked: true, content: [{ text: 'done' }] },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', type: 'reference', target: { kind: 'task', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6' } }
      ]
    }
    const { container } = render(<NoteContentView content={hostile} describe={() => '<b>Task · x</b>'} />)
    expect(container.querySelector('script, img, iframe, style')).toBeNull()
    expect(container.querySelector('[onerror], [style]')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)> Title')
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('<b>Task · x</b>')
    const links = [...container.querySelectorAll('a')]
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('https://example.org/a?b=1')
    expect(links[0]!.getAttribute('rel')).toContain('noopener')
    expect(container.querySelector('li.note-indent-1')).toBeTruthy()
    expect(container.querySelector('strong')?.textContent).toBe('<b>bold?</b>')
  })

  it('says so when a version is empty', () => {
    render(<NoteContentView content={{ format: 'tg-note', version: 1, blocks: [] }} />)
    expect(screen.getByText('This version is empty.')).toBeTruthy()
  })
})

describe('workflow bridge', () => {
  async function withRecords() {
    const ctx = setup()
    const task = await ctx.cases.createCaseTask(CASE, { title: 'Order microfilm', description: null, dueDate: null })
    const journal = await ctx.cases.createJournalEntry(CASE, { occurredAt: '2026-10-12T15:00:00.000Z', activity: 'Archive search', body: 'Checked the index.' })
    const hours = await ctx.cases.createTimeEntry(CASE, { workDate: '2026-10-12', durationMinutes: 90, activityType: null, note: null })
    if (!task.ok || !journal.ok || !hours.ok) throw new Error('setup')
    const opened = await openPage(ctx)
    return { ...opened, task: task.task, journal: journal.entry, hours: hours.entry }
  }

  it('labels references from the case\'s records, and tells when a record is missing', async () => {
    const { editor, task, journal, hours } = await withRecords()
    const describe = session(editor).options.describeReference!
    await waitFor(() => expect(describe({ kind: 'task', id: task.id })).toBe('Task · Order microfilm (pending)'))
    expect(describe({ kind: 'journal', id: journal.id })).toMatch(/^Journal · .*2026.* · Archive search$/)
    expect(describe({ kind: 'time', id: hours.id })).toMatch(/^Hours · 1 h 30 m on .*2026/)
    expect(describe({ kind: 'task', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toBe('Linked record not available')
    // Labels that arrive after the blocks were shown are pushed to the editor.
    expect(session(editor).refreshes).toBeGreaterThan(0)
  })

  it('links a record: filter, choose, insertReference; the record is not copied', async () => {
    const { editor, cases, task } = await withRecords()
    const before = (await cases.listCaseTasks(CASE)).length
    fireEvent.click(screen.getByRole('button', { name: 'Link record' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link a record' })
    await within(dialog).findByRole('button', { name: 'Task · Order microfilm (pending)' })
    expect(within(dialog).getAllByRole('button').length).toBeGreaterThan(3)
    fireEvent.change(within(dialog).getByLabelText('Filter records'), { target: { value: 'microfilm' } })
    expect(within(dialog).getAllByRole('button', { name: /microfilm/ })).toHaveLength(1)
    expect(within(dialog).queryByRole('button', { name: /Archive search/ })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Task · Order microfilm (pending)' }))
    expect(session(editor).commands.at(-1)).toEqual({ type: 'insertReference', target: { kind: 'task', id: task.id } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(contentOf(session(editor))).toContain(task.id)
    expect(await cases.listCaseTasks(CASE)).toHaveLength(before)
  })

  it('shows a friendly message when nothing matches the filter', async () => {
    await withRecords()
    fireEvent.click(screen.getByRole('button', { name: 'Link record' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link a record' })
    await within(dialog).findByRole('button', { name: /microfilm/ })
    fireEvent.change(within(dialog).getByLabelText('Filter records'), { target: { value: 'zzz' } })
    expect(within(dialog).getByText(/No records match/)).toBeTruthy()
  })

  it('opens the case screen, at the record, when a reference is activated', async () => {
    const { editor, task } = await withRecords()
    act(() => session(editor).activateReference({ kind: 'task', id: task.id }))
    await screen.findByRole('heading', { level: 1, name: /Maternal grandparents/ })
    expect(window.location.hash).toBe(`#/cases/${CASE}`)
    await waitFor(() => expect(document.getElementById(`task-${task.id}`)).toBeTruthy())
  })

  it('creates a task from the selection only after you press Create task; then links it', async () => {
    const { editor, cases } = await withRecords()
    const before = (await cases.listCaseTasks(CASE)).length
    session(editor).selectText('Ask the parish for the 1884 index')
    fireEvent.click(screen.getByRole('button', { name: 'Create task from selection' }))
    let dialog = await screen.findByRole('dialog', { name: 'Create a task from your notes' })
    expect((within(dialog).getByLabelText('What needs doing') as HTMLInputElement).value).toBe('Ask the parish for the 1884 index')
    // Cancelling creates nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await cases.listCaseTasks(CASE)).toHaveLength(before)
    expect(session(editor).commands.some((c) => c.type === 'insertReference')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Create task from selection' }))
    dialog = await screen.findByRole('dialog', { name: 'Create a task from your notes' })
    fireEvent.change(within(dialog).getByLabelText('What needs doing'), { target: { value: 'Ask the parish for the index' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const tasks = await cases.listCaseTasks(CASE)
    expect(tasks).toHaveLength(before + 1)
    const created = tasks.find((t) => t.title === 'Ask the parish for the index')!
    expect(session(editor).commands.at(-1)).toEqual({ type: 'insertReference', target: { kind: 'task', id: created.id } })
    expect(screen.getByText(/Task “Ask the parish for the index” created and linked here/)).toBeTruthy()
    // The reference reads the new record's label at once.
    expect(session(editor).options.describeReference!({ kind: 'task', id: created.id })).toBe('Task · Ask the parish for the index (pending)')
  })

  it('works with nothing selected, and checks the same rules as the task form', async () => {
    const { cases } = await withRecords()
    const before = (await cases.listCaseTasks(CASE)).length
    fireEvent.click(screen.getByRole('button', { name: 'Create task from selection' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a task from your notes' })
    expect(within(dialog).getByText(/Nothing is selected/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }))
    expect(await within(dialog).findByText('Give the task a name.')).toBeTruthy()
    expect(await cases.listCaseTasks(CASE)).toHaveLength(before)
  })

  it('adds a journal entry from the selection only on Add to journal; then links it', async () => {
    const { editor, cases } = await withRecords()
    const before = (await cases.listJournalEntries(CASE)).length
    session(editor).selectText('Found the baptism of Rosa Ejemplo, 1884.')
    fireEvent.click(screen.getByRole('button', { name: 'Add to journal from selection' }))
    let dialog = await screen.findByRole('dialog', { name: 'Add to the research journal' })
    expect((within(dialog).getByLabelText('What you did or found') as HTMLTextAreaElement).value).toBe('Found the baptism of Rosa Ejemplo, 1884.')
    expect((within(dialog).getByLabelText('When') as HTMLInputElement).value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await cases.listJournalEntries(CASE)).toHaveLength(before)

    fireEvent.click(screen.getByRole('button', { name: 'Add to journal from selection' }))
    dialog = await screen.findByRole('dialog', { name: 'Add to the research journal' })
    fireEvent.change(within(dialog).getByLabelText('Activity (optional)'), { target: { value: 'Record analysis' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to journal' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const entries = await cases.listJournalEntries(CASE)
    expect(entries).toHaveLength(before + 1)
    const created = entries.find((e) => e.body === 'Found the baptism of Rosa Ejemplo, 1884.')!
    expect(created.activity).toBe('Record analysis')
    expect(session(editor).commands.at(-1)).toEqual({ type: 'insertReference', target: { kind: 'journal', id: created.id } })
    expect(screen.getByText(/Journal entry added and linked here/)).toBeTruthy()
  })

  it('keeps the dialog and the text when creating fails', async () => {
    const ctx = setup((real) => ({ ...real, createCaseTask: () => Promise.reject(new Error('offline')) }))
    await openPage(ctx)
    fireEvent.click(screen.getByRole('button', { name: 'Create task from selection' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a task from your notes' })
    fireEvent.change(within(dialog).getByLabelText('What needs doing'), { target: { value: 'Keep me' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }))
    expect(await within(dialog).findByText(/Nothing was created/)).toBeTruthy()
    expect((within(dialog).getByLabelText('What needs doing') as HTMLInputElement).value).toBe('Keep me')
  })

  it('hides every bridge action on an archived case', async () => {
    const ctx = setup()
    await ctx.cases.archiveCase(demoCaseIds.paternal)
    window.location.hash = `#/cases/${demoCaseIds.paternal}/notebook`
    render(<App runtime={ctx.runtime} notebookAdapters={ctx.adapters} />)
    await screen.findByText(/This case is archived, so its notebook is read-only/)
    await waitFor(() => expect(session(ctx.editor).editable).toBe(false))
    for (const name of ['Link record', 'Create task from selection', 'Add to journal from selection', 'Start timer']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByRole('group', { name: 'Research hours' })).toBeNull()
  })

  it('drives the existing research timer from the notebook header', async () => {
    const { cases } = await withRecords()
    const hoursBefore = (await cases.listTimeEntries(CASE)).length
    const group = screen.getByRole('group', { name: 'Research hours' })
    fireEvent.click(within(group).getByRole('button', { name: 'Start timer' }))
    await waitFor(async () => expect((await cases.getActiveTimer())?.caseId).toBe(CASE))
    fireEvent.click(await within(group).findByRole('button', { name: 'Pause timer' }))
    await waitFor(async () => expect((await cases.getActiveTimer())?.state).toBe('paused'))
    fireEvent.click(await within(group).findByRole('button', { name: 'Resume timer' }))
    await waitFor(async () => expect((await cases.getActiveTimer())?.state).toBe('running'))
    // Stopping goes through the existing "Save this time?" flow; nothing is saved on its own.
    fireEvent.click(within(group).getByRole('button', { name: 'Stop & save time' }))
    expect(await screen.findByRole('alertdialog')).toBeTruthy()
    expect(await cases.listTimeEntries(CASE)).toHaveLength(hoursBefore)
  })
})
