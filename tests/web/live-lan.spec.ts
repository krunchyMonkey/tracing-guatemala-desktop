import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

// Home-network Live, end to end (#137, finishing the browser tests of #136): the
// built host is started with --lan-host on this computer's own private address
// and a LAN demo name, then driven by two browser contexts, the host (loopback
// launch link) and a "second device" (the LAN origin). Skipped when the machine
// has no private IPv4 address. Fictional data only.
//
// Test hooks: TG_TEST_HOOKS=1 with TG_TEST_RESOLVE=<name>=<ip> makes the host
// resolve the demo name server-side; the browser maps it with
// --host-resolver-rules. Neither does anything outside automated tests.

const root = resolve(__dirname, '../..')
const DEMO_NAME = 'tg-demo.test'
const HTTP_TEXT = 'Unencrypted HTTP — trusted home network only'

const addresses = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter((e) => e.family === 'IPv4' && !e.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.address))
  .map((e) => e.address)
const lanIp = addresses.find((address) => addresses.filter((a) => a === address).length === 1)

test.skip(!lanIp, 'This machine has no private IPv4 address.')

interface Host {
  child: ChildProcess
  launchUrl: string
  output: () => string
}

const running: ChildProcess[] = []
const folders: string[] = []

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise<number>((done, fail) => {
      const probe = createServer()
      probe.once('error', fail)
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port
        probe.close(() => done(p))
      })
    })
    // Both the Live port and port + 1 (the demo) must be free on both interfaces.
    const free = async (host: string, p: number) =>
      new Promise<boolean>((done) => {
        const probe = createServer()
        probe.once('error', () => done(false))
        probe.listen(p, host, () => probe.close(() => done(true)))
      })
    if ((await free('127.0.0.1', port)) && (await free('127.0.0.1', port + 1)) && (await free(lanIp!, port)) && (await free(lanIp!, port + 1))) return port
  }
  throw new Error('no free port pair')
}

async function startHost(port: number, withLan: boolean): Promise<{ host: Host; dataDir: string }> {
  const parent = mkdtempSync(join(tmpdir(), 'tg-lan-e2e-'))
  folders.push(parent)
  const dataDir = join(parent, 'profile')
  const args = ['--disable-warning=ExperimentalWarning', 'dist-web/server/main.mjs', '--port', String(port), '--data-dir', dataDir]
  if (withLan) args.push('--lan-host', lanIp!, '--init-lan-test-profile', '--lan-demo-name', DEMO_NAME)
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, TG_TEST_HOOKS: '1', TG_TEST_RESOLVE: `${DEMO_NAME}=${lanIp}` }
  })
  running.push(child)
  let output = ''
  const launchUrl = await new Promise<string>((ready, fail) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = /http:\/\/127\.0\.0\.1:\d+\/launch\?token=[\w-]+/.exec(output)
      if (match && output.includes('Press Ctrl+C to stop')) ready(match[0])
    })
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.once('exit', (code) => fail(new Error(`web:local exited with ${code}: ${output}`)))
  })
  return { host: { child, launchUrl, output: () => output }, dataDir }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => child.once('exit', done))
  child.kill()
  await exited
}

