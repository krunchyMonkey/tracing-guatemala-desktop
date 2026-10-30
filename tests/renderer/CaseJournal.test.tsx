// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds, demoClientIds } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime, CaseApi } from '../../src/renderer/src/runtime/AppRuntime'
import type { JournalEntryInput } from '../../src/shared/case-journal'

// The research journal on the case page (#18) against the demo's in-memory
// adapters, which follow the same shared rules as the host. Fictional data only.

const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999'

function setup() {
  const data = createDemoApi(buildDemoData(), appInfo)
  const cases = createDemoCases(buildDemoCases(), data.getClient, defaultClock)
  const runtime: AppRuntime = {
    mode: 'live',
    switcher: { kind: 'unavailable', reason: 'not-available' },
    data,
    backup: { createBackup: vi.fn(), chooseBackupToRestore: vi.fn(), restoreBackup: vi.fn() } as never,
    cases
  }
  return { data, cases, runtime }
}

function openAt(hash: string, runtime: AppRuntime) {
  window.location.hash = hash
  return render(<App runtime={runtime} />)
}

const entry: JournalEntryInput = { occurredAt: '2026-10-20T15:30:00.000Z', activity: 'Archive search', body: 'Looked at the index.' }
const journalCard = async () => within(await screen.findByRole('region', { name: 'Research journal' }))
const addForm = async () => within((await journalCard()).getByRole('form', { name: 'Add a journal entry' }))
const items = (card: { getAllByRole: (role: string) => HTMLElement[] }) => card.getAllByRole('listitem')
const bodies = (card: { getAllByRole: (role: string) => HTMLElement[] }) => items(card).map((li) => li.querySelector('.timeline-body')?.textContent)
const dialog = () => screen.getByRole('alertdialog')

afterEach(cleanup)
beforeEach(() => {
  window.location.hash = ''
})

