// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { ModeSwitcher } from '../../src/renderer/src/components/ModeSwitcher'
import { demoModeSwitch } from '../../src/renderer/src/demo/modeLink'
import { AppRuntimeProvider, type AppRuntime, type LanAdminApi, type LanDevice, type ModeSwitch } from '../../src/renderer/src/runtime/AppRuntime'
import { EnrollDevice } from '../../src/renderer/src/web/EnrollDevice'
import { HostUnreachable } from '../../src/renderer/src/web/HostUnreachable'
import { liveModeSwitch, validDemoHref } from '../../src/renderer/src/web/demoLink'
import { createLiveApi, LiveApiError } from '../../src/renderer/src/web/liveApi'
import { createFakeApi } from './fakeApi'
import { emptySummary } from './fixtures/studio'

// Home-network UX (#137): remote indicator and badges, recovery messages, the
// host's operational controls and every Demo/Live switch rule on the LAN.
// Fictional data only.

const HTTP_TEXT = 'Unencrypted HTTP — trusted home network only'
const unavailable: ModeSwitch = { kind: 'unavailable', reason: 'not-available' }

beforeEach(() => {
  window.location.hash = ''
  vi.stubGlobal('tracingGuatemala', createFakeApi().api)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const liveRuntime = (extra: Partial<Extract<AppRuntime, { mode: 'live' }>> = {}, switcher: ModeSwitch = unavailable): AppRuntime => ({
  mode: 'live',
  data: createFakeApi().api,
  backup: null,
  backupStatus: null,
  cases: { getStudioSummary: async () => emptySummary() } as never,
  switcher,
  ...extra
})

describe('badges', () => {
  it('names where each mode keeps its data', () => {
    const host = render(
      <AppRuntimeProvider runtime={liveRuntime()}>
        <ModeSwitcher />
      </AppRuntimeProvider>
    )
    expect(screen.getByText('Live · saved on this computer')).toBeTruthy()
    expect(screen.getByText('Demo not available')).toBeTruthy()
    host.unmount()

    const remote = render(
      <AppRuntimeProvider runtime={liveRuntime({ remote: true })}>
        <ModeSwitcher />
      </AppRuntimeProvider>
    )
    expect(screen.getByText('Live · saved on the researcher’s computer')).toBeTruthy()
    expect(screen.getByText('Demo not available from this device')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    remote.unmount()

    render(
      <AppRuntimeProvider runtime={{ mode: 'demo', data: createFakeApi().api, backup: null, cases: null, switcher: unavailable }}>
        <ModeSwitcher />
      </AppRuntimeProvider>
    )
    expect(screen.getByText('Demo · fictional, resets on refresh')).toBeTruthy()
  })

  it('links a remote Live page to the LAN demo', () => {
    render(
      <AppRuntimeProvider runtime={liveRuntime({ remote: true }, { kind: 'link', href: 'http://tg-demo.test:4181/' })}>
        <ModeSwitcher />
      </AppRuntimeProvider>
    )
    expect(screen.getByRole('link', { name: 'Open the fictional demo' }).getAttribute('href')).toBe('http://tg-demo.test:4181/')
  })
})

describe('the HTTP indicator', () => {
  it('shows on every page of a paired device and not on the host', async () => {
    const view = render(<App runtime={liveRuntime({ remote: true, signOut: async () => undefined })} />)
    for (const hash of ['#/', '#/clients', '#/cases', '#/settings']) {
      window.location.hash = hash
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      await waitFor(() => expect(screen.getByRole('note', { name: 'Connection warning' }).textContent).toBe(HTTP_TEXT))
    }
    view.unmount()

    render(<App runtime={liveRuntime()} />)
    await screen.findByRole('navigation', { name: 'Main' })
    expect(screen.queryByText(HTTP_TEXT)).toBeNull()
  })

  it('is also on the unreachable page and the enrollment page', () => {
    const view = render(<HostUnreachable onRetry={vi.fn()} />)
    expect(screen.getByRole('note', { name: 'Connection warning' }).textContent).toBe(HTTP_TEXT)
    view.unmount()
    render(<EnrollDevice enroll={vi.fn()} onDone={vi.fn()} />)
    expect(screen.getByText(new RegExp(`^${HTTP_TEXT}`))).toBeTruthy()
  })
})

describe('recovery messages', () => {
  it('says the host can’t be reached, offers Retry and never mentions the private link', () => {
    const retry = vi.fn()
    const { container } = render(<HostUnreachable onRetry={retry} />)
    expect(
      screen.getByText('Can’t reach the researcher’s computer. It may be asleep, stopped, or on a different network. Nothing you saved is lost.')
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(container.textContent).not.toMatch(/private link|launch/i)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('tells a paired device when a call can’t reach the host', async () => {
    const onUnreachable = vi.fn()
    const api = createLiveApi({
      csrfToken: 'csrf',
      onSessionLost: vi.fn(),
      onUnreachable,
      fetchImpl: async () => Promise.reject(new TypeError('fetch failed'))
    })
    await expect(api.data.getAppInfo()).rejects.toEqual(new LiveApiError('unreachable'))
    expect(onUnreachable).toHaveBeenCalledOnce()
  })

  it('does not call onUnreachable for an answer from the host', async () => {
    const onUnreachable = vi.fn()
    const onSessionLost = vi.fn()
    const api = createLiveApi({
      csrfToken: 'csrf',
      onSessionLost,
      onUnreachable,
      fetchImpl: async () => new Response('{"error":"not-signed-in"}', { status: 401 })
    })
    await expect(api.data.getAppInfo()).rejects.toEqual(new LiveApiError('not-signed-in'))
    expect(onSessionLost).toHaveBeenCalledOnce()
    expect(onUnreachable).not.toHaveBeenCalled()
  })

  it('sends an ended session back to enrollment with the session-ended message', () => {
    render(<EnrollDevice enroll={vi.fn()} onDone={vi.fn()} sessionEnded />)
    expect(screen.getByText('Your session ended. Ask for a new pairing code on the researcher’s computer.')).toBeTruthy()
    expect(screen.getByLabelText('Pairing code')).toBeTruthy()
    expect(screen.queryByText(/private link/i)).toBeNull()
  })

  it('shows no session-ended message on a fresh enrollment page', () => {
    render(<EnrollDevice enroll={vi.fn()} onDone={vi.fn()} />)
    expect(screen.queryByText(/Your session ended/)).toBeNull()
  })
})

describe('host operational panel', () => {
  const device = (id: string, name: string): LanDevice => ({ id, name, enrolledAt: '2026-10-30T09:00:00.000Z', lastSeenAt: '2026-10-30T09:30:00.000Z' })

  function host(disable: LanAdminApi['disableLan'] = vi.fn(async () => ({ disabled: true }))) {
    const lan: LanAdminApi = {
      getLanStatus: vi.fn(async () => ({ enabled: true, origin: 'http://192.168.1.20:4180' })),
      createPairingCode: vi.fn(async () => ({ code: 'ABCD-EFGH', expiresAt: '2026-10-30T09:05:00.000Z' })),
      listDevices: vi.fn(async () => [device('id-1', 'Kitchen tablet')]),
      revokeDevice: vi.fn(async () => ({ revoked: true })),
      revokeAllDevices: vi.fn(async () => ({ revoked: 1 })),
      disableLan: disable
    }
    window.location.hash = '#/settings'
    const view = render(<App runtime={liveRuntime({ backup: createFakeApi().api, lan })} />)
    return { lan, view }
  }

  it('shows the address, the warning and the instructions, with no code until asked', async () => {
    host()
    expect(await screen.findByText('Home-network devices')).toBeTruthy()
    expect(screen.getByTestId('lan-address').textContent).toBe('http://192.168.1.20:4180')
    expect(screen.getByText(new RegExp(HTTP_TEXT))).toBeTruthy()
    expect(screen.getByText(/open the address above/)).toBeTruthy()
    expect(screen.queryByTestId('pairing-code')).toBeNull()
  })

  it('copies the address only', async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    host()
    fireEvent.click(await screen.findByRole('button', { name: 'Copy address' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://192.168.1.20:4180'))
    expect(await screen.findByText('Address copied.')).toBeTruthy()
    // Even with a code on screen, only the address is copied.
    fireEvent.click(screen.getByRole('button', { name: 'Show pairing code' }))
    await screen.findByTestId('pairing-code')
    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText.mock.calls.every(([value]) => value === 'http://192.168.1.20:4180')).toBe(true)
  })

  it('says so when copying is not possible', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async () => Promise.reject(new Error('denied')) } })
    host()
    fireEvent.click(await screen.findByRole('button', { name: 'Copy address' }))
    expect(await screen.findByText(/Couldn’t copy/)).toBeTruthy()
  })

  it('turns access off only after a confirm step, then says how to turn it on again', async () => {
    const { lan } = host()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off home-network access' }))
    expect(lan.disableLan).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(lan.disableLan).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Turn off home-network access' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByText('Home-network access is off')).toBeTruthy()
    expect(lan.disableLan).toHaveBeenCalledOnce()
    expect(screen.getByText(/restart Tracing Guatemala with/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show pairing code' })).toBeNull()
  })

  it('keeps the controls and reports a failed turn-off', async () => {
    host(vi.fn(async () => Promise.reject(new Error('boom'))))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off home-network access' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show pairing code' })).toBeTruthy()
  })

  it('calls the host-only disableLan endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"result":{"disabled":true}}', { status: 200 }))
    const api = createLiveApi({ csrfToken: 'csrf', onSessionLost: vi.fn(), fetchImpl })
    expect(await api.lan.disableLan()).toEqual({ disabled: true })
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/v1/call/disableLan')
  })
})