test.afterAll(async () => {
  await Promise.all(running.splice(0).map(stop))
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const channel = process.platform === 'win32' ? 'msedge' : undefined
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const switcher = (page: Page) => page.getByRole('region', { name: 'Workspace mode' })
const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test.describe.serial('home-network Live on this computer', () => {
  let browser: Browser
  let hostCtx: BrowserContext
  let deviceCtx: BrowserContext
  let hostPage: Page
  let devicePage: Page
  let host: Host
  let port: number
  let lan: string
  let demo: string

  test.beforeAll(async () => {
    port = await freePort()
    lan = `http://${lanIp}:${port}`
    demo = `http://${DEMO_NAME}:${port + 1}`
    host = (await startHost(port, true)).host
    // The browser, not the OS resolver, maps the demo name to this computer.
    browser = await chromium.launch({ channel, args: [`--host-resolver-rules=MAP ${DEMO_NAME} ${lanIp}`, '--no-proxy-server'] })
    hostCtx = await browser.newContext()
    deviceCtx = await browser.newContext()
    hostPage = await hostCtx.newPage()
    devicePage = await deviceCtx.newPage()
  })

  test.afterAll(async () => {
    await browser?.close()
  })

  async function pairDevice(name: string): Promise<void> {
    await hostPage.goto(`http://127.0.0.1:${port}/#/settings`)
    await hostPage.reload()
    await hostPage.getByRole('button', { name: 'Show pairing code' }).click()
    const code = (await hostPage.getByTestId('pairing-code').locator('strong').innerText()).trim()
    await devicePage.goto(`${lan}/`)
    await devicePage.getByLabel('Pairing code').fill(code)
    await devicePage.getByLabel('Device name (optional)').fill(name)
    await devicePage.getByRole('button', { name: 'Pair this device' }).click()
    await expect(nav(devicePage)).toBeVisible()
  }

  test('prints the LAN address, the demo address and the warning', () => {
    const out = host.output()
    expect(out).toContain(`${lan}/`)
    expect(out).toContain(`${demo}/`)
    expect(out).toContain('UNENCRYPTED HTTP')
    expect(out).toContain('TEST HOOK ACTIVE')
  })

  test('the device sees enrollment only: no data, no private-link text', async () => {
    await devicePage.goto(`${lan}/`)
    await expect(devicePage.getByRole('heading', { name: 'Pair this device' })).toBeVisible()
    await expect(devicePage.getByText(HTTP_TEXT, { exact: false }).first()).toBeVisible()
    await expect(devicePage.getByText(/private link/i)).toHaveCount(0)
    await expect(nav(devicePage)).toHaveCount(0)
    expect(await deviceCtx.cookies()).toEqual([])
    const session = await (await deviceCtx.request.get(`${lan}/api/v1/session`)).json()
    expect(session).toEqual({ authenticated: false, demoUrl: `${demo}/`, remote: true })
  })

  test('the host shows the code in Settings and the device enrolls in the browser', async () => {
    await hostPage.goto(host.launchUrl)
    await expect(hostPage).toHaveURL(`http://127.0.0.1:${port}/`)
    await hostPage.goto(`http://127.0.0.1:${port}/#/settings`)
    await expect(hostPage.getByRole('heading', { name: 'Home-network devices' })).toBeVisible()
    await expect(hostPage.getByTestId('lan-address')).toHaveText(lan)
    await expect(hostPage.getByText(HTTP_TEXT, { exact: false }).first()).toBeVisible()
    await expect(hostPage.getByRole('button', { name: 'Copy address' })).toBeVisible()
    await expect(hostPage.getByRole('button', { name: 'Turn off home-network access' })).toBeVisible()
    await pairDevice('Kitchen tablet')
    await expect(switcher(devicePage)).toContainText('Live · saved on the researcher’s computer')
    await expect(devicePage.getByRole('note', { name: 'Connection warning' })).toHaveText(HTTP_TEXT)
    await hostPage.reload()
    await expect(hostPage.getByText('Kitchen tablet')).toBeVisible()
  })

  test('the device creates a client and case that the host sees and that survive a reload', async () => {
    await devicePage.goto(`${lan}/#/clients/new`)
    await devicePage.getByLabel(/^Name/).fill('Lucía LAN Ficticia')
    await pick(devicePage, 'Direct')
    await devicePage.getByRole('button', { name: 'Save client' }).click()
    await expect(devicePage.getByRole('heading', { level: 1, name: 'Lucía LAN Ficticia' })).toBeVisible()

    await devicePage.goto(`${lan}/#/cases/new`)
    await devicePage.getByLabel('Client', { exact: true }).selectOption({ label: 'Lucía LAN Ficticia' })
    await devicePage.getByRole('button', { name: 'Continue' }).click()
    await devicePage.getByLabel(/^Title/).fill('Abuelos ficticios — Antigua')
    await devicePage.getByRole('button', { name: 'Create case' }).click()
    await expect(devicePage.getByRole('heading', { level: 1, name: 'Abuelos ficticios — Antigua' })).toBeVisible()

    await hostPage.goto(`http://127.0.0.1:${port}/#/clients`)
    await hostPage.reload()
    await expect(hostPage.getByText('Lucía LAN Ficticia').first()).toBeVisible()
    await hostPage.goto(`http://127.0.0.1:${port}/#/cases`)
    await expect(hostPage.getByText('Abuelos ficticios — Antigua').first()).toBeVisible()

    await devicePage.reload()
    await devicePage.goto(`${lan}/#/clients`)
    await expect(devicePage.getByText('Lucía LAN Ficticia').first()).toBeVisible()
  })

  test('the device’s Settings has no backup controls', async () => {
    await devicePage.goto(`${lan}/#/settings`)
    await expect(devicePage.getByText('Backups are managed on the researcher’s computer.')).toBeVisible()
    await expect(devicePage.getByRole('button', { name: /Create backup|Restore/ })).toHaveCount(0)
    await expect(devicePage.getByText('Home-network devices')).toHaveCount(0)
  })

  for (const [width, height] of [
    [375, 740],
    [768, 1024],
    [1280, 800]
  ] as const) {
    test(`the device layout at ${width}px has no horizontal overflow and a visible HTTP indicator`, async () => {
      await devicePage.setViewportSize({ width, height })
      for (const hash of ['#/', '#/clients', '#/cases', '#/settings']) {
        await devicePage.goto(`${lan}/${hash}`)
        await expect(nav(devicePage)).toBeVisible()
        const banner = devicePage.getByRole('note', { name: 'Connection warning' })
        await expect(banner).toBeVisible()
        await expect(banner).toBeInViewport()
        expect(await overflow(devicePage), `${hash} at ${width}`).toBeLessThanOrEqual(0)
      }
      // The enrollment page too (a fresh, signed-out context).
      const fresh = await browser.newContext({ viewport: { width, height } })
      const page = await fresh.newPage()
      await page.goto(`${lan}/`)
      await expect(page.getByRole('heading', { name: 'Pair this device' })).toBeVisible()
      await expect(page.getByText(HTTP_TEXT, { exact: false }).first()).toBeInViewport()
      expect(await overflow(page), `enrollment at ${width}`).toBeLessThanOrEqual(0)
      await fresh.close()
    })
  }

  test('Live -> Demo -> Live on the device: a different site, no shared cookies, still signed in', async () => {
    await devicePage.setViewportSize({ width: 1280, height: 800 })
    await devicePage.goto(`${lan}/#/`)
    await expect(switcher(devicePage)).toContainText('Live · saved on the researcher’s computer')
    await devicePage.getByRole('link', { name: 'Open the fictional demo' }).click()
    await expect(devicePage).toHaveURL(`${demo}/`)
    await expect(switcher(devicePage)).toContainText('Demo · fictional, resets on refresh')
    await expect(devicePage.getByRole('region', { name: 'Demo mode' })).toBeVisible()
    await expect(devicePage.getByText('Lucía LAN Ficticia')).toHaveCount(0)

    // The demo origin holds no cookie; the Live cookie belongs to the IP only.
    expect(await deviceCtx.cookies(`${demo}/`)).toEqual([])
    const cookies = await deviceCtx.cookies()
    expect(cookies.map((c) => c.name)).toEqual([`tg_lan_${port}`])
    expect(cookies[0]!.domain).toBe(lanIp)
    // The demo listener refuses the IP Host, which would have been Live's site.
    expect((await deviceCtx.request.get(`http://${lanIp}:${port + 1}/`)).status()).toBe(421)

    await devicePage.getByRole('link', { name: 'Back to Live (your real data)' }).click()
    await expect(devicePage).toHaveURL(`${lan}/`)
    await expect(nav(devicePage)).toBeVisible()
    await expect(switcher(devicePage)).toContainText('Live · saved on the researcher’s computer')
  })

  test('the host’s own Live page links to the loopback demo, not the LAN one', async () => {
    await hostPage.goto(`http://127.0.0.1:${port}/#/`)
    const link = hostPage.getByRole('link', { name: 'Open the fictional demo' })
    await expect(link).toHaveAttribute('href', `http://localhost:${port + 1}/?live=${port}`)
  })

  test('revoking the device sends its next action to enrollment with the session-ended message', async () => {
    await hostPage.goto(`http://127.0.0.1:${port}/#/settings`)
    await hostPage.reload()
    await hostPage.getByRole('button', { name: 'Revoke Kitchen tablet' }).click()
    await expect(hostPage.getByText('No devices are paired.')).toBeVisible()

    await devicePage.goto(`${lan}/#/`)
    await nav(devicePage).getByRole('link', { name: 'Clients' }).click()
    await expect(devicePage.getByText('Your session ended. Ask for a new pairing code on the researcher’s computer.')).toBeVisible()
    await expect(devicePage.getByLabel('Pairing code')).toBeVisible()
    await expect(devicePage.getByText(/private link/i)).toHaveCount(0)
  })

  test('re-pairs, then logs out', async () => {
    await pairDevice('Kitchen tablet')
    await devicePage.goto(`${lan}/#/settings`)
    await devicePage.getByRole('button', { name: 'Sign out this device' }).click()
    await expect(devicePage.getByRole('heading', { name: 'Pair this device' })).toBeVisible()
  })

  test('turning access off closes the listeners and the device can no longer connect', async () => {
    await pairDevice('Kitchen tablet')
    await hostPage.goto(`http://127.0.0.1:${port}/#/settings`)
    await hostPage.reload()
    await hostPage.getByRole('button', { name: 'Turn off home-network access' }).click()
    await hostPage.getByRole('button', { name: 'Turn off', exact: true }).click()
    await expect(hostPage.getByText('Home-network access is off')).toBeVisible()
    await expect(hostPage.getByText(/restart Tracing Guatemala with/)).toBeVisible()
    await expect.poll(() => host.output()).toContain('Home-network access was turned off')

    // The device's next call can't reach the host: the recovery page, not the private link.
    await nav(devicePage).getByRole('link', { name: 'Clients' }).click()
    await expect(devicePage.getByText(/Can’t reach the researcher’s computer. It may be asleep/)).toBeVisible()
    await expect(devicePage.getByText(/private link/i)).toHaveCount(0)
    await expect(deviceCtx.request.get(`${lan}/api/v1/session`, { timeout: 5_000 })).rejects.toBeTruthy()
    await expect(deviceCtx.request.get(`${demo}/`, { timeout: 5_000 })).rejects.toBeTruthy()

    // Loopback keeps working, and restoring a backup is no longer blocked by LAN.
    await hostPage.goto(`http://127.0.0.1:${port}/#/`)
    await expect(nav(hostPage)).toBeVisible()
    const status = await hostPage.evaluate(async () => {
      const session = (await (await fetch('/api/v1/session')).json()) as { csrfToken: string }
      const reply = await fetch('/api/v1/call/getLanStatus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TG-CSRF': session.csrfToken },
        body: '{"args":[]}'
      })
      return reply.json()
    })
    expect(status).toEqual({ result: { enabled: false, origin: null } })
  })
})

