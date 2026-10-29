import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The browser demo (#100), served from dist-demo/ by `npm run demo:lan`
// (scripts/demo-lan.mjs) itself. It binds to one of this computer's private LAN
// addresses when there is one, so the page is a real non-secure HTTP origin (no
// crypto.randomUUID). Without one it falls back to 127.0.0.1 and the LAN-only
// test is skipped. Screenshots for the PR are opt-in:
//   npm run demo:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project browser-demo

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
const lanAddress =
  process.env['DEMO_E2E_HOST'] ??
  Object.values(networkInterfaces())
    .flat()
    .find((a) => a?.family === 'IPv4' && PRIVATE_IPV4.test(a.address))?.address
const host = lanAddress ?? '127.0.0.1'
const port = Number(process.env['DEMO_E2E_PORT'] ?? 4183)
const root = resolve(__dirname, '../..')
const shotsDir = join(root, 'docs/screenshots/issue-100')
const capture = Boolean(process.env['CAPTURE_SCREENSHOTS'])
const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/

const server = { url: `http://${host}:${port}/` }
let child: ChildProcess

test.beforeAll(async () => {
  child = spawn(process.execPath, ['scripts/demo-lan.mjs', '--host', host, '--port', String(port)], { cwd: root })
  let output = ''
  await new Promise<void>((ready, fail) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('Press Ctrl+C to stop')) ready()
    })
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.once('exit', (code) => fail(new Error(`demo:lan exited with ${code}: ${output}`)))
  })
  expect(output).toContain(`${server.url}#/clients`)
})

test.afterAll(() => {
  child?.kill()
})

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()

async function addClient(page: Page, name: string) {
  await page.goto(`${server.url}#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

test('serves the shared UI over plain HTTP, with no Electron bridge and no other origins', async ({ page }) => {
  const origins = new Set<string>()
  page.on('request', (request) => origins.add(new URL(request.url()).origin))
  page.on('websocket', (ws) => origins.add(new URL(ws.url()).origin))

  const response = await page.goto(`${server.url}#/clients`)
  expect(page.url()).toBe(`http://${host}:${port}/#/clients`)
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'none'")

  await expect(page.getByRole('region', { name: 'Demo mode' })).toContainText('Demo Mode — Fictional Data Only')
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
  await expect(page.getByText('7 active · 1 archived')).toBeVisible()
  expect(await page.evaluate(() => 'tracingGuatemala' in window)).toBe(false)

  await nav(page).getByRole('link', { name: 'Settings & Backup' }).click()
  await expect(page.getByText(/only available in the desktop app/)).toBeVisible()
  await expect(page.getByRole('button', { name: /backup/i })).toHaveCount(0)
  await expect(page.getByTestId('app-version')).toHaveText(/^Tracing Guatemala browser demo version \d+\.\d+\.\d+$/)

  expect([...origins]).toEqual([`http://${host}:${port}`])
})

test('creates clients with v4 UUIDs on a non-secure LAN origin', async ({ page }) => {
  test.skip(!lanAddress, 'No private LAN address on this computer; the next test still covers the UUID fallback.')
  await page.goto(server.url)
  expect(await page.evaluate(() => [window.isSecureContext, typeof crypto.randomUUID])).toEqual([false, 'undefined'])

  await addClient(page, 'Valeria Pop')
  expect(page.url()).toMatch(new RegExp(`#/clients/${UUID_V4.source}$`))
})

test('creates clients with v4 UUIDs when crypto.randomUUID is missing on any origin', async ({ page }) => {
  await page.addInitScript(() => {
    delete (Crypto.prototype as Partial<Crypto>).randomUUID
  })
  await addClient(page, 'Valeria Pop')
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined')
  expect(page.url()).toMatch(new RegExp(`#/clients/${UUID_V4.source}$`))
})