describe('Demo -> Live from a LAN demo page (meta tg-live-url)', () => {
  const lan = { hostname: 'tg-demo.test', search: '' }
  const link = (href: string): ModeSwitch => ({ kind: 'link', href })
  const notOnHost: ModeSwitch = { kind: 'unavailable', reason: 'not-on-host' }

  it('links to a valid private Live address', () => {
    expect(demoModeSwitch(lan, 'http://192.168.1.20:4180/')).toEqual(link('http://192.168.1.20:4180/'))
    expect(demoModeSwitch(lan, 'http://10.0.0.5:1024/')).toEqual(link('http://10.0.0.5:1024/'))
    expect(demoModeSwitch(lan, 'http://172.16.0.9:65535/')).toEqual(link('http://172.16.0.9:65535/'))
    expect(demoModeSwitch(lan, 'http://172.31.255.254:4180/')).toEqual(link('http://172.31.255.254:4180/'))
  })

  it('refuses everything else, keeping the plain-text explanation', () => {
    const bad: (string | null | undefined)[] = [
      undefined,
      null,
      '',
      'https://192.168.1.20:4180/',
      'http://192.168.1.20/',
      'http://192.168.1.20:80/',
      'http://192.168.1.20:1023/',
      'http://192.168.1.20:65536/',
      'http://192.168.1.20:04180/',
      'http://192.168.1.20:4180',
      'http://192.168.1.20:4180/path',
      'http://192.168.1.20:4180/?next=1',
      'http://192.168.1.20:4180/?',
      'http://192.168.1.20:4180/#x',
      'http://user@192.168.1.20:4180/',
      'http://user:pw@192.168.1.20:4180/',
      'http://8.8.8.8:4180/',
      'http://172.15.0.1:4180/',
      'http://172.32.0.1:4180/',
      'http://192.169.1.20:4180/',
      'http://100.64.0.1:4180/',
      'http://169.254.1.1:4180/',
      'http://127.0.0.1:4180/',
      'http://localhost:4180/',
      'http://[::1]:4180/',
      'http://evil.test:4180/',
      'http://192.168.1.20.evil.test:4180/',
      'http://0xC0.168.1.20:4180/',
      'http://192.168.001.20:4180/',
      'http://192.168.1.256:4180/',
      'javascript:alert(1)',
      'data:text/html,hi',
      '//192.168.1.20:4180/',
      ' http://192.168.1.20:4180/',
      'http://192.168.1.20:4180/ ',
      'not a url'
    ]
    for (const value of bad) expect(demoModeSwitch(lan, value), String(value)).toEqual(notOnHost)
  })

  it('refuses a Live address equal to the page’s own host', () => {
    expect(demoModeSwitch({ hostname: '192.168.1.20', search: '' }, 'http://192.168.1.20:4180/')).toEqual(notOnHost)
  })

  it('ignores URL parameters on a non-loopback page', () => {
    expect(demoModeSwitch({ hostname: 'tg-demo.test', search: '?live=4180' }, null)).toEqual(notOnHost)
    expect(demoModeSwitch({ hostname: 'tg-demo.test', search: '?live=http://192.168.1.20:4180/' }, undefined)).toEqual(notOnHost)
    expect(demoModeSwitch({ hostname: 'tg-demo.test', search: '?live=4180&tg-live-url=http://192.168.1.20:4180/' }, undefined)).toEqual(notOnHost)
  })

  it('never produces a loopback link on a non-loopback page', () => {
    for (const hostname of ['192.168.1.20', 'tg-demo.test', '10.0.0.5']) {
      for (const meta of [null, 'http://127.0.0.1:4180/', 'http://localhost:4180/']) {
        const result = demoModeSwitch({ hostname, search: '?live=4180' }, meta)
        expect(result.kind, `${hostname} ${meta}`).toBe('unavailable')
      }
    }
  })

  it('ignores a meta on a loopback page in favour of the existing rule', () => {
    const meta = 'http://192.168.1.20:4180/'
    expect(demoModeSwitch({ hostname: 'localhost', search: '?live=4180' }, meta)).toEqual(link('http://127.0.0.1:4180/'))
    expect(demoModeSwitch({ hostname: '127.0.0.1', search: '' }, meta)).toEqual({ kind: 'unavailable', reason: 'not-running' })
    expect(demoModeSwitch({ hostname: 'localhost', search: '?live=4180' }, 'javascript:alert(1)')).toEqual(link('http://127.0.0.1:4180/'))
  })
})

