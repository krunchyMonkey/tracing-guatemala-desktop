import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The Research Studio Home dashboard (#116) in the built Live web app, driven through
// the UI: an empty profile shows the zero state; after a client, a case and a task the
// dashboard shows the continue link and the metrics. Own port. Fictional data only.

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_STUDIO_PORT'] ?? 4197)
const origin = `http://127.0.0.1:${port}`

let dataDir: string
let host: ChildProcess

test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-studio-e2e-'))
  host = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist-web/server/main.mjs', '--port', String(port), '--data-dir', dataDir], { cwd: root })
  let output = ''
  const launchUrl = await new Promise<string>((ready, fail) => {
    host.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = /http:\/\/127\.0\.0\.1:\d+\/launch\?token=[\w-]+/.exec(output)
      if (match && output.includes('Press Ctrl+C to stop')) ready(match[0])
    })
    host.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    host.once('exit', (code) => fail(new Error(`web:local exited with ${code}: ${output}`)))
  })
  process.env['TG_STUDIO_LAUNCH'] = launchUrl
})

test.afterEach(async () => {
  if (host.exitCode === null) {
    const exited = new Promise((done) => host.once('exit', done))
    host.kill()
    await exited
  }
  rmSync(dataDir, { recursive: true, force: true })
})

const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const overflowOf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

test('shows the zero state, then the continue link and metrics after a client, a case and a task', async ({ page }) => {
  await page.goto(process.env['TG_STUDIO_LAUNCH']!)
  await page.goto(`${origin}/#/`)
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
  const first = page.getByRole('link', { name: 'Add your first client' })
  await expect(first).toBeVisible()
  await expect(page.getByRole('link', { name: /Continue researching/ })).toHaveCount(0)
  await expect(page.getByText('Illustrative figures from fictional demo data')).toHaveCount(0)
  const glance = page.getByRole('region', { name: 'At a glance' })
  await expect(glance.locator('.studio-tile-value').first()).toHaveText('0')
  await first.click()

  await page.getByLabel(/^Name/).fill('Ana Ejemplo')
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ana Ejemplo' })).toBeVisible()

  // With a client but no case, the action becomes Start a case.
  await page.goto(`${origin}/#/`)
  await expect(page.getByRole('link', { name: 'Start a case' })).toBeVisible()

  await page.goto(`${origin}/#/cases/new`)
  await page.getByLabel('Client', { exact: true }).selectOption({ label: 'Ana Ejemplo' })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel(/^Title/).fill('Maternal grandparents')
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Maternal grandparents' })).toBeVisible()
  const caseUrl = page.url()

  const steps = page.getByRole('region', { name: 'Next steps' })
  const form = steps.getByRole('form', { name: 'Add a next step' })
  await form.getByLabel('What needs doing').fill('Request the 1931 register')
  await form.getByLabel('Deadline (optional)').fill('2000-01-01')
  await form.getByRole('button', { name: 'Add next step' }).click()
  await expect(form.getByLabel('What needs doing')).toHaveValue('')

  await page.goto(`${origin}/#/`)
  const cont = page.getByRole('link', { name: /Continue researching/ })
  await expect(cont).toBeVisible()
  await expect(page.getByRole('link', { name: 'Start a case' })).toHaveCount(0)
  const tile = (label: string) => glance.locator('.studio-tile').filter({ hasText: label })
  await expect(tile('Open cases')).toContainText('1')
  await expect(tile('Overdue tasks')).toContainText('1')
  await expect(page.getByRole('region', { name: 'Upcoming tasks' })).toContainText('Request the 1931 register')
  await expect(page.getByRole('region', { name: 'Upcoming tasks' }).locator('.overdue-tag')).toHaveText('Overdue')
  await expect(page.getByRole('region', { name: 'Active cases' })).toContainText('Maternal grandparents')
  await expect(page.getByRole('region', { name: 'Recent activity' })).toContainText('Case created')

  await cont.click()
  await expect(page).toHaveURL(caseUrl)
  await expect(page.getByRole('heading', { level: 1, name: 'Maternal grandparents' })).toBeVisible()
})

test('has no horizontal overflow at 375, 768 and 1280 wide, and honours reduced motion', async ({ page }) => {
  await page.goto(process.env['TG_STUDIO_LAUNCH']!)
  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1280, 800]
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.goto(`${origin}/#/`)
    await expect(page.getByRole('link', { name: 'Add your first client' })).toBeVisible()
    expect(await overflowOf(page), `${width}px wide`).toBeLessThanOrEqual(0)
  }
  const animationOf = () => page.locator('.studio-tile').first().evaluate((el) => getComputedStyle(el).animationName)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await expect(page.locator('.studio-tile').first()).toBeVisible()
  expect(await animationOf()).toBe('none')
})
