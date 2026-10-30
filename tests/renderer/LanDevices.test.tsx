// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import type { AppRuntime, LanAdminApi, LanDevice } from '../../src/renderer/src/runtime/AppRuntime'
import { EnrollDevice } from '../../src/renderer/src/web/EnrollDevice'
import { createLiveApi, enrollDevice, LiveApiError } from '../../src/renderer/src/web/liveApi'
import { createFakeApi } from './fakeApi'
import { emptySummary } from './fixtures/studio'

// Home-network device enrollment (#136): the enrollment form, a paired device's
// Settings and the host's device panel. Fictional data only.

const switcher = { kind: 'unavailable', reason: 'not-available' } as const

beforeEach(() => {
  vi.stubGlobal('tracingGuatemala', createFakeApi().api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('enrollment form', () => {
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

  it('shows the unencrypted-HTTP notice and no private-link text', () => {
    render(<EnrollDevice enroll={vi.fn()} onDone={vi.fn()} />)
    expect(
      screen.getByText('Unencrypted HTTP — trusted home network only. The pairing code, your session and everything you open travel unencrypted.')
    ).toBeTruthy()
    expect(screen.queryByText(/private link/i)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('sends the code and name, then reloads on success', async () => {
    const enroll = vi.fn(async () => undefined)
    const onDone = vi.fn()
    render(<EnrollDevice enroll={enroll} onDone={onDone} />)
    const submit = screen.getByRole('button', { name: 'Pair this device' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    type('Pairing code', 'abcd-efgh')
    type('Device name (optional)', 'Kitchen tablet')
    fireEvent.click(submit)
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    expect(enroll).toHaveBeenCalledWith('abcd-efgh', 'Kitchen tablet')
  })

  it.each([
    ['invalid-code', /That code didn’t work/],
    ['too-many-attempts', /Too many tries/],
    ['too-many-devices', /most devices paired/],
    ['unreachable', /can’t be reached/]
  ])('explains %s', async (code, message) => {
    const onDone = vi.fn()
    render(<EnrollDevice enroll={async () => Promise.reject(new LiveApiError(code))} onDone={onDone} />)
    type('Pairing code', 'ABCD-EFGH')
    fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }))
    expect(await screen.findByText(message)).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.queryByText(/private link/i)).toBeNull()
  })

  it('posts JSON to the enrollment endpoint and maps failures to codes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"error":"invalid-code"}', { status: 401 }))
    await expect(enrollDevice('ABCD-EFGH', ' ', fetchImpl)).rejects.toEqual(new LiveApiError('invalid-code'))
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/v1/lan/enroll')
    expect(JSON.parse(init!.body as string)).toEqual({ code: 'ABCD-EFGH' })
    await expect(enrollDevice('x', 'Tablet', async () => Promise.reject(new TypeError('fetch failed')))).rejects.toEqual(new LiveApiError('unreachable'))
  })
})

describe('a paired device', () => {
  function remote(signOut = vi.fn(async () => undefined)) {
    const fake = createFakeApi()
    const runtime: AppRuntime = {
      mode: 'live',
      data: fake.api,
      backup: null,
      backupStatus: null,
      cases: { getStudioSummary: async () => emptySummary() } as never,
      switcher,
      remote: true,
      signOut
    }
    return { runtime, signOut }
  }

  it('sees no backup controls and can sign out', async () => {
    const { runtime, signOut } = remote()
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, hash: '#/settings', reload })
    render(<App runtime={runtime} />)
    expect(await screen.findByText('Backups are managed on the researcher’s computer.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Create backup/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Restore from backup/ })).toBeNull()
    expect(screen.queryByText('Home-network devices')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out this device' }))
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce())
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  })

  it('logs out through the logout endpoint with the CSRF token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"result":{"ok":true}}', { status: 200 }))
    const api = createLiveApi({ csrfToken: 'csrf-1', onSessionLost: vi.fn(), fetchImpl })
    await api.signOut()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/v1/lan/logout')
    expect(init).toMatchObject({ method: 'POST', headers: { 'X-TG-CSRF': 'csrf-1' } })
  })
})

describe('host device panel', () => {
  const device = (id: string, name: string): LanDevice => ({ id, name, enrolledAt: '2026-10-30T09:00:00.000Z', lastSeenAt: '2026-10-30T09:30:00.000Z' })

  function host(enabled: boolean, initial: LanDevice[] = []) {
    let devices = [...initial]
    const lan: LanAdminApi = {
      getLanStatus: vi.fn(async () => ({ enabled, origin: enabled ? 'http://192.168.1.20:4180' : null })),
      createPairingCode: vi.fn(async () => ({ code: 'ABCD-EFGH', expiresAt: '2026-10-30T09:05:00.000Z' })),
      listDevices: vi.fn(async () => devices),
      revokeDevice: vi.fn(async (id: string) => {
        const before = devices.length
        devices = devices.filter((d) => d.id !== id)
        return { revoked: devices.length < before }
      }),
      revokeAllDevices: vi.fn(async () => {
        const count = devices.length
        devices = []
        return { revoked: count }
      }),
      disableLan: vi.fn(async () => ({ disabled: true }))
    }
    const fake = createFakeApi()
    const runtime: AppRuntime = {
      mode: 'live',
      data: fake.api,
      backup: fake.api,
      backupStatus: null,
      cases: { getStudioSummary: async () => emptySummary() } as never,
      switcher,
      lan
    }
    return { lan, runtime }
  }

  function open(runtime: AppRuntime) {
    window.location.hash = '#/settings'
    return render(<App runtime={runtime} />)
  }

  it('is hidden when the home-network listener is off', async () => {
    const { runtime, lan } = host(false)
    open(runtime)
    await screen.findByTestId('app-version')
    await waitFor(() => expect(lan.getLanStatus).toHaveBeenCalled())
    expect(screen.queryByText('Home-network devices')).toBeNull()
    expect(lan.listDevices).not.toHaveBeenCalled()
  })

  it('shows the code only on request, lists devices, revokes one and all', async () => {
    const { runtime, lan } = host(true, [device('id-1', 'Kitchen tablet'), device('id-2', 'Hall phone')])
    open(runtime)
    expect(await screen.findByText('Home-network devices')).toBeTruthy()
    expect(screen.getByText(/encrypt anything/)).toBeTruthy()
    expect(screen.queryByTestId('pairing-code')).toBeNull()
    expect(await screen.findByText('Kitchen tablet')).toBeTruthy()
    expect(screen.getByText('Hall phone')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Show pairing code' }))
    const shown = await screen.findByTestId('pairing-code')
    expect(shown.textContent).toContain('ABCD-EFGH')
    expect(shown.textContent).toContain('Expires in 5 minutes')

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Kitchen tablet' }))
    await waitFor(() => expect(screen.queryByText('Kitchen tablet')).toBeNull())
    expect(lan.revokeDevice).toHaveBeenCalledWith('id-1')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out all devices' }))
    await waitFor(() => expect(screen.getByText('No devices are paired.')).toBeTruthy())
    expect(lan.revokeAllDevices).toHaveBeenCalledOnce()
  })

  it('shows no session id, cookie or launch token', async () => {
    const { runtime } = host(true, [device('id-1', 'Kitchen tablet')])
    const { container } = open(runtime)
    await screen.findByText('Kitchen tablet')
    expect(container.textContent).not.toMatch(/tg_lan|tg_live|launch|token=|cookie/i)
  })
})
