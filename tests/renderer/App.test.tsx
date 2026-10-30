// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createFakeApi } from './fakeApi'

beforeEach(() => {
  window.location.hash = ''
  vi.stubGlobal('tracingGuatemala', createFakeApi().api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App navigation', () => {
  it('starts on the home screen', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy()
  })

  it('navigates between the placeholder screens', async () => {
    render(<App />)
    const nav = screen.getByRole('navigation', { name: 'Main' })

    fireEvent.click(within(nav, 'Clients'))
    expect(await screen.findByRole('heading', { level: 1, name: 'Clients' })).toBeTruthy()

    fireEvent.click(within(nav, 'Settings & Backup'))
    expect(screen.getByRole('heading', { level: 1, name: 'Settings & Backup' })).toBeTruthy()
    expect((await screen.findByTestId('app-version')).textContent).toBe('Tracing Guatemala version 0.1.0')

    fireEvent.click(within(nav, 'Home'))
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy()
  })

  it('shows future phases as disabled, non-routed Coming Soon items', () => {
    render(<App />)
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(screen.getByRole('heading', { name: /Coming soon/i })).toBeTruthy()

    const upcoming = [
      ['Evidence Library', 3],
      ['Document AI', 4],
      ['Client Reports', 5],
      ['Family Trees', 6],
      ['Research Copilot', 7],
      ['Integrations', 8],
      ['Business Tools', 9]
    ] as const

    for (const [label, phase] of upcoming) {
      const button = screen.getByRole('button', { name: `${label}, coming soon in Phase ${phase}` })
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(button.querySelector('svg[aria-hidden="true"]')).toBeTruthy()
      expect(Array.from(nav.querySelectorAll('a')).some((link) => link.textContent === label)).toBe(false)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Family Trees, coming soon in Phase 6' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy()
  })

  it('shows a friendly message when app info cannot be loaded', async () => {
    const { api } = createFakeApi()
    vi.mocked(api.getAppInfo).mockRejectedValue(new Error('rejected'))
    vi.stubGlobal('tracingGuatemala', api)
    window.location.hash = '#/settings'
    render(<App />)
    expect(await screen.findByText('Version information is unavailable.')).toBeTruthy()
  })

  it('redirects unknown routes home', () => {
    window.location.hash = '#/does-not-exist'
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy()
  })
})

function within(container: HTMLElement, linkName: string): HTMLElement {
  const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === linkName)
  if (!link) throw new Error(`No navigation link named ${linkName}`)
  return link
}
