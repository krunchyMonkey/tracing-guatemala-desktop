// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'

beforeEach(() => {
  window.location.hash = ''
  vi.stubGlobal('tracingGuatemala', {
    getAppInfo: vi.fn().mockResolvedValue({ name: 'Tracing Guatemala', version: '0.1.0', platform: 'win32' })
  })
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
    expect(screen.getByRole('heading', { level: 1, name: 'Clients' })).toBeTruthy()

    fireEvent.click(within(nav, 'Settings & Backup'))
    expect(screen.getByRole('heading', { level: 1, name: 'Settings & Backup' })).toBeTruthy()
    expect((await screen.findByTestId('app-version')).textContent).toBe('Tracing Guatemala version 0.1.0')

    fireEvent.click(within(nav, 'Home'))
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy()
  })

  it('shows a friendly message when app info cannot be loaded', async () => {
    vi.stubGlobal('tracingGuatemala', { getAppInfo: vi.fn().mockRejectedValue(new Error('rejected')) })
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
