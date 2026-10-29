// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import type { Client } from '../../src/shared/client-model'
import { createFakeApi } from './fakeApi'

// Profile view against an in-memory stand-in for the main process. Fictional data only.

const base = {
  sourceDetail: null,
  fiverrUsername: null,
  email: null,
  otherContact: null,
  preferredContactChannel: 'unspecified',
  status: 'active',
  createdAt: '2026-03-01T10:00:00.000Z',
  updatedAt: '2026-03-01T10:00:00.000Z',
  archivedAt: null
} as const

const full: Client = {
  ...base,
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Rosa Ficticia',
  source: 'referral',
  sourceDetail: 'Referred by a previous client',
  fiverrUsername: 'rosa_demo',
  email: 'rosa.example@example.com',
  otherContact: 'WhatsApp, evenings only',
  preferredContactChannel: 'email'
}

const sparse: Client = { ...base, id: '22222222-2222-4222-8222-222222222222', displayName: 'Solo Nombre', source: 'direct' }

const archived: Client = {
  ...base,
  id: '33333333-3333-4333-8333-333333333333',
  displayName: 'Archivada Ejemplo',
  source: 'fiverr',
  fiverrUsername: 'archived_demo',
  preferredContactChannel: 'fiverr',
  status: 'archived',
  updatedAt: '2026-06-15T12:00:00.000Z',
  archivedAt: '2026-06-15T12:00:00.000Z'
}

let fake: ReturnType<typeof createFakeApi>

beforeEach(() => {
  fake = createFakeApi([full, sparse, archived])
  vi.stubGlobal('tracingGuatemala', fake.api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function open(client: Client) {
  window.location.hash = `#/clients/${client.id}`
  render(<App />)
  return screen.findByRole('heading', { level: 1, name: client.displayName })
}

function detail(region: string, label: string): HTMLElement {
  const card = screen.getByRole('region', { name: region })
  const term = within(card).getByText(label, { selector: 'dt' })
  return term.nextElementSibling as HTMLElement
}

describe('client profile', () => {
  it('shows every v1 field for a complete profile', async () => {
    await open(full)
    expect(screen.getByText('Referral', { selector: '.source-tag' })).toBeTruthy()
    expect(screen.getByText('Active', { selector: '.badge' })).toBeTruthy()
    expect(detail('Contact', 'Fiverr').textContent).toBe('@rosa_demo')
    expect(detail('Contact', 'Email').textContent).toBe('rosa.example@example.com')
    expect(detail('Contact', 'Other').textContent).toBe('WhatsApp, evenings only')
    const email = within(screen.getByRole('region', { name: 'Contact' })).getByText('Email', { selector: 'dt' })
    expect(within(email).getByText('Preferred')).toBeTruthy()
    expect(detail('Details', 'Source details').textContent).toBe('Referred by a previous client')
  })

  it('uses plain placeholders for a sparse profile and never shows technical values', async () => {
    await open(sparse)
    expect(detail('Contact', 'Fiverr').textContent).toBe('Not added')
    expect(detail('Contact', 'Email').textContent).toBe('Not added')
    expect(detail('Contact', 'Other').textContent).toBe('Not added')
    expect(detail('Contact', 'Preferred').textContent).toBe('Not specified')
    expect(detail('Details', 'Source details').textContent).toBe('Not added')

    const text = document.body.textContent ?? ''
    for (const technical of ['null', 'undefined', 'unspecified', 'NaN', 'Invalid Date', sparse.id]) {
      expect(text).not.toContain(technical)
    }
  })

  it('shows archived profiles read-only, with the archive date and a restore action', async () => {
    await open(archived)
    expect(screen.getByText(/Archived on/)).toBeTruthy()
    expect(screen.getByText(/This profile is read-only/)).toBeTruthy()
    expect(screen.getByText('Archived', { selector: '.badge' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restore client' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Edit details' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
  })

  it('keeps orders and research cases as a labeled placeholder', async () => {
    await open(full)
    const orders = screen.getByRole('region', { name: 'Orders & research cases' })
    expect(within(orders).getByText(/Planned for a later phase/)).toBeTruthy()
    expect(within(orders).queryByRole('button')).toBeNull()
    expect(within(orders).queryByRole('link')).toBeNull()
  })

  it('opens directly from a link (as after a reload or restart) and reads the saved client', async () => {
    await open(sparse)
    await waitFor(() => expect(fake.api.getClient).toHaveBeenCalledWith(sparse.id))
  })

  it('shows the latest saved data, not a stale copy', async () => {
    const heading = open(full)
    fake.replace({ ...full, email: 'rosa.updated@example.com', updatedAt: '2026-10-29T12:00:00.000Z' })
    await heading
    await waitFor(() => expect(detail('Contact', 'Email').textContent).toBe('rosa.updated@example.com'))
  })

  it('explains an unknown client link', async () => {
    window.location.hash = '#/clients/44444444-4444-4444-8444-444444444444'
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Client not found' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to clients' })).toBeTruthy()
  })

  it('moves focus to the profile heading after archiving', async () => {
    const heading = await open(sparse)
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive client' }))
    await screen.findByText('Client archived.')
    await waitFor(() => expect(document.activeElement).toBe(heading))
  })

  it('is consistent with the directory after archiving', async () => {
    await open(sparse)
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive client' }))
    await screen.findByText('Client archived.')

    fireEvent.click(screen.getByRole('link', { name: '← Clients' }))
    const table = await screen.findByRole('table')
    await waitFor(() => expect(within(table).queryByRole('link', { name: sparse.displayName })).toBeNull())
    fireEvent.click(screen.getByLabelText('Archived'))
    expect(await screen.findByRole('link', { name: sparse.displayName })).toBeTruthy()
  })
})
