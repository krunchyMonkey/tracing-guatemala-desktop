import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The Live web app (#110): dist-web/ served by `npm run web:local`'s built host
// (dist-web/server/main.mjs) on 127.0.0.1, with a throwaway data folder per
// test. Fictional data only. Screenshots for the PR are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_PORT'] ?? 4191)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/issue-110')
const capture = Boolean(process.env['CAPTURE_SCREENSHOTS'])

interface Host {
  child: ChildProcess
  launchUrl: string
}

let dataDir: string
const running: ChildProcess[] = []

async function startHost(): Promise<Host> {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'dist-web/server/main.mjs', '--port', String(port), '--data-dir', dataDir],
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
  return { child, launchUrl }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => child.once('exit', done))
  child.kill()
  await exited
}

const stopHost = (host: Host) => stop(host.child)

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-e2e-'))
})

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stop))
  rmSync(dataDir, { recursive: true, force: true })
})

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()

async function addClient(page: Page, name: string) {
  await page.goto(`${origin}/#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

test('shows only sign-in guidance without the launch link, under a same-origin-only CSP', async ({ page }) => {
  await startHost()
  const response = await page.goto(`${origin}/#/clients`)
  const csp = response?.headers()['content-security-policy'] ?? ''
  expect(csp).toContain("connect-src 'self'")
  expect(csp).toContain("script-src 'self';")
  await expect(page.getByRole('heading', { name: 'Open Tracing Guatemala from its link' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
  expect(await page.evaluate(() => 'tracingGuatemala' in window)).toBe(false)
  if (capture) await page.screenshot({ path: join(shotsDir, 'launch-required.png') })
})

test('saves clients and notes through the local host and keeps them across reloads and restarts', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  // The token leaves the address bar straight away.
  await expect(page).toHaveURL(`${origin}/`)
  await expect(page.getByRole('region', { name: 'Demo mode' })).toHaveCount(0)

  await addClient(page, 'Lucía Ficticia')
  const history = page.getByRole('region', { name: 'Notes & contact history' })
  await history.getByLabel('Your note').fill('Fictional note: asked about the parish records.')
  await history.getByRole('button', { name: 'Add note' }).click()
  await expect(history.getByText('Fictional note: asked about the parish records.')).toBeVisible()
  const profileUrl = page.url()

  await page.reload()
  await expect(page.getByText('Fictional note: asked about the parish records.')).toBeVisible()

  // Restarting the host signs the browser out but keeps the data.
  await stopHost(host)
  host = await startHost()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Open Tracing Guatemala from its link' })).toBeVisible()
  await page.goto(host.launchUrl)
  await page.goto(profileUrl)
  await expect(page.getByRole('heading', { level: 1, name: 'Lucía Ficticia' })).toBeVisible()
  await expect(page.getByText('Fictional note: asked about the parish records.')).toBeVisible()

  await nav(page).getByRole('link', { name: 'Settings & Backup' }).click()
  await expect(page.getByTestId('app-version')).toHaveText(/^Tracing Guatemala version \d+\.\d+\.\d+$/)
})

test('signs out a tab whose host restarted, without losing what was saved', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Mateo Ficticio')
  await stopHost(host)
  host = await startHost()
  await page.goto(`${origin}/#/clients`)
  await expect(page.getByRole('heading', { name: 'Open Tracing Guatemala from its link' })).toBeVisible()
  await page.goto(host.launchUrl)
  await page.goto(`${origin}/#/clients`)
  await expect(page.getByRole('link', { name: 'Mateo Ficticio' })).toBeVisible()
})

test('makes a backup the browser downloads', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Elena Ficticia')
  await nav(page).getByRole('link', { name: 'Settings & Backup' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Create backup…' }).click()
  expect((await download).suggestedFilename()).toMatch(/^Tracing Guatemala backup \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.tgbackup$/)
  await expect(page.getByText(/A copy is kept in the app’s backups folder/)).toBeVisible()
  expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(1)
})

test('shows when the last backup was made and stops reminding once there is one (#117)', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await expect(page.getByText('Live · saved on this computer')).toBeVisible()

  // No backup yet: a gentle note on Home, not a dialog.
  await page.goto(`${origin}/#/`)
  const reminder = page.getByRole('note', { name: 'Backup reminder' })
  await expect(reminder).toContainText('You haven’t made a backup yet.')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await reminder.getByRole('link', { name: /Settings & Backup/ }).click()

  const status = page.getByTestId('backup-status')
  await expect(status).toContainText('No backup made yet')
  await expect(status).toContainText('0 backups in the app’s backups folder.')
  await expect(page.getByRole('heading', { name: 'Your data is not encrypted' })).toBeVisible()

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Create backup…' }).click()
  await download
  const today = await page.evaluate(() => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date()))
  await expect(status).toContainText(`Last backup: ${today}`)
  await expect(status).toContainText('(today)')
  await expect(status).toContainText('1 backup in the app’s backups folder.')

  // Home no longer asks, and the status survives a host restart.
  await page.goto(`${origin}/#/`)
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
  await expect(page.getByRole('note', { name: 'Backup reminder' })).toHaveCount(0)
  await stopHost(host)
  expect(JSON.parse(readFileSync(join(dataDir, 'backup-status.json'), 'utf8'))).toMatchObject({ clients: 0, notes: 0 })
  host = await startHost()
  await page.goto(host.launchUrl)
  await page.goto(`${origin}/#/settings`)
  await expect(page.getByTestId('backup-status')).toContainText('(today)')
})

