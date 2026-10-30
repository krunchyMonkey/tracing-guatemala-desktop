import { spawn, type ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The guided demo tour (#102) in the built browser demo, served by
// `npm run demo:lan` itself on 127.0.0.1 with its own port. Fictional data only.
// Screenshots are opt-in:
//   npm run demo:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project browser-demo tour

const root = resolve(__dirname, '../..')
const port = Number(process.env['DEMO_E2E_TOUR_PORT'] ?? 4185)
const url = `http://127.0.0.1:${port}/`
const shotsDir = join(root, 'docs/screenshots/issue-102')
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

const popover = (page: Page) => page.locator('.driver-popover')
const title = (page: Page) => page.locator('.driver-popover-title')
const tourButton = (page: Page) => page.getByRole('button', { name: /^(Take a tour|Restart tour)$/ })
const nextButton = (page: Page) => page.locator('.driver-popover-next-btn')
const backButton = (page: Page) => page.locator('.driver-popover-prev-btn')

const stepTitles = [
  'Welcome to the Research Studio',
  'Find any client',
  'Add a client',
  'A client profile',
  'Notes and contact history',
  'Archive and restore',
  'A research case'
]

/** Records CSP violations and console errors for the whole page lifetime. */
async function watchViolations(page: Page) {
  const problems: string[] = []
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      ;(window as unknown as { __csp: string[] }).__csp = [...((window as unknown as { __csp?: string[] }).__csp ?? []), `${event.violatedDirective} ${event.blockedURI}`]
    })
  })
  page.on('console', (message) => {
    // The browser's automatic favicon request 404s on the static demo; that is not a tour problem.
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) problems.push(`console: ${message.text()} ${message.location().url}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  return async () => {
    const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
    return [...problems, ...csp.map((c) => `csp: ${c}`)]
  }
}

async function expectNoOverlay(page: Page) {
  await expect(page.locator('.driver-overlay, .driver-popover, .driver-active-element')).toHaveCount(0)
}

test('runs the whole tour with Next, Back and Finish, with no CSP violations and nothing changed', async ({ page }) => {
  const problems = await watchViolations(page)
  const origins = new Set<string>()
  page.on('request', (request) => origins.add(new URL(request.url()).origin))

  const response = await page.goto(`${url}#/`)
  const header = response?.headers()['content-security-policy'] ?? ''
  expect(header).toContain("script-src 'self'")
  expect(header).toContain("style-src 'self'")
  expect(header).toContain("connect-src 'none'")
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
  await expect(popover(page)).toHaveCount(0)

  await tourButton(page).click()
  await expect(tourButton(page)).toHaveText('Restart tour')
  for (const [index, expected] of stepTitles.entries()) {
    await expect(title(page)).toHaveText(expected)
    await expect(page.locator('.driver-popover-progress-text')).toHaveText(`Step ${index + 1} of ${stepTitles.length}`)
    if (capture) await page.screenshot({ path: join(shotsDir, `tour-step-${index + 1}.png`) })
    if (index === 0) await expect(backButton(page)).toBeHidden()
    if (index === 1) await expect(page).toHaveURL(/#\/clients$/)
    if (index === 3) await expect(page).toHaveURL(/#\/clients\/de300000-0000-4000-8000-000000000001$/)
    if (index === 6) await expect(page).toHaveURL(/#\/cases\/de300000-0000-4000-8000-200000000001$/)
    if (index === stepTitles.length - 1) await expect(nextButton(page)).toHaveText('Finish')
    await nextButton(page).click()
  }
  await expectNoOverlay(page)
  await expect(tourButton(page)).toBeFocused()

  // Nothing was created, edited or archived.
  await page.goto(`${url}#/clients`)
  await expect(page.getByText('43 active · 5 archived')).toBeVisible()

  expect(await problems()).toEqual([])
  expect([...origins]).toEqual([`http://127.0.0.1:${port}`])
})

test('Back returns to the previous step and screen', async ({ page }) => {
  await page.goto(`${url}#/`)
  await tourButton(page).click()
  await nextButton(page).click()
  await nextButton(page).click()
  await nextButton(page).click()
  await expect(title(page)).toHaveText('A client profile')
  await backButton(page).click()
  await expect(title(page)).toHaveText('Add a client')
  await expect(page).toHaveURL(/#\/clients$/)
  await backButton(page).click()
  await backButton(page).click()
  await expect(title(page)).toHaveText('Welcome to the Research Studio')
  await expect(page).toHaveURL(/#\/$/)
})

test('Escape closes the tour, returns focus to the button, and Restart starts again from step 1', async ({ page }) => {
  await page.goto(`${url}#/`)
  await tourButton(page).click()
  await nextButton(page).click()
  await expect(title(page)).toHaveText('Find any client')
  await page.keyboard.press('Escape')
  await expectNoOverlay(page)
  await expect(tourButton(page)).toBeFocused()

  await tourButton(page).click()
  await expect(title(page)).toHaveText('Welcome to the Research Studio')
  await expect(page).toHaveURL(/#\/$/)
})

test('works from the keyboard and leaves no overlay when the route changes underneath it', async ({ page }) => {
  await page.goto(`${url}#/`)
  await tourButton(page).focus()
  await page.keyboard.press('Enter')
  await expect(title(page)).toHaveText('Welcome to the Research Studio')
  await nextButton(page).focus()
  await page.keyboard.press('Enter')
  await expect(title(page)).toHaveText('Find any client')
  // Driver.js ignores arrow keys while its step animation is running, so retry until one lands.
  await expect(async () => {
    await page.keyboard.press('ArrowRight')
    await expect(title(page)).toHaveText('Add a client', { timeout: 500 })
  }).toPass()
  await expect(async () => {
    await page.keyboard.press('ArrowLeft')
    await expect(title(page)).toHaveText('Find any client', { timeout: 500 })
  }).toPass()

  await page.evaluate(() => (window.location.hash = '#/settings'))
  await expectNoOverlay(page)
  await expect(page.getByRole('heading', { level: 1, name: /Settings/ })).toBeVisible()
})

test('turns animation off when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${url}#/`)
  await tourButton(page).click()
  await expect(popover(page)).toBeVisible()
  await expect(page.locator('body.driver-fade')).toHaveCount(0)
  await expect(page.locator('body.driver-active')).toHaveCount(1)
})

test('keeps every popover on screen and the page free of horizontal scroll at 375, 768 and 1280', async ({ page }) => {
  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1280, 800]
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.goto(`${url}#/`)
    await tourButton(page).click()
    for (const [index, expected] of stepTitles.entries()) {
      await expect(title(page)).toHaveText(expected)
      await page.waitForTimeout(0)
      const box = await popover(page).boundingBox()
      expect(box, `${width}px step ${index + 1}`).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5)
      expect(box!.y + box!.height).toBeLessThanOrEqual(height + 0.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
      if (capture && width === 375 && index === 3) await page.screenshot({ path: join(shotsDir, 'tour-375.png') })
      await nextButton(page).click()
    }
    await expectNoOverlay(page)
  }
})
