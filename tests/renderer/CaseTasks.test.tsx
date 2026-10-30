// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { dueLabel } from '../../src/renderer/src/cases/TasksCard'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds, demoClientIds } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime, CaseApi } from '../../src/renderer/src/runtime/AppRuntime'
import { localDateString } from '../../src/shared/case-model'
import type { CaseTask, CaseTaskInput } from '../../src/shared/case-tasks'

// Next steps (case tasks, #19) on the case page against the demo's in-memory
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

const input: CaseTaskInput = { title: 'Write to the diocesan archive', description: 'Ask about 1880s books.', dueDate: '2026-12-01' }
const card = async () => within(await screen.findByRole('region', { name: 'Next steps' }))
const addForm = async () => within((await card()).getByRole('form', { name: 'Add a next step' }))
const openTitles = (c: ReturnType<typeof within>) =>
  within(c.getByRole('list', { name: 'Open next steps' }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.task-title')?.textContent)
const dateIn = (days: number) => {
  const d = new Date()
  return localDateString(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days))
}

afterEach(cleanup)
beforeEach(() => {
  window.location.hash = ''
})

describe('next steps on the case page', () => {
  it('sits right after Progress and before the brief, and says nothing is sent', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    const c = await card()
    expect(c.getByText(/Nothing here is sent to anyone/)).toBeTruthy()
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent)
    expect(headings.indexOf('Progress')).toBeLessThan(headings.indexOf('Next steps'))
    expect(headings.indexOf('Next steps')).toBeLessThan(headings.indexOf('Research brief'))
  })

  it('lists open steps by deadline with due text in words, undated last', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Open next steps' })
    expect(openTitles(c)).toEqual([
      'Ask the client for the photograph and letters',
      'Search the 1880s baptism index for the second parish',
      'Compare spelling variants of the surname',
      'Draft the interim findings summary',
      'Note down archive opening hours'
    ])
    const rows = within(c.getByRole('list', { name: 'Open next steps' })).getAllByRole('listitem')
    expect(within(rows[0]!).getByText('Overdue by 2 days')).toBeTruthy()
    expect(within(rows[1]!).getByText('Due today')).toBeTruthy()
    expect(within(rows[2]!).getByText('Due in 2 days')).toBeTruthy()
    expect(within(rows[3]!).getByText('Due in 14 days')).toBeTruthy()
    expect(within(rows[4]!).getByText('No deadline')).toBeTruthy()
    expect(rows[0]!.querySelector('time')?.getAttribute('datetime')).toBe(dateIn(-2))
    expect(within(rows[0]!).getByText(/They mentioned a photograph/)).toBeTruthy()
  })

  it('keeps completed steps in a Completed (N) disclosure with Reopen', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    const c = await card()
    const summary = await c.findByText('Completed (1)')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    fireEvent.click(summary)
    expect(details.open).toBe(true)
    const done = within(c.getByRole('list', { name: 'Completed next steps' }))
    expect(done.getByText('Confirm the client’s grandfather’s birth year')).toBeTruthy()
    expect(done.getByRole('listitem').textContent).toMatch(/Done /)
    expect(done.queryByText(/Overdue/)).toBeNull()
    expect(done.getByRole('button', { name: /^Reopen:/ })).toBeTruthy()
  })

  it('shows an empty state, and only the steps of this case', async () => {
    const { runtime } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    expect(await (await card()).findByText('No next steps yet.')).toBeTruthy()
    cleanup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Open next steps' })
    expect(openTitles(c)).toEqual(['Request 1931 civil marriage register extract', 'Try the spelling variants in the online index'])
    expect(c.queryByText(/photograph/)).toBeNull()
  })

  it('shows saved text as plain text, never as markup', async () => {
    const { runtime, cases } = setup()
    await cases.createCaseTask(demoCaseIds.secondBranch, { title: '<b>bold?</b> “Ángel” & co', description: '<script>window.__pwned = 1</script>', dueDate: null })
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const c = await card()
    expect(await c.findByText('<b>bold?</b> “Ángel” & co')).toBeTruthy()
    expect(c.getByText('<script>window.__pwned = 1</script>')).toBeTruthy()
    expect(document.querySelector('.tasks script, .tasks b')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('offers a retry when the steps can’t be loaded', async () => {
    const { runtime, cases } = setup()
    let fail = true
    const flaky: CaseApi = { ...cases, listCaseTasks: (id) => (fail ? Promise.reject(new Error('down')) : cases.listCaseTasks(id)) }
    openAt(`#/cases/${demoCaseIds.paternal}`, { ...runtime, cases: flaky } as AppRuntime)
    expect(await screen.findByText('The next steps couldn’t be loaded')).toBeTruthy()
    fail = false
    fireEvent.click((await card()).getByRole('button', { name: 'Try again' }))
    expect(await (await card()).findByText('Draft the interim findings summary')).toBeTruthy()
  })
})

describe('dueLabel', () => {
  const task = (dueDate: string | null, status: CaseTask['status'] = 'pending') =>
    ({ status, dueDate }) as CaseTask
  it('words every case, including singular days and month boundaries', () => {
    expect(dueLabel(task('2026-10-30'), '2026-10-31')).toEqual({ text: 'Overdue by 1 day', tone: 'overdue' })
    expect(dueLabel(task('2026-10-31'), '2026-10-31')).toEqual({ text: 'Due today', tone: 'today' })
    expect(dueLabel(task('2026-11-01'), '2026-10-31')).toEqual({ text: 'Due tomorrow', tone: 'soon' })
    expect(dueLabel(task('2026-11-03'), '2026-10-31')).toEqual({ text: 'Due in 3 days', tone: 'soon' })
    expect(dueLabel(task('2026-11-04'), '2026-10-31')).toEqual({ text: 'Due in 4 days', tone: 'later' })
    expect(dueLabel(task('2027-01-01'), '2026-12-31')).toEqual({ text: 'Due tomorrow', tone: 'soon' })
    expect(dueLabel(task(null), '2026-10-31')).toBeNull()
    expect(dueLabel(task('2020-01-01', 'completed'), '2026-10-31')).toBeNull()
  })
})

describe('adding steps', () => {
  it('has labelled fields with a native date input', async () => {
    openAt(`#/cases/${demoCaseIds.secondBranch}`, setup().runtime)
    const form = await addForm()
    expect((form.getByLabelText('What needs doing') as HTMLInputElement).type).toBe('text')
    expect((form.getByLabelText('Details (optional)') as HTMLTextAreaElement).tagName).toBe('TEXTAREA')
    const due = form.getByLabelText('Deadline (optional)') as HTMLInputElement
    expect(due.type).toBe('date')
    expect(due.value).toBe('')
  })

  it('adds a step, clears the form, shows a past deadline as overdue and keeps the host’s text', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('What needs doing'), { target: { value: '  Check   the  index ' } })
    fireEvent.change(form.getByLabelText('Deadline (optional)'), { target: { value: dateIn(-3) } })
    fireEvent.click(form.getByRole('button', { name: 'Add next step' }))

    const c = await card()
    await waitFor(() => expect(openTitles(c)).toEqual(['Check the index']))
    expect(c.getByText('Overdue by 3 days')).toBeTruthy()
    expect((form.getByLabelText('What needs doing') as HTMLInputElement).value).toBe('')
    expect((form.getByLabelText('Deadline (optional)') as HTMLInputElement).value).toBe('')
    expect(await cases.listCaseTasks(demoCaseIds.secondBranch)).toMatchObject([{ title: 'Check the index', dueDate: dateIn(-3), status: 'pending' }])
  })

  it('adds a step without a deadline', async () => {
    openAt(`#/cases/${demoCaseIds.secondBranch}`, setup().runtime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('What needs doing'), { target: { value: 'No date' } })
    fireEvent.click(form.getByRole('button', { name: 'Add next step' }))
    const c = await card()
    await waitFor(() => expect(c.getByText('No deadline')).toBeTruthy())
  })

  it('validates inline, keeps what was typed and writes nothing', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const form = await addForm()
    fireEvent.click(form.getByRole('button', { name: 'Add next step' }))
    expect(await form.findByText('Write what needs doing before adding it.')).toBeTruthy()
    expect(form.getByLabelText('What needs doing').getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(form.getByLabelText('What needs doing'), { target: { value: 'x'.repeat(161) } })
    fireEvent.change(form.getByLabelText('Details (optional)'), { target: { value: 'Keep my details' } })
    fireEvent.click(form.getByRole('button', { name: 'Add next step' }))
    expect(await form.findByText('Keep the title under 160 characters.')).toBeTruthy()
    expect((form.getByLabelText('Details (optional)') as HTMLTextAreaElement).value).toBe('Keep my details')
    expect(await cases.listCaseTasks(demoCaseIds.secondBranch)).toEqual([])
  })

  it('shows the host’s issues when it rejects a draft the browser accepted, and keeps the input', async () => {
    const { runtime, cases } = setup()
    const rejecting: CaseApi = {
      ...cases,
      createCaseTask: async () => ({ ok: false, reason: 'invalid', issues: [{ field: 'dueDate', code: 'invalid-date' }] })
    }
    openAt(`#/cases/${demoCaseIds.secondBranch}`, { ...runtime, cases: rejecting } as AppRuntime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('What needs doing'), { target: { value: 'Keep me' } })
    fireEvent.click(form.getByRole('button', { name: 'Add next step' }))
    expect(await form.findByText(/That date doesn’t exist/)).toBeTruthy()
    expect((form.getByLabelText('What needs doing') as HTMLInputElement).value).toBe('Keep me')
  })

  it('keeps the input and offers a retry when saving fails, then succeeds', async () => {
    const { runtime, cases } = setup()
    let fail = true
    const flaky: CaseApi = {
      ...cases,
      createCaseTask: (id, i) => (fail ? Promise.reject(new Error('down')) : cases.createCaseTask(id, i))
    }
    openAt(`#/cases/${demoCaseIds.secondBranch}`, { ...runtime, cases: flaky } as AppRuntime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('What needs doing'), { target: { value: 'Keep me' } })
    fireEvent.click(form.getByRole('button', { name: 'Add next step' }))
    expect(await form.findByText(/Your text is still here; please try again/)).toBeTruthy()
    expect((form.getByLabelText('What needs doing') as HTMLInputElement).value).toBe('Keep me')
    fail = false
    fireEvent.click(form.getByRole('button', { name: 'Try again' }))
    const c = await card()
    await waitFor(() => expect(openTitles(c)).toEqual(['Keep me']))
  })

  it('disables the button while saving, so a double click adds one step', async () => {
    const { runtime, cases } = setup()
    const create = vi.fn(cases.createCaseTask)
    openAt(`#/cases/${demoCaseIds.secondBranch}`, { ...runtime, cases: { ...cases, createCaseTask: create } } as AppRuntime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('What needs doing'), { target: { value: 'Once only' } })
    const button = form.getByRole('button', { name: 'Add next step' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const c = await card()
    await waitFor(() => expect(openTitles(c)).toEqual(['Once only']))
  })

  it('explains when the case was archived meanwhile and keeps the input', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('What needs doing'), { target: { value: 'Keep me' } })
    await cases.archiveCase(demoCaseIds.secondBranch)
    fireEvent.click(form.getByRole('button', { name: 'Add next step' }))
    expect(await form.findByText(/archived, so the tasks can’t be changed/)).toBeTruthy()
    expect((form.getByLabelText('What needs doing') as HTMLInputElement).value).toBe('Keep me')
  })
})

