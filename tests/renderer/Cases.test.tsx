// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds, demoClientIds } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime, CaseApi } from '../../src/renderer/src/runtime/AppRuntime'
import type { CaseInput } from '../../src/shared/case-model'
import { createFakeApi } from './fakeApi'

// Case screens (#16) against the demo's in-memory adapters, which follow the same
// shared rules as the host. Fictional data only.

const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999'

function setup() {
  const data = createDemoApi(buildDemoData(), appInfo)
  const cases = createDemoCases(buildDemoCases(), data.getClient, defaultClock)
  const runtime: AppRuntime = { mode: 'live', data, backup: { createBackup: vi.fn(), chooseBackupToRestore: vi.fn(), restoreBackup: vi.fn() } as never, cases, switcher: { kind: 'unavailable', reason: 'not-available' } }
  return { data, cases, runtime }
}

function openAt(hash: string, runtime: AppRuntime) {
  window.location.hash = hash
  return render(<App runtime={runtime} />)
}

const input: CaseInput = { title: 'New research', goal: null, orderReference: null, dueDate: null }
const stateGroup = () => screen.getByRole('group', { name: 'State' })
const showGroup = () => screen.getByRole('group', { name: 'Show' })
const rows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1)
const rowTitles = () => rows().map((row) => within(row).getAllByRole('link')[0]!.textContent)
/** The result count line, which also carries the clear-filters button once filtered. */
const count = (n: number) => new RegExp(`^${n} cases?( ·|$)`)
const dialog = () => screen.getByRole('alertdialog')

afterEach(cleanup)

