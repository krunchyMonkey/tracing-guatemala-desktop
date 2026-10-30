import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Safe Demo/Live switching (#114): `web:local` serves Live on 127.0.0.1 and the
// fictional demo on http://localhost:<port + 1>/, two independent origins. The
// built host (dist-web/server/main.mjs) runs on 4198/4199 with a throwaway data
// folder per test. Fictional data only. Screenshots for the PR are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-mode-switch

const root = resolve(__dirname, '../..')
const livePort = Number(process.env['SWITCH_E2E_PORT'] ?? 4198)
const demoPort = livePort + 1
const liveOrigin = `http://127.0.0.1:${livePort}`
const demoOrigin = `http://localhost:${demoPort}`
const shotsDir = join(root, 'docs/screenshots/issue-114')
const capture = Boolean(process.env['CAPTURE_SCREENSHOTS'])

interface Host {
  child: ChildProcess
  launchUrl: string
  output: () => string
}

let dataDir: string
const running: ChildProcess[] = []

async function startHost(extraArgs: string[] = []): Promise<Host> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'dist-web/server/main.mjs', '--port', String(livePort), '--data-dir', dataDir, ...extraArgs],
    { cwd: root }
  )
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
  return { child, launchUrl, output: () => output }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => child.once('exit', done))
  child.kill()
  await exited
}

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-switch-e2e-'))
})

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stop))
  rmSync(dataDir, { recursive: true, force: true })
})

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const switcher = (page: Page) => page.getByRole('region', { name: 'Workspace mode' })
const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const openDemo = (page: Page) => page.getByRole('link', { name: 'Open the fictional demo' })
const backToLive = (page: Page) => page.getByRole('link', { name: 'Back to Live (your real data)' })

async function addClient(page: Page, base: string, name: string) {
  await page.goto(`${base}#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test('prints the demo address and keeps Live and the demo on separate origins', async ({ page, context }) => {
  const host = await startHost()
  expect(host.output()).toContain(`Fictional demo on this computer: ${demoOrigin}/`)

  // The session answer is not secret and names only the demo address.
  const session = await (await page.request.get(`${liveOrigin}/api/v1/session`)).json()
  expect(session).toEqual({ authenticated: false, demoUrl: `${demoOrigin}/?live=${livePort}` })

  // The demo origin has no API and answers only its own Host names.
  expect((await page.request.get(`${demoOrigin}/api/v1/session`)).status()).toBe(404)
  expect((await page.request.post(`${demoOrigin}/api/v1/call/listClients`)).status()).toBe(405)
  expect((await page.request.get(`http://127.0.0.1:${demoPort}/`)).status()).toBe(200)
  const response = await page.goto(`${demoOrigin}/`)
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'none'")
  expect(response?.headers()['set-cookie']).toBeUndefined()
  expect(await context.cookies()).toEqual([])
})

