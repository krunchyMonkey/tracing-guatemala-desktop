// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime, CaseApi } from '../../src/renderer/src/runtime/AppRuntime'
import type { StudioSummary } from '../../src/shared/studio-summary'
import { createFakeApi } from './fakeApi'
import { busySummary, emptySummary } from './fixtures/studio'

// The Research Studio Home dashboard (#116). Fictional data only.

const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }
const LABEL = 'Illustrative figures from fictional demo data'
const CASE_ID = 'cccccccc-0000-4000-8000-000000000001'

function runtimeWith(mode: 'live' | 'demo', getStudioSummary: () => Promise<StudioSummary>): AppRuntime {
  const cases = { getStudioSummary } as unknown as CaseApi
  if (mode === 'demo') {
    return { mode, data: createDemoApi(buildDemoData(), appInfo), backup: null, cases }
  }
  const fake = createFakeApi()
  return { mode, data: fake.api, backup: fake.api, cases }
}

function openHome(runtime?: AppRuntime) {
  window.location.hash = '#/'
  return render(<App runtime={runtime} />)
}

beforeEach(() => {
  vi.stubGlobal('tracingGuatemala', createFakeApi().api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('metrics', () => {
  it('shows the figures and lists from the summary, with links to real case routes', async () => {
    openHome(runtimeWith('live', async () => busySummary()))
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy()
    const home = await screen.findByRole('region', { name: 'At a glance' })

    const tile = (label: string) => within(home).getByText(label).closest('li')!
    expect(tile('Open cases').textContent).toContain('4')
    expect(tile('Overdue tasks').textContent).toContain('2')
    expect(tile('Due in 7 days').textContent).toContain('3')
    expect(tile('Hours this week').textContent).toContain('5h 30m')
    expect(tile('Hours this week').textContent).toContain('15h this month')

    const cases = screen.getByRole('region', { name: 'Active cases' })
    expect(within(cases).getByRole('link', { name: /Maternal grandparents/ }).getAttribute('href')).toBe(`#/cases/${CASE_ID}`)
    const tasks = screen.getByRole('region', { name: 'Upcoming tasks' })
    const rows = within(tasks).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Request the 1931 register')
    expect(rows[0]!.querySelector('.overdue-tag')?.textContent).toBe('Overdue')
    expect(rows[1]!.querySelector('.overdue-tag')).toBeNull()
    const activity = screen.getByRole('region', { name: 'Recent activity' })
    expect(within(activity).getByText('Logged 1h 30m')).toBeTruthy()
    expect(within(activity).getByText('Journal entry')).toBeTruthy()
    for (const link of within(activity).getAllByRole('link')) expect(link.getAttribute('href')).toBe(`#/cases/${CASE_ID}`)
  })

  it('labels the figures as illustrative in the demo, and not in Live', async () => {
    openHome(runtimeWith('demo', async () => busySummary()))
    expect(await screen.findByText(LABEL)).toBeTruthy()
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Clients' }).getAttribute('href')).toBe('#/clients')
    cleanup()
    openHome(runtimeWith('live', async () => busySummary()))
    await screen.findByRole('region', { name: 'At a glance' })
    expect(screen.queryByText(LABEL)).toBeNull()
  })

  it('shows the demo adapter figures from the portfolio', async () => {
    const data = createDemoApi(buildDemoData(), appInfo)
    const cases = createDemoCases(buildDemoCases(), data.getClient, defaultClock, () =>
      data.listClients({ text: '', status: 'all', sources: [], sort: 'name' })
    )
    const expected = await cases.getStudioSummary()
    openHome({ mode: 'demo', data, backup: null, cases })
    const glance = await screen.findByRole('region', { name: 'At a glance' })
    expect(within(glance).getByText('Open cases').closest('li')!.textContent).toContain(String(expected.counts.openCases))
    expect(within(glance).getByText('Overdue tasks').closest('li')!.textContent).toContain(String(expected.counts.overdueTasks))
    const link = screen.getByRole('link', { name: /Continue researching/ })
    expect(link.getAttribute('href')).toBe(`#/cases/${expected.continueCase!.caseId}`)
  })
})

describe('Continue researching', () => {
  it('links to the continue case', async () => {
    openHome(runtimeWith('live', async () => busySummary()))
    const link = await screen.findByRole('link', { name: /Continue researching/ })
    expect(link.getAttribute('href')).toBe(`#/cases/${CASE_ID}`)
    expect(document.getElementById(link.getAttribute('aria-describedby')!)?.textContent).toContain('Maternal grandparents')
  })

  it('offers Start a case when there are clients but no open case', async () => {
    const summary = emptySummary()
    summary.counts.activeClients = 2
    openHome(runtimeWith('live', async () => summary))
    const link = await screen.findByRole('link', { name: 'Start a case' })
    expect(link.getAttribute('href')).toBe('#/cases/new')
    expect(screen.queryByRole('link', { name: /Continue researching/ })).toBeNull()
  })

  it('offers Add your first client when there are no clients, and shows empty lists', async () => {
    openHome(runtimeWith('live', async () => emptySummary()))
    const link = await screen.findByRole('link', { name: 'Add your first client' })
    expect(link.getAttribute('href')).toBe('#/clients/new')
    expect(screen.getByText('No open cases right now.')).toBeTruthy()
    expect(screen.getByText('Nothing is due. Tasks with a deadline appear here.')).toBeTruthy()
    expect(screen.getByText('Activity appears here as you work on cases.')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'At a glance' }).textContent).toContain('All caught up')
  })
})

describe('loading and errors', () => {
  it('says it is loading, then shows the studio', async () => {
    let finish!: (s: StudioSummary) => void
    openHome(runtimeWith('live', () => new Promise((resolve) => (finish = resolve))))
    expect(await screen.findByText('Loading your studio…')).toBeTruthy()
    finish(busySummary())
    await screen.findByRole('link', { name: /Continue researching/ })
    expect(screen.queryByText('Loading your studio…')).toBeNull()
  })

  it('shows an error with a retry that loads the studio', async () => {
    const load = vi.fn<() => Promise<StudioSummary>>().mockRejectedValueOnce(new Error('down')).mockResolvedValue(busySummary())
    openHome(runtimeWith('live', load))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The studio overview')
    expect(screen.queryByRole('link', { name: /Continue researching/ })).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await screen.findByRole('link', { name: /Continue researching/ })
    expect(load).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('other runtimes', () => {
  it('keeps the simple welcome in the desktop app', async () => {
    openHome()
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy()
    expect(screen.getByText(/Your research workspace/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'At a glance' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Continue researching/ })).toBeNull()
  })

  it('keeps the simple demo welcome when the demo has no case support', async () => {
    openHome({ mode: 'demo', data: createDemoApi(buildDemoData(), appInfo), backup: null, cases: null })
    expect(await screen.findByText(/filled with fictional clients/)).toBeTruthy()
    expect(screen.queryByText(LABEL)).toBeNull()
  })

  it('keeps the backup reminder at the top in Live', async () => {
    const runtime = runtimeWith('live', async () => busySummary())
    const backupStatus = async () => ({ lastBackupAt: null, fileName: null, backupCount: 0 })
    openHome({ ...runtime, backupStatus } as AppRuntime)
    const note = await screen.findByRole('note', { name: 'Backup reminder' })
    const heading = screen.getByRole('heading', { level: 1, name: 'Welcome' })
    expect(note.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
