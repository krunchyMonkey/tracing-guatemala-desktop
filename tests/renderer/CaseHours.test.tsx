// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime, CaseApi } from '../../src/renderer/src/runtime/AppRuntime'
import { localDateString } from '../../src/shared/case-model'
import { formatMinutes, summarizeEntries } from '../../src/shared/case-time'

// Research hours (#109): the Research hours card on the case page and the timer
// pill, against the demo's in-memory adapters, which follow the same shared rules
// and the same timer state machine as the host. Fictional data only.

const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }
const PATERNAL = 'Paternal line — Quetzaltenango, 1880s'
const MATERNAL = 'Maternal grandparents — Totonicapán'
const MIN = 60 * 1000

/** A clock the test moves by hand; the timer's server side reads it. */
function handClock() {
  let at = Date.now()
  return { ...defaultClock, now: () => new Date(at), advance: (ms: number) => (at += ms) }
}

function setup() {
  const clock = handClock()
  const data = createDemoApi(buildDemoData(), appInfo)
  const cases = createDemoCases(buildDemoCases(), data.getClient, clock)
  const runtime: AppRuntime = {
    mode: 'live',
    switcher: { kind: 'unavailable', reason: 'not-available' },
    data,
    backup: { createBackup: vi.fn(), chooseBackupToRestore: vi.fn(), restoreBackup: vi.fn() } as never,
    cases
  }
  return { clock, data, cases, runtime }
}

function openAt(hash: string, runtime: AppRuntime) {
  window.location.hash = hash
  return render(<App runtime={runtime} />)
}

const card = async () => within(await screen.findByRole('region', { name: 'Research hours' }))
const pill = () => within(screen.getByRole('region', { name: 'Research timer' }))
const addForm = async () => within((await card()).getByRole('form', { name: 'Add hours by hand' }))
const rows = (c: ReturnType<typeof within>) => within(c.getByRole('list', { name: 'Hours entries' })).getAllByRole('listitem')
const dateIn = (days: number) => {
  const d = new Date()
  return localDateString(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days))
}
const totals = (c: ReturnType<typeof within>) => ({
  total: c.getByText('Total hours').nextElementSibling?.textContent,
  week: c.getByText('This week').nextElementSibling?.textContent,
  month: c.getByText('This month').nextElementSibling?.textContent
})

/** Makes the page ask the host again, as it does when the tab comes back. */
const resync = () => act(async () => void window.dispatchEvent(new Event('focus')))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
beforeEach(() => {
  window.location.hash = ''
})