test('switches Live -> demo -> Live without leaking data or the session either way', async ({ page, context }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await expect(page).toHaveURL(`${liveOrigin}/`)
  await addClient(page, `${liveOrigin}/`, 'Lucía Viva Ficticia')

  // Live says what it is and offers the demo.
  await expect(switcher(page)).toContainText('Live · saved on this computer')
  await expect(page.getByRole('region', { name: 'Demo mode' })).toHaveCount(0)
  if (capture) {
    mkdirSync(shotsDir, { recursive: true })
    await page.screenshot({ path: join(shotsDir, 'live-switcher-desktop.png') })
  }

  // ... into the demo: another origin, fictional fixtures, no Live data or session.
  await openDemo(page).click()
  await expect(page).toHaveURL(`${demoOrigin}/?live=${livePort}`)
  expect(new URL(page.url()).origin).toBe(demoOrigin)
  await expect(page.getByRole('region', { name: 'Demo mode' })).toContainText('Demo Mode — Fictional Data Only')
  await expect(switcher(page)).toContainText('Demo · nothing is saved')
  if (capture) await page.screenshot({ path: join(shotsDir, 'demo-on-host-switcher.png') })
  await nav(page).getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByText('43 active · 5 archived')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Lucía Viva Ficticia' })).toHaveCount(0)
  // The query survives in-demo navigation, so the way back stays available.
  expect(new URL(page.url()).search).toBe(`?live=${livePort}`)
  await expect(backToLive(page)).toHaveAttribute('href', `${liveOrigin}/`)

  // The Live session cookie is neither visible to the demo page nor sent to its origin.
  expect(await page.evaluate(() => document.cookie)).not.toContain('tg_live')
  expect(await context.cookies(demoOrigin)).toEqual([])
  expect((await context.cookies(liveOrigin)).map((c) => c.name)).toEqual([`tg_live_${livePort}`])
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
  // The demo page cannot call the Live host: its policy allows no connections.
  const attempt = await page.evaluate(async (target) => {
    try {
      await fetch(`${target}/api/v1/session`, { credentials: 'include' })
      return 'reached'
    } catch {
      return 'blocked'
    }
  }, liveOrigin)
  expect(attempt).toBe('blocked')

  // A demo change stays in the demo tab.
  await addClient(page, `${demoOrigin}/?live=${livePort}`, 'Visitante Demo')
  await nav(page).getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByRole('link', { name: 'Visitante Demo' })).toBeVisible()

  // Back to Live: same session, no launch link, Live data only.
  await backToLive(page).click()
  await expect(page).toHaveURL(`${liveOrigin}/`)
  await expect(nav(page)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Open Tracing Guatemala from its link' })).toHaveCount(0)
  await nav(page).getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByRole('link', { name: 'Lucía Viva Ficticia' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Visitante Demo' })).toHaveCount(0)
  await expect(page.getByText('Demo Mode')).toHaveCount(0)

  // Reloading Live keeps Live data; reopening the demo starts from the fixtures again.
  await page.reload()
  await expect(page.getByRole('link', { name: 'Lucía Viva Ficticia' })).toBeVisible()
  await openDemo(page).click()
  await nav(page).getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByText('43 active · 5 archived')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Visitante Demo' })).toHaveCount(0)
})

test('never shows demo content when the host is stopped', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await expect(nav(page)).toBeVisible()
  await openDemo(page).click()
  await expect(page.getByRole('region', { name: 'Demo mode' })).toBeVisible()
  await stop(host.child)

  // Both origins are gone with the host: the browser shows its own error, not
  // a stale or substitute page, and following "Back to Live" cannot show demo data.
  await backToLive(page).click().catch(() => {})
  await expect(page.getByRole('region', { name: 'Demo mode' })).toHaveCount(0)
  await expect(page.getByText('Fictional Data Only')).toHaveCount(0)
  await page.goto(`${liveOrigin}/`).catch(() => {})
  await expect(page.getByText('Fictional Data Only')).toHaveCount(0)
  await expect(page.getByText('Open Tracing Guatemala from its link')).toHaveCount(0)
})

test('says Tracing Guatemala isn’t running when the host cannot be reached, with no demo link or content', async ({ page }) => {
  const host = await startHost()
  await page.route('**/api/v1/session', (route) => route.abort('connectionrefused'))
  await page.goto(host.launchUrl)
  await page.goto(`${liveOrigin}/`)
  await expect(page.getByRole('heading', { name: 'Tracing Guatemala isn’t running' })).toBeVisible()
  await expect(page.getByRole('link')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Demo mode' })).toHaveCount(0)
})

test('lets a signed-out browser open the demo, while Live still needs the launch link', async ({ page, browser }) => {
  await startHost()
  const fresh = await browser.newContext()
  const signedOut = await fresh.newPage()
  await signedOut.goto(`${liveOrigin}/`)
  await expect(signedOut.getByRole('heading', { name: 'Open Tracing Guatemala from its link' })).toBeVisible()
  await expect(nav(signedOut)).toHaveCount(0)

  await signedOut.getByRole('link', { name: 'Open the fictional demo instead' }).click()
  await expect(signedOut).toHaveURL(`${demoOrigin}/?live=${livePort}`)
  await expect(signedOut.getByRole('region', { name: 'Demo mode' })).toBeVisible()

  // Going back does not sign anyone in.
  await backToLive(signedOut).click()
  await expect(signedOut).toHaveURL(`${liveOrigin}/`)
  await expect(signedOut.getByRole('heading', { name: 'Open Tracing Guatemala from its link' })).toBeVisible()
  await expect(signedOut.getByText('Lucía')).toHaveCount(0)
  await fresh.close()
  await page.close()
})

test('with --no-demo, Live starts and says the demo is not available', async ({ page }) => {
  const host = await startHost(['--no-demo'])
  expect(host.output()).toContain('Fictional demo: not served (--no-demo).')
  expect(await (await page.request.get(`${liveOrigin}/api/v1/session`)).json()).toEqual({ authenticated: false, demoUrl: null })
  await expect(page.request.get(`${demoOrigin}/`)).rejects.toThrow()

  await page.goto(host.launchUrl)
  await expect(switcher(page)).toContainText('Live · saved on this computer')
  await expect(switcher(page)).toContainText('Demo not available')
  await expect(openDemo(page)).toHaveCount(0)
  await expect(switcher(page).getByRole('link')).toHaveCount(0)
})

test('with the demo port taken, Live still starts without a demo', async ({ page }) => {
  const blocker = createServer()
  await new Promise<void>((ready) => blocker.listen(demoPort, '127.0.0.1', ready))
  try {
    const host = await startHost()
    expect(host.output()).toMatch(/Fictional demo: not served \(port \d+ is in use\)/)
    await page.goto(host.launchUrl)
    await expect(switcher(page)).toContainText('Demo not available')
    await expect(openDemo(page)).toHaveCount(0)
  } finally {
    await new Promise((done) => blocker.close(done))
  }
})

test('the switch link is reachable and works from the keyboard', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  const link = openDemo(page)
  await expect(link).toBeVisible()
  let reached = false
  for (let presses = 0; presses < 8 && !reached; presses++) {
    await page.keyboard.press('Tab')
    reached = await link.evaluate((el) => el === document.activeElement)
  }
  expect(reached).toBe(true)
  // A visible focus ring, not removed by the page's styles.
  expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`${demoOrigin}/?live=${livePort}`)

  reached = false
  const back = backToLive(page)
  for (let presses = 0; presses < 8 && !reached; presses++) {
    await page.keyboard.press('Tab')
    reached = await back.evaluate((el) => el === document.activeElement)
  }
  expect(reached).toBe(true)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`${liveOrigin}/`)
  await expect(nav(page)).toBeVisible()
})

for (const viewport of [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 }
]) {
  test(`shows the switcher without sideways scrolling at ${viewport.width}px, in Live and in the demo`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const host = await startHost()
    await page.goto(host.launchUrl)
    await addClient(page, `${liveOrigin}/`, 'Sofía Ficticia')
    await page.goto(`${liveOrigin}/#/clients`)

    for (const mode of ['live', 'demo'] as const) {
      if (mode === 'demo') await openDemo(page).click()
      const box = await switcher(page).boundingBox()
      expect(box, `${mode} switcher visible`).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
      for (const hash of ['#/', '#/clients', '#/settings']) {
        await page.evaluate((h) => (window.location.hash = h), hash)
        await expect(switcher(page)).toBeVisible()
        expect(await overflow(page), `${mode} ${hash} overflows`).toBeLessThanOrEqual(0)
      }
      if (capture && mode === 'live' && viewport.name === 'phone') {
        mkdirSync(shotsDir, { recursive: true })
        await page.screenshot({ path: join(shotsDir, 'live-switcher-phone.png') })
      }
    }
  })
}