describe('journal on the case page', () => {
  it('lists the seeded entries newest first, with date, activity, line breaks and an edited marker', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    const card = await journalCard()
    await card.findByRole('list', { name: 'Journal entries, newest first' })
    expect(bodies(card)).toEqual([
      'Asked the client for the photograph and any letters. Waiting for a reply.',
      'Compared the two possible baptisms with the family story.\nThe second one fits the date the client gave.',
      'Searched the fictional diocesan index for baptisms of the Ejemplo family, 1880 to 1890.\nFound two possible entries; neither names a father.'
    ])
    const list = items(card)
    expect(within(list[0]!).getByText('Client communication')).toBeTruthy()
    expect(within(list[0]!).getByText(/^Edited /)).toBeTruthy()
    expect(within(list[1]!).queryByText(/^Edited /)).toBeNull()
    expect(list[1]!.querySelector('time')?.getAttribute('datetime')).toBe(list[0]!.querySelector('time')?.getAttribute('datetime'))
    expect(list[2]!.querySelector('.timeline-body')?.className).toContain('preserve-lines')
  })

  it('says the journal is the case’s research log, separate from the client’s contact history', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    const card = await journalCard()
    expect(card.getByText(/separate from the client’s notes and contact history/)).toBeTruthy()
    // The page order: brief, then journal, then history.
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent)
    const at = (name: string) => headings.indexOf(name)
    expect(at('Research brief')).toBeLessThan(at('Research journal'))
    expect(at('Research journal')).toBeLessThan(at('History'))
  })

  it('shows an empty state, and only the entries of this case', async () => {
    const { runtime } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    expect(await (await journalCard()).findByText('No journal entries yet.')).toBeTruthy()
    cleanup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime)
    const card = await journalCard()
    await card.findByRole('list', { name: 'Journal entries, newest first' })
    expect(items(card)).toHaveLength(2)
    expect(card.queryByText(/diocesan index/)).toBeNull()
  })

  it('shows saved text as plain text, never as markup', async () => {
    const { runtime, cases } = setup()
    await cases.createJournalEntry(demoCaseIds.secondBranch, { ...entry, body: '<script>window.__pwned = 1</script><b>bold?</b> “Ángel” & co', activity: '<i>x</i>' })
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const card = await journalCard()
    expect(await card.findByText('<script>window.__pwned = 1</script><b>bold?</b> “Ángel” & co')).toBeTruthy()
    expect(card.getByText('<i>x</i>')).toBeTruthy()
    expect(document.querySelector('.journal script, .journal b, .journal i')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('offers a retry when the journal can’t be loaded', async () => {
    const { runtime, cases } = setup()
    let fail = true
    const flaky: CaseApi = { ...cases, listJournalEntries: (id) => (fail ? Promise.reject(new Error('down')) : cases.listJournalEntries(id)) }
    openAt(`#/cases/${demoCaseIds.paternal}`, { ...runtime, cases: flaky } as AppRuntime)
    expect(await screen.findByText('The journal couldn’t be loaded')).toBeTruthy()
    fail = false
    const card = await journalCard()
    fireEvent.click(card.getByRole('button', { name: 'Try again' }))
    expect(await card.findByText('Client communication')).toBeTruthy()
  })
})

describe('adding entries', () => {
  it('has labelled fields, a default time, and suggestions for the activity', async () => {
    openAt(`#/cases/${demoCaseIds.secondBranch}`, setup().runtime)
    const form = await addForm()
    const when = form.getByLabelText('When') as HTMLInputElement
    expect(when.type).toBe('datetime-local')
    expect(when.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    const activity = form.getByLabelText('Activity (optional)') as HTMLInputElement
    const listId = activity.getAttribute('list')!
    const options = Array.from(document.querySelectorAll(`datalist#${CSS.escape(listId)} option`)).map((o) => o.getAttribute('value'))
    expect(options).toEqual(expect.arrayContaining(['Archive search', 'Record analysis']))
    expect((form.getByLabelText('What you did or found') as HTMLTextAreaElement).tagName).toBe('TEXTAREA')
  })

  it('adds an entry at the top, clears the form and keeps the host’s normalized text', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('Activity (optional)'), { target: { value: '  Record analysis ' } })
    fireEvent.change(form.getByLabelText('What you did or found'), { target: { value: '  Read the baptism entry.\nSecond line.  ' } })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))

    const card = await journalCard()
    await waitFor(() => expect(bodies(card)).toEqual(['Read the baptism entry.\nSecond line.']))
    expect(card.getByText('Record analysis')).toBeTruthy()
    expect((form.getByLabelText('What you did or found') as HTMLTextAreaElement).value).toBe('')
    expect((form.getByLabelText('Activity (optional)') as HTMLInputElement).value).toBe('')
    expect(await cases.listJournalEntries(demoCaseIds.secondBranch)).toMatchObject([{ activity: 'Record analysis', body: 'Read the baptism entry.\nSecond line.' }])
  })

  it('sorts a back-dated entry into place, not at the top', async () => {
    openAt(`#/cases/${demoCaseIds.maternal}`, setup().runtime)
    const form = await addForm()
    const card = await journalCard()
    await card.findByRole('list', { name: 'Journal entries, newest first' })
    fireEvent.change(form.getByLabelText('When'), { target: { value: '2020-01-15T09:00' } })
    fireEvent.change(form.getByLabelText('What you did or found'), { target: { value: 'Very early work.' } })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    await waitFor(() => expect(items(card)).toHaveLength(3))
    expect(bodies(card)[2]).toBe('Very early work.')
    expect(bodies(card)[0]).toContain('Wrote down the variants')
  })

  it('validates inline, keeps what was typed and writes nothing', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const form = await addForm()
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    expect(await form.findByText('Write what you did or found before adding it.')).toBeTruthy()
    expect(form.getByLabelText('What you did or found').getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(form.getByLabelText('What you did or found'), { target: { value: 'Some work.' } })
    fireEvent.change(form.getByLabelText('Activity (optional)'), { target: { value: 'a'.repeat(61) } })
    fireEvent.change(form.getByLabelText('When'), { target: { value: '' } })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    expect(await form.findByText('Keep the activity under 60 characters.')).toBeTruthy()
    expect(form.getByText('Choose a date and time.')).toBeTruthy()
    expect((form.getByLabelText('What you did or found') as HTMLTextAreaElement).value).toBe('Some work.')

    const future = new Date(Date.now() + 5 * 24 * 3600 * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    fireEvent.change(form.getByLabelText('Activity (optional)'), { target: { value: 'Ok' } })
    fireEvent.change(form.getByLabelText('When'), {
      target: { value: `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T10:00` }
    })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    expect(await form.findByText('This date is in the future. Choose when the work happened.')).toBeTruthy()
    expect(await cases.listJournalEntries(demoCaseIds.secondBranch)).toEqual([])
  })

  it('keeps the input and offers a retry when saving fails, then succeeds', async () => {
    const { runtime, cases } = setup()
    let fail = true
    const flaky: CaseApi = {
      ...cases,
      createJournalEntry: (id, input) => (fail ? Promise.reject(new Error('down')) : cases.createJournalEntry(id, input))
    }
    openAt(`#/cases/${demoCaseIds.secondBranch}`, { ...runtime, cases: flaky } as AppRuntime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('Activity (optional)'), { target: { value: 'Archive search' } })
    fireEvent.change(form.getByLabelText('What you did or found'), { target: { value: 'Keep me' } })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    expect(await form.findByText(/Your text is still here; please try again/)).toBeTruthy()
    expect((form.getByLabelText('What you did or found') as HTMLTextAreaElement).value).toBe('Keep me')
    expect((form.getByLabelText('Activity (optional)') as HTMLInputElement).value).toBe('Archive search')

    fail = false
    fireEvent.click(form.getByRole('button', { name: 'Try again' }))
    const card = await journalCard()
    await waitFor(() => expect(bodies(card)).toEqual(['Keep me']))
    expect(form.queryByText(/Your text is still here/)).toBeNull()
  })

  it('shows the host’s issues when it rejects a draft the browser accepted, and keeps the input', async () => {
    const { runtime, cases } = setup()
    const rejecting: CaseApi = {
      ...cases,
      createJournalEntry: async () => ({ ok: false, reason: 'invalid', issues: [{ field: 'body', code: 'too-long' }] })
    }
    openAt(`#/cases/${demoCaseIds.secondBranch}`, { ...runtime, cases: rejecting } as AppRuntime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('What you did or found'), { target: { value: 'My careful notes' } })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    expect(await form.findByText('Keep an entry under 10,000 characters.')).toBeTruthy()
    expect((form.getByLabelText('What you did or found') as HTMLTextAreaElement).value).toBe('My careful notes')
  })

  it('keeps the input with an explanation when the case was archived meanwhile', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('What you did or found'), { target: { value: 'Keep me' } })
    await cases.archiveCase(demoCaseIds.secondBranch)
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    expect(await form.findByText(/archived, so the journal can’t be changed/)).toBeTruthy()
    expect((form.getByLabelText('What you did or found') as HTMLTextAreaElement).value).toBe('Keep me')
  })
})

