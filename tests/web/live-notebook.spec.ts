import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

// The research notebook (#148) in the built Live web app, with the real rich-text editor,
// driven through the UI only: start a notebook, write and format, organize sections and
// pages, switch pages and come back, paste hostile HTML, reload, restart the host, and
// read an archived case. Also checks that the production CSP (no inline styles) is never
// violated and that nothing scrolls sideways. Own port; fictional data only.
// Screenshots are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-notebook

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_NOTEBOOK_PORT'] ?? 4199)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/issue-148')
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

/** Anything the browser reports about the page's security policy. */
let violations: string[]

test.beforeEach(async ({ page }) => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-notebook-e2e-'))
  violations = []
  page.on('console', (message) => {
    if (/content security policy|refused to (apply|load|execute)/i.test(message.text())) violations.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => violations.push(`pageerror: ${error.message}`))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`)
    })
  })
})

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stop))
  rmSync(dataDir, { recursive: true, force: true })
})

const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const dialog = (page: Page) => page.getByRole('alertdialog')
const editor = (page: Page) => page.getByRole('textbox', { name: 'Page text' })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Formatting' })
const nav = (page: Page) => page.getByRole('navigation', { name: 'Notebook' })
const status = (page: Page) => page.locator('.note-save-status')
const pageLinks = (page: Page) => nav(page).locator('.note-nav-page')

async function addClient(page: Page, name: string): Promise<void> {
  await page.goto(`${origin}/#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

async function addCase(page: Page, clientName: string, title: string): Promise<string> {
  await page.goto(`${origin}/#/cases/new`)
  await page.getByLabel('Client', { exact: true }).selectOption({ label: clientName })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel(/^Title/).fill(title)
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  return page.url()
}

/** From the case page: Start a notebook, then Start. Leaves the first page open. */
async function startNotebook(page: Page): Promise<void> {
  const card = page.getByRole('region', { name: 'Research notebook' })
  await expect(card).toContainText('Sections and pages for your working notes')
  await card.getByRole('link', { name: 'Start a notebook' }).click()
  await expect(page.getByRole('heading', { name: 'Start your research notebook' })).toBeVisible()
  await page.getByRole('button', { name: 'Start your research notebook' }).click()
  await expect(pageLinks(page)).toHaveText(['First page'])
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true')
}

async function renameOpenPage(page: Page, title: string): Promise<void> {
  const field = page.getByLabel('Page title')
  await field.fill(title)
  await field.press('Enter')
  await expect(pageLinks(page).filter({ hasText: title })).toHaveCount(1)
}

/** A formatted, fictional page: heading, bold words, bullets (one nested), a checklist and a divider. */
async function writeSamplePage(page: Page): Promise<void> {
  const surface = editor(page)
  await surface.click()
  await page.keyboard.type('# Parish sources')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Fictional: Sample family baptism search. We checked the index for the ')
  await page.keyboard.press('Control+B')
  await page.keyboard.type('Ejemplo')
  await page.keyboard.press('Control+B')
  await page.keyboard.type(' family and found two entries.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- Ask the archivist about the registers')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Request slip needed')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.type('Copy the index page')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('[ ] Order microfilm')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Check the fiche numbers')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await toolbar(page).getByRole('button', { name: 'Divider' }).click()
  await page.keyboard.type('Next visit: bring the request slip.')
}

async function paste(page: Page, html: string, text: string): Promise<void> {
  await page.evaluate(
    ({ html: markup, text: plain }) => {
      const target = document.querySelector('.ProseMirror')!
      const data = new DataTransfer()
      data.setData('text/html', markup)
      data.setData('text/plain', plain)
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    },
    { html, text }
  )
}

const overflowOf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

async function expectSample(surface: Locator): Promise<void> {
  await expect(surface.locator('h1')).toHaveText('Parish sources')
  await expect(surface.locator('strong')).toHaveText('Ejemplo')
  await expect(surface.locator('ul > li > p').first()).toHaveText('Ask the archivist about the registers')
  await expect(surface.locator('ul > li > ul > li')).toHaveText('Request slip needed')
  await expect(surface.locator('li[data-type="taskItem"]')).toHaveCount(2)
  await expect(surface.locator('hr')).toHaveCount(1)
  await expect(surface).toContainText('Next visit: bring the request slip.')
}

test('writes, formats and organizes a notebook, and finds it all after a reload and a host restart', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseUrl = await addCase(page, 'Ana Ejemplo', 'Fictional: Sample family baptism search')
  await startNotebook(page)

  // Write and format on the first page.
  await renameOpenPage(page, 'Archive visit notes')
  await expect(editor(page).locator('p.is-editor-empty')).toHaveAttribute('data-placeholder', 'Start writing… Use the toolbar or type # for a heading')
  await writeSamplePage(page)
  await expectSample(editor(page))
  // Tick the first task with the keyboard-reachable checkbox.
  const firstTask = editor(page).locator('li[data-type="taskItem"]').first()
  await expect(firstTask.getByRole('checkbox')).toHaveAccessibleName('Task: Order microfilm')
  await firstTask.getByRole('checkbox').check()
  await expect(firstTask).toHaveAttribute('data-checked', 'true')
  await expect(status(page)).toHaveText(/^Saved at \d\d:\d\d$/)

  // The toolbar reflects the caret: bold is pressed inside the bold word.
  await editor(page).locator('strong').click()
  await expect(toolbar(page).getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')

  // Add a page (focus lands on its title), a section, and a page in it.
  await nav(page).getByRole('button', { name: '+ Add a page' }).click()
  await expect(page.getByLabel('Page title')).toBeFocused()
  await page.keyboard.type('Questions for the archivist')
  await page.keyboard.press('Enter')
  await expect(pageLinks(page)).toHaveText(['Archive visit notes', 'Questions for the archivist'])
  await editor(page).click()
  await page.keyboard.type('Which registers survived the 1976 earthquake? (fictional)')

  await nav(page).getByRole('button', { name: '+ New section' }).click()
  await nav(page).getByLabel('New section name').fill('Letters')
  await nav(page).getByRole('button', { name: 'Add section' }).click()
  await expect(nav(page).getByRole('button', { name: /^Letters/ })).toBeVisible()
  await nav(page).getByRole('button', { name: 'Options for section Letters' }).click()
  await page.getByRole('group', { name: 'Options for section Letters' }).getByRole('button', { name: 'Add a page' }).click()
  await expect(page.getByLabel('Page title')).toBeFocused()
  await page.keyboard.type('Letter to the municipal archive')
  await page.keyboard.press('Enter')
  await expect(pageLinks(page)).toHaveText(['Archive visit notes', 'Questions for the archivist', 'Letter to the municipal archive'])

  // Reorder: move the second page up, and the letter into the first section.
  await nav(page).getByRole('button', { name: 'Options for page Questions for the archivist' }).click()
  await page.getByRole('button', { name: 'Move up' }).click()
  await expect(pageLinks(page)).toHaveText(['Questions for the archivist', 'Archive visit notes', 'Letter to the municipal archive'])
  await nav(page).getByRole('button', { name: 'Options for page Letter to the municipal archive' }).click()
  await page.getByLabel('Move to section').selectOption({ label: 'Research notes' })
  await expect(nav(page).locator('.note-nav-section').first().locator('.note-nav-page')).toHaveCount(3)

  // Switch away and back: the content is intact (and was saved on the way out).
  await pageLinks(page).filter({ hasText: 'Archive visit notes' }).click()
  await expect(page.getByLabel('Page title')).toHaveValue('Archive visit notes')
  await expectSample(editor(page))
  await expect(editor(page).locator('li[data-type="taskItem"]').first()).toHaveAttribute('data-checked', 'true')
  await pageLinks(page).filter({ hasText: 'Questions for the archivist' }).click()
  await expect(editor(page)).toContainText('Which registers survived')
  await pageLinks(page).filter({ hasText: 'Archive visit notes' }).click()

  // Hostile paste: no image, script, frame, style attribute or javascript: link survives.
  await editor(page).click()
  await page.keyboard.press('Control+End')
  await paste(
    page,
    '<p>Pasted line</p><img src="x" onerror="window.__pwned=1"><script>window.__pwned=1</script>' +
      '<iframe src="https://example.org"></iframe><p style="color:red" onclick="window.__pwned=1">Styled <a href="javascript:window.__pwned=1">bad link</a> ' +
      '<a href="https://example.org/ok" target="_self" onclick="window.__pwned=1">good link</a></p>',
    'fallback'
  )
  await expect(editor(page)).toContainText('Pasted line')
  await expect(editor(page)).toContainText('bad link')
  const hostileLeft = (surface: Locator) => surface.locator('img, script, iframe, style, [style], [onclick], [onerror], a[href^="javascript"]')
  await expect(hostileLeft(page.locator('.note-surface'))).toHaveCount(0)
  await expect(editor(page).locator('a')).toHaveAttribute('href', 'https://example.org/ok')
  await expect(editor(page).locator('a')).toHaveAttribute('rel', 'noopener noreferrer nofollow')
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  await expect(status(page)).toHaveText(/^Saved at \d\d:\d\d$/)

  // Reload: everything persists, still without hostile markup.
  await page.reload()
  await expect(page.getByLabel('Page title')).toHaveValue('Archive visit notes')
  await expectSample(editor(page))
  await expect(editor(page)).toContainText('Pasted line')
  await expect(hostileLeft(page.locator('.note-surface'))).toHaveCount(0)
  await expect(editor(page).locator('a')).toHaveCount(1)

  // Restart the host: still there, in the same order.
  await stop(host.child)
  host = await startHost()
  await page.goto(host.launchUrl)
  await page.goto(caseUrl)
  await expect(page.getByRole('region', { name: 'Research notebook' })).toContainText('3 pages in 2 sections')
  await page.getByRole('link', { name: 'Open the notebook' }).click()
  await expect(pageLinks(page)).toHaveText(['Questions for the archivist', 'Archive visit notes', 'Letter to the municipal archive'])
  await pageLinks(page).filter({ hasText: 'Archive visit notes' }).click()
  await expectSample(editor(page))
  expect(violations).toEqual([])
})

test('archives and restores pages and sections, keeps their content, and goes read-only with the case', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Beatriz Muestra')
  const caseUrl = await addCase(page, 'Beatriz Muestra', 'Fictional: Marriage record check')
  await startNotebook(page)
  await editor(page).click()
  await page.keyboard.type('Kept while archived.')
  await expect(status(page)).toHaveText(/^Saved at \d\d:\d\d$/)

  await nav(page).getByRole('button', { name: '+ Add a page' }).click()
  await expect(page.getByLabel('Page title')).toBeFocused()
  await page.keyboard.type('Second page')
  await page.keyboard.press('Enter')
  await expect(pageLinks(page)).toHaveText(['First page', 'Second page'])

  // Archive the first page after confirming.
  await nav(page).getByRole('button', { name: 'Options for page First page' }).click()
  await page.getByRole('button', { name: 'Archive page' }).click()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(pageLinks(page)).toHaveText(['First page', 'Second page'])
  await nav(page).getByRole('button', { name: 'Options for page First page' }).click()
  await page.getByRole('button', { name: 'Archive page' }).click()
  await dialog(page).getByRole('button', { name: 'Archive page' }).click()
  await expect(nav(page).getByText('Archived (1)')).toBeVisible()
  await expect(pageLinks(page)).toHaveText(['Second page', 'First page · Research notes'])
  await nav(page).getByText('Archived (1)').click()
  // An archived page can be read but not changed.
  await nav(page).locator('.note-nav-archived').getByRole('link', { name: 'First page' }).click()
  await expect(editor(page)).toContainText('Kept while archived.')
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false')
  await expect(page.getByText('This page is archived, so it is read-only')).toBeVisible()
  await expect(toolbar(page)).toHaveCount(0)
  await nav(page).getByRole('button', { name: 'Restore page First page' }).click()
  await expect(nav(page).getByText(/^Archived \(/)).toHaveCount(0)
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true')
  await expect(editor(page)).toContainText('Kept while archived.')

  // The whole case archived: readable, not writable.
  await page.goto(caseUrl)
  await page.getByRole('button', { name: 'Archive case' }).click()
  await dialog(page).getByRole('button', { name: 'Archive case' }).click()
  await expect(page.getByText('Case archived.')).toBeVisible()
  await page.getByRole('link', { name: 'Open the notebook' }).click()
  await expect(page.getByText('This case is archived, so its notebook is read-only.')).toBeVisible()
  await expect(editor(page)).toContainText('Kept while archived.')
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false')
  await expect(page.getByLabel('Page title')).toHaveJSProperty('readOnly', true)
  await expect(toolbar(page)).toHaveCount(0)
  await expect(nav(page).getByRole('button', { name: '+ New section' })).toHaveCount(0)
  await expect(nav(page).getByRole('button', { name: /^Options for/ })).toHaveCount(0)
  expect(violations).toEqual([])
})

test('never breaks the content security policy and fits phone, tablet and desktop; captures screenshots on request', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  await addCase(page, 'Ana Ejemplo', 'Fictional: Sample family baptism search')
  await startNotebook(page)
  await renameOpenPage(page, 'Archive visit notes')
  await writeSamplePage(page)
  await editor(page).locator('li[data-type="taskItem"]').first().getByRole('checkbox').check()
  await expect(status(page)).toHaveText(/^Saved at \d\d:\d\d$/)
  // A second page with a very long title and one unbroken word, to prove nothing scrolls sideways.
  await nav(page).getByRole('button', { name: '+ Add a page' }).click()
  await expect(page.getByLabel('Page title')).toBeFocused()
  await page.keyboard.type('Questions for the archivist about the neighbouring parishes and every surname variant')
  await page.keyboard.press('Enter')
  await editor(page).click()
  await paste(page, `<p>${'Ejemplo'.repeat(30)}</p>`, '')
  await expect(status(page)).toHaveText(/^Saved at \d\d:\d\d$/)
  await nav(page).getByRole('button', { name: '+ New section' }).click()
  await nav(page).getByLabel('New section name').fill('Letters')
  await nav(page).getByRole('button', { name: 'Add section' }).click()
  const longPage = page.url()
  await pageLinks(page).first().click()
  await expectSample(editor(page))
  const firstPage = page.url()
  if (capture) mkdirSync(shotsDir, { recursive: true })

  // The editor never reaches for inline styles: nothing in the page has a style attribute.
  expect(await page.locator('.notebook [style]').count()).toBe(0)
  expect(await page.locator('head style').count()).toBe(0)

  for (const viewport of [
    { name: 'phone', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(viewport)
    await page.goto(longPage)
    await expect(editor(page)).toContainText('EjemploEjemplo')
    expect(await overflowOf(page), `the long page overflows by ${await overflowOf(page)}px at ${viewport.width}px`).toBeLessThanOrEqual(0)
    await page.goto(firstPage)
    await page.reload()
    await expectSample(editor(page))
    expect(await overflowOf(page), `overflows by ${await overflowOf(page)}px at ${viewport.width}px`).toBeLessThanOrEqual(0)
    const toggle = page.getByRole('button', { name: 'Pages', exact: true })
    if (viewport.width >= 1024) {
      await expect(toggle).toBeHidden()
      await expect(nav(page)).toBeVisible()
      if (capture) await page.screenshot({ path: join(shotsDir, 'desktop-1280-notebook.png'), fullPage: true })
    } else {
      await expect(nav(page)).toBeHidden()
      if (capture) await page.screenshot({ path: join(shotsDir, `${viewport.name}-${viewport.width}-navigation-collapsed.png`), fullPage: true })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(nav(page)).toBeVisible()
      expect(await overflowOf(page), `overflows with the list open at ${viewport.width}px`).toBeLessThanOrEqual(0)
      if (capture && viewport.name === 'tablet') await page.screenshot({ path: join(shotsDir, 'tablet-768-navigation-open.png') })
      await toggle.click()
      await expect(nav(page)).toBeHidden()
    }
    // Touch targets in the toolbar are at least 40px.
    for (const button of await toolbar(page).getByRole('button').all()) {
      const box = (await button.boundingBox())!
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(40)
    }
  }
  expect(violations).toEqual([])
})