describe('completing, reopening and editing', () => {
  it('marks a step done, moves it to Completed, and reopens it', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Open next steps' })
    fireEvent.click(c.getByRole('button', { name: 'Mark done: Request 1931 civil marriage register extract' }))
    await waitFor(() => expect(c.getByText('Completed (1)')).toBeTruthy())
    expect(openTitles(c)).toEqual(['Try the spelling variants in the online index'])
    expect((await cases.listCaseTasks(demoCaseIds.maternal)).filter((t) => t.status === 'completed')).toHaveLength(1)

    fireEvent.click(c.getByText('Completed (1)'))
    fireEvent.click(c.getByRole('button', { name: 'Reopen: Request 1931 civil marriage register extract' }))
    await waitFor(() => expect(c.queryByText(/Completed \(/)).toBeNull())
    expect(openTitles(c)).toEqual(['Request 1931 civil marriage register extract', 'Try the spelling variants in the online index'])
    expect(c.getByText('Overdue by 4 days')).toBeTruthy()
  })

  it('does not send a second request while one is in flight', async () => {
    const { runtime, cases } = setup()
    const complete = vi.fn(cases.completeCaseTask)
    openAt(`#/cases/${demoCaseIds.maternal}`, { ...runtime, cases: { ...cases, completeCaseTask: complete } } as AppRuntime)
    const c = await card()
    await c.findByRole('list', { name: 'Open next steps' })
    const button = c.getByRole('button', { name: 'Mark done: Request 1931 civil marriage register extract' })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(c.getByText('Completed (1)')).toBeTruthy())
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('says so and refreshes when a step was already changed elsewhere', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Open next steps' })
    const [target] = await cases.listCaseTasks(demoCaseIds.maternal)
    await cases.completeCaseTask(demoCaseIds.maternal, target!.id)
    fireEvent.click(c.getByRole('button', { name: `Mark done: ${target!.title}` }))
    await waitFor(() => expect(c.getByText('Completed (1)')).toBeTruthy())
    expect(openTitles(c)).not.toContain(target!.title)
  })

  it('keeps a step and shows an error when completing fails', async () => {
    const { runtime, cases } = setup()
    const flaky: CaseApi = { ...cases, completeCaseTask: () => Promise.reject(new Error('down')) }
    openAt(`#/cases/${demoCaseIds.maternal}`, { ...runtime, cases: flaky } as AppRuntime)
    const c = await card()
    await c.findByRole('list', { name: 'Open next steps' })
    fireEvent.click(c.getByRole('button', { name: /^Mark done: Request 1931/ }))
    expect(await c.findByText(/Couldn’t update this task/)).toBeTruthy()
    expect(openTitles(c)).toHaveLength(2)
  })

  it('edits a step in place, re-sorting by the new deadline', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Open next steps' })
    fireEvent.click(c.getByRole('button', { name: 'Edit task: Request 1931 civil marriage register extract' }))
    const form = c.getByRole('form', { name: 'Edit task' })
    // Only one step is edited at a time.
    expect(c.queryAllByRole('button', { name: /^Edit task:/ })).toHaveLength(0)
    expect((within(form).getByLabelText('Deadline (optional)') as HTMLInputElement).value).toBe(dateIn(-4))
    fireEvent.change(within(form).getByLabelText('Task'), { target: { value: 'Request the 1931 extract (renamed)' } })
    fireEvent.change(within(form).getByLabelText('Deadline (optional)'), { target: { value: dateIn(30) } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(c.queryByRole('form', { name: 'Edit task' })).toBeNull())
    expect(openTitles(c)).toEqual(['Try the spelling variants in the online index', 'Request the 1931 extract (renamed)'])
    expect((await cases.listCaseTasks(demoCaseIds.maternal)).map((t) => t.title)).toContain('Request the 1931 extract (renamed)')
  })

  it('validates inline during an edit, keeps the typed text on failure, then retries', async () => {
    const { runtime, cases } = setup()
    let fail = true
    const flaky: CaseApi = {
      ...cases,
      updateCaseTask: (id, taskId, i) => (fail ? Promise.reject(new Error('down')) : cases.updateCaseTask(id, taskId, i))
    }
    openAt(`#/cases/${demoCaseIds.maternal}`, { ...runtime, cases: flaky } as AppRuntime)
    const c = await card()
    await c.findByRole('list', { name: 'Open next steps' })
    fireEvent.click(c.getByRole('button', { name: /^Edit task: Request 1931/ }))
    const form = within(c.getByRole('form', { name: 'Edit task' }))
    fireEvent.change(form.getByLabelText('Task'), { target: { value: '  ' } })
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }))
    expect(await form.findByText('Write what needs doing before adding it.')).toBeTruthy()
    fireEvent.change(form.getByLabelText('Task'), { target: { value: 'Revised' } })
    fireEvent.click(form.getByRole('button', { name: 'Save changes' }))
    expect(await form.findByText(/Your text is still here; please try again/)).toBeTruthy()
    expect((form.getByLabelText('Task') as HTMLInputElement).value).toBe('Revised')
    fail = false
    fireEvent.click(form.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(openTitles(c)).toContain('Revised'))
  })

  it('asks before discarding unsaved changes, and cancels without asking when nothing changed', async () => {
    openAt(`#/cases/${demoCaseIds.maternal}`, setup().runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Open next steps' })
    fireEvent.click(c.getByRole('button', { name: /^Edit task: Request 1931/ }))
    fireEvent.click(c.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(c.queryByRole('form', { name: 'Edit task' })).toBeNull()

    fireEvent.click(c.getByRole('button', { name: /^Edit task: Request 1931/ }))
    fireEvent.change(c.getByLabelText('Task'), { target: { value: 'changed' } })
    fireEvent.click(c.getByRole('button', { name: 'Cancel' }))
    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('Discard your changes?')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }))
    expect(c.queryByRole('form', { name: 'Edit task' })).toBeNull()
    expect(openTitles(c)[0]).toBe('Request 1931 civil marriage register extract')
  })
})