test('walks through search, notes, duplicates and archive/restore, then resets on refresh', async ({ page }) => {
  await page.goto(`${server.url}#/clients`)

  // Directory search (accent-insensitive) and filters.
  await page.getByLabel('Search clients').fill('lucia')
  await expect(page.locator('.result-count')).toHaveText(/^1 client · /)
  await page.getByRole('button', { name: 'Clear search and filters' }).click()
  await pick(page, 'Referral')
  await expect(page.getByRole('link', { name: 'María José Alvarado' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Daniel Ochoa' })).toHaveCount(0)
  await pick(page, 'Archived')
  await expect(page.getByRole('link', { name: 'Rosa Chávez Ixcoy' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search and filters' }).click()

  // Profile, notes and contact entries.
  await page.getByRole('link', { name: 'Lucía Fernández (Quetzaltenango line)' }).click()
  const history = page.getByRole('region', { name: 'Notes & contact history' })
  await expect(history.getByText(/civil registry index/)).toBeVisible()
  await history.getByLabel('Your note').fill('Demo note: asked for the grandparents’ town.')
  await history.getByRole('button', { name: 'Add note' }).click()
  await expect(history.getByText('Demo note: asked for the grandparents’ town.')).toBeVisible()

  // Edit details.
  await page.getByRole('link', { name: 'Edit details' }).click()
  await page.getByLabel(/^Email/).fill('lucia.demo@example.com')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Changes saved.')).toBeVisible()

  // Duplicate advisory (advisory only: saving anyway works).
  await page.goto(`${server.url}#/clients/new`)
  await page.getByLabel(/^Name/).fill('daniel ochoa')
  await pick(page, 'Fiverr')
  await page.getByRole('button', { name: 'Save client' }).click()
  const advisory = page.getByRole('alert').filter({ hasText: 'This might be someone you already have' })
  await expect(advisory.getByText('Daniel Ochoa')).toBeVisible()
  await advisory.getByRole('button', { name: 'Save as a new client anyway' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'daniel ochoa' })).toBeVisible()

  // Archive (read-only profile) and restore.
  await page.getByRole('button', { name: 'Archive' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Archive client' }).click()
  await expect(page.getByText(/This profile is read-only/)).toBeVisible()
  await page.getByRole('button', { name: 'Restore client' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore client' }).click()
  await expect(page.getByText('Client restored.')).toBeVisible()

  await nav(page).getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByText('8 active · 1 archived')).toBeVisible()

  // Refresh: back to the documented sample set.
  await page.reload()
  await expect(page.getByText('7 active · 1 archived')).toBeVisible()
  await expect(page.getByRole('link', { name: 'daniel ochoa', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'Lucía Fernández (Quetzaltenango line)' }).click()
  await expect(page.getByRole('region', { name: 'Contact' }).getByText('lucia.fernandez@example.com')).toBeVisible()
  await expect(page.getByText('Demo note: asked for the grandparents’ town.')).toHaveCount(0)
})

const viewports = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 }
]

for (const viewport of viewports) {
  test(`fits a ${viewport.name} screen (${viewport.width}px) without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const routes = [
      ['home', ''],
      ['directory', '#/clients'],
      ['profile', '#/clients/de300000-0000-4000-8000-000000000001'],
      ['archived-profile', '#/clients/de300000-0000-4000-8000-000000000008'],
      ['form', '#/clients/new'],
      ['settings', '#/settings']
    ] as const

    for (const [name, hash] of routes) {
      await page.goto(`${server.url}${hash}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Demo mode' })).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, `${name} overflows by ${overflow}px`).toBeLessThanOrEqual(0)
      if (capture) await page.screenshot({ path: join(shotsDir, `${viewport.name}-${name}.png`), fullPage: true })
    }

    // Main navigation stays reachable at every width.
    await nav(page).getByRole('link', { name: 'Clients' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
    await page.getByRole('link', { name: 'Grace Whitfield' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Grace Whitfield' })).toBeVisible()
  })
}

test('keeps demo code and sample data out of the desktop bundle', () => {
  const assets = resolve(__dirname, '../../out/renderer/assets')
  const bundle = readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(assets, f), 'utf8'))
    .join('\n')
  expect(bundle).toContain('Settings & Backup')
  for (const marker of ['Tracing Guatemala browser demo', 'de300000-0000-4000', 'Lucía Fernández', 'getRandomValues']) {
    expect(bundle).not.toContain(marker)
  }
})