describe('hours on the case page', () => {
  it('sits right after Next steps and says nothing is billed', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    const c = await card()
    expect(c.getByText(/Nothing here is billed or sent to anyone/)).toBeTruthy()
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent)
    expect(headings.indexOf('Next steps')).toBeLessThan(headings.indexOf('Research hours'))
    expect(headings.indexOf('Research hours')).toBeLessThan(headings.indexOf('Research brief'))
  })

  it('shows total, this-week and this-month hours for this case only, with entries newest first', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Hours entries' })
    const own = await cases.listTimeEntries(demoCaseIds.paternal)
    const expected = summarizeEntries(own, localDateString(new Date()))
    expect(totals(c)).toEqual({
      total: '7:30',
      week: formatMinutes(expected.weekMinutes),
      month: formatMinutes(expected.monthMinutes)
    })
    expect(rows(c).map((r) => r.querySelector('.hours-duration')?.textContent)).toEqual(['1:30', '2:00', '0:45', '3:15'])
    expect(rows(c)[0]!.textContent).toContain('Research')
    expect(within(rows(c)[0]!).getByText(/diocesan baptism index/)).toBeTruthy()
    expect(rows(c)[0]!.querySelector('time')?.getAttribute('datetime')).toBe(dateIn(-1))
    expect(c.getAllByText('Added by hand').length + c.getAllByText('From the timer').length).toBe(4)

    cleanup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime)
    const other = await card()
    await other.findByRole('list', { name: 'Hours entries' })
    expect(totals(other).total).toBe('1:50')
    expect(rows(other)).toHaveLength(2)
    expect(other.queryByText(/diocesan baptism index/)).toBeNull()
  })

  it('shows an empty state with zero totals', async () => {
    openAt(`#/cases/${demoCaseIds.secondBranch}`, setup().runtime)
    const c = await card()
    expect(await c.findByText('No hours recorded yet.')).toBeTruthy()
    expect(totals(c)).toEqual({ total: '0:00', week: '0:00', month: '0:00' })
  })

  it('shows saved notes as plain text, never as markup', async () => {
    const { runtime, cases } = setup()
    await cases.createTimeEntry(demoCaseIds.secondBranch, {
      workDate: dateIn(0),
      durationMinutes: 10,
      activityType: null,
      note: '<script>window.__pwned = 1</script> “Ángel” & co'
    })
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const c = await card()
    expect(await c.findByText('<script>window.__pwned = 1</script> “Ángel” & co')).toBeTruthy()
    expect(document.querySelector('.hours script')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('offers a retry when the hours can’t be loaded', async () => {
    const { runtime, cases } = setup()
    let fail = true
    const flaky: CaseApi = { ...cases, listTimeEntries: (id) => (fail ? Promise.reject(new Error('down')) : cases.listTimeEntries(id)) }
    openAt(`#/cases/${demoCaseIds.paternal}`, { ...runtime, cases: flaky } as AppRuntime)
    expect(await screen.findByText('The hours couldn’t be loaded')).toBeTruthy()
    fail = false
    fireEvent.click((await card()).getByRole('button', { name: 'Try again' }))
    expect(await (await card()).findByRole('list', { name: 'Hours entries' })).toBeTruthy()
  })

  it('is read-only on an archived case: entries stay visible, nothing can be changed or started', async () => {
    const { runtime, cases } = setup()
    await cases.archiveCase(demoCaseIds.paternal)
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Hours entries' })
    expect(c.getByText(/archived, so its hours can’t be changed/)).toBeTruthy()
    expect(c.queryByRole('form', { name: 'Add hours by hand' })).toBeNull()
    expect(c.queryByRole('button', { name: 'Start timer' })).toBeNull()
    expect(c.queryAllByRole('button', { name: /^(Edit|Delete) entry/ })).toHaveLength(0)
    expect(rows(c)).toHaveLength(4)
  })
})

describe('adding, editing and deleting entries', () => {
  it('has labelled fields with a native date input defaulting to today', async () => {
    openAt(`#/cases/${demoCaseIds.secondBranch}`, setup().runtime)
    const form = await addForm()
    const date = form.getByLabelText('Date') as HTMLInputElement
    expect(date.type).toBe('date')
    expect(date.value).toBe(dateIn(0))
    expect((form.getByLabelText('Hours') as HTMLInputElement).type).toBe('number')
    expect((form.getByLabelText('Minutes') as HTMLInputElement).type).toBe('number')
    const options = within(form.getByLabelText('Activity (optional)')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Not specified', 'Research', 'Correspondence', 'Analysis', 'Writing', 'Other'])
  })

  it('adds an entry, clears the form and updates the totals', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('Date'), { target: { value: dateIn(0) } })
    fireEvent.change(form.getByLabelText('Hours'), { target: { value: '1' } })
    fireEvent.change(form.getByLabelText('Minutes'), { target: { value: '25' } })
    fireEvent.change(form.getByLabelText('Activity (optional)'), { target: { value: 'writing' } })
    fireEvent.change(form.getByLabelText('Note (optional)'), { target: { value: '  Drafted the summary  ' } })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))

    const c = await card()
    await waitFor(() => expect(rows(c)).toHaveLength(1))
    expect(totals(c)).toEqual({ total: '1:25', week: '1:25', month: '1:25' })
    expect(rows(c)[0]!.textContent).toContain('Writing')
    expect(rows(c)[0]!.textContent).toContain('Drafted the summary')
    expect((form.getByLabelText('Hours') as HTMLInputElement).value).toBe('')
    expect((form.getByLabelText('Minutes') as HTMLInputElement).value).toBe('')
    expect(await cases.listTimeEntries(demoCaseIds.secondBranch)).toMatchObject([{ durationMinutes: 85, activityType: 'writing', source: 'manual', note: 'Drafted the summary' }])
  })

  it('rejects zero, negative, fractional, oversized and empty durations inline and writes nothing', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const form = await addForm()
    const submit = (hours: string, minutes: string) => {
      fireEvent.change(form.getByLabelText('Hours'), { target: { value: hours } })
      fireEvent.change(form.getByLabelText('Minutes'), { target: { value: minutes } })
      fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    }
    submit('', '')
    expect(await form.findByText('Enter at least 1 minute.')).toBeTruthy()
    submit('0', '0')
    expect(await form.findByText('Enter at least 1 minute.')).toBeTruthy()
    submit('-1', '0')
    expect(await form.findByText('Enter at least 1 minute.')).toBeTruthy()
    submit('1.5', '')
    expect(await form.findByText('Use whole numbers for hours and minutes.')).toBeTruthy()
    submit('0', '75')
    expect(await form.findByText('Use whole numbers for hours and minutes.')).toBeTruthy()
    submit('12', '1')
    expect(await form.findByText(/Enter at most 12 hours per entry/)).toBeTruthy()
    expect(form.getByLabelText('Hours').getAttribute('aria-invalid')).toBe('true')
    expect(await cases.listTimeEntries(demoCaseIds.secondBranch)).toEqual([])

    submit('12', '0')
    await waitFor(async () => expect(await cases.listTimeEntries(demoCaseIds.secondBranch)).toHaveLength(1))
  })

  it('validates the date and the note, keeping what was typed', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.secondBranch}`, runtime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('Date'), { target: { value: '' } })
    fireEvent.change(form.getByLabelText('Hours'), { target: { value: '1' } })
    fireEvent.change(form.getByLabelText('Note (optional)'), { target: { value: 'Keep my note' } })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    expect(await form.findByText('Choose the date you worked.')).toBeTruthy()
    expect((form.getByLabelText('Note (optional)') as HTMLTextAreaElement).value).toBe('Keep my note')
    fireEvent.change(form.getByLabelText('Date'), { target: { value: dateIn(0) } })
    fireEvent.change(form.getByLabelText('Note (optional)'), { target: { value: 'x'.repeat(501) } })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    expect(await form.findByText('Keep the note under 500 characters.')).toBeTruthy()
    expect(await cases.listTimeEntries(demoCaseIds.secondBranch)).toEqual([])
  })

  it('keeps the input and offers a retry when saving fails, then adds exactly one entry', async () => {
    const { runtime, cases } = setup()
    let fail = true
    const create = vi.fn((id: string, input: Parameters<CaseApi['createTimeEntry']>[1]) => (fail ? Promise.reject(new Error('down')) : cases.createTimeEntry(id, input)))
    openAt(`#/cases/${demoCaseIds.secondBranch}`, { ...runtime, cases: { ...cases, createTimeEntry: create } } as AppRuntime)
    const form = await addForm()
    fireEvent.change(form.getByLabelText('Minutes'), { target: { value: '20' } })
    fireEvent.click(form.getByRole('button', { name: 'Add entry' }))
    expect(await form.findByText(/What you typed is still here/)).toBeTruthy()
    expect((form.getByLabelText('Minutes') as HTMLInputElement).value).toBe('20')
    fail = false
    const button = form.getByRole('button', { name: 'Try again' })
    fireEvent.click(button)
    fireEvent.click(button)
    const c = await card()
    await waitFor(() => expect(rows(c)).toHaveLength(1))
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('edits an entry in place and asks before discarding unsaved edits', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Hours entries' })
    const target = rows(c)[0]!
    fireEvent.click(within(target).getByRole('button', { name: /^Edit entry: 0:50 on/ }))
    const form = c.getByRole('form', { name: 'Edit hours entry' })
    expect(c.queryAllByRole('button', { name: /^Edit entry:/ })).toHaveLength(0)
    expect((within(form).getByLabelText('Minutes') as HTMLInputElement).value).toBe('50')

    fireEvent.change(within(form).getByLabelText('Minutes'), { target: { value: '5' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(c.getByRole('form', { name: 'Edit hours entry' })).toBeTruthy()

    fireEvent.change(within(form).getByLabelText('Hours'), { target: { value: '2' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(c.queryByRole('form', { name: 'Edit hours entry' })).toBeNull())
    expect(totals(c).total).toBe('3:05')
    expect((await cases.listTimeEntries(demoCaseIds.maternal)).map((e) => e.durationMinutes).sort((a, b) => a - b)).toEqual([60, 125])
  })

  it('confirms before deleting, and cancelling keeps the entry', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.maternal}`, runtime)
    const c = await card()
    await c.findByRole('list', { name: 'Hours entries' })
    fireEvent.click(within(rows(c)[0]!).getByRole('button', { name: /^Delete entry: 0:50 on/ }))
    let dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Delete this entry?')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(await cases.listTimeEntries(demoCaseIds.maternal)).toHaveLength(2)

    fireEvent.click(within(rows(c)[0]!).getByRole('button', { name: /^Delete entry: 0:50 on/ }))
    dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete entry' }))
    await waitFor(() => expect(rows(c)).toHaveLength(1))
    expect(totals(c).total).toBe('1:00')
    expect(await cases.listTimeEntries(demoCaseIds.maternal)).toHaveLength(1)
  })
})

describe('the timer', () => {
  it('shows no timer pill until one exists, and no Start button for a case that already has the timer', async () => {
    const { runtime } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const c = await card()
    expect(screen.queryByRole('region', { name: 'Research timer' })).toBeNull()
    fireEvent.click(await c.findByRole('button', { name: 'Start timer' }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Research timer' })).toBeTruthy())
    expect(c.queryByRole('button', { name: 'Start timer' })).toBeNull()
    expect(c.getByText(/Timer running on this case/)).toBeTruthy()
  })

  it('runs start, pause, resume and stop-and-save, and saves exactly one rounded entry', async () => {
    const { runtime, cases, clock } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const c = await card()
    fireEvent.click(await c.findByRole('button', { name: 'Start timer' }))

    await waitFor(() => expect(pill().getByText(PATERNAL)).toBeTruthy())
    expect(pill().getByRole('link', { name: /Go to the case being timed/ }).getAttribute('href')).toBe(`#/cases/${demoCaseIds.paternal}`)
    expect(pill().getByRole('timer').textContent).toBe('0:00:00')
    expect(pill().getByText('Running')).toBeTruthy()
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Timer started on')

    clock.advance(100 * 1000)
    fireEvent.click(pill().getByRole('button', { name: `Pause timer on ${PATERNAL}` }))
    await waitFor(() => expect(pill().getByText('Paused')).toBeTruthy())
    expect(pill().getByRole('timer').textContent).toBe('0:01:40')
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Timer paused.')

    clock.advance(60 * MIN) // paused time counts for nothing
    fireEvent.click(pill().getByRole('button', { name: `Resume timer on ${PATERNAL}` }))
    await waitFor(() => expect(pill().getByText('Running')).toBeTruthy())
    expect(pill().getByRole('timer').textContent).toBe('0:01:40')
    clock.advance(80 * 1000)
    await resync()
    expect(pill().getByRole('timer').textContent).toBe('0:03:00')

    fireEvent.click(pill().getByRole('button', { name: `Stop and save timer on ${PATERNAL}` }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Save this time?')).toBeTruthy()
    expect((within(dialog).getByLabelText('Minutes to save') as HTMLInputElement).value).toBe('3')
    fireEvent.change(within(dialog).getByLabelText('Activity (optional)'), { target: { value: 'analysis' } })
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: 'Compared registers' } })
    const save = within(dialog).getByRole('button', { name: 'Save time' })
    fireEvent.click(save)
    fireEvent.click(save)

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Research timer' })).toBeNull())
    await waitFor(() => expect(rows(c)).toHaveLength(5))
    expect(totals(c).total).toBe('7:33')
    expect(rows(c).filter((r) => r.textContent?.includes('From the timer') && r.textContent.includes('Compared registers'))).toHaveLength(1)
    const saved = (await cases.listTimeEntries(demoCaseIds.paternal)).filter((e) => e.note === 'Compared registers')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ durationMinutes: 3, activityType: 'analysis', source: 'timer' })
    expect(await cases.getActiveTimer()).toBeNull()
    expect(c.getByRole('button', { name: 'Start timer' })).toBeTruthy()
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toMatch(/^Saved 0:03 hours to /)
  })

  it('keeps the timer visible on every screen and links back to its case', async () => {
    const { runtime } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await (await card()).findByRole('button', { name: 'Start timer' }))
    await waitFor(() => expect(pill().getByText(PATERNAL)).toBeTruthy())
    for (const hash of ['#/', '#/clients', '#/settings', `#/cases/${demoCaseIds.maternal}`]) {
      act(() => {
        window.location.hash = hash
      })
      await waitFor(() => expect(pill().getByText(PATERNAL)).toBeTruthy())
    }
    // On the other case the card offers a switch, not a second timer.
    expect(await (await card()).findByRole('button', { name: 'Start timer' })).toBeTruthy()
  })

  it('does not save a session under 30 seconds; it can be discarded after a confirmation', async () => {
    const { runtime, cases, clock } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await (await card()).findByRole('button', { name: 'Start timer' }))
    await waitFor(() => expect(pill().getByText('Running')).toBeTruthy())
    clock.advance(20 * 1000)
    await resync()

    fireEvent.click(pill().getByRole('button', { name: `Stop and save timer on ${PATERNAL}` }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Only 20 seconds were counted/)).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: 'Save time' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard this timer instead' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard this timer?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(await cases.getActiveTimer()).not.toBeNull()

    fireEvent.click(pill().getByRole('button', { name: `Stop and save timer on ${PATERNAL}` }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard this timer instead' }))
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Discard this timer?' })).getByRole('button', { name: 'Discard timer' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Research timer' })).toBeNull())
    expect(await cases.getActiveTimer()).toBeNull()
    expect(await cases.listTimeEntries(demoCaseIds.paternal)).toHaveLength(4)
  })

  it('asks before switching cases, then stops and saves the first and starts the second', async () => {
    const { runtime, cases, clock } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await (await card()).findByRole('button', { name: 'Start timer' }))
    await waitFor(() => expect(pill().getByText(PATERNAL)).toBeTruthy())
    clock.advance(2 * MIN)
    await resync()

    act(() => {
      window.location.hash = `#/cases/${demoCaseIds.maternal}`
    })
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: MATERNAL })).toBeTruthy())
    const c = await card()
    fireEvent.click(await c.findByRole('button', { name: 'Start timer' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain(`Stop and save the timer on ${PATERNAL}, then start here (${MATERNAL})?`)
    // Nothing changed yet.
    expect(await cases.getActiveTimer()).toMatchObject({ caseId: demoCaseIds.paternal })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(await cases.getActiveTimer()).toMatchObject({ caseId: demoCaseIds.paternal })

    fireEvent.click(c.getByRole('button', { name: 'Start timer' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop, save and start here' }))
    await waitFor(() => expect(pill().getByText(MATERNAL)).toBeTruthy())
    expect(await cases.getActiveTimer()).toMatchObject({ caseId: demoCaseIds.maternal, version: 1 })
    const savedOnFirst = (await cases.listTimeEntries(demoCaseIds.paternal)).filter((e) => e.source === 'timer' && e.durationMinutes === 2)
    expect(savedOnFirst.length).toBe(1)
    expect(await cases.listTimeEntries(demoCaseIds.maternal)).toHaveLength(2)
  })

  it('offers to discard instead when the other timer is too short to save', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await (await card()).findByRole('button', { name: 'Start timer' }))
    await waitFor(() => expect(pill().getByText(PATERNAL)).toBeTruthy())
    act(() => {
      window.location.hash = `#/cases/${demoCaseIds.maternal}`
    })
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: MATERNAL })).toBeTruthy())
    fireEvent.click(await (await card()).findByRole('button', { name: 'Start timer' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop, save and start here' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'The other timer can’t be saved' })
    expect(dialog.textContent).toContain('under 30 seconds')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard it and start here' }))
    await waitFor(() => expect(pill().getByText(MATERNAL)).toBeTruthy())
    expect(await cases.listTimeEntries(demoCaseIds.paternal)).toHaveLength(4)
  })

  it('asks for a review, never saving the unobserved gap, when the timer was left running', async () => {
    const { runtime, cases, clock } = setup()
    await cases.startTimer(demoCaseIds.paternal)
    clock.advance(2 * MIN)
    await cases.heartbeatTimer(1)
    clock.advance(9 * 60 * MIN) // nine hours with nobody watching

    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const dialog = await screen.findByRole('alertdialog', { name: 'Review the time before saving' })
    expect(dialog.textContent).toContain('0:02:00')
    expect(dialog.textContent).toContain('Nothing has been saved')
    expect((within(dialog).getByLabelText('Minutes to save') as HTMLInputElement).value).toBe('2')
    // No pause, resume or plain stop while it needs review.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(pill().getByText('Needs review')).toBeTruthy()
    expect(pill().queryByRole('button', { name: /^Pause/ })).toBeNull()
    expect(pill().queryByRole('button', { name: /^Stop and save/ })).toBeNull()
    expect(await cases.listTimeEntries(demoCaseIds.paternal)).toHaveLength(4)

    fireEvent.click(pill().getByRole('button', { name: 'Review time' }))
    const again = await screen.findByRole('alertdialog')
    fireEvent.change(within(again).getByLabelText('Minutes to save'), { target: { value: '45' } })
    fireEvent.click(within(again).getByRole('button', { name: 'Save time' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Research timer' })).toBeNull())
    const saved = (await cases.listTimeEntries(demoCaseIds.paternal)).filter((e) => e.source === 'timer' && e.durationMinutes === 45)
    expect(saved).toHaveLength(1)
  })

  it('lets a reviewed timer be discarded and validates the reviewed minutes', async () => {
    const { runtime, cases, clock } = setup()
    await cases.startTimer(demoCaseIds.paternal)
    clock.advance(2 * MIN)
    await cases.heartbeatTimer(1)
    clock.advance(60 * MIN)
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const dialog = await screen.findByRole('alertdialog', { name: 'Review the time before saving' })
    const minutes = within(dialog).getByLabelText('Minutes to save')
    for (const [value, message] of [
      ['0', 'Enter at least 1 minute.'],
      ['-5', 'Enter whole minutes.'],
      ['2.5', 'Enter whole minutes.'],
      ['721', 'Enter at most 720 minutes (12 hours).']
    ] as const) {
      fireEvent.change(minutes, { target: { value } })
      expect(within(dialog).getByText(message)).toBeTruthy()
      expect((within(dialog).getByRole('button', { name: 'Save time' }) as HTMLButtonElement).disabled).toBe(true)
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard this timer instead' }))
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Discard this timer?' })).getByRole('button', { name: 'Discard timer' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Research timer' })).toBeNull())
    expect(await cases.getActiveTimer()).toBeNull()
    expect(await cases.listTimeEntries(demoCaseIds.paternal)).toHaveLength(4)
  })

  it('refreshes and explains when the timer was changed somewhere else, instead of acting twice', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await (await card()).findByRole('button', { name: 'Start timer' }))
    await waitFor(() => expect(pill().getByText('Running')).toBeTruthy())
    // Another tab pauses it behind this page's back.
    await cases.pauseTimer(1)
    fireEvent.click(pill().getByRole('button', { name: `Pause timer on ${PATERNAL}` }))
    await waitFor(() => expect(pill().getByText(/changed somewhere else/)).toBeTruthy())
    expect(pill().getByText('Paused')).toBeTruthy()
    fireEvent.click(pill().getByRole('button', { name: 'Dismiss' }))
    expect(pill().queryByText(/changed somewhere else/)).toBeNull()
  })

  it('sends a heartbeat every 30 seconds while running, and none while paused', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { runtime, cases } = setup()
    const heartbeat = vi.fn(cases.heartbeatTimer)
    await cases.startTimer(demoCaseIds.paternal)
    openAt(`#/cases/${demoCaseIds.paternal}`, { ...runtime, cases: { ...cases, heartbeatTimer: heartbeat } } as AppRuntime)
    await waitFor(() => expect(pill().getByText('Running')).toBeTruthy())
    await act(async () => undefined) // let the heartbeat interval's effect register before moving the clock
    expect(heartbeat).not.toHaveBeenCalled()
    await act(async () => void vi.advanceTimersByTime(30_000))
    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(heartbeat).toHaveBeenLastCalledWith(1)
    await act(async () => void vi.advanceTimersByTime(60_000))
    expect(heartbeat).toHaveBeenCalledTimes(3)

    fireEvent.click(pill().getByRole('button', { name: `Pause timer on ${PATERNAL}` }))
    await waitFor(() => expect(pill().getByText('Paused')).toBeTruthy())
    await act(async () => void vi.advanceTimersByTime(120_000))
    expect(heartbeat).toHaveBeenCalledTimes(3)
  })

  it('counts the clock with the browser’s monotonic timer between syncs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { runtime, cases } = setup()
    await cases.startTimer(demoCaseIds.paternal)
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    await waitFor(() => expect(pill().getByRole('timer').textContent).toBe('0:00:00'))
    now += 65_000
    await act(async () => void vi.advanceTimersByTime(1000))
    expect(pill().getByRole('timer').textContent).toBe('0:01:05')
    expect(pill().getByRole('timer').getAttribute('aria-live')).toBe('off')
  })

  it('does not start a timer on an archived case', async () => {
    const { runtime, cases } = setup()
    await cases.archiveCase(demoCaseIds.paternal)
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    const c = await card()
    expect(c.queryByRole('button', { name: 'Start timer' })).toBeNull()
    expect(await cases.startTimer(demoCaseIds.paternal)).toEqual({ ok: false, reason: 'wrong-status' })
  })
})

describe('the demo’s timer', () => {
  it('lives in memory only: a fresh demo has no timer and sample hours are the documented set', async () => {
    const first = setup()
    await first.cases.startTimer(demoCaseIds.paternal)
    expect(await first.cases.getActiveTimer()).not.toBeNull()
    const refreshed = setup()
    expect(await refreshed.cases.getActiveTimer()).toBeNull()
    expect(await refreshed.cases.listTimeEntries(demoCaseIds.paternal)).toHaveLength(4)
  })
})