describe('read-only next steps', () => {
  it('keeps steps visible but offers no add, edit, done or reopen when the case is archived', async () => {
    const { runtime, cases } = setup()
    await cases.archiveCase(demoCaseIds.paternal)
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const c = await card()
    expect(await c.findByText('Draft the interim findings summary')).toBeTruthy()
    expect(c.getByText(/This case is archived, so its next steps can’t be changed/)).toBeTruthy()
    expect(c.queryByRole('form')).toBeNull()
    expect(c.queryByRole('button', { name: /Add next step|Edit task|Mark done|Reopen/ })).toBeNull()
    fireEvent.click(c.getByText('Completed (1)'))
    expect(c.queryByRole('button', { name: /Reopen/ })).toBeNull()
  })

  it('keeps steps visible but offers no changes when the client is archived', async () => {
    const { runtime, data } = setup()
    await data.archiveClient(demoClientIds.lucia)
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const c = await card()
    expect(await c.findByText('Draft the interim findings summary')).toBeTruthy()
    expect(c.getByText(/This client is archived, so the next steps can’t be changed/)).toBeTruthy()
    expect(c.queryByRole('form')).toBeNull()
    expect(c.queryByRole('button', { name: /Add next step|Edit task|Mark done|Reopen/ })).toBeNull()
  })

  it('is writable again after unarchiving', async () => {
    const { runtime, cases } = setup()
    await cases.archiveCase(demoCaseIds.secondBranch)
    await cases.unarchiveCase(demoCaseIds.secondBranch)
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    expect(await addForm()).toBeTruthy()
  })
})