describe('Live -> Demo from a paired device', () => {
  const page = { hostname: '192.168.1.20' }

  it('accepts the LAN demo form and rebuilds it from parts', () => {
    expect(validDemoHref('http://tg-demo.test:4181/', page)).toBe('http://tg-demo.test:4181/')
    expect(validDemoHref('http://TG-Demo.Test:4181/', page)).toBe('http://tg-demo.test:4181/')
    expect(validDemoHref('http://demo.home.arpa:65535/', page)).toBe('http://demo.home.arpa:65535/')
    expect(liveModeSwitch('http://tg-demo.test:4181/', page)).toEqual({ kind: 'link', href: 'http://tg-demo.test:4181/' })
  })

  it('still accepts the loopback form on the host’s own page, unchanged', () => {
    const host = { hostname: '127.0.0.1' }
    expect(validDemoHref('http://localhost:4181/?live=4180', host)).toBe('http://localhost:4181/?live=4180')
    expect(validDemoHref('http://tg-demo.test:4181/', host)).toBeNull()
  })

  it('rejects hostile and malformed values', () => {
    const bad: unknown[] = [
      null,
      undefined,
      '',
      42,
      {},
      'https://tg-demo.test:4181/',
      'http://tg-demo.test/',
      'http://tg-demo.test:80/',
      'http://tg-demo.test:1023/',
      'http://tg-demo.test:65536/',
      'http://tg-demo.test:4181/path',
      'http://tg-demo.test:4181/?live=4180',
      'http://tg-demo.test:4181/?x=1',
      'http://tg-demo.test:4181/#frag',
      'http://user@tg-demo.test:4181/',
      'http://user:pw@tg-demo.test:4181/',
      // IP literals, even private ones, are the same site as Live.
      'http://192.168.1.20:4181/',
      'http://192.168.1.21:4181/',
      'http://10.0.0.5:4181/',
      'http://127.0.0.1:4181/',
      'http://[::1]:4181/',
      'http://0x7f.1:4181/',
      'http://2130706433:4181/',
      // Loopback names are the device's own computer.
      'http://localhost:4181/',
      'http://demo.localhost:4181/',
      'http://tg-demo:4181/',
      'javascript:alert(1)',
      'data:text/html,hi',
      '//tg-demo.test:4181/',
      'not a url'
    ]
    for (const value of bad) {
      expect(validDemoHref(value, page), String(value)).toBeNull()
      expect(liveModeSwitch(value, page), String(value)).toEqual(unavailable)
    }
  })

  it('refuses a demo name equal to the page’s own host (same site)', () => {
    expect(validDemoHref('http://tg-demo.test:4181/', { hostname: 'tg-demo.test' })).toBeNull()
    expect(validDemoHref('http://tg-demo.test:4181/', { hostname: 'TG-DEMO.TEST' })).toBeNull()
  })

  it('does not treat the loopback form as valid on a remote page', () => {
    expect(validDemoHref('http://localhost:4181/', page)).toBeNull()
    expect(validDemoHref('http://localhost:4181/?live=4180', page)).toBeNull()
  })
})
