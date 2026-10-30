// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { ModeSwitcher } from '../../src/renderer/src/components/ModeSwitcher'
import { demoModeSwitch } from '../../src/renderer/src/demo/modeLink'
import { AppRuntimeProvider, desktopRuntime, type AppRuntime, type ModeSwitch } from '../../src/renderer/src/runtime/AppRuntime'
import { LaunchRequired } from '../../src/renderer/src/web/LaunchRequired'
import { liveModeSwitch, validDemoHref } from '../../src/renderer/src/web/demoLink'
import { createFakeApi } from './fakeApi'

// Switching between the fictional demo and Live (#114): each entry point decides
// the link from its own address, and the shared UI only renders it.

beforeEach(() => {
  window.location.hash = ''
})

afterEach(cleanup)

const notRunning: ModeSwitch = { kind: 'unavailable', reason: 'not-running' }
const notOnHost: ModeSwitch = { kind: 'unavailable', reason: 'not-on-host' }
const unavailable: ModeSwitch = { kind: 'unavailable', reason: 'not-available' }

describe('demoModeSwitch (from the demo page’s own address)', () => {
  const toLive = (port: number): ModeSwitch => ({ kind: 'link', href: `http://127.0.0.1:${port}/` })

  it('links back to Live on 127.0.0.1 when opened on this computer with a valid port', () => {
    expect(demoModeSwitch({ hostname: 'localhost', search: '?live=4180' })).toEqual(toLive(4180))
    expect(demoModeSwitch({ hostname: '127.0.0.1', search: '?live=4180' })).toEqual(toLive(4180))
    expect(demoModeSwitch({ hostname: 'localhost', search: '?x=1&live=1024' })).toEqual(toLive(1024))
    expect(demoModeSwitch({ hostname: 'localhost', search: '?live=65535' })).toEqual(toLive(65535))
  })

  it('never links from a LAN or any other address, even with a valid port', () => {
    for (const hostname of ['192.168.1.20', '10.0.0.5', '172.16.4.9', 'demo.example.com', 'localhost.evil.test', '127.0.0.2', '[::1]', '0.0.0.0', '']) {
      expect(demoModeSwitch({ hostname, search: '?live=4180' }), hostname).toEqual(notOnHost)
      expect(demoModeSwitch({ hostname, search: '' }), hostname).toEqual(notOnHost)
    }
  })

  it('says Live is not running on this computer when the port is missing or unusable', () => {
    const searches = [
      '',
      '?',
      '?live',
      '?live=',
      '?live=0',
      '?live=80',
      '?live=1023',
      '?live=65536',
      '?live=99999',
      '?live=abc',
      '?live=4180abc',
      '?live=4180.5',
      '?live=-4180',
      '?live=%2B4180',
      '?live=04180',
      '?live= 4180',
      '?live=1e3',
      '?live=0x1000',
      '?live=4180&live=1',
      '?live=1&live=4180',
      '?live=4180&live=4180',
      '?LIVE=4180',
      '?live=http://evil.test/',
      '?live=4180/../x'
    ]
    for (const search of searches) {
      expect(demoModeSwitch({ hostname: 'localhost', search }), search).toEqual(notRunning)
      expect(demoModeSwitch({ hostname: '127.0.0.1', search }), search).toEqual(notRunning)
    }
  })

  it('only ever produces an http://127.0.0.1:<port>/ address', () => {
    const result = demoModeSwitch({ hostname: 'localhost', search: '?live=4180&redirect=http://evil.test' })
    expect(result).toEqual(toLive(4180))
  })
})

describe('Live’s check of the demo address the host reports', () => {
  it('accepts http://localhost:<port>/ with or without the live port', () => {
    expect(validDemoHref('http://localhost:4181/')).toBe('http://localhost:4181/')
    expect(validDemoHref('http://localhost:4181')).toBe('http://localhost:4181/')
    expect(validDemoHref('http://localhost:4199/?live=4198')).toBe('http://localhost:4199/?live=4198')
    expect(liveModeSwitch('http://localhost:4181/?live=4180')).toEqual({ kind: 'link', href: 'http://localhost:4181/?live=4180' })
  })

  it('rejects everything else', () => {
    const bad: unknown[] = [
      null,
      undefined,
      '',
      42,
      {},
      ['http://localhost:4181/'],
      'https://localhost:4181/',
      'http://127.0.0.1:4181/',
      'http://example.com:4181/',
      'http://localhost.evil.test:4181/',
      'http://evil.test@localhost:4181/',
      'http://user:pw@localhost:4181/',
      'http://localhost/',
      'http://localhost:80/',
      'http://localhost:0/',
      'http://localhost:1023/',
      'http://localhost:70000/',
      'http://localhost:4181/path',
      'http://localhost:4181/index.html',
      'http://localhost:4181/?next=http://evil.test',
      'http://localhost:4181/?live=abc',
      'http://localhost:4181/#/clients',
      'javascript:alert(1)',
      'data:text/html,hi',
      'localhost:4181',
      '//localhost:4181/',
      'not a url'
    ]
    for (const value of bad) {
      expect(validDemoHref(value), String(value)).toBeNull()
      expect(liveModeSwitch(value), String(value)).toEqual(unavailable)
    }
  })
})

