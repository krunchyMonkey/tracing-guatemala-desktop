// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { HttpRiskBanner } from '../../src/renderer/src/components/HttpRiskBanner'
import type { AppRuntime, LanAdminApi } from '../../src/renderer/src/runtime/AppRuntime'
import { EnrollDevice } from '../../src/renderer/src/web/EnrollDevice'
import { isEncryptedTransport } from '../../src/renderer/src/runtime/transport'
import { createFakeApi } from './fakeApi'
import { emptySummary } from './fixtures/studio'

// Transport wording (#167): device pages follow the page's own scheme, the host's
// Settings follows the LAN origin. Fictional values only.

const HTTP_UNENCRYPTED = 'Unencrypted HTTP — trusted home network only. The pairing code, your session and everything you open travel unencrypted.'

beforeEach(() => {
  vi.stubGlobal('tracingGuatemala', createFakeApi().api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each([
  ['http:', false],
  ['https:', true]
])('page scheme %s', (protocol, encrypted) => {
  beforeEach(() => {
    vi.stubGlobal('location', { ...window.location, protocol })
  })

  it('reports the transport', () => {
    expect(isEncryptedTransport()).toBe(encrypted)
  })

  it('words the pairing page to match', () => {
    render(<EnrollDevice enroll={vi.fn()} onDone={vi.fn()} />)
    if (encrypted) {
      expect(screen.getByText('Encrypted connection')).toBeTruthy()
      expect(screen.getByText(/encrypted in transit/)).toBeTruthy()
      expect(screen.queryByText(/Unencrypted/)).toBeNull()
    } else {
      expect(screen.getByText(HTTP_UNENCRYPTED)).toBeTruthy()
    }
  })

  it('words the banner to match', () => {
    render(<HttpRiskBanner />)
    if (encrypted) {
      expect(screen.getByText('Encrypted (HTTPS) — home network only · fictional test data only')).toBeTruthy()
      expect(screen.queryByText(/Unencrypted/)).toBeNull()
    } else {
      expect(screen.getByText('Unencrypted HTTP — trusted home network only')).toBeTruthy()
    }
  })
})

describe('host Settings', () => {
  function open(origin: string) {
    const lan: LanAdminApi = {
      getLanStatus: vi.fn(async () => ({ enabled: true, origin })),
      createPairingCode: vi.fn(async () => ({ code: 'ABCD-EFGH', expiresAt: '2026-10-30T09:05:00.000Z' })),
      listDevices: vi.fn(async () => []),
      revokeDevice: vi.fn(async () => ({ revoked: false })),
      revokeAllDevices: vi.fn(async () => ({ revoked: 0 })),
      disableLan: vi.fn(async () => ({ disabled: true }))
    }
    const fake = createFakeApi()
    const runtime: AppRuntime = {
      mode: 'live',
      data: fake.api,
      backup: fake.api,
      backupStatus: null,
      cases: { getStudioSummary: async () => emptySummary() } as never,
      switcher: { kind: 'unavailable', reason: 'not-available' },
      lan
    }
    window.location.hash = '#/settings'
    render(<App runtime={runtime} />)
    return lan
  }

  it('shows the HTTPS wording for an https origin', async () => {
    const lan = open('https://tg.example.com')
    await waitFor(() => expect(lan.getLanStatus).toHaveBeenCalled())
    expect(await screen.findByText('HTTPS — home network only.')).toBeTruthy()
    expect(screen.getByText(/encrypted by the\s+local reverse proxy/)).toBeTruthy()
    expect(screen.queryByText(/encrypt anything/)).toBeNull()
  })

  it('keeps the unencrypted wording for an http origin', async () => {
    open('http://192.168.1.20:4180')
    expect(await screen.findByText(/encrypt anything/)).toBeTruthy()
    expect(screen.getByText('Unencrypted HTTP — trusted home network only.')).toBeTruthy()
  })
})