describe('editing entries', () => {
  it('edits an entry in place, marks it edited and keeps the others', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime)
    const card = await journalCard()
    await card.findByRole('list', { name: 'Journal entries, newest first' })
    const target = items(card)[1]!
    expect(within(target).queryByText(/^Edited /)).toBeNull()
    fireEvent.click(within(target).getByRole('button', { name: /^Edit journal entry from/ }))

    const form = card.getByRole('form', { name: 'Edit journal entry' })
    expect(within(form).getByLabelText('Entry') as HTMLTextAreaElement).toBeTruthy()
    expect((within(form).getByLabelText('Activity (optional)') as HTMLInputElement).value).toBe('Online database search')
    // Only one entry can be edited at a time.
    expect(card.queryAllByRole('button', { name: /^Edit journal entry from/ })).toHaveLength(0)
    fireEvent.change(within(form).getByLabelText('Entry'), { target: { value: 'Updated finding.\nMore detail.' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(card.queryByRole('form', { name: 'Edit journal entry' })).toBeNull())
    expect(bodies(card)[1]).toBe('Updated finding.\nMore detail.')
    expect(within(items(card)[1]!).getByText(/^Edited /)).toBeTruthy()
    expect(bodies(card)[0]).toContain('Wrote down the variants')
    expect((await cases.listJournalEntries(demoCaseIds.maternal)).map((e) => e.body)).toContain('Updated finding.\nMore detail.')
  })

  it('re-sorts when the time is changed', async () => {
    openAt(`#/cases/${demoCaseIds.maternal}`, setup().runtime)
    const card = await journalCard()
    await card.findByRole('list', { name: 'Journal entries, newest first' })
    fireEvent.click(within(items(card)[1]!).getByRole('button', { name: /^Edit journal entry from/ }))
    const form = card.getByRole('form', { name: 'Edit journal entry' })
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    fireEvent.change(within(form).getByLabelText('When'), {
      target: { value: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00:00` }
    })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(bodies(card)[0]).toContain('Looked for the 1931 marriage'))
  })

  it('validates inline and keeps the edit open with the typed text on failure, then retries', async () => {
    const { runtime, cases } = setup()
    let fail = true
    const flaky: CaseApi = {
      ...cases,
      updateJournalEntry: (id, entryId, input) =>
        fail ? Promise.reject(new Error('down')) : cases.updateJournalEntry(id, entryId, input)
    }
    openAt(`#/cases/${demoCaseIds.maternal}`, { ...runtime, cases: flaky } as AppRuntime)
    const card = await journalCard()
    await card.findByRole('list', { name: 'Journal entries, newest first' })
    fireEvent.click(within(items(card)[0]!).getByRole('button', { name: /^Edit journal entry from/ }))
    const form = within(card.getByRole('form', { name: 'Edit journal entry' }))

    fireEvent.change(form.getByLabelText('Entry'), { target: { value: '   ' } })
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }))
    expect(await form.findByText('Write what you did or found before adding it.')).toBeTruthy()

    fireEvent.change(form.getByLabelText('Entry'), { target: { value: 'Revised text' } })
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }))
    expect(await form.findByText(/Your text is still here; please try again/)).toBeTruthy()
    expect((form.getByLabelText('Entry') as HTMLTextAreaElement).value).toBe('Revised text')

    fail = false
    fireEvent.click(form.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(bodies(card)[0]).toBe('Revised text'))
  })

  it('asks before discarding unsaved changes, and cancels without asking when nothing changed', async () => {
    openAt(`#/cases/${demoCaseIds.maternal}`, setup().runtime)
    const card = await journalCard()
    await card.findByRole('list', { name: 'Journal entries, newest first' })
    fireEvent.click(within(items(card)[0]!).getByRole('button', { name: /^Edit journal entry from/ }))
    fireEvent.click(card.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(card.queryByRole('form', { name: 'Edit journal entry' })).toBeNull()

    fireEvent.click(within(items(card)[0]!).getByRole('button', { name: /^Edit journal entry from/ }))
    fireEvent.change(card.getByLabelText('Entry'), { target: { value: 'changed' } })
    fireEvent.click(card.getByRole('button', { name: 'Cancel' }))
    expect(within(dialog()).getByText('Discard your changes?')).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect((card.getByLabelText('Entry') as HTMLTextAreaElement).value).toBe('changed')
    fireEvent.click(card.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard changes' }))
    expect(card.queryByRole('form', { name: 'Edit journal entry' })).toBeNull()
    expect(bodies(card)[0]).toContain('Wrote down the variants')
  })
})

