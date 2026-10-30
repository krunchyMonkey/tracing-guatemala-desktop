// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { downloadText } from '../../src/renderer/src/cases/downloadText'
import { createDemoApi, defaultClock } from '../../src/renderer/src/demo/demoApi'
import { createDemoCases } from '../../src/renderer/src/demo/demoCases'
import { buildDemoCases, buildDemoData, demoCaseIds } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime } from '../../src/renderer/src/runtime/AppRuntime'
import { DEMO_SUMMARY_LINE } from '../../src/shared/case-summary'
import { localDateString } from '../../src/shared/case-model'

// Export summary on the case page (#20) against the demo's in-memory adapters
// (two clients with contact details, several cases). The browser download is
// replaced by a spy so the exact file name and text can be checked. Fictional data only.

vi.mock('../../src/renderer/src/cases/downloadText', () => ({ downloadText: vi.fn() }))

const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }

function setup(mode: 'live' | 'demo' = 'live') {
  const data = createDemoApi(buildDemoData(), appInfo)
  const cases = createDemoCases(buildDemoCases(), data.getClient, defaultClock)
  const runtime = (
    mode === 'live'
      ? { mode: 'live', data, backup: { createBackup: vi.fn(), chooseBackupToRestore: vi.fn(), restoreBackup: vi.fn() }, cases, switcher: { kind: 'unavailable', reason: 'not-available' } }
      : { mode: 'demo', data, backup: null, cases, switcher: { kind: 'unavailable', reason: 'not-available' } }
  ) as unknown as AppRuntime
  return { data, cases, runtime }
}

function openAt(hash: string, runtime: AppRuntime) {
  window.location.hash = hash
  return render(<App runtime={runtime} />)
}

const exportButton = () => screen.findByRole('button', { name: 'Export summary…' })
const dialog = () => screen.getByRole('alertdialog')
const downloaded = () => vi.mocked(downloadText)
const today = () => localDateString(new Date())

afterEach(cleanup)
beforeEach(() => {
  window.location.hash = ''
  downloaded().mockReset()
})

