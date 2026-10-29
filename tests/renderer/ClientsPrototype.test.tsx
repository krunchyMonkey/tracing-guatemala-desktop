// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'

beforeEach(() => {
  window.location.hash = '#/clients'
  vi.stubGlobal('tracingGuatemala', { getAppInfo: vi.fn().mockResolvedValue({ name: 'x', version: '0', platform: 'x' }) })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const rowNames = () =>
  within(screen.getByRole('table'))
    .getAllByRole('rowheader')
    .map((cell) => cell.textContent)

describe('client directory prototype', () => {
  it('lists active sample clients and hides archived ones by default', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'Clients' })).toBeTruthy()
    expect(rowNames()).toContain('Daniel Ochoa')
    expect(rowNames()).not.toContain('Tomás Herrera')
  })

  it('searches, filters by status, and explains when nothing matches', () => {
    render(<App />)
    fireEvent.change(screen.getByLabelText('Search clients'), { target: { value: 'tomas' } })
    expect(screen.getByRole('heading', { name: 'No matching clients' })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('All'))
    expect(rowNames()).toEqual(['Tomás Herrera'])

    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }))
    expect(rowNames()).not.toContain('Tomás Herrera')
  })

  it('shows a welcoming empty state when there are no clients', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Show empty directory' }))
    expect(screen.getByRole('heading', { name: 'No clients yet' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('add client prototype', () => {
  it('blocks saving without required fields and lists what to fix', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: /Add client/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))

    const summary = screen.getByText(/2 things need fixing/).closest('[role="alert"]') as HTMLElement
    expect(within(summary).getByText('Add a name so you can find this client later.')).toBeTruthy()
    expect(within(summary).getByText('Choose where this client came from.')).toBeTruthy()
    expect(screen.getByLabelText(/^Name/).getAttribute('aria-invalid')).toBe('true')
  })

  it('warns about a possible duplicate, including archived clients, and can save anyway', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: /Add client/ }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Tomas Herrera' } })
    fireEvent.click(screen.getByLabelText('Referral'))
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))

    expect(screen.getByText('This might be someone you already have')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open to restore' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save as a new client anyway' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Tomas Herrera' })).toBeTruthy()
    expect(screen.getByText('Client added.')).toBeTruthy()
  })

  it('keeps the form when a save fails', () => {
    render(<App />)
    fireEvent.click(screen.getByLabelText('Simulate save errors'))
    fireEvent.click(screen.getByRole('link', { name: /Add client/ }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Nueva Clienta' } })
    fireEvent.click(screen.getByLabelText('Fiverr'))
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))

    expect(screen.getByText('Couldn’t save this client')).toBeTruthy()
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Nueva Clienta')
  })

  it('asks before discarding unsaved changes', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: /Add client/ }))
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    const dialog = screen.getByRole('alertdialog', { name: 'Discard your changes?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Draft')
  })
})

describe('client profile prototype', () => {
  function openProfile(name: string) {
    render(<App />)
    fireEvent.click(screen.getByLabelText('All'))
    fireEvent.click(screen.getByRole('link', { name }))
  }

  it('shows contact details, blanks for missing fields, and history', () => {
    openProfile('Lucía Fernández (Quetzaltenango line)')
    const contact = screen.getByRole('region', { name: 'Contact' })
    expect(within(contact).getByText('@lucia_roots_demo')).toBeTruthy()
    expect(within(contact).getByText('Not added')).toBeTruthy()
    expect(screen.getByText(/Repeat client: sent a custom offer/)).toBeTruthy()
  })

  it('archives after confirmation, becomes read-only, and restores', () => {
    openProfile('Daniel Ochoa')
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Archive Daniel Ochoa?' })
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive client' }))

    expect(screen.getByText(/This profile is read-only/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Edit details' })).toBeNull()
    expect(screen.queryByLabelText('Your note')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Restore client' }))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore client' })
    )
    expect(screen.getByText('Client restored.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Edit details' })).toBeTruthy()
  })

  it('adds a note and a logged contact entry', () => {
    openProfile('Grace Whitfield')
    expect(screen.getByText('No notes or contact history yet.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    expect(screen.getByText('Write something before adding it.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Your note'), { target: { value: 'Asked about the 1890s census.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    expect(screen.getByText('Asked about the 1890s census.')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Logged contact'))
    fireEvent.change(screen.getByLabelText('What was said'), { target: { value: 'Sent a status update.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add contact entry' }))
    fireEvent.click(screen.getByLabelText('Contact log'))
    const history = screen.getByRole('region', { name: 'Notes & contact history' })
    expect(within(history).getByText('Sent a status update.')).toBeTruthy()
    expect(within(history).queryByText('Asked about the 1890s census.')).toBeNull()
  })
})
