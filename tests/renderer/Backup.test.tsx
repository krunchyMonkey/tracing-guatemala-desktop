// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createFakeApi } from './fakeApi'

// Settings & Backup screen against an in-memory stand-in for the main process.

const token = '6f1d2b1a-3c1e-4c0a-9a51-7b0d1a520001'
const choice = {
  ok: true as const,
  token,
  fileName: 'Tracing Guatemala backup 2026-10-01.tgbackup',
  savedAt: '2026-10-01T09:00:00.000Z',
  clients: 7,
  notes: 12
}

let fake: ReturnType<typeof createFakeApi>

beforeEach(() => {
  fake = createFakeApi()
  vi.stubGlobal('tracingGuatemala', fake.api)
  window.location.hash = '#/settings'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const backupCard = () => screen.getByRole('region', { name: 'Backup' })

describe('backup', () => {
  it('explains where data lives and that backups are not encrypted', () => {
    render(<App />)
    expect(screen.getByText(/stored only on this computer/)).toBeTruthy()
    expect(screen.getByText(/nothing is uploaded to the cloud/)).toBeTruthy()
    expect(within(backupCard()).getByText('not encrypted')).toBeTruthy()
  })

  it('creates a backup and says what it contains', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Create backup…' }))
    expect(await screen.findByText(/Backup saved as “Tracing Guatemala backup 2026-10-29.tgbackup”/)).toBeTruthy()
    expect(fake.api.createBackup).toHaveBeenCalledWith()
  })

  it('says nothing when the save dialog is cancelled', async () => {
    vi.mocked(fake.api.createBackup).mockResolvedValueOnce({ ok: false, reason: 'cancelled' })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Create backup…' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create backup…' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Backup saved/)).toBeNull()
  })

  it('reports a failed backup', async () => {
    vi.mocked(fake.api.createBackup).mockResolvedValueOnce({ ok: false, reason: 'failed' })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Create backup…' }))
    expect(await screen.findByText(/The backup couldn’t be saved/)).toBeTruthy()
  })
})

describe('restore', () => {
  it('shows what the backup contains and asks before replacing anything', async () => {
    vi.mocked(fake.api.chooseBackupToRestore).mockResolvedValueOnce(choice)
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from backup…' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Replace all data with this backup?' })
    expect(within(dialog).getByText(/contains 7 clients and 12 notes/)).toBeTruthy()
    expect(within(dialog).getByText(/Everything currently in the app will be replaced/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fake.api.restoreBackup).not.toHaveBeenCalled()
  })

  it('restores after confirmation and reloads clients', async () => {
    vi.mocked(fake.api.chooseBackupToRestore).mockResolvedValueOnce(choice)
    vi.mocked(fake.api.restoreBackup).mockResolvedValueOnce({ ok: true, clients: 7, notes: 12 })
    render(<App />)
    await waitFor(() => expect(fake.api.listClients).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Restore from backup…' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace with backup' }))

    expect(await screen.findByText(/Backup restored: 7 clients and 12 notes/)).toBeTruthy()
    expect(fake.api.restoreBackup).toHaveBeenCalledWith(token)
    await waitFor(() => expect(fake.api.listClients).toHaveBeenCalledTimes(2))
  })

  it.each([
    ['not-a-backup', /isn’t a Tracing Guatemala backup/],
    ['damaged', /damaged and can’t be used/],
    ['too-new', /made by a newer version/]
  ] as const)('explains a %s file without asking to restore', async (reason, text) => {
    vi.mocked(fake.api.chooseBackupToRestore).mockResolvedValueOnce({ ok: false, reason })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from backup…' }))
    expect(await screen.findByText(text)).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('says the previous data was kept when a restore fails', async () => {
    vi.mocked(fake.api.chooseBackupToRestore).mockResolvedValueOnce(choice)
    vi.mocked(fake.api.restoreBackup).mockResolvedValueOnce({ ok: false, reason: 'failed' })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from backup…' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Replace with backup' }))
    expect(await screen.findByText(/your previous data was kept unchanged/)).toBeTruthy()
  })
})