describe('export summary dialog', () => {
  it('says what is included, the file name and that the file is not encrypted', async () => {
    openAt(`#/cases/${demoCaseIds.paternal}`, setup().runtime)
    fireEvent.click(await exportButton())
    const d = within(dialog())
    expect(d.getByRole('heading', { name: 'Export case summary' })).toBeTruthy()
    expect(d.getByText(/The client’s name only — no contact details/)).toBeTruthy()
    for (const item of [/research brief/, /Next steps/, /research journal/, /case history/]) expect(d.getByText(item)).toBeTruthy()
    expect(d.getByText(`case-summary-paternal-line-quetzaltenango-1880s-${today()}.md`)).toBeTruthy()
    expect(d.getByText(/The file is not encrypted\./)).toBeTruthy()
    expect(d.getByText(/keep it private/)).toBeTruthy()
    expect(d.getByText(/Your browser will save or ask where to save it\./)).toBeTruthy()
    // It never claims to know where, or whether, the file was saved.
    expect(dialog().textContent).not.toMatch(/saved to|your downloads folder|has been saved/i)
    expect(d.getByRole('button', { name: 'Download' })).toBeTruthy()
    expect(d.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(downloaded()).not.toHaveBeenCalled()
  })

  it('downloads a summary of the selected case only, with the client name and no contact details', async () => {
    const { runtime } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await exportButton())
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(downloaded()).toHaveBeenCalledTimes(1))
    const [fileName, text] = downloaded().mock.calls[0]!
    expect(fileName).toBe(`case-summary-paternal-line-quetzaltenango-1880s-${today()}.md`)
    expect(text).toContain('# Case summary: Paternal line — Quetzaltenango, 1880s')
    expect(text).toContain('- Client: Lucía Fernández (Quetzaltenango line)')
    expect(text).toContain('Compare spelling variants of the surname')
    // Not the same client's other cases, nor other clients.
    for (const other of ['Maternal grandparents', 'Request 1931 civil marriage register extract', 'Surname origin', 'Daniel Ochoa', 'Ethan']) {
      expect(text).not.toContain(other)
    }
    // Not a single contact detail of the client.
    for (const secret of ['lucia.fernandez@example.com', 'lucia_roots_demo', '@example.', 'lucia_roots']) expect(text).not.toContain(secret)
    // Live mode: no fictional-data line.
    expect(text).not.toContain(DEMO_SUMMARY_LINE)
    // The dialog closes and the page says the browser takes over, without claiming a location.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByText('Summary prepared. Your browser will save it or ask where to save it.')).toBeTruthy()
  })

  it('exports another case on its own, and says the data is fictional in demo mode', async () => {
    openAt(`#/cases/${demoCaseIds.maternal}`, setup('demo').runtime)
    fireEvent.click(await exportButton())
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(downloaded()).toHaveBeenCalledTimes(1))
    const [fileName, text] = downloaded().mock.calls[0]!
    expect(fileName).toBe(`case-summary-maternal-grandparents-totonicapan-${today()}.md`)
    expect(text).toContain(`# Case summary: Maternal grandparents — Totonicapán\n\n${DEMO_SUMMARY_LINE}\n`)
    expect(text).toContain('Request 1931 civil marriage register extract')
    expect(text).not.toContain('Compare spelling variants of the surname')
    expect(text).not.toContain('Paternal line')
  })

  it('is also available for an archived case and a case of an archived client, which stay read-only', async () => {
    const { runtime, cases } = setup()
    await cases.archiveCase(demoCaseIds.paternal)
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await exportButton())
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(downloaded()).toHaveBeenCalledTimes(1))
    expect(downloaded().mock.calls[0]![1]).toContain('- Archived: yes, since')
    expect(screen.queryByRole('link', { name: 'Edit details' })).toBeNull()
  })

  it('does nothing on Cancel or Escape', async () => {
    const { runtime, cases } = setup()
    const spies = [vi.spyOn(cases, 'getCase'), vi.spyOn(cases, 'listJournalEntries'), vi.spyOn(cases, 'listCaseTasks')]
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    await exportButton()
    await screen.findByRole('region', { name: 'Next steps' })
    const callsBefore = spies.map((spy) => spy.mock.calls.length)
    fireEvent.click(screen.getByRole('button', { name: 'Export summary…' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Export summary…' }))
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(downloaded()).not.toHaveBeenCalled()
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(callsBefore)
    expect(screen.queryByText(/Summary prepared/)).toBeNull()
  })

  it('shows an alert and exports nothing when the case can’t be read, then works on retry', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await exportButton())
    const failing = vi.spyOn(cases, 'listJournalEntries').mockRejectedValueOnce(new Error('boom: secret journal text'))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' }))
    const alert = await within(dialog()).findByRole('alert')
    expect(alert.textContent).toContain('The summary couldn’t be created')
    expect(alert.textContent).toContain('nothing was exported')
    expect(alert.textContent).not.toContain('secret journal text')
    expect(downloaded()).not.toHaveBeenCalled()
    expect(failing).toHaveBeenCalledTimes(1)

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(downloaded()).toHaveBeenCalledTimes(1))
  })

  it('exports nothing when the case has vanished', async () => {
    const { runtime, cases } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await exportButton())
    vi.spyOn(cases, 'getCase').mockResolvedValueOnce(null)
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' }))
    expect((await within(dialog()).findByRole('alert')).textContent).toContain('couldn’t be found any more')
    expect(downloaded()).not.toHaveBeenCalled()
  })

  it('never writes anything: no write call is made while exporting', async () => {
    const { runtime, cases, data } = setup()
    openAt(`#/cases/${demoCaseIds.paternal}`, runtime)
    fireEvent.click(await exportButton())
    const writes = [
      'createCase', 'updateCase', 'setCaseState', 'archiveCase', 'unarchiveCase', 'saveCaseBrief', 'createJournalEntry',
      'updateJournalEntry', 'createCaseTask', 'updateCaseTask', 'completeCaseTask', 'reopenCaseTask'
    ].map((name) => vi.spyOn(cases, name as 'createCase'))
    const dataWrites = ['createClient', 'updateClient', 'archiveClient', 'restoreClient', 'createNote', 'updateNote'].map((name) =>
      vi.spyOn(data, name as 'createClient')
    )
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(downloaded()).toHaveBeenCalledTimes(1))
    for (const spy of [...writes, ...dataWrites]) expect(spy).not.toHaveBeenCalled()
  })
})

describe('downloadText', () => {
  it('saves a Markdown blob through a temporary download link and releases it', async () => {
    const { downloadText: real } = await vi.importActual<typeof import('../../src/renderer/src/cases/downloadText')>(
      '../../src/renderer/src/cases/downloadText'
    )
    vi.useFakeTimers()
    const blobs: Blob[] = []
    const created = vi.fn((blob: Blob) => (blobs.push(blob), 'blob:fake-url'))
    const revoked = vi.fn()
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked })
    const clicked: { href: string; download: string; connected: boolean }[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, connected: this.isConnected })
    })
    const log = vi.spyOn(console, 'log')

    real('case-summary-x-2026-10-30.md', '# Hello 🌽')
    expect(blobs).toHaveLength(1)
    expect(blobs[0]!.type).toBe('text/markdown;charset=utf-8')
    expect(await blobs[0]!.text()).toBe('# Hello 🌽')
    expect(clicked).toEqual([{ href: 'blob:fake-url', download: 'case-summary-x-2026-10-30.md', connected: true }])
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revoked).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1500)
    expect(revoked).toHaveBeenCalledWith('blob:fake-url')
    expect(log).not.toHaveBeenCalled()

    click.mockRestore()
    log.mockRestore()
    vi.useRealTimers()
  })
})
