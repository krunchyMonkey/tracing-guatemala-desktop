// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { describeFailure, refusalKind } from '../../src/renderer/src/runtime/errorText'
import type { AppRuntime } from '../../src/renderer/src/runtime/AppRuntime'
import { LiveApiError } from '../../src/renderer/src/web/liveApi'
import { createFakeApi } from './fakeApi'
import { emptySummary } from './fixtures/studio'

// #246-a: the host-session notice and the plain-language refusal text. Fictional data only.

const NOTICE = /host session manages the app .* can’t open research once accounts exist/

function liveRuntime(research: 'own' | 'all' | 'none' | undefined, overrides: Partial<ReturnType<typeof createFakeApi>['api']> = {}): AppRuntime {
  const fake = createFakeApi()
  return {
    mode: 'live',
    data: { ...fake.api, ...overrides },
    backup: fake.api,
    cases: { getStudioSummary: async () => emptySummary() } as never,
    switcher: { kind: 'unavailable', reason: 'not-available' },
    ...(research ? { research } : {})
  }
}

beforeEach(() => {
  vi.stubGlobal('tracingGuatemala', createFakeApi().api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('host research notice', () => {
  for (const [hash, heading] of [
    ['#/', 'Welcome'],
    ['#/clients', 'Clients']
  ] as const) {
    it(`shows on ${heading} for research none`, async () => {
      window.location.hash = hash
      render(<App runtime={liveRuntime('none')} />)
      await screen.findByRole('heading', { level: 1, name: heading })
      expect(screen.getByRole('note').textContent).toMatch(NOTICE)
      expect(screen.getByRole('note').textContent).toContain('Sign in with your Google account')
    })

    for (const research of ['own', 'all', undefined] as const) {
      it(`does not show on ${heading} for research ${String(research)}`, async () => {
        window.location.hash = hash
        render(<App runtime={liveRuntime(research)} />)
        await screen.findByRole('heading', { level: 1, name: heading })
        expect(screen.queryByRole('note')).toBeNull()
      })
    }
  }
})

describe('refusal text', () => {
  it('maps the three known codes and keeps a generic fallback, never echoing a code', () => {
    for (const code of ['owner-required', 'research-unavailable', 'forbidden']) {
      const text = describeFailure(new LiveApiError(code), 'generic')
      expect(text).not.toBe('generic')
      expect(text).not.toContain(code)
    }
    expect(describeFailure(new LiveApiError('http-500'), 'generic')).toBe('generic')
    expect(describeFailure(new Error('owner-required'), 'generic')).toBe('generic')
    expect(describeFailure(undefined, 'generic')).toBe('generic')
    expect(refusalKind(new LiveApiError('forbidden'))).toBe('forbidden')
  })
})

describe('client form refusal', () => {
  it('shows the mapped message for owner-required and keeps what was typed', async () => {
    window.location.hash = '#/clients/new'
    const createClient = vi.fn().mockRejectedValue(new LiveApiError('owner-required'))
    render(<App runtime={liveRuntime('none', { createClient })} />)
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Alfa Client' } })
    fireEvent.click(screen.getByLabelText('Fiverr'))
    fireEvent.click(screen.getByRole('button', { name: 'Save client' }))
    await waitFor(() => expect(createClient).toHaveBeenCalled())
    const alert = await screen.findByText(/host session can’t add or change research/)
    expect(alert.textContent).not.toContain('owner-required')
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Alfa Client')
  })
})
