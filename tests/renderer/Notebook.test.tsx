// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime, CaseApi } from '../../src/renderer/src/runtime/AppRuntime'
import type { NotebookAdapters } from '../../src/renderer/src/notebook/NotebookAdapters'
import { createFakeEditorAdapter, type FakeEditorAdapter, type FakeEditorSession } from './notebook/fakeEditorAdapter'

// The notebook screens (#148) with the in-memory fake editor injected through App's
// `notebookAdapters` prop: nothing here depends on the real editor library. The demo's
// in-memory notebook (same rules as the host) stands in for the host. Fictional data only.

const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }

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

function openAt(hash: string, runtime: AppRuntime, adapters: NotebookAdapters) {
  window.location.hash = hash
  return render(<App runtime={runtime} notebookAdapters={adapters} />)
}

const notebookUrl = (caseId: string) => `#/cases/${caseId}/notebook`
const session = (editor: FakeEditorAdapter): FakeEditorSession => editor.sessions.at(-1)!
// Looked up when used, so it also works before the list has appeared.
const nav = () =>
  new Proxy({} as ReturnType<typeof within>, {
    get: (_t, key: string) => (...args: unknown[]) => {
      const call = (root: HTMLElement) => (within(root) as unknown as Record<string, (...a: unknown[]) => unknown>)[key]!(...args)
      return key.startsWith('find') ? screen.findByRole('navigation', { name: 'Notebook' }).then(call) : call(screen.getByRole('navigation', { name: 'Notebook' }))
    }
  })
const toolbar = () => within(screen.getByRole('toolbar', { name: 'Formatting' }))
const textOf = (s: FakeEditorSession): string => JSON.stringify(s.getContent())
const pageLinks = () => nav().queryAllByRole('link').map((a: HTMLElement) => a.textContent)

async function openMenu(label: string) {
  fireEvent.click(await nav().findByRole('button', { name: label }))
}
const choose = (name: string) => fireEvent.click(within(screen.getByRole('group', { name: /^Options for/ })).getByRole('button', { name }))

afterEach(cleanup)
beforeEach(() => {
  window.location.hash = ''
})