describe('read-only journal', () => {
  it('keeps entries visible but offers no add or edit when the case is archived', async () => {
    const { runtime, cases } = setup()
    await cases.createJournalEntry(demoCaseIds.surname, entry)
    await cases.archiveCase(demoCaseIds.surname)
    openAt(`#/cases/${demoCaseIds.surname}`, runtime)
    const card = await journalCard()
    expect(await card.findByText('Looked at the index.')).toBeTruthy()
    expect(card.getByText(/This case is archived, so the journal can’t be changed/)).toBeTruthy()
    expect(card.queryByRole('form')).toBeNull()
    expect(card.queryByRole('button', { name: /Add entry|Edit journal entry/ })).toBeNull()
  })

  it('keeps entries visible but offers no add or edit when the client is archived', async () => {
    const { runtime, data } = setup()
    await data.archiveClient(demoClientIds.lucia)
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const card = await journalCard()
    expect(await card.findByText('Client communication')).toBeTruthy()
    expect(card.getByText(/This client is archived, so the journal can’t be changed/)).toBeTruthy()
    expect(card.queryByRole('form')).toBeNull()
    expect(card.queryByRole('button', { name: /Add entry|Edit journal entry/ })).toBeNull()
  })

  it('is writable again after unarchiving', async () => {
    const { runtime, cases } = setup()
    await cases.archiveCase(demoCaseIds.secondBranch)
    await cases.unarchiveCase(demoCaseIds.secondBranch)
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    expect(await addForm()).toBeTruthy()
  })
})

