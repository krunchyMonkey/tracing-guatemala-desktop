// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createFakeApi } from './fakeApi'
import { ARCHIVED_COUNT, MANY_CLIENTS, manyClients } from './fixtures/manyClients'

// Client screens against an in-memory stand-in for the main process. Fictional data only.

let fake: ReturnType<typeof createFakeApi>

beforeEach(() => {
  window.location.hash = '#/clients'
  fake = createFakeApi()
  vi.stubGlobal('tracingGuatemala', fake.api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function rowNames() {
  const table = await screen.findByRole('table')
  return within(table)
    .getAllByRole('rowheader')
    .map((cell) => cell.textContent)
}

async function openProfile(name: string) {
  render(<App />)
  fireEvent.click(await screen.findByLabelText('All'))
  // Directory results arrive asynchronously from the main process.
  fireEvent.click(await screen.findByRole('link', { name }))
  await screen.findByRole('heading', { level: 1, name })
}

function clientNamed(name: string) {
  const client = fake.clients().find((c) => c.displayName === name)
  if (!client) throw new Error(`No fictional client named ${name}`)
  return client
}

describe('client directory', () => {
  it('lists saved active clients and hides archived ones by default', async () => {
    render(<App />)
    const names = await rowNames()
    expect(names).toContain('Daniel Ochoa')
    expect(names).not.toContain('Tomás Herrera')
  })

  it('searches, filters by status, and explains when nothing matches', async () => {
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Search clients'), { target: { value: 'tomas' } })
    expect(await screen.findByRole('heading', { name: 'No matching clients' })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('All'))
    expect(await rowNames()).toEqual(['Tomás Herrera'])

    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }))
    expect(await rowNames()).not.toContain('Tomás Herrera')
  })

  it('shows a welcoming empty state when there are no clients', async () => {
    fake = createFakeApi([])
    vi.stubGlobal('tracingGuatemala', fake.api)
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'No clients yet' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('explains a failed load and retries', async () => {
    fake.state.failing = true
    render(<App />)
    expect(await screen.findByText('Your clients couldn’t be loaded')).toBeTruthy()

    fake.state.failing = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await rowNames()).toContain('Daniel Ochoa')
  })
})

describe('add and edit client', () => {
  it('blocks saving without required fields and lists what to fix', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('link', { name: /Add client/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))

    const summary = screen.getByText(/2 things need fixing/).closest('[role="alert"]') as HTMLElement
    expect(within(summary).getByText('Add a name so you can find this client later.')).toBeTruthy()
    expect(within(summary).getByText('Choose where this client came from.')).toBeTruthy()
    expect(screen.getByLabelText(/^Name/).getAttribute('aria-invalid')).toBe('true')
    expect(fake.api.createClient).not.toHaveBeenCalled()
  })

  it('saves a new client through the main process', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('link', { name: /Add client/ }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: '  Nueva   Clienta ' } })
    fireEvent.click(screen.getByLabelText('Fiverr'))
    fireEvent.change(screen.getByLabelText(/^Fiverr username/), { target: { value: '@nueva_demo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Nueva Clienta' })).toBeTruthy()
    expect(screen.getByText('Client added.')).toBeTruthy()
    expect(fake.api.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Nueva Clienta', fiverrUsername: 'nueva_demo', source: 'fiverr' })
    )
    expect(clientNamed('Nueva Clienta').status).toBe('active')
  })

  it('warns about a possible duplicate, including archived clients, and can save anyway', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('link', { name: /Add client/ }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Tomas Herrera' } })
    fireEvent.click(screen.getByLabelText('Referral'))
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))

    expect(screen.getByText('This might be someone you already have')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open to restore' })).toBeTruthy()
    expect(fake.api.createClient).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save as a new client anyway' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Tomas Herrera' })).toBeTruthy()
    expect(screen.getByText('Client added.')).toBeTruthy()
  })

  it('keeps everything typed when a save fails, and saves on retry', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('link', { name: /Add client/ }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Nueva Clienta' } })
    fireEvent.click(screen.getByLabelText('Fiverr'))

    fake.state.failing = true
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))
    expect(await screen.findByText('Couldn’t save this client')).toBeTruthy()
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Nueva Clienta')
    expect(fake.clients().some((c) => c.displayName === 'Nueva Clienta')).toBe(false)

    fake.state.failing = false
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Nueva Clienta' })).toBeTruthy()
  })

  it('shows rule errors returned by the main process', async () => {
    vi.mocked(fake.api.createClient).mockResolvedValueOnce({
      ok: false,
      reason: 'invalid',
      issues: [{ field: 'email', severity: 'error', code: 'invalid-format' }]
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('link', { name: /Add client/ }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Nueva Clienta' } })
    fireEvent.click(screen.getByLabelText('Direct'))
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))

    const summary = (await screen.findByText(/One thing needs fixing/)).closest('[role="alert"]') as HTMLElement
    expect(within(summary).getByText("This email address doesn't look complete.")).toBeTruthy()
  })

  it('edits a client and keeps its id', async () => {
    await openProfile('Daniel Ochoa')
    const { id } = clientNamed('Daniel Ochoa')
    fireEvent.click(screen.getByRole('link', { name: 'Edit details' }))
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Daniel O.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Daniel O.' })).toBeTruthy()
    expect(screen.getByText('Changes saved.')).toBeTruthy()
    expect(fake.api.updateClient).toHaveBeenCalledWith(id, expect.objectContaining({ displayName: 'Daniel O.' }))
    expect(clientNamed('Daniel O.').id).toBe(id)
  })

  it('asks before discarding unsaved changes', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('link', { name: /Add client/ }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    const dialog = screen.getByRole('alertdialog', { name: 'Discard your changes?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Draft')
  })

  it('shows saved data after the app restarts', async () => {
    await openProfile('Daniel Ochoa')
    fireEvent.click(screen.getByRole('link', { name: 'Edit details' }))
    fireEvent.change(await screen.findByLabelText(/^Email/), { target: { value: 'daniel.new@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Changes saved.')

    cleanup()
    window.location.hash = '#/clients'
    render(<App />)
    fireEvent.click(await screen.findByRole('link', { name: 'Daniel Ochoa' }))
    const contact = await screen.findByRole('region', { name: 'Contact' })
    expect(within(contact).getByText('daniel.new@example.com')).toBeTruthy()
  })
})

describe('client profile', () => {
  it('shows contact details and blanks for missing fields', async () => {
    await openProfile('Lucía Fernández (Quetzaltenango line)')
    const contact = screen.getByRole('region', { name: 'Contact' })
    expect(within(contact).getByText('@lucia_roots_demo')).toBeTruthy()
    expect(within(contact).getByText('Not added')).toBeTruthy()
  })

  it('archives after confirmation, becomes read-only, and restores with the same id', async () => {
    await openProfile('Daniel Ochoa')
    const { id } = clientNamed('Daniel Ochoa')
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Archive Daniel Ochoa?' })
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive client' }))

    expect(await screen.findByText(/This profile is read-only/)).toBeTruthy()
    expect(fake.api.archiveClient).toHaveBeenCalledWith(id)
    expect(screen.queryByRole('link', { name: 'Edit details' })).toBeNull()
    expect(screen.queryByLabelText('Your note')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Restore client' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore client' }))
    expect(await screen.findByText('Client restored.')).toBeTruthy()
    expect(fake.api.restoreClient).toHaveBeenCalledWith(id)
    expect(clientNamed('Daniel Ochoa')).toMatchObject({ id, status: 'active', archivedAt: null })
    expect(screen.getByRole('link', { name: 'Edit details' })).toBeTruthy()
  })

  it('keeps the client unchanged when archiving fails', async () => {
    await openProfile('Daniel Ochoa')
    fake.state.failing = true
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive client' }))
    expect(await screen.findByText('That didn’t work')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Edit details' })).toBeTruthy()
    expect(clientNamed('Daniel Ochoa').status).toBe('active')
  })
})

describe('directory with many clients', () => {
  beforeEach(() => {
    fake = createFakeApi(manyClients())
    vi.stubGlobal('tracingGuatemala', fake.api)
  })

  it('runs searches in the main process and shows the count', async () => {
    render(<App />)
    expect(await screen.findByText(`${MANY_CLIENTS - ARCHIVED_COUNT} clients`)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search clients'), { target: { value: 'maria lopez' } })
    expect(await screen.findByText(/^3 clients/)).toBeTruthy()
    expect(fake.api.listClients).toHaveBeenLastCalledWith({
      text: 'maria lopez',
      status: 'active',
      sources: [],
      sort: 'name'
    })
  })

  it('keeps search and filters when going to a profile and back', async () => {
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Search clients'), { target: { value: 'perez' } })
    fireEvent.click(screen.getByLabelText('Referral'))
    fireEvent.click(screen.getByLabelText('All'))
    await waitFor(async () => expect((await rowNames()).length).toBeLessThan(MANY_CLIENTS))
    const first = (await rowNames())[0]!
    fireEvent.click(screen.getByRole('link', { name: first }))
    await screen.findByRole('heading', { level: 1, name: first })

    fireEvent.click(screen.getByRole('link', { name: '← Clients' }))
    expect(((await screen.findByLabelText('Search clients')) as HTMLInputElement).value).toBe('perez')
    expect((screen.getByLabelText('Referral') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('All') as HTMLInputElement).checked).toBe(true)
  })

  it('shows an error with retry when a search fails, keeping the last results', async () => {
    render(<App />)
    await screen.findByText(`${MANY_CLIENTS - ARCHIVED_COUNT} clients`)
    fake.state.failing = true
    fireEvent.change(screen.getByLabelText('Search clients'), { target: { value: 'ana' } })
    expect(await screen.findByText('Search isn’t working right now')).toBeTruthy()
    expect(screen.getByRole('table')).toBeTruthy()

    fake.state.failing = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByText('Search isn’t working right now')).toBeNull())
    expect((await rowNames()).every((name) => name?.startsWith('Ana'))).toBe(true)
  })
})