test('refuses writes from another site, even in a browser signed in to Live', async ({ page, context }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)

  // A hostile page in the same browser, without any CSP of its own.
  await context.route('http://attacker.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Elsewhere</title>' })
  )
  const attacker = await context.newPage()
  await attacker.goto('http://attacker.test/')
  const attempts = await attacker.evaluate(async (target) => {
    const body = JSON.stringify({
      args: [{ displayName: 'Injected', source: 'direct', sourceDetail: null, fiverrUsername: null, email: null, otherContact: null, preferredContactChannel: 'unspecified' }]
    })
    const outcomes: string[] = []
    // Readable cross-origin request: blocked by the browser (no CORS) and by the host.
    try {
      await fetch(`${target}/api/v1/call/createClient`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body })
      outcomes.push('readable')
    } catch {
      outcomes.push('blocked')
    }
    // "Simple" no-cors request, like a classic CSRF form post.
    await fetch(`${target}/api/v1/call/createClient`, { method: 'POST', mode: 'no-cors', credentials: 'include', body }).catch(() => {})
    outcomes.push('sent')
    // Reading the session (and its CSRF token) cross-origin is blocked.
    try {
      await (await fetch(`${target}/api/v1/session`, { credentials: 'include' })).json()
      outcomes.push('session-read')
    } catch {
      outcomes.push('session-blocked')
    }
    return outcomes
  }, origin)
  expect(attempts).toEqual(['blocked', 'sent', 'session-blocked'])

  await page.goto(`${origin}/#/clients`)
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
  await expect(page.getByText('Injected')).toHaveCount(0)
})

test('the fictional demo build has no way to reach the Live host', () => {
  const assets = join(root, 'dist-demo', 'assets')
  for (const file of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(join(assets, file), 'utf8')
    expect(code).not.toContain('/api/v1')
    expect(code).not.toContain('X-TG-CSRF')
  }
  const html = readFileSync(join(root, 'dist-demo', 'index.html'), 'utf8')
  expect(html).toMatch(/connect-src (?:'|&#39;)none(?:'|&#39;)/)
})

for (const viewport of [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 }
]) {
  test(`fits a ${viewport.name} screen (${viewport.width}px) without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const host = await startHost()
    await page.goto(host.launchUrl)
    await addClient(page, 'Sofía Ficticia')
    await page.goto(`${origin}/#/clients`)
    await expect(page.getByRole('link', { name: 'Sofía Ficticia' })).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    if (capture) await page.screenshot({ path: join(shotsDir, `clients-${viewport.width}.png`), fullPage: true })
  })

  test(`fits Settings & Backup on a ${viewport.name} screen (${viewport.width}px) without sideways scrolling (#117)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const host = await startHost()
    await page.goto(host.launchUrl)
    await page.goto(`${origin}/#/settings`)
    await expect(page.getByTestId('backup-status')).toContainText('No backup made yet')
    await expect(page.getByRole('heading', { name: 'Your data is not encrypted' })).toBeVisible()
    await expect(page.getByText('Live · saved on this computer')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
}