describe('demo journal adapter', () => {
  it('follows the repository’s rules and check order', async () => {
    const { data, cases } = setup()
    const [newest] = await cases.listJournalEntries(demoCaseIds.paternal)
    const bad = { occurredAt: 'nope', activity: null, body: '' }
    expect(await cases.listJournalEntries(UNKNOWN_ID)).toEqual([])
    expect(await cases.createJournalEntry(UNKNOWN_ID, entry)).toEqual({ ok: false, reason: 'not-found' })
    expect(await cases.updateJournalEntry(UNKNOWN_ID, newest!.id, entry)).toEqual({ ok: false, reason: 'not-found' })
    // The entry must belong to the case in the call.
    expect(await cases.updateJournalEntry(demoCaseIds.maternal, newest!.id, bad)).toEqual({ ok: false, reason: 'not-found' })
    expect(await cases.updateJournalEntry(demoCaseIds.maternal, newest!.id, entry)).toEqual({ ok: false, reason: 'not-found' })
    expect((await cases.listJournalEntries(demoCaseIds.paternal))[0]).toEqual(newest)
    // Archived is reported before a missing entry and invalid input.
    expect(await cases.createJournalEntry(demoCaseIds.reunion, bad)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.updateJournalEntry(demoCaseIds.reunion, UNKNOWN_ID, bad)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.createJournalEntry(demoCaseIds.secondBranch, bad)).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'body', code: 'required' },
        { field: 'occurredAt', code: 'invalid-format' }
      ]
    })
    expect(await cases.createJournalEntry(demoCaseIds.secondBranch, { ...entry, occurredAt: '2031-01-01T00:00:00.000Z' })).toMatchObject({
      reason: 'invalid',
      issues: [{ field: 'occurredAt', code: 'in-future' }]
    })

    const before = (await cases.getCase(demoCaseIds.secondBranch))!
    const created = await cases.createJournalEntry(demoCaseIds.secondBranch, { ...entry, body: ' a\r\nb ', activity: ' ' })
    expect(created).toMatchObject({ ok: true, entry: { body: 'a\nb', activity: null, caseId: demoCaseIds.secondBranch } })
    expect((await cases.getCase(demoCaseIds.secondBranch))!.updatedAt > before.updatedAt).toBe(true)
    expect(await cases.listCaseEvents(demoCaseIds.secondBranch)).toHaveLength(3)

    await data.archiveClient(demoClientIds.ethan)
    expect(await cases.createJournalEntry(demoCaseIds.secondBranch, entry)).toEqual({ ok: false, reason: 'wrong-status' })
  })

  it('seeds entries for two cases of one client, with a tie in time, and none for the others', async () => {
    const { cases } = setup()
    const paternal = await cases.listJournalEntries(demoCaseIds.paternal)
    const maternal = await cases.listJournalEntries(demoCaseIds.maternal)
    expect(paternal).toHaveLength(3)
    expect(maternal).toHaveLength(2)
    expect(new Set(paternal.map((e) => e.occurredAt)).size).toBe(2)
    expect(paternal[0]!.occurredAt).toBe(paternal[1]!.occurredAt)
    expect(paternal[0]!.createdAt > paternal[1]!.createdAt).toBe(true)
    for (const id of [demoCaseIds.baptism, demoCaseIds.surname, demoCaseIds.secondBranch, demoCaseIds.reunion, demoCaseIds.spelling]) {
      expect(await cases.listJournalEntries(id)).toEqual([])
    }
  })

  it('returns copies and starts from the seeded entries again on every load', async () => {
    const initial = buildDemoCases()
    const data = createDemoApi(buildDemoData(), appInfo)
    const first = createDemoCases(initial, data.getClient, defaultClock)
    const list = await first.listJournalEntries(demoCaseIds.paternal)
    list[0]!.body = 'Changed in place'
    expect((await first.listJournalEntries(demoCaseIds.paternal))[0]!.body).toContain('Asked the client')

    await first.createJournalEntry(demoCaseIds.paternal, entry)
    expect(await first.listJournalEntries(demoCaseIds.paternal)).toHaveLength(4)
    const reload = createDemoCases(initial, data.getClient, defaultClock)
    expect(await reload.listJournalEntries(demoCaseIds.paternal)).toHaveLength(3)
  })

  it('never shows journal entries among the client’s notes', async () => {
    const { data } = setup()
    const notes = await data.listNotes(demoClientIds.lucia)
    expect(JSON.stringify(notes)).not.toContain('diocesan index')
  })
})