test('a paired device shows the host-unreachable recovery when the host stops', async () => {
  const port = await freePort()
  const { host } = await startHost(port, true)
  const lan = `http://${lanIp}:${port}`
  const browser = await chromium.launch({ channel, args: ['--no-proxy-server'] })
  try {
    const host_ = await browser.newContext()
    const device = await browser.newContext()
    const hostPage = await host_.newPage()
    const devicePage = await device.newPage()
    await hostPage.goto(host.launchUrl)
    await hostPage.goto(`http://127.0.0.1:${port}/#/settings`)
    await hostPage.getByRole('button', { name: 'Show pairing code' }).click()
    const code = (await hostPage.getByTestId('pairing-code').locator('strong').innerText()).trim()
    await devicePage.goto(`${lan}/`)
    await devicePage.getByLabel('Pairing code').fill(code)
    await devicePage.getByRole('button', { name: 'Pair this device' }).click()
    await expect(nav(devicePage)).toBeVisible()

    await stop(host.child)
    await nav(devicePage).getByRole('link', { name: 'Clients' }).click()
    await expect(
      devicePage.getByText('Can’t reach the researcher’s computer. It may be asleep, stopped, or on a different network. Nothing you saved is lost.')
    ).toBeVisible()
    await expect(devicePage.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(devicePage.getByText(/private link/i)).toHaveCount(0)
    await expect(devicePage.getByRole('note', { name: 'Connection warning' })).toHaveText(HTTP_TEXT)
  } finally {
    await browser.close()
  }
})

test('the default host (no --lan-host) is not reachable on the LAN address', async ({ playwright }) => {
  const port = await freePort()
  const { host } = await startHost(port, false)
  expect(host.output()).not.toContain('Home network (opt-in)')
  const api = await playwright.request.newContext()
  try {
    await expect(api.get(`http://${lanIp}:${port}/`, { timeout: 5_000 })).rejects.toBeTruthy()
    await expect(api.get(`http://${lanIp}:${port + 1}/`, { timeout: 5_000 })).rejects.toBeTruthy()
    expect((await api.get(`http://127.0.0.1:${port}/api/v1/session`)).status()).toBe(200)
  } finally {
    await api.dispose()
  }
})
