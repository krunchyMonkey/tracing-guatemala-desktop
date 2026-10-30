import { spawn, type ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The Research Studio Home dashboard (#116) in the built browser demo, served by
// `npm run demo:lan` itself on 127.0.0.1 with its own port. Fictional data only.
// Screenshots are opt-in:
//   npm run demo:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project browser-demo studio-home

const root = resolve(__dirname, '../..')
const port = Number(process.env['DEMO_E2E_STUDIO_PORT'] ?? 4184)
const url = `http://127.0.0.1:${port}/`
const shotsDir = join(root, 'docs/screenshots/issue-116')
const capture = Boolean(process.env['CAPTURE_SCREENSHOTS'])
let child: ChildProcess

test.beforeAll(async () => {
  child = spawn(process.execPath, ['scripts/demo-lan.mjs', '--host', '127.0.0.1', '--port', String(port)], { cwd: root })
  let output = ''
  await new Promise<void>((ready, fail) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('Press Ctrl+C to stop')) ready()
    })
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.once('exit', (code) => fail(new Error(`demo:lan exited with ${code}: ${output}`)))
  })
})

test.afterAll(() => {
  child?.kill()
})

const overflowOf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

test('renders the studio with the illustrative label, and Continue researching opens a case', async ({ page }) => {
  await page.goto(`${url}#/`)
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
  await expect(page.getByText('Illustrative figures from fictional demo data')).toBeVisible()
  const glance = page.getByRole('region', { name: 'At a glance' })
  await expect(glance.locator('.studio-tile')).toHaveCount(4)
  await expect(page.getByRole('region', { name: 'Active cases' }).getByRole('listitem')).toHaveCount(6)
  await expect(page.getByRole('region', { name: 'Upcoming tasks' }).getByRole('listitem').first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'Recent activity' }).getByRole('listitem')).toHaveCount(8)
  await expect(page.getByRole('region', { name: 'Welcome' }).getByRole('link', { name: 'Clients' })).toBeVisible()

  await page.getByRole('link', { name: /Continue researching/ }).click()
  await expect(page).toHaveURL(/#\/cases\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByText('Case not found')).toHaveCount(0)
})

test('has no horizontal overflow at 375, 768 and 1280 wide', async ({ page }) => {
  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1280, 800]
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.goto(`${url}#/`)
    await expect(page.getByRole('region', { name: 'Recent activity' }).getByRole('listitem').first()).toBeVisible()
    expect(await overflowOf(page), `${width}px wide`).toBeLessThanOrEqual(0)
  }
})

test('plays the tile entrance by default and not under reduced motion', async ({ page }) => {
  const animationOf = () => page.locator('.studio-tile').first().evaluate((el) => getComputedStyle(el).animationName)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto(`${url}#/`)
  await expect(page.locator('.studio-tile').first()).toBeVisible()
  expect(await animationOf()).toBe('studio-rise')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await expect(page.locator('.studio-tile').first()).toBeVisible()
  expect(await animationOf()).toBe('none')
})

test('does not call anything but its own origin', async ({ page }) => {
  const origins = new Set<string>()
  page.on('request', (request) => origins.add(new URL(request.url()).origin))
  await page.goto(`${url}#/`)
  await expect(page.getByRole('region', { name: 'At a glance' })).toBeVisible()
  expect([...origins]).toEqual([new URL(url).origin])
})

test('captures the dashboard for the PR', async ({ page }) => {
  test.skip(!capture, 'Set CAPTURE_SCREENSHOTS=1 to write the PR screenshots')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`${url}#/`)
  await expect(page.getByRole('region', { name: 'Recent activity' }).getByRole('listitem').first()).toBeVisible()
  await page.screenshot({ path: join(shotsDir, 'after-desktop-home.png'), fullPage: true })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${url}#/`)
  await expect(page.getByRole('region', { name: 'Recent activity' }).getByRole('listitem').first()).toBeVisible()
  await page.screenshot({ path: join(shotsDir, 'after-phone-home.png'), fullPage: true })
})