describe('navigation and runtimes', () => {
  it('adds a Cases link after Clients where cases exist', async () => {
    openAt('#/', setup().runtime)
    const links = within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual(['Home', 'Clients', 'Cases', 'Settings & Backup'])
  })

  it('leaves the desktop app unchanged: no Cases link, no case routes, the old placeholder', async () => {
    const fake = createFakeApi()
    vi.stubGlobal('tracingGuatemala', fake.api)
    try {
      window.location.hash = '#/cases'
      render(<App />)
      expect(await screen.findByRole('heading', { level: 1, name: /Tracing Guatemala|Welcome|Home/i })).toBeTruthy()
      const links = within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link')
      expect(links.map((l) => l.textContent)).toEqual(['Home', 'Clients', 'Settings & Backup'])
      expect(window.location.hash).toBe('#/')

      cleanup()
      window.location.hash = `#/clients/${(await fake.api.listClients({ text: '', status: 'all', sources: [], sort: 'name' }))[0]!.id}`
      render(<App />)
      expect(await screen.findByRole('heading', { name: /Orders & research cases/ })).toBeTruthy()
      expect(screen.queryByRole('region', { name: 'Research cases' })).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('case list', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  it('shows open, unarchived cases by default with state, client, due date and an Overdue marker', async () => {
    openAt('#/cases', setup().runtime)
    expect(await screen.findByText(count(28))).toBeTruthy()
    expect(rowTitles().slice(0, 3)).toEqual([
      'Samayoa Ramírez — Zacapa, 1950s', // overdue by ten days, so the earliest due date
      'Mejía marriage search — Quiché', // overdue
      'Maternal grandparents — Totonicapán' // overdue, and the Lucía line
    ])
    const overdue = screen.getAllByText('Overdue')
    expect(overdue).toHaveLength(5)
    expect(rows()[2]!.textContent).toContain('Overdue')
    expect(within(rows()[2]!).getByText('Waiting')).toBeTruthy()
    expect(within(rows()[2]!).getByRole('link', { name: 'Lucía Fernández (Quetzaltenango line)' }).getAttribute('href')).toBe(
      `#/clients/${demoClientIds.lucia}`
    )
    expect(screen.getByText(/28 open · 14 finished · 3 archived/)).toBeTruthy()
  })

  it('never marks delivered or closed cases overdue', async () => {
    openAt('#/cases?state=all', setup().runtime)
    expect(await screen.findByText(count(42))).toBeTruthy()
    expect(screen.getAllByText('Overdue')).toHaveLength(5)
    expect(within(rows().find((r) => r.textContent?.includes('Second branch report'))!).queryByText('Overdue')).toBeNull()
  })

  it('filters by state group and by the case archive flag', async () => {
    openAt('#/cases', setup().runtime)
    await screen.findByText(count(28))

    fireEvent.click(within(stateGroup()).getByLabelText('Delivered'))
    expect(await screen.findByText(count(5))).toBeTruthy()
    expect(rowTitles()).toEqual([
      'Ortiz line — Huehuetenango, 1900s',
      'Second line — Jalapa, 1920s',
      'Yac family — San Marcos, 1940s',
      'Ixcoy Tambriz — Chiquimula, 1900s',
      'Second branch report'
    ])

    fireEvent.click(within(stateGroup()).getByLabelText('Closed'))
    expect(await screen.findByText(count(9))).toBeTruthy()
    expect(rowTitles().slice(0, 2)).toEqual(['Surname spelling variations', 'Choc Pop — Izabal, 1870s']) // earliest due first

    fireEvent.click(within(showGroup()).getByLabelText('Archived'))
    expect(await screen.findByText(count(3))).toBeTruthy()
    expect(rowTitles()).toEqual([
      'Rosales Tzep — Petén, 1920s',
      'Short family history for a reunion',
      'Pop family — Quetzaltenango, 1900s'
    ])
    expect(within(rows()[0]!).getByText('Archived')).toBeTruthy()

    fireEvent.click(within(showGroup()).getByLabelText('All'))
    fireEvent.click(within(stateGroup()).getByLabelText('All'))
    expect(await screen.findByText(count(45))).toBeTruthy()
  })

  it('filters by client, searches title and order reference, and clears everything', async () => {
    openAt('#/cases?state=all', setup().runtime)
    await screen.findByText(count(42))

    fireEvent.change(screen.getByLabelText('Client'), { target: { value: demoClientIds.lucia } })
    expect(await screen.findByText(count(3))).toBeTruthy()
    for (const row of rows()) expect(row.textContent).toContain('Lucía Fernández')

    fireEvent.change(screen.getByLabelText('Search cases'), { target: { value: 'fo-demo-0042' } })
    expect(await screen.findByText(count(1))).toBeTruthy()
    expect(rowTitles()).toEqual(['Paternal line — Quetzaltenango, 1880s'])

    fireEvent.change(screen.getByLabelText('Search cases'), { target: { value: 'quetzaltenango' } })
    expect(rowTitles()).toEqual(['Paternal line — Quetzaltenango, 1880s'])

    fireEvent.change(screen.getByLabelText('Search cases'), { target: { value: 'zzz nothing' } })
    expect(await screen.findByText('No matching cases')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }))
    expect(await screen.findByText(count(28))).toBeTruthy()
  })

  it('sorts by title, recently updated and recently created', async () => {
    openAt('#/cases?state=all', setup().runtime)
    await screen.findByText(count(42))
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'title' } })
    expect(rowTitles()[0]).toBe('Ajanel Cux — Quiché, 1930s')
    expect(rowTitles()[5]).toBe('Chub Ixtecoc — Alta Verapaz, 1960s')
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'updated' } })
    expect(rowTitles()[0]).toBe('Coc Ajcalón — Escuintla, 1880s') // updated yesterday, like the second branch report
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'created' } })
    expect(rowTitles()[0]).toBe('Surname origin — one family, one town') // created 6 days ago
  })

  it('invites you to open a client when there are no cases, and offers a retry when loading fails', async () => {
    const { runtime, cases } = setup()
    const empty: CaseApi = { ...cases, listCases: async () => [] }
    openAt('#/cases', { ...runtime, cases: empty })
    expect(await screen.findByText(/No cases yet — open a client to start one/)).toBeTruthy()
    cleanup()

    const listCases = vi.fn<CaseApi['listCases']>().mockRejectedValueOnce(new Error('down'))
    listCases.mockImplementation(cases.listCases)
    openAt('#/cases', { ...runtime, cases: { ...cases, listCases } })
    expect(await screen.findByText('Your cases couldn’t be loaded')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(count(28))).toBeTruthy()
  })
})

