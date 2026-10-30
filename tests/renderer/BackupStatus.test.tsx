// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi } from '../../src/renderer/src/demo/demoApi'
import { buildDemoData } from '../../src/renderer/src/demo/sampleData'
import type { AppRuntime } from '../../src/renderer/src/runtime/AppRuntime'
import { backupIsDue, daysSince, describeAge } from '../../src/renderer/src/runtime/useBackupStatus'
import type { BackupStatus } from '../../src/shared/ipc'
import { createFakeApi } from './fakeApi'
import { emptySummary } from './fixtures/studio'

// Backup status, the Live reminder and the encryption notice (#117). Fictional data only.

const fileName = 'Tracing Guatemala backup 2026-10-29 08-05-09.tgbackup'

/** Local noon, `days` calendar days ago. */
const daysAgo = (days: number) => {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() - days)
  return date.toISOString()
}
const made = (days: number, backupCount = 1): BackupStatus => ({ lastBackupAt: daysAgo(days), fileName, backupCount })
const none: BackupStatus = { lastBackupAt: null, fileName: null, backupCount: 0 }

/** A Live runtime whose status call returns each given status in turn (the last one repeats), or fails. */
function live(statuses: BackupStatus[] | Error = [none]) {
  const fake = createFakeApi()
  const queue = Array.isArray(statuses) ? [...statuses] : []
  const backupStatus = vi.fn(async () => {
    if (statuses instanceof Error) throw statuses
    return queue.length > 1 ? queue.shift()! : queue[0]!
  })
  const runtime: AppRuntime = { mode: 'live', data: fake.api, backup: fake.api, cases: { getStudioSummary: async () => emptySummary() } as never, backupStatus }
  return { fake, backupStatus, runtime }
}

function openAt(hash: string, runtime?: AppRuntime) {
  window.location.hash = hash
  return render(<App runtime={runtime} />)
}

const reminder = () => screen.queryByRole('note', { name: 'Backup reminder' })