describe('entry point on the case page', () => {
  it('shows the seeded notebook and opens it', async () => {
    const { runtime, adapters } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime, adapters)
    const card = await screen.findByRole('region', { name: 'Research notebook' })
    expect(await within(card).findByText(/1 page in 1 section/)).toBeTruthy()
    fireEvent.click(within(card).getByRole('link', { name: 'Open the notebook' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Research notebook' })).toBeTruthy()
    expect(await nav().findByRole('link', { name: 'Diocesan archive, first visit' })).toBeTruthy()
  })

  it('invites a case without a notebook to start one', async () => {
    const { runtime, adapters } = setup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime, adapters)
    const card = await screen.findByRole('region', { name: 'Research notebook' })
    expect(await within(card).findByRole('link', { name: 'Start a notebook' })).toBeTruthy()
  })

  it('has no notebook routes where the runtime has no cases', async () => {
    const { runtime, adapters } = setup()
    openAt(notebookUrl(demoCaseIds.paternal), { ...runtime, mode: 'desktop', cases: null, backup: runtime.backup } as never, adapters)
    expect(screen.queryByRole('heading', { name: 'Research notebook' })).toBeNull()
  })
})

describe('starting and opening', () => {
  it('shows a friendly empty state, then creates the first section and page and opens it', async () => {
    const { runtime, adapters, editor, cases } = setup()
    openAt(notebookUrl(demoCaseIds.maternal), runtime, adapters)
    expect(await screen.findByRole('heading', { name: 'Start your research notebook' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start your research notebook' }))
    const link = await nav().findByRole('link', { name: 'First page' })
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(nav().getByRole('button', { name: /^Research notes/ })).toBeTruthy()
    await waitFor(() => expect(editor.sessions.length).toBe(1))
    expect(session(editor).options.placeholder).toBe('Start writing… Use the toolbar or type # for a heading')
    expect((await cases.getNotebook(demoCaseIds.maternal))!.sections[0]!.pages).toHaveLength(1)
  })

  it('opens the first page of a notebook that has one and shows its content in the editor', async () => {
    const { runtime, adapters, editor } = setup()
    openAt(notebookUrl(demoCaseIds.paternal), runtime, adapters)
    const link = await nav().findByRole('link', { name: 'Diocesan archive, first visit' })
    await waitFor(() => expect(link.getAttribute('aria-current')).toBe('page'))
    await waitFor(() => expect(textOf(session(editor))).toContain('Ask for the Ejemplo family baptisms'))
    expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('Diocesan archive, first visit')
    expect(session(editor).options.label).toBe('Page text')
    expect(session(editor).editable).toBe(true)
  })

  it('offers "Add a page" for an empty section', async () => {
    const { runtime, adapters, cases } = setup()
    await cases.createNotebookSection(demoCaseIds.maternal, { title: 'Parish books' })
    openAt(notebookUrl(demoCaseIds.maternal), runtime, adapters)
    const main = await screen.findByRole('heading', { name: 'Parish books' })
    fireEvent.click(within(main.parentElement!).getByRole('button', { name: 'Add a page' }))
    expect(await nav().findByRole('link', { name: 'Untitled page' })).toBeTruthy()
  })
})

describe('organizing sections and pages', () => {
  async function seeded() {
    const ctx = setup()
    const a = await ctx.cases.createNotebookSection(demoCaseIds.maternal, { title: 'Parish books' })
    const b = await ctx.cases.createNotebookSection(demoCaseIds.maternal, { title: 'Letters' })
    if (!a.ok || !b.ok) throw new Error('setup')
    for (const title of ['Baptisms 1880', 'Marriages 1890']) await ctx.cases.createNotebookPage(demoCaseIds.maternal, a.section.id, { title })
    openAt(notebookUrl(demoCaseIds.maternal), ctx.runtime, ctx.adapters)
    await nav().findByRole('link', { name: 'Baptisms 1880' })
    return { ...ctx, a: a.section, b: b.section }
  }

  it('adds, renames and reorders sections', async () => {
    const { cases } = await seeded()
    fireEvent.click(nav().getByRole('button', { name: '+ New section' }))
    const form = nav().getByLabelText('New section name') as HTMLInputElement
    fireEvent.change(form, { target: { value: 'Photographs' } })
    fireEvent.click(nav().getByRole('button', { name: 'Add section' }))
    await nav().findByRole('button', { name: /^Photographs/ })

    await openMenu('Options for section Letters')
    choose('Rename')
    fireEvent.change(nav().getByLabelText('Section name'), { target: { value: 'Correspondence' } })
    fireEvent.click(nav().getByRole('button', { name: 'Save' }))
    await nav().findByRole('button', { name: /^Correspondence/ })

    await openMenu('Options for section Correspondence')
    choose('Move up')
    await waitFor(async () => {
      const titles = (await cases.getNotebook(demoCaseIds.maternal))!.sections.map((s) => s.title)
      expect(titles).toEqual(['Correspondence', 'Parish books', 'Photographs'])
    })
    await waitFor(() => {
      const names = nav().getAllByRole('button', { name: /^(Correspondence|Parish books|Photographs)/ }).filter((b: HTMLElement) => b.hasAttribute('aria-expanded')).map((b: HTMLElement) => b.textContent)
      expect(names[0]).toContain('Correspondence')
    })
  })

  it('moves a page up and down, and to another section', async () => {
    const { cases } = await seeded()
    await openMenu('Options for page Marriages 1890')
    choose('Move up')
    await waitFor(() => expect(pageLinks()).toEqual(['Marriages 1890', 'Baptisms 1880']))

    await openMenu('Options for page Marriages 1890')
    fireEvent.change(within(screen.getByRole('group', { name: /^Options for/ })).getByLabelText('Move to section'), { target: { value: (await cases.getNotebook(demoCaseIds.maternal))!.sections[1]!.id } })
    await waitFor(async () => {
      const outline = (await cases.getNotebook(demoCaseIds.maternal))!
      expect(outline.sections.map((s) => s.pages.map((p) => p.title))).toEqual([['Baptisms 1880'], ['Marriages 1890']])
    })
  })

  it('renames the open page from its title field', async () => {
    const { cases } = await seeded()
    const title = (await screen.findByLabelText('Page title')) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe('Baptisms 1880'))
    fireEvent.change(title, { target: { value: 'Baptisms 1880 to 1885' } })
    fireEvent.blur(title)
    await nav().findByRole('link', { name: 'Baptisms 1880 to 1885' })
    expect((await cases.getNotebook(demoCaseIds.maternal))!.sections[0]!.pages[0]!.title).toBe('Baptisms 1880 to 1885')
  })

  it('asks before archiving, hides the page, and restores it from the Archived list', async () => {
    const { cases } = await seeded()
    await openMenu('Options for page Marriages 1890')
    choose('Archive page')
    const confirm = screen.getByRole('alertdialog')
    expect(within(confirm).getByText(/Nothing is deleted/)).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(pageLinks()).toContain('Marriages 1890')

    await openMenu('Options for page Marriages 1890')
    choose('Archive page')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive page' }))
    await waitFor(() => expect(nav().getByText('Archived (1)')).toBeTruthy())
    fireEvent.click(nav().getByText('Archived (1)'))
    fireEvent.click(await nav().findByRole('button', { name: 'Restore page Marriages 1890' }))
    await waitFor(async () => expect((await cases.getNotebook(demoCaseIds.maternal))!.sections[0]!.pages.every((p) => p.archivedAt === null)).toBe(true))
    await waitFor(() => expect(nav().queryByText(/^Archived \(/)).toBeNull())
  })

  it('archives and restores a section', async () => {
    await seeded()
    await openMenu('Options for section Letters')
    choose('Archive section')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive section' }))
    await waitFor(() => expect(nav().queryByRole('button', { name: /^Letters/ })).toBeNull())
    fireEvent.click(nav().getByText('Archived (1)'))
    fireEvent.click(nav().getByRole('button', { name: 'Restore section Letters' }))
    await nav().findByRole('button', { name: /^Letters/ })
  })

  it('collapses a section with a button that says whether it is expanded', async () => {
    await seeded()
    const toggle = nav().getByRole('button', { name: /^Parish books/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(nav().queryByRole('link', { name: 'Baptisms 1880' })).toBeNull()
  })

  it('opens pages from the list and keeps one highlighted', async () => {
    const { editor } = await seeded()
    const second = await nav().findByRole('link', { name: 'Marriages 1890' })
    fireEvent.click(second)
    await waitFor(() => expect(second.getAttribute('aria-current')).toBe('page'))
    expect(nav().getByRole('link', { name: 'Baptisms 1880' }).getAttribute('aria-current')).toBeNull()
    await waitFor(() => expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('Marriages 1890'))
    expect(editor.sessions).toHaveLength(1)
  })

  it('has a Pages toggle for narrow screens', async () => {
    await seeded()
    const toggle = screen.getByRole('button', { name: 'Pages' })
    expect(toggle.getAttribute('aria-controls')).toBe('notebook-nav')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById('notebook-nav')).toBeTruthy()
  })
})

describe('toolbar', () => {
  async function ready() {
    const ctx = setup()
    openAt(notebookUrl(demoCaseIds.paternal), ctx.runtime, ctx.adapters)
    await waitFor(() => expect(ctx.editor.sessions.length).toBe(1))
    await waitFor(() => expect(textOf(session(ctx.editor))).toContain('Ejemplo'))
    return ctx
  }

  it('is a labelled toolbar with named buttons', async () => {
    await ready()
    for (const name of ['Undo', 'Redo', 'Bold', 'Italic', 'Underline', 'Strikethrough', 'Code', 'Bulleted list', 'Numbered list', 'Checklist', 'Indent', 'Outdent', 'Link', 'Divider']) {
      expect(toolbar().getByRole('button', { name })).toBeTruthy()
    }
    expect(toolbar().getByRole('combobox', { name: 'Block type' })).toBeTruthy()
    expect(toolbar().getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('turns list buttons on and off from the block under the caret', async () => {
    const { editor } = await ready()
    const s = session(editor)
    // The caret is in a checklist item, so its button is pressed and turns the item back into a paragraph.
    expect(toolbar().getByRole('button', { name: 'Checklist' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toolbar().getByRole('button', { name: 'Checklist' }))
    expect(s.commands.at(-1)).toEqual({ type: 'setBlock', block: 'paragraph' })
    for (const [name, block] of [['Bulleted list', 'bullet'], ['Numbered list', 'numbered'], ['Checklist', 'check']] as const) {
      fireEvent.click(toolbar().getByRole('button', { name }))
      expect(s.commands.at(-1), name).toEqual({ type: 'setBlock', block })
    }
  })

  it('sends the right commands to the editor', async () => {
    const { editor } = await ready()
    const s = session(editor)
    for (const [name, command] of [
      ['Bold', { type: 'toggleMark', mark: 'bold' }],
      ['Italic', { type: 'toggleMark', mark: 'italic' }],
      ['Underline', { type: 'toggleMark', mark: 'underline' }],
      ['Strikethrough', { type: 'toggleMark', mark: 'strike' }],
      ['Code', { type: 'toggleMark', mark: 'code' }],
      ['Indent', { type: 'indent' }],
      ['Outdent', { type: 'outdent' }],
      ['Divider', { type: 'insertDivider' }]
    ] as const) {
      fireEvent.click(toolbar().getByRole('button', { name }))
      expect(s.commands.at(-1), name).toEqual(command)
    }
    fireEvent.change(toolbar().getByRole('combobox', { name: 'Block type' }), { target: { value: 'heading2' } })
    expect(s.commands.at(-1)).toEqual({ type: 'setBlock', block: 'heading2' })
  })

  it('reflects the editor state: active block and marks', async () => {
    const { editor } = await ready()
    const s = session(editor)
    // The seeded page ends in a checklist, so the caret block is a check.
    s.select(0)
    fireEvent.click(toolbar().getByRole('button', { name: 'Undo' }))
    s.type('!')
    await waitFor(() => expect(toolbar().getByRole('button', { name: 'Undo' }).getAttribute('aria-disabled')).toBe('false'))
    s.select(0)
    s.run({ type: 'setBlock', block: 'bullet' })
    await waitFor(() => expect(toolbar().getByRole('button', { name: 'Bulleted list' }).getAttribute('aria-pressed')).toBe('true'))
  })

  it('validates link addresses before asking the editor', async () => {
    const { editor } = await ready()
    const s = session(editor)
    fireEvent.click(toolbar().getByRole('button', { name: 'Link' }))
    const dialog = screen.getByRole('dialog', { name: 'Link' })
    fireEvent.change(within(dialog).getByLabelText('Web address'), { target: { value: 'javascript:alert(1)' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply link' }))
    expect(within(dialog).getByRole('alert').textContent).toMatch(/https:\/\//)
    expect(s.commands.some((c) => c.type === 'setLink')).toBe(false)

    fireEvent.change(within(dialog).getByLabelText('Web address'), { target: { value: 'https://example.org/archive' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply link' }))
    expect(s.commands.at(-1)).toEqual({ type: 'setLink', href: 'https://example.org/archive' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('moves between tools with the arrow keys (one tab stop)', async () => {
    await ready()
    const stops = () => toolbar().getAllByRole('button').filter((b) => b.tabIndex === 0)
    expect(stops()).toHaveLength(1)
    const first = stops()[0]!
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).not.toBe(first)
    expect(toolbar().getAllByRole('button').filter((b) => b.tabIndex === 0).length + (document.activeElement?.tagName === 'SELECT' ? 1 : 0)).toBeGreaterThan(0)
  })
})

describe('saving', () => {
  async function open(wrap?: (cases: CaseApi) => CaseApi) {
    const ctx = setup(wrap)
    const created = await ctx.cases.createNotebookSection(demoCaseIds.maternal, { title: 'Parish books' })
    if (!created.ok) throw new Error('setup')
    const first = await ctx.cases.createNotebookPage(demoCaseIds.maternal, created.section.id, { title: 'Baptisms' })
    const second = await ctx.cases.createNotebookPage(demoCaseIds.maternal, created.section.id, { title: 'Marriages' })
    if (!first.ok || !second.ok) throw new Error('setup')
    openAt(`${notebookUrl(demoCaseIds.maternal)}/${first.page.id}`, ctx.runtime, ctx.adapters)
    await waitFor(() => expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('Baptisms'))
    await waitFor(() => expect(session(ctx.editor).editable).toBe(true))
    return { ...ctx, first: first.page, second: second.page }
  }

  it('saves after a pause: Saving…, then Saved at HH:MM, with the host holding the new version', async () => {
    const { editor, cases, first } = await open()
    expect(document.querySelector('.note-save-status')?.getAttribute('aria-live')).toBe('polite')
    session(editor).type('Searched the index.')
    await waitFor(() => expect(document.querySelector('.note-save-status')?.textContent).toBe('Saving…'))
    await waitFor(() => expect(document.querySelector('.note-save-status')?.textContent).toMatch(/^Saved at \d\d:\d\d$/), { timeout: 4000 })
    const saved = (await cases.getNotebookPage(demoCaseIds.maternal, first.id))!
    expect(saved.version).toBe(2)
    expect(JSON.stringify(saved.content)).toContain('Searched the index.')
  })

  it('saves at once when leaving a page, and shows the saved text when coming back', async () => {
    const { editor, cases, first } = await open()
    session(editor).type('Note one.')
    fireEvent.click(await nav().findByRole('link', { name: 'Marriages' }))
    await waitFor(async () => expect(JSON.stringify((await cases.getNotebookPage(demoCaseIds.maternal, first.id))!.content)).toContain('Note one.'))
    await waitFor(() => expect(session(editor).editable).toBe(true))
    expect(textOf(session(editor))).not.toContain('Note one.')
    fireEvent.click(nav().getByRole('link', { name: 'Baptisms' }))
    await waitFor(() => expect(textOf(session(editor))).toContain('Note one.'))
  })

  it('keeps unsaved text when a save fails, says so, and retries', async () => {
    let failing = true
    const { editor, cases, first } = await open((real) => ({
      ...real,
      saveNotebookPage: (caseId, pageId, save) => (failing ? Promise.reject(new Error('offline')) : real.saveNotebookPage(caseId, pageId, save))
    }))
    session(editor).type('Precious words.')
    fireEvent.click(await nav().findByRole('link', { name: 'Marriages' }))
    await waitFor(() => expect(session(editor).editable).toBe(true))
    expect(textOf(session(editor))).not.toContain('Precious words.')
    // Back on the first page, the draft is shown, and it is flagged as not saved.
    fireEvent.click(nav().getByRole('link', { name: 'Baptisms' }))
    await waitFor(() => expect(textOf(session(editor))).toContain('Precious words.'))
    await waitFor(() => expect(document.querySelector('.note-save-status')?.textContent).toBe('Not saved — retrying'), { timeout: 4000 })
    expect(screen.getByText(/Your text is still here/)).toBeTruthy()

    failing = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    await waitFor(() => expect(document.querySelector('.note-save-status')?.textContent).toMatch(/^Saved at \d\d:\d\d$/))
    expect(JSON.stringify((await cases.getNotebookPage(demoCaseIds.maternal, first.id))!.content)).toContain('Precious words.')
  })

  it('says the page changed in another window on a conflict and shows the saved version on request', async () => {
    const { editor, cases, first } = await open()
    // Another window saves first.
    const current = (await cases.getNotebookPage(demoCaseIds.maternal, first.id))!
    await cases.saveNotebookPage(demoCaseIds.maternal, first.id, {
      baseVersion: current.version,
      content: { format: 'tg-note', version: 1, blocks: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'paragraph', indent: 0, content: [{ text: 'Saved elsewhere.' }] }] }
    })
    session(editor).type('Local words.')
    const useSaved = await screen.findByRole('button', { name: 'Use the saved version' }, { timeout: 4000 })
    expect(screen.getByRole('alert').textContent).toContain('This page was changed in another window.')
    fireEvent.click(useSaved)
    await waitFor(() => expect(textOf(session(editor))).toContain('Saved elsewhere.'))
    expect(textOf(session(editor))).not.toContain('Local words.')
  })
})

describe('archived case', () => {
  it('is read-only: notice, no organization actions, editor not editable', async () => {
    const { runtime, adapters, editor, cases } = setup()
    await cases.archiveCase(demoCaseIds.paternal)
    openAt(notebookUrl(demoCaseIds.paternal), runtime, adapters)
    expect(await screen.findByText(/This case is archived, so its notebook is read-only/)).toBeTruthy()
    await nav().findByRole('link', { name: 'Diocesan archive, first visit' })
    expect(nav().queryByRole('button', { name: '+ New section' })).toBeNull()
    expect(nav().queryByRole('button', { name: /^Options for/ })).toBeNull()
    expect(screen.queryByRole('toolbar')).toBeNull()
    await waitFor(() => expect(textOf(session(editor))).toContain('Ejemplo'))
    expect(session(editor).editable).toBe(false)
    expect((screen.getByLabelText('Page title') as HTMLInputElement).readOnly).toBe(true)
  })

  it('cannot start a notebook on an archived case', async () => {
    const { runtime, adapters, cases } = setup()
    await cases.archiveCase(demoCaseIds.maternal)
    openAt(notebookUrl(demoCaseIds.maternal), runtime, adapters)
    expect(await screen.findByRole('heading', { name: 'No notebook was started' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start your research notebook' })).toBeNull()
  })
})