describe('client profile cases', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  it('lists only that client’s cases, grouped, with a New case link', async () => {
    openAt(`#/clients/${demoClientIds.lucia}`, setup().runtime)
    const section = await screen.findByRole('region', { name: 'Research cases' })
    await within(section).findByText('Paternal line — Quetzaltenango, 1880s')
    expect(within(section).getAllByRole('listitem').map((li) => li.querySelector('a')!.textContent)).toEqual([
      'Maternal grandparents — Totonicapán',
      'Paternal line — Quetzaltenango, 1880s',
      'Baptism search — San Pedro (fictional parish)'
    ])
    expect(within(section).queryByText('Surname origin — one family, one town')).toBeNull()
    expect(within(section).queryByText('Second branch report')).toBeNull()
    expect(within(section).getByText('Open')).toBeTruthy()
    expect(within(section).getByText('Delivered and closed')).toBeTruthy()
    expect(within(section).getByRole('link', { name: 'New case' }).getAttribute('href')).toBe(`#/cases/new?client=${demoClientIds.lucia}`)
  })

  it('includes archived cases in their own group', async () => {
    openAt(`#/clients/${demoClientIds.tomas}`, setup().runtime)
    const section = await screen.findByRole('region', { name: 'Research cases' })
    expect(await within(section).findByText('Short family history for a reunion')).toBeTruthy()
    expect(within(section).getByText('Archived', { selector: 'h3' })).toBeTruthy()
  })

  it('explains that an archived client must be restored before a new case, but still shows its cases', async () => {
    openAt(`#/clients/${demoClientIds.rosa}`, setup().runtime)
    const section = await screen.findByRole('region', { name: 'Research cases' })
    expect(within(section).getByText(/Restore this client to start a new case/)).toBeTruthy()
    expect(within(section).queryByRole('link', { name: 'New case' })).toBeNull()
    expect(await within(section).findByText('Surname spelling variations')).toBeTruthy()
  })
})