beforeEach(() => {
  vi.stubGlobal('tracingGuatemala', createFakeApi().api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('backup age', () => {
  it('counts calendar days in local time', () => {
    const now = new Date(2026, 9, 29, 9, 0)
    expect(daysSince(new Date(2026, 9, 29, 0, 5).toISOString(), now)).toBe(0)
    expect(daysSince(new Date(2026, 9, 28, 23, 55).toISOString(), now)).toBe(1)
    expect(daysSince(new Date(2026, 9, 22, 18, 0).toISOString(), now)).toBe(7)
    expect(daysSince(new Date(2026, 9, 30, 8, 0).toISOString(), now)).toBe(0)
    expect([0, 1, 5].map(describeAge)).toEqual(['today', 'yesterday', '5 days ago'])
  })

  it('is due with no backup or after more than 7 days', () => {
    const now = new Date(2026, 9, 29, 9, 0)
    const at = (day: number): BackupStatus => ({ lastBackupAt: new Date(2026, 9, day, 12).toISOString(), fileName, backupCount: 1 })
    expect(backupIsDue(none, now)).toBe(true)
    expect(backupIsDue(at(22), now)).toBe(false)
    expect(backupIsDue(at(21), now)).toBe(true)
  })
})

describe('Settings in Live mode', () => {
  it('shows when the last backup was made and how many are kept', async () => {
    openAt('#/settings', live([made(3, 4)]).runtime)
    const status = await screen.findByTestId('backup-status')
    expect(within(status).getByText(/Last backup:/)).toBeTruthy()
    expect(status.textContent).toContain('(3 days ago)')
    expect(within(status).getByText('4 backups in the app’s backups folder.')).toBeTruthy()
  })

  it('says plainly that no backup has been made', async () => {
    openAt('#/settings', live([none]).runtime)
    const status = await screen.findByTestId('backup-status')
    expect(within(status).getByText('No backup made yet')).toBeTruthy()
    expect(within(status).getByText('0 backups in the app’s backups folder.')).toBeTruthy()
    expect(status.textContent).not.toContain('Last backup')
  })

  it('refreshes the status after a backup is created, and not after one that failed', async () => {
    const { fake, backupStatus, runtime } = live([none, made(0, 1)])
    openAt('#/settings', runtime)
    await screen.findByText('No backup made yet')

    vi.mocked(fake.api.createBackup).mockResolvedValueOnce({ ok: false, reason: 'failed' })
    fireEvent.click(screen.getByRole('button', { name: 'Create backup…' }))
    await screen.findByText(/The backup couldn’t be saved/)
    expect(backupStatus).toHaveBeenCalledTimes(1)
    expect(screen.getByText('No backup made yet')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create backup…' }))
    await waitFor(() => expect(screen.getByTestId('backup-status').textContent).toContain('(today)'))
    expect(screen.getByText('1 backup in the app’s backups folder.')).toBeTruthy()
    expect(backupStatus).toHaveBeenCalledTimes(2)
  })

  it('claims nothing when the status cannot be read', async () => {
    openAt('#/settings', live(new Error('down')).runtime)
    expect(await screen.findByText('Backup status is unavailable right now.')).toBeTruthy()
    expect(screen.queryByText(/No backup made yet|Last backup/)).toBeNull()
  })

  it('explains that data is not encrypted and what to do about it', async () => {
    openAt('#/settings', live().runtime)
    const panel = (await screen.findByRole('heading', { name: 'Your data is not encrypted' })).closest('section')!
    const text = panel.textContent ?? ''
    for (const phrase of [/before an upgrade or a restore/, /BitLocker/, /FileVault/, /off this computer/, /Never email/, /Nothing is ever deleted automatically/, /last 5/]) {
      expect(text).toMatch(phrase)
    }
  })
})

describe('Home reminder in Live mode', () => {
  it('asks for a first backup, with a link to Settings & Backup', async () => {
    openAt('#/', live([none]).runtime)
    const note = await screen.findByRole('note', { name: 'Backup reminder' })
    expect(note.textContent).toContain('You haven’t made a backup yet.')
    expect(within(note).getByRole('link', { name: /Settings & Backup/ }).getAttribute('href')).toBe('#/settings')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('appears for a backup older than 7 days', async () => {
    openAt('#/', live([made(8)]).runtime)
    expect((await screen.findByRole('note', { name: 'Backup reminder' })).textContent).toContain('8 days ago')
  })

  it.each([0, 1, 7])('stays away after a backup %i days ago', async (days) => {
    const { backupStatus, runtime } = live([made(days)])
    openAt('#/', runtime)
    await waitFor(() => expect(backupStatus).toHaveBeenCalled())
    await screen.findByRole('heading', { level: 1, name: 'Welcome' })
    // Let the answer arrive and render before checking that nothing appeared.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reminder()).toBeNull()
  })

  it('stays away when the status is unknown, rather than nagging falsely', async () => {
    const { backupStatus, runtime } = live(new Error('down'))
    openAt('#/', runtime)
    await waitFor(() => expect(backupStatus).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reminder()).toBeNull()
  })
})

describe('other runtimes', () => {
  it('shows no reminder, status or encryption panel in the desktop app', async () => {
    openAt('#/')
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy()
    expect(reminder()).toBeNull()
    cleanup()
    openAt('#/settings')
    await screen.findByTestId('app-version')
    expect(screen.queryByTestId('backup-status')).toBeNull()
    expect(screen.queryByText('Your data is not encrypted')).toBeNull()
    expect(screen.queryByText(/saved on this computer/)).toBeNull()
  })

  it('shows none of it in the browser demo, even if given a status', async () => {
    const backupStatus = vi.fn(async () => none)
    const runtime: AppRuntime = {
      mode: 'demo',
      data: createDemoApi(buildDemoData(), { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }),
      backup: null,
      cases: null,
      backupStatus: backupStatus as never
    }
    openAt('#/', runtime)
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reminder()).toBeNull()
    cleanup()
    openAt('#/settings', runtime)
    await screen.findByTestId('app-version')
    expect(screen.queryByTestId('backup-status')).toBeNull()
    expect(screen.queryByText('Your data is not encrypted')).toBeNull()
    expect(backupStatus).not.toHaveBeenCalled()
  })

  it('says edits are saved on this computer only in Live mode', async () => {
    openAt('#/', live().runtime)
    expect(await screen.findByText('Live · saved on this computer')).toBeTruthy()
  })
})