function renderSwitcher(runtime: AppRuntime) {
  return render(
    <AppRuntimeProvider runtime={runtime}>
      <ModeSwitcher />
    </AppRuntimeProvider>
  )
}

const live = (switcher: ModeSwitch): AppRuntime => ({ mode: 'live', data: createFakeApi().api, backup: createFakeApi().api, switcher })
const demo = (switcher: ModeSwitch): AppRuntime => ({ mode: 'demo', data: createFakeApi().api, backup: null, switcher })

describe('ModeSwitcher', () => {
  it('Live: shows what persists and links to the demo in the same tab', () => {
    renderSwitcher(live({ kind: 'link', href: 'http://localhost:4181/?live=4180' }))
    const region = screen.getByRole('region', { name: 'Workspace mode' })
    expect(region.textContent).toContain('Live · saved on this computer')
    const link = screen.getByRole('link', { name: 'Open the fictional demo' })
    expect(link.getAttribute('href')).toBe('http://localhost:4181/?live=4180')
    expect(link.hasAttribute('target')).toBe(false)
  })

  it('Live without a demo: muted text, no anchor', () => {
    renderSwitcher(live(unavailable))
    expect(screen.getByText('Live · saved on this computer')).toBeTruthy()
    expect(screen.getByText('Demo not available')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.querySelector('a, button')).toBeNull()
  })

  it('Demo: links back to Live only for the link kind', () => {
    renderSwitcher(demo({ kind: 'link', href: 'http://127.0.0.1:4180/' }))
    expect(screen.getByRole('region', { name: 'Workspace mode' }).textContent).toContain('Demo · nothing is saved')
    expect(screen.getByRole('link', { name: 'Back to Live (your real data)' }).getAttribute('href')).toBe('http://127.0.0.1:4180/')
  })

  it.each([
    [notOnHost, 'Live mode opens only on the researcher’s own computer.'],
    [notRunning, 'Start Tracing Guatemala on this computer to use Live.'],
    [unavailable, 'Live mode is not available here.']
  ])('Demo: explains %o in plain text, with no anchor or button', (switcher, text) => {
    renderSwitcher(demo(switcher))
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(document.querySelector('a, button, [href]')).toBeNull()
  })

  it('renders nothing on the desktop', () => {
    const { container } = renderSwitcher(desktopRuntime)
    expect(container.innerHTML).toBe('')
    expect(desktopRuntime.switcher).toEqual(unavailable)
  })

  it('appears in the app layout in Live and Demo, and not on the desktop', async () => {
    const view = render(<App runtime={live({ kind: 'link', href: 'http://localhost:4181/' })} />)
    expect(await screen.findByRole('link', { name: 'Open the fictional demo' })).toBeTruthy()
    view.unmount()

    const demoView = render(<App runtime={demo(notOnHost)} />)
    expect(await screen.findByText('Live mode opens only on the researcher’s own computer.')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Demo mode' })).toBeTruthy()
    demoView.unmount()
  })
})

describe('LaunchRequired', () => {
  it('offers the demo when the host gave a checked address, but not when it is unreachable', () => {
    const { rerender } = render(<LaunchRequired reason="signed-out" demoHref="http://localhost:4181/?live=4180" />)
    expect(screen.getByRole('link', { name: 'Open the fictional demo instead' }).getAttribute('href')).toBe('http://localhost:4181/?live=4180')

    rerender(<LaunchRequired reason="session-ended" demoHref="http://localhost:4181/" />)
    expect(screen.getByRole('link', { name: 'Open the fictional demo instead' })).toBeTruthy()

    rerender(<LaunchRequired reason="unreachable" demoHref="http://localhost:4181/" />)
    expect(screen.queryByRole('link')).toBeNull()

    rerender(<LaunchRequired reason="signed-out" />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
