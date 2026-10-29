// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createFakeApi } from './fakeApi'
import { sampleClients } from './fixtures/sampleClients'

// Notes and contact log on the profile, against an in-memory stand-in for the
// main process. Fictional data only.

const byName = (name: string) => sampleClients.find((c) => c.displayName === name)!
const lucia = byName('Lucía Fernández (Quetzaltenango line)')
const grace = byName('Grace Whitfield')
const daniel = byName('Daniel Ochoa')

let fake: ReturnType<typeof createFakeApi>

beforeEach(() => {
  fake = createFakeApi()
  vi.stubGlobal('tracingGuatemala', fake.api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function open(id: string) {
  window.location.hash = `#/clients/${id}`
  render(<App />)
  await screen.findByRole('heading', { level: 1 })
  return screen.getByRole('region', { name: 'Notes & contact history' })
}

const timelineBodies = (history: HTMLElement) =>
  Array.from(history.querySelectorAll('.timeline-body')).map((p) => p.textContent)

describe('notes and contact history', () => {
  it('shows only this client’s saved entries, newest first', async () => {
    const history = await open(lucia.id)
    await within(history).findByText(/Repeat client: sent a custom offer/)
    const bodies = timelineBodies(history)
    expect(bodies[0]).toMatch(/Repeat client/)
    expect(bodies.at(-1)).toMatch(/First order/)
    expect(within(history).queryByText(/family bible/)).toBeNull()
    expect(fake.api.listNotes).toHaveBeenCalledWith(lucia.id)
  })

  it('adds a note that is still there after the app restarts', async () => {
    const history = await open(grace.id)
    expect(await within(history).findByText('No notes or contact history yet.')).toBeTruthy()

    fireEvent.click(within(history).getByRole('button', { name: 'Add note' }))
    expect(within(history).getByText('Write something before adding it.')).toBeTruthy()
    expect(fake.api.createNote).not.toHaveBeenCalled()

    fireEvent.change(within(history).getByLabelText('Your note'), { target: { value: '  Asked about the 1890s census. ' } })
    fireEvent.click(within(history).getByRole('button', { name: 'Add note' }))
    expect(await within(history).findByText('Asked about the 1890s census.')).toBeTruthy()
    expect((within(history).getByLabelText('Your note') as HTMLTextAreaElement).value).toBe('')
    expect(fake.api.createNote).toHaveBeenCalledWith(grace.id, expect.objectContaining({ kind: 'note' }))

    cleanup()
    const reopened = await open(grace.id)
    expect(await within(reopened).findByText('Asked about the 1890s census.')).toBeTruthy()
  })

  it('logs a contact entry with direction and channel, and filters the history', async () => {
    const history = await open(grace.id)
    await within(history).findByText('No notes or contact history yet.')
    fireEvent.click(within(history).getByLabelText('Logged contact'))
    fireEvent.change(within(history).getByLabelText('Message'), { target: { value: 'inbound' } })
    fireEvent.change(within(history).getByLabelText('Via'), { target: { value: 'email' } })
    fireEvent.change(within(history).getByLabelText('What was said'), { target: { value: 'Asked for an update.' } })
    fireEvent.click(within(history).getByRole('button', { name: 'Add contact entry' }))

    expect(await within(history).findByText('Asked for an update.')).toBeTruthy()
    expect(within(history).getByText('Received · Email')).toBeTruthy()
    fireEvent.click(within(history).getByLabelText('Notes'))
    expect(within(history).queryByText('Asked for an update.')).toBeNull()
  })

  it('places a back-dated entry in date order', async () => {
    const history = await open(daniel.id)
    await within(history).findByText(/family bible/)
    fireEvent.change(within(history).getByLabelText('When'), { target: { value: '2025-01-15T09:30' } })
    fireEvent.change(within(history).getByLabelText('Your note'), { target: { value: 'First enquiry, recorded late.' } })
    fireEvent.click(within(history).getByRole('button', { name: 'Add note' }))

    await within(history).findByText('First enquiry, recorded late.')
    expect(timelineBodies(history).at(-1)).toBe('First enquiry, recorded late.')
  })

  it('rejects a future date', async () => {
    const history = await open(grace.id)
    await within(history).findByText('No notes or contact history yet.')
    fireEvent.change(within(history).getByLabelText('When'), { target: { value: '2099-01-01T09:00' } })
    fireEvent.change(within(history).getByLabelText('Your note'), { target: { value: 'Dated by mistake.' } })
    fireEvent.click(within(history).getByRole('button', { name: 'Add note' }))
    expect(within(history).getByText('This date is in the future. Choose when it happened.')).toBeTruthy()
    expect(fake.api.createNote).not.toHaveBeenCalled()
  })

  it('edits an entry and marks it as edited', async () => {
    const history = await open(daniel.id)
    await within(history).findByText(/family bible/)
    fireEvent.click(within(history).getByRole('button', { name: /^Edit note from/ }))
    const editor = within(history).getByRole('form', { name: 'Edit note' })
    fireEvent.change(within(editor).getByLabelText('Note'), { target: { value: 'Received the family bible scans.' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))

    expect(await within(history).findByText('Received the family bible scans.')).toBeTruthy()
    expect(within(history).getByText(/^Edited /)).toBeTruthy()
    const saved = fake.notes().find((n) => n.body === 'Received the family bible scans.')
    expect(saved?.clientId).toBe(daniel.id)
  })

  it('asks before discarding an edit, and keeps the text if you go back', async () => {
    const history = await open(daniel.id)
    await within(history).findByText(/family bible/)
    fireEvent.click(within(history).getByRole('button', { name: /^Edit note from/ }))
    const editor = within(history).getByRole('form', { name: 'Edit note' })
    fireEvent.change(within(editor).getByLabelText('Note'), { target: { value: 'Half-written change' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))

    const dialog = screen.getByRole('alertdialog', { name: 'Discard your changes?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect((within(editor).getByLabelText('Note') as HTMLTextAreaElement).value).toBe('Half-written change')

    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }))
    expect(within(history).getByText(/family bible/)).toBeTruthy()
    expect(fake.api.updateNote).not.toHaveBeenCalled()
  })

  it('keeps typed text when saving fails', async () => {
    const history = await open(grace.id)
    await within(history).findByText('No notes or contact history yet.')
    fake.state.failing = true
    fireEvent.change(within(history).getByLabelText('Your note'), { target: { value: 'Important detail.' } })
    fireEvent.click(within(history).getByRole('button', { name: 'Add note' }))

    expect(await within(history).findByText(/Couldn’t save this entry/)).toBeTruthy()
    expect((within(history).getByLabelText('Your note') as HTMLTextAreaElement).value).toBe('Important detail.')
  })

  it('shows archive and restore as system entries that cannot be edited, and is read-only while archived', async () => {
    const history = await open(daniel.id)
    await within(history).findByText(/family bible/)
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive client' }))

    expect(await within(history).findByText('Archived.')).toBeTruthy()
    expect(within(history).queryByLabelText('Your note')).toBeNull()
    expect(within(history).queryByRole('button', { name: /^Edit/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Restore client' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore client' }))
    expect(await within(history).findByText('Restored.')).toBeTruthy()
    const editButtons = within(history).getAllByRole('button', { name: /^Edit/ })
    expect(editButtons).toHaveLength(1)
  })

  it('explains when notes cannot be loaded and retries', async () => {
    vi.mocked(fake.api.listNotes).mockRejectedValueOnce(new Error('IPC request rejected: internal-error'))
    const history = await open(lucia.id)
    expect(await within(history).findByText('Notes couldn’t be loaded')).toBeTruthy()
    fireEvent.click(within(history).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(history).getByText(/Repeat client/)).toBeTruthy())
  })
})