describe('demo task adapter', () => {
  it('follows the repository’s rules and check order', async () => {
    const { data, cases } = setup()
    const [first] = await cases.listCaseTasks(demoCaseIds.paternal)
    const bad = { title: '', description: null, dueDate: 'nope' }
    expect(await cases.listCaseTasks(UNKNOWN_ID)).toEqual([])
    expect(await cases.createCaseTask(UNKNOWN_ID, input)).toEqual({ ok: false, reason: 'not-found' })
    expect(await cases.completeCaseTask(UNKNOWN_ID, first!.id)).toEqual({ ok: false, reason: 'not-found' })
    // The task must belong to the case in the call.
    for (const act of [
      () => cases.updateCaseTask(demoCaseIds.maternal, first!.id, bad),
      () => cases.completeCaseTask(demoCaseIds.maternal, first!.id),
      () => cases.reopenCaseTask(demoCaseIds.maternal, first!.id)
    ])
      expect(await act()).toEqual({ ok: false, reason: 'not-found' })
    expect((await cases.listCaseTasks(demoCaseIds.paternal))[0]).toEqual(first)
    // Archived is reported before a missing task and invalid input.
    expect(await cases.createCaseTask(demoCaseIds.reunion, bad)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.updateCaseTask(demoCaseIds.reunion, UNKNOWN_ID, bad)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.createCaseTask(demoCaseIds.secondBranch, bad)).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [
        { field: 'title', code: 'required' },
        { field: 'dueDate', code: 'invalid-format' }
      ]
    })

    // Duplicate complete/reopen is wrong-status and changes nothing.
    expect(await cases.reopenCaseTask(demoCaseIds.paternal, first!.id)).toEqual({ ok: false, reason: 'wrong-status' })
    const done = await cases.completeCaseTask(demoCaseIds.paternal, first!.id)
    expect(done).toMatchObject({ ok: true, task: { status: 'completed' } })
    const after = (await cases.getCase(demoCaseIds.paternal))!
    expect(await cases.completeCaseTask(demoCaseIds.paternal, first!.id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.getCase(demoCaseIds.paternal)).toEqual(after)

    const before = (await cases.getCase(demoCaseIds.secondBranch))!
    const created = await cases.createCaseTask(demoCaseIds.secondBranch, { title: ' a  b ', description: ' ', dueDate: null })
    expect(created).toMatchObject({ ok: true, task: { title: 'a b', description: null, status: 'pending', completedAt: null, caseId: demoCaseIds.secondBranch } })
    expect((await cases.getCase(demoCaseIds.secondBranch))!.updatedAt > before.updatedAt).toBe(true)
    expect(await cases.listCaseEvents(demoCaseIds.secondBranch)).toHaveLength(3)

    await data.archiveClient(demoClientIds.ethan)
    expect(await cases.createCaseTask(demoCaseIds.secondBranch, input)).toEqual({ ok: false, reason: 'wrong-status' })
  })

  it('seeds steps with an overdue, a due-today, a soon, a later, an undated and a completed one', async () => {
    const { cases } = setup()
    const today = localDateString(new Date())
    const paternal = await cases.listCaseTasks(demoCaseIds.paternal)
    expect(paternal).toHaveLength(6)
    expect(paternal.map((t) => t.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending', 'completed'])
    expect(paternal.slice(0, 5).map((t) => t.dueDate)).toEqual([dateIn(-2), today, dateIn(2), dateIn(14), null])
    expect(await cases.listCaseTasks(demoCaseIds.maternal)).toHaveLength(2)
    for (const id of [demoCaseIds.baptism, demoCaseIds.surname, demoCaseIds.secondBranch, demoCaseIds.reunion, demoCaseIds.spelling]) {
      expect(await cases.listCaseTasks(id)).toEqual([])
    }
  })

  it('returns copies and starts from the seeded steps again on every load', async () => {
    const initial = buildDemoCases()
    const data = createDemoApi(buildDemoData(), appInfo)
    const first = createDemoCases(initial, data.getClient, defaultClock)
    const list = await first.listCaseTasks(demoCaseIds.paternal)
    list[0]!.title = 'Changed in place'
    expect((await first.listCaseTasks(demoCaseIds.paternal))[0]!.title).toContain('Ask the client')

    await first.createCaseTask(demoCaseIds.paternal, input)
    expect(await first.listCaseTasks(demoCaseIds.paternal)).toHaveLength(7)
    const reload = createDemoCases(initial, data.getClient, defaultClock)
    expect(await reload.listCaseTasks(demoCaseIds.paternal)).toHaveLength(6)
  })
})