describe('creating and editing', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  it('asks which client when none is given, offering only active clients', async () => {
    openAt('#/cases/new', setup().runtime)
    const picker = await screen.findByLabelText('Client')
    const options = within(picker).getAllByRole('option').map((o) => o.textContent)
    expect(options).toContain('Daniel Ochoa')
    expect(options).not.toContain('Rosa Chávez Ixcoy')
    fireEvent.change(picker, { target: { value: demoClientIds.daniel } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByLabelText(/^Title/)).toBeTruthy()
    expect(screen.getByText('Daniel Ochoa')).toBeTruthy()
  })

  it('refuses to start a case for an archived client and points to the client', async () => {
    openAt(`#/cases/new?client=${demoClientIds.rosa}`, setup().runtime)
    expect(await screen.findByText(/is archived/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open Rosa/ }).getAttribute('href')).toBe(`#/clients/${demoClientIds.rosa}`)
    expect(screen.queryByLabelText(/^Title/)).toBeNull()
  })

  it('keeps what you typed when validation fails, then creates the case in intake', async () => {
    const { runtime } = setup()
    openAt(`#/cases/new?client=${demoClientIds.daniel}`, runtime)
    fireEvent.change(await screen.findByLabelText(/^Requested outcome/), { target: { value: 'Find the family’s town.\nSecond line.' } })
    fireEvent.change(screen.getByLabelText(/^Order reference/), { target: { value: 'FO-TEST-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create case' }))

    const summary = await screen.findByRole('alert')
    expect(summary.textContent).toContain('Give the case a title')
    expect((screen.getByLabelText(/^Requested outcome/) as HTMLTextAreaElement).value).toBe('Find the family’s town.\nSecond line.')
    expect((screen.getByLabelText(/^Order reference/) as HTMLInputElement).value).toBe('FO-TEST-1')
    expect(screen.getByLabelText(/^Title/).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/Never paste passwords or payment details/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: '  Cobán   records ' } })
    fireEvent.change(screen.getByLabelText(/^Due date/), { target: { value: '2026-12-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create case' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Cobán records' })).toBeTruthy()
    expect(screen.getByText('Case created.')).toBeTruthy()
    expect(screen.getAllByText('Intake').length).toBeGreaterThan(0)
    expect(document.querySelector('.preserve-lines')!.textContent).toBe('Find the family’s town.\nSecond line.')
    expect(await screen.findByText('Case created', { selector: '.kind-label' })).toBeTruthy()
  })

  it('shows a clear alert and keeps the form when the client was archived meanwhile', async () => {
    const { runtime, data } = setup()
    openAt(`#/cases/new?client=${demoClientIds.daniel}`, runtime)
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Late start' } })
    await data.archiveClient(demoClientIds.daniel)
    fireEvent.click(screen.getByRole('button', { name: 'Create case' }))
    expect(await screen.findByText(/This client is archived, so a new case can’t be started/)).toBeTruthy()
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Late start')
  })

  it('shows the host’s issues when it rejects a draft the browser accepted', async () => {
    const { runtime, cases } = setup()
    const rejecting: CaseApi = {
      ...cases,
      createCase: async () => ({ ok: false, reason: 'invalid', issues: [{ field: 'orderReference', code: 'too-long' }] })
    }
    openAt(`#/cases/new?client=${demoClientIds.daniel}`, { ...runtime, cases: rejecting })
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Okay title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create case' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Keep the order reference under 100 characters')
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Okay title')
  })

  it('does not lose input when saving fails with a network error', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/new?client=${demoClientIds.daniel}`, { ...runtime, cases: { ...cases, createCase: () => Promise.reject(new Error('down')) } })
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create case' }))
    expect(await screen.findByText(/Something went wrong while saving/)).toBeTruthy()
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Keep me')
  })

  it('edits a case, and asks before discarding unsaved changes', async () => {
    openAt(`#/cases/${demoCaseIds.surname}/edit`, setup().runtime)
    const title = (await screen.findByLabelText(/^Title/)) as HTMLInputElement
    expect(title.value).toBe('Surname origin — one family, one town')

    fireEvent.change(title, { target: { value: 'Changed my mind' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(within(dialog()).getByText('Discard your changes?')).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Changed my mind')

    fireEvent.change(screen.getByLabelText(/^Due date/), { target: { value: '2027-01-15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Changed my mind' })).toBeTruthy()
    expect(screen.getByText('Changes saved.')).toBeTruthy()
    expect(screen.getByText(/2027/)).toBeTruthy()
  })

  it('leaves without asking when nothing changed, and is read-only for archived cases and clients', async () => {
    openAt(`#/cases/${demoCaseIds.surname}/edit`, setup().runtime)
    await screen.findByLabelText(/^Title/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(await screen.findByRole('heading', { level: 1, name: /Daniel Ochoa|Surname origin/ })).toBeTruthy()
    cleanup()

    openAt(`#/cases/${demoCaseIds.reunion}/edit`, setup().runtime)
    expect(await screen.findByText('This case is archived')).toBeTruthy()
    expect(screen.queryByLabelText(/^Title/)).toBeNull()
    cleanup()

    openAt(`#/cases/${demoCaseIds.spelling}/edit`, setup().runtime)
    expect(await screen.findByText('This client is archived')).toBeTruthy()
    expect(screen.queryByLabelText(/^Title/)).toBeNull()
  })
})

describe('case overview', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  const stateButtons = () => within(screen.getByRole('group', { name: 'Change state' })).getAllByRole('button').map((b) => b.textContent)

  it('shows the details, client link, overdue marker, history and the hours placeholder', async () => {
    openAt(`#/cases/${demoCaseIds.maternal}`, setup().runtime)
    expect(await screen.findByRole('heading', { level: 1, name: 'Maternal grandparents — Totonicapán' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Lucía Fernández (Quetzaltenango line)' }).getAttribute('href')).toBe(`#/clients/${demoClientIds.lucia}`)
    const details = screen.getByRole('region', { name: 'Details' })
    expect(within(details).getByText('FO-DEMO-0039')).toBeTruthy()
    expect(within(details).getByText('Overdue')).toBeTruthy()
    expect(within(details).getByText(/maiden name/)).toBeTruthy()

    const history = screen.getByRole('region', { name: 'History' })
    await within(history).findByText('Waiting on someone')
    const sentences = within(history).getAllByRole('listitem').map((li) => li.querySelector('.kind-label')!.textContent)
    expect(sentences).toEqual(['Waiting on someone', 'Research started', 'Case created']) // newest first
    expect(screen.getByRole('region', { name: 'Research hours' })).toBeTruthy()
    expect(screen.queryByText(/coming soon/)).toBeNull()
  })

  it('offers only the transitions from the current state, with human labels', async () => {
    openAt(`#/cases/${demoCaseIds.surname}`, setup().runtime)
    await screen.findByRole('heading', { level: 1, name: /Surname origin/ })
    expect(stateButtons()).toEqual(['Start research', 'Waiting on someone', 'Close case'])
    cleanup()

    openAt(`#/cases/${demoCaseIds.maternal}`, setup().runtime)
    await screen.findByRole('heading', { level: 1, name: /Maternal/ })
    expect(stateButtons()).toEqual(['Resume research', 'Mark delivered', 'Close case'])
    cleanup()

    openAt(`#/cases/${demoCaseIds.secondBranch}`, setup().runtime)
    await screen.findByRole('heading', { level: 1, name: /Second branch/ })
    expect(stateButtons()).toEqual(['Reopen', 'Close case'])
    cleanup()

    openAt(`#/cases/${demoCaseIds.baptism}`, setup().runtime)
    await screen.findByRole('heading', { level: 1, name: /Baptism/ })
    expect(stateButtons()).toEqual(['Reopen'])
  })

  it('changes unconfirmed transitions straight away and confirms the others', async () => {
    openAt(`#/cases/${demoCaseIds.surname}`, setup().runtime)
    await screen.findByRole('heading', { level: 1, name: /Surname origin/ })

    fireEvent.click(screen.getByRole('button', { name: 'Start research' }))
    expect(await screen.findByText('Case is now active.')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(stateButtons()).toEqual(['Waiting on someone', 'Mark delivered', 'Close case'])
    expect(await screen.findByText('Research started', { selector: '.kind-label' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Mark delivered' }))
    expect(within(dialog()).getByText('Mark this case as delivered?')).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(stateButtons()).toEqual(['Waiting on someone', 'Mark delivered', 'Close case'])

    fireEvent.click(screen.getByRole('button', { name: 'Mark delivered' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark delivered' }))
    expect(await screen.findByText('Case is now delivered.')).toBeTruthy()
    expect(stateButtons()).toEqual(['Reopen', 'Close case'])
    expect(await screen.findByText('Marked delivered', { selector: '.kind-label' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(within(dialog()).getByText('Reopen this case?')).toBeTruthy()
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(stateButtons()).toEqual(['Reopen', 'Close case'])

    // Waiting needs no confirmation either way.
    cleanup()
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    await screen.findByRole('heading', { level: 1, name: /Paternal line/ })
    fireEvent.click(screen.getByRole('button', { name: 'Waiting on someone' }))
    expect(await screen.findByText('Case is now waiting.')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('archives with confirmation, becomes read-only, then unarchives', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    await screen.findByRole('heading', { level: 1, name: /Paternal line/ })
    expect(screen.getByRole('link', { name: 'Edit details' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Archive case' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/Archived on/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Archive case' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Archive case' }))
    expect(await screen.findByText('Case archived.')).toBeTruthy()
    expect(screen.getByText(/This case is read-only/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Edit details' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Change state' })).toBeNull()
    expect(screen.getAllByText('Archived').length).toBeGreaterThan(0)
    expect(await screen.findByText('Archived', { selector: '.kind-label' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Unarchive case' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Unarchive case' }))
    expect(await screen.findByText('Case unarchived.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Edit details' })).toBeTruthy()
    expect(await screen.findByText('Restored from the archive')).toBeTruthy()
  })

  it('is read-only, with an explanation and no archive button, when the client is archived', async () => {
    openAt(`#/cases/${demoCaseIds.spelling}`, setup().runtime)
    expect(await screen.findByRole('heading', { level: 1, name: 'Surname spelling variations' })).toBeTruthy()
    expect(screen.getByText(/Their cases are read-only until the client is restored/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Edit details' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Change state' })).toBeNull()
    expect(screen.queryByRole('button', { name: /archive case/i })).toBeNull()
  })

  it('locks the case when the client is archived while it is open, and reports the refusal', async () => {
    const { runtime, data } = setup()
    openAt(`#/cases/${demoCaseIds.surname}`, runtime)
    await screen.findByRole('heading', { level: 1, name: /Surname origin/ })
    await data.archiveClient(demoClientIds.daniel)
    fireEvent.click(screen.getByRole('button', { name: 'Start research' }))
    expect(await screen.findByText(/it can’t be changed/)).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Change state' })).toBeNull())
    expect(screen.getAllByText('Intake', { selector: '.state-badge' }).length).toBeGreaterThan(0)
  })

  it('shows a friendly not-found state for unknown and malformed ids, and nothing from other cases', async () => {
    for (const hash of [`#/cases/${UNKNOWN_ID}`, '#/cases/not-an-id', `#/cases/${UNKNOWN_ID}/edit`, '#/cases/..%2F..']) {
      openAt(hash, setup().runtime)
      expect(await screen.findByRole('heading', { level: 1, name: 'Case not found' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Back to cases' }).getAttribute('href')).toBe('#/cases')
      expect(screen.queryByText(/Lucía|FO-DEMO/)).toBeNull()
      cleanup()
    }
  })
})

describe('demo case adapter', () => {
  it('follows the repository’s rules and check order', async () => {
    const { data, cases } = setup()

    expect(await cases.createCase(UNKNOWN_ID, input)).toEqual({ ok: false, reason: 'not-found' })
    expect(await cases.createCase(demoClientIds.rosa, input)).toEqual({ ok: false, reason: 'client-archived' })
    // The archived client is reported before the invalid input.
    expect(await cases.createCase(demoClientIds.rosa, { ...input, title: ' ' })).toEqual({ ok: false, reason: 'client-archived' })
    expect(await cases.createCase(demoClientIds.daniel, { ...input, title: ' ' })).toEqual({
      ok: false,
      reason: 'invalid',
      issues: [{ field: 'title', code: 'required' }]
    })

    const created = await cases.createCase(demoClientIds.daniel, input)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.case.id
    expect(created.case).toMatchObject({ state: 'intake', clientId: demoClientIds.daniel, archivedAt: null })

    expect(await cases.setCaseState(id, 'delivered')).toEqual({ ok: false, reason: 'invalid-transition' })
    expect(await cases.setCaseState(id, 'intake')).toEqual({ ok: false, reason: 'invalid-transition' })
    expect(await cases.setCaseState(UNKNOWN_ID, 'active')).toEqual({ ok: false, reason: 'not-found' })
    expect((await cases.setCaseState(id, 'active')).ok).toBe(true)

    expect((await cases.archiveCase(id)).ok).toBe(true)
    expect(await cases.updateCase(id, input)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.setCaseState(id, 'waiting')).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.archiveCase(id)).toEqual({ ok: false, reason: 'wrong-status' })
    expect((await cases.unarchiveCase(id)).ok).toBe(true)
    expect(await cases.unarchiveCase(id)).toEqual({ ok: false, reason: 'wrong-status' })

    expect((await cases.listCaseEvents(id)).map((e) => [e.kind, e.fromState, e.toState])).toEqual([
      ['unarchived', null, null],
      ['archived', null, null],
      ['state', 'intake', 'active'],
      ['created', null, 'intake']
    ])
    expect(await cases.listCaseEvents(UNKNOWN_ID)).toEqual([])

    await data.archiveClient(demoClientIds.daniel)
    expect(await cases.updateCase(id, input)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await cases.unarchiveCase(demoCaseIds.reunion)).toEqual({ ok: true, case: expect.objectContaining({ archivedAt: null }) })
  })

  it('returns copies and starts from the sample set again on every load', async () => {
    const initial = buildDemoCases()
    const data = createDemoApi(buildDemoData(), appInfo)
    const first = createDemoCases(initial, data.getClient, defaultClock)
    const one = (await first.getCase(demoCaseIds.paternal))!
    one.title = 'Changed in place'
    expect((await first.getCase(demoCaseIds.paternal))!.title).toBe('Paternal line — Quetzaltenango, 1880s')

    await first.setCaseState(demoCaseIds.paternal, 'waiting')
    const reload = createDemoCases(initial, data.getClient, defaultClock)
    expect((await reload.getCase(demoCaseIds.paternal))!.state).toBe('active')
  })
})
