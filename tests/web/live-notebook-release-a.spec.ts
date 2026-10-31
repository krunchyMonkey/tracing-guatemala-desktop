import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

// Phase 3 Release A, integrated verification (#145): one realistic, serial journey through
// the built Live web app with the real editor, driven through the UI (plus the typed HTTP
// API only where a test must prove what the host refuses). Two fictional clients, each with
// a case; the notebook is built, formatted, reorganized, recovered, made to fail and
// conflict, linked to case records, kept apart per case, backed up and restored, made
// read-only with the case, and compared with the separate fictional demo. This is
// engineering verification, not researcher acceptance (#157).
// Own port (the demo is served on port + 1). Fictional data only.
// Screenshots are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-notebook-release-a

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_RELEASE_A_PORT'] ?? 4202)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/release-a')
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

/** Anything the browser reports about the page's security policy, plus uncaught page errors. */
let violations: string[]

test.beforeEach(async ({ page }) => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-release-a-e2e-'))
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

const SAVED = /^Saved at \d\d:\d\d$/
const SAVE_CALL = '**/api/v1/call/saveNotebookPage'
const ALPHA = 'Fictional Client Alpha'
const BETA = 'Fictional Client Beta'

const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const dialog = (page: Page) => page.getByRole('alertdialog')
const editor = (page: Page) => page.getByRole('textbox', { name: 'Page text' })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Formatting' })
const nav = (page: Page) => page.getByRole('navigation', { name: 'Notebook' })
const status = (page: Page) => page.locator('.note-save-status')
const pageLinks = (page: Page) => nav(page).locator('.note-nav-page')
const overflowOf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

async function addClient(page: Page, name: string): Promise<void> {
  await page.goto(`${origin}/#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

async function addCase(page: Page, clientName: string, title: string): Promise<{ url: string; id: string }> {
  await page.goto(`${origin}/#/cases/new`)
  await page.getByLabel('Client', { exact: true }).selectOption({ label: clientName })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel(/^Title/).fill(title)
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  return { url: page.url(), id: /#\/cases\/([\w-]+)/.exec(page.url())![1]! }
}

/** From the case page: Start a notebook, then Start. Leaves the first page open. */
async function startNotebook(page: Page): Promise<void> {
  const card = page.getByRole('region', { name: 'Research notebook' })
  await card.getByRole('link', { name: 'Start a notebook' }).click()
  await page.getByRole('button', { name: 'Start your research notebook' }).click()
  await expect(pageLinks(page)).toHaveText(['First page'])
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true')
}

const pageIdOf = (page: Page): string => /\/notebook\/([\w-]+)/.exec(page.url())![1]!

async function renameOpenPage(page: Page, title: string): Promise<void> {
  const field = page.getByLabel('Page title')
  await field.fill(title)
  await field.press('Enter')
  await expect(pageLinks(page).filter({ hasText: title })).toHaveCount(1)
}

async function addPageIn(page: Page, section: string, title: string): Promise<void> {
  await nav(page).getByRole('button', { name: `Options for section ${section}` }).click()
  await page.getByRole('group', { name: `Options for section ${section}` }).getByRole('button', { name: 'Add a page' }).click()
  await expect(page.getByLabel('Page title')).toBeFocused()
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  await expect(pageLinks(page).filter({ hasText: title })).toHaveCount(1)
}

async function addSection(page: Page, title: string): Promise<void> {
  await nav(page).getByRole('button', { name: '+ New section' }).click()
  await nav(page).getByLabel('New section name').fill(title)
  await nav(page).getByRole('button', { name: 'Add section' }).click()
  await expect(nav(page).getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible()
}

const openPage = async (page: Page, title: string): Promise<void> => {
  await nav(page).getByRole('link', { name: title, exact: true }).click()
  await expect(page.getByLabel('Page title')).toHaveValue(title)
}

/** The visible outline: each active section with its page titles, in order. */
const outlineOf = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('nav[aria-label="Notebook"] .note-nav-sections > li.note-nav-section')).map((section) => ({
      section: section.querySelector('.note-nav-section-title')!.textContent,
      pages: Array.from(section.querySelectorAll('a.note-nav-page')).map((a) => a.textContent)
    }))
  )

/** Calls the typed local API from the signed-in page, like the web client's adapter. */
async function api<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ([callName, callArgs]) => {
      const session = (await (await fetch('/api/v1/session', { credentials: 'same-origin' })).json()) as { csrfToken: string }
      const response = await fetch(`/api/v1/call/${callName as string}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-TG-CSRF': session.csrfToken },
        body: JSON.stringify({ args: callArgs })
      })
      if (!response.ok) throw new Error(`call failed: ${response.status}`)
      return ((await response.json()) as { result: unknown }).result
    },
    [name, args] as const
  ) as Promise<T>
}

interface ApiPage {
  version: number
  title: string
  content: unknown
}

/** Waits until the host holds the page with this text: proves a save went through, never a stale status line. */
async function hostHasText(page: Page, caseId: string, pageId: string, text: string): Promise<void> {
  await expect
    .poll(async () => JSON.stringify(((await api<ApiPage | null>(page, 'getNotebookPage', caseId, pageId)) ?? {}).content ?? null).includes(text), { timeout: 15_000 })
    .toBe(true)
}

async function addTask(page: Page, title: string): Promise<void> {
  const form = page.getByRole('region', { name: 'Next steps' }).getByRole('form', { name: 'Add a next step' })
  await form.getByLabel('What needs doing').fill(title)
  await form.getByRole('button', { name: 'Add next step' }).click()
  await expect(form.getByLabel('What needs doing')).toHaveValue('')
}

async function addJournalEntry(page: Page, activity: string, body: string): Promise<void> {
  const form = page.getByRole('region', { name: 'Research journal' }).getByRole('form', { name: 'Add a journal entry' })
  await form.getByLabel('Activity (optional)').fill(activity)
  await form.getByLabel('What you did or found').fill(body)
  await form.getByRole('button', { name: 'Add entry' }).click()
  await expect(form.getByLabel('What you did or found')).toHaveValue('')
}

/** A formatted, fictional page: heading, bold/italic, nested bullets, numbered list, checklist, link, divider. */
async function writeFormattedPage(page: Page): Promise<void> {
  await editor(page).click()
  await page.keyboard.type('# Parish sources')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Fictional: Sample family baptism search. We checked the index for the ')
  await page.keyboard.press('Control+B')
  await page.keyboard.type('Ejemplo')
  await page.keyboard.press('Control+B')
  await page.keyboard.type(' family and found ')
  await page.keyboard.press('Control+I')
  await page.keyboard.type('two entries')
  await page.keyboard.press('Control+I')
  await page.keyboard.type('.')
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
  await page.keyboard.press('Enter')
  await toolbar(page).getByRole('button', { name: 'Numbered list' }).click()
  await page.keyboard.type('Confirm the opening hours')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Bring a pencil')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Archive website')
  await page.keyboard.press('Shift+Home')
  await toolbar(page).getByRole('button', { name: 'Link', exact: true }).click()
  const linkDialog = page.getByRole('dialog', { name: 'Link' })
  await linkDialog.getByLabel('Web address').fill('https://example.org')
  await linkDialog.getByRole('button', { name: 'Apply link' }).click()
  await expect(linkDialog).toHaveCount(0)
  await editor(page).locator('li[data-type="taskItem"]').first().getByRole('checkbox').check()
}

async function expectFormattedPage(surface: Locator): Promise<void> {
  await expect(surface.locator('h1')).toHaveText('Parish sources')
  await expect(surface.locator('strong')).toHaveText('Ejemplo')
  await expect(surface.locator('em')).toHaveText('two entries')
  await expect(surface.locator('ul > li > p').first()).toHaveText('Ask the archivist about the registers')
  await expect(surface.locator('ul > li > ul > li')).toHaveText('Request slip needed')
  await expect(surface.locator('ol > li')).toHaveText(['Confirm the opening hours', 'Bring a pencil'])
  await expect(surface.locator('li[data-type="taskItem"]')).toHaveCount(2)
  await expect(surface.locator('li[data-type="taskItem"]').first()).toHaveAttribute('data-checked', 'true')
  await expect(surface.locator('li[data-type="taskItem"]').nth(1)).not.toHaveAttribute('data-checked', 'true')
  await expect(surface.locator('hr')).toHaveCount(1)
  await expect(surface.locator('a')).toHaveText('Archive website')
  await expect(surface.locator('a')).toHaveAttribute('href', /^https:\/\/example\.org\/?$/)
  await expect(surface).toContainText('Next visit: bring the request slip.')
}

const EXPECTED_OUTLINE = [
  { section: 'Research notes', pages: ['Questions for the archivist', 'Archive visit notes', 'Recovery page'] },
  { section: 'Photo records', pages: ['Camera notes'] },
  { section: 'Letters', pages: ['Letter to the municipal archive', 'Photo register'] }
]

test('Release A: one realistic journey from first notebook to backup, archive and the separate demo', async ({ page, context }) => {
  test.setTimeout(420_000)
  let host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, ALPHA)
  const alpha = await addCase(page, ALPHA, 'Fictional: Alpha baptism search')
  await addClient(page, BETA)
  const beta = await addCase(page, BETA, 'Fictional: Beta marriage search')
  const alphaPageIds: Record<string, string> = {}

  await test.step('1. create a notebook with 3 sections and 6 pages from the case screen', async () => {
    await page.goto(alpha.url)
    await startNotebook(page)
    await renameOpenPage(page, 'Archive visit notes')
    alphaPageIds['Archive visit notes'] = pageIdOf(page)
    await addSection(page, 'Letters')
    await addSection(page, 'Photographs')
    await addPageIn(page, 'Research notes', 'Questions for the archivist')
    await addPageIn(page, 'Research notes', 'Recovery page')
    await addPageIn(page, 'Letters', 'Letter to the municipal archive')
    await addPageIn(page, 'Letters', 'Photo log')
    await addPageIn(page, 'Photographs', 'Camera notes')
    expect(await outlineOf(page)).toEqual([
      { section: 'Research notes', pages: ['Archive visit notes', 'Questions for the archivist', 'Recovery page'] },
      { section: 'Letters', pages: ['Letter to the municipal archive', 'Photo log'] },
      { section: 'Photographs', pages: ['Camera notes'] }
    ])
  })

  await test.step('2. write and format notes in the real editor', async () => {
    await openPage(page, 'Archive visit notes')
    await writeFormattedPage(page)
    await expectFormattedPage(editor(page))
    await hostHasText(page, alpha.id, alphaPageIds['Archive visit notes']!, 'Bring a pencil')
    await expect(status(page)).toHaveText(SAVED)
    // The page the researcher sees is the page the host holds: the link is stored as a safe href.
    const stored = JSON.stringify((await api<ApiPage>(page, 'getNotebookPage', alpha.id, alphaPageIds['Archive visit notes']!)).content)
    expect(stored).toContain('https://example.org')
    expect(stored).not.toMatch(/<\/?(p|strong|em|ul|li|a)\b/)
  })

  await test.step('3. reorder pages and sections, move a page to another section, rename; reopen and compare', async () => {
    await openPage(page, 'Questions for the archivist')
    await editor(page).click()
    await page.keyboard.type('Which registers survived the 1976 earthquake? (fictional)')
    await nav(page).getByRole('button', { name: 'Options for page Questions for the archivist' }).click()
    await page.getByRole('button', { name: 'Move up' }).click()
    await expect(pageLinks(page).first()).toHaveText('Questions for the archivist')

    await nav(page).getByRole('button', { name: 'Options for section Photographs' }).click()
    await page.getByRole('group', { name: 'Options for section Photographs' }).getByRole('button', { name: 'Move up' }).click()
    await nav(page).getByRole('button', { name: 'Options for section Photographs' }).click()
    await page.getByRole('group', { name: 'Options for section Photographs' }).getByRole('button', { name: 'Rename' }).click()
    await nav(page).getByLabel('Section name').fill('Photo records')
    await nav(page).getByRole('button', { name: 'Save' }).click()
    await expect(nav(page).getByRole('button', { name: /^Photo records/ })).toBeVisible()

    // Move the photo log to the first section's neighbour by title, then rename it.
    await nav(page).getByRole('button', { name: 'Options for page Photo log' }).click()
    await page.getByLabel('Move to section').selectOption({ label: 'Photo records' })
    await expect.poll(async () => (await outlineOf(page)).find((s) => s.section === 'Photo records')?.pages.includes('Photo log')).toBe(true)
    await openPage(page, 'Photo log')
    await renameOpenPage(page, 'Photo register')
    await nav(page).getByRole('button', { name: 'Options for page Photo register' }).click()
    await page.getByLabel('Move to section').selectOption({ label: 'Letters' })
    await expect.poll(async () => (await outlineOf(page)).find((s) => s.section === 'Letters')?.pages.includes('Photo register')).toBe(true)

    expect(await outlineOf(page)).toEqual(EXPECTED_OUTLINE)
    // Reopen pages: their content is where it was left.
    await openPage(page, 'Archive visit notes')
    await expectFormattedPage(editor(page))
    await openPage(page, 'Questions for the archivist')
    await expect(editor(page)).toContainText('Which registers survived the 1976 earthquake?')
    await openPage(page, 'Archive visit notes')
    await expectFormattedPage(editor(page))
    await expect(page.getByLabel('Page title')).toHaveValue('Archive visit notes')
    for (const title of ['Questions for the archivist', 'Recovery page', 'Camera notes', 'Letter to the municipal archive', 'Photo register']) {
      await openPage(page, title)
      alphaPageIds[title] = pageIdOf(page)
    }
  })

  await test.step('4. reload the browser and restart the host: outline, order and formatting survive', async () => {
    await openPage(page, 'Archive visit notes')
    await page.reload()
    await expectFormattedPage(editor(page))
    expect(await outlineOf(page)).toEqual(EXPECTED_OUTLINE)

    await stop(host.child)
    host = await startHost()
    await page.goto(host.launchUrl)
    await page.goto(alpha.url)
    await expect(page.getByRole('region', { name: 'Research notebook' })).toContainText('6 pages in 3 sections')
    await page.getByRole('link', { name: 'Open the notebook' }).click()
    await expect(editor(page)).toHaveAttribute('contenteditable', 'true')
    expect(await outlineOf(page)).toEqual(EXPECTED_OUTLINE)
    await openPage(page, 'Archive visit notes')
    await expectFormattedPage(editor(page))
  })

  await test.step('5. history: restore an earlier version; the pre-restore version is itself in the history', async () => {
    // The host keeps an automatic snapshot at most every 5 minutes, which a test cannot wait for:
    // the first save of a page always keeps one, and a restore keeps "Before restore" + "Restored"
    // entries. So the journey spans the first-save snapshot and a restore, not a 5 minute gap.
    const recovery = alphaPageIds['Recovery page']!
    await openPage(page, 'Recovery page')
    await editor(page).click()
    await page.keyboard.type('Original findings: two baptisms found.')
    await hostHasText(page, alpha.id, recovery, 'Original findings')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Overwritten by mistake.')
    await hostHasText(page, alpha.id, recovery, 'Overwritten by mistake')
    await expect(status(page)).toHaveText(SAVED)

    await page.getByRole('button', { name: 'History' }).click()
    const history = page.getByRole('dialog', { name: 'Page history' })
    const versions = history.getByRole('list', { name: 'Versions' }).getByRole('button')
    await expect(versions).toHaveCount(1)
    await versions.first().click()
    await expect(history.getByRole('region', { name: 'Preview' })).toContainText('Original findings')
    await expect(history.getByRole('region', { name: 'Preview' })).not.toContainText('Overwritten by mistake')
    await history.getByRole('button', { name: 'Restore this version' }).click()
    await dialog(page).getByRole('button', { name: 'Restore version' }).click()
    await expect(history.getByRole('status')).toContainText('What was there before is kept in the history')
    await expect(editor(page)).toContainText('Original findings')
    await expect(editor(page)).not.toContainText('Overwritten by mistake')

    // The text that was replaced is still there, as "Before restore", and can be read.
    await expect(history.getByRole('list', { name: 'Versions' }).getByRole('button')).toHaveCount(3)
    await history.getByRole('button', { name: /Before restore · version \d+/ }).click()
    await expect(history.getByRole('region', { name: 'Preview' })).toContainText('Overwritten by mistake')
    await history.getByRole('button', { name: /Restored · version \d+/ }).click()
    await expect(history.getByRole('region', { name: 'Preview' })).toContainText('Original findings')
    await history.getByRole('button', { name: 'Close' }).click()
    await page.reload()
    await expect(editor(page)).toContainText('Original findings')
    await expect(editor(page)).not.toContainText('Overwritten by mistake')
  })

  await test.step('6. a failed save keeps the text, says "Not saved", and recovers by itself', async () => {
    await openPage(page, 'Questions for the archivist')
    await page.route(SAVE_CALL, (route) => route.abort())
    await editor(page).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' Typed while the host is unreachable.')
    await expect(status(page)).toHaveText('Not saved — retrying', { timeout: 10_000 })
    await openPage(page, 'Archive visit notes')
    await openPage(page, 'Questions for the archivist')
    await expect(editor(page)).toContainText('Typed while the host is unreachable.')
    await expect(status(page)).toHaveText('Not saved — retrying', { timeout: 10_000 })

    await page.unroute(SAVE_CALL)
    await expect(status(page)).toHaveText(SAVED, { timeout: 20_000 })
    await page.reload()
    await expect(editor(page)).toContainText('Typed while the host is unreachable.')
  })

  await test.step('7. a second tab edits the same page: conflict banner, Keep my version, the other version is in the history', async () => {
    const pageUrl = page.url()
    const tabB = await context.newPage()
    await tabB.goto(pageUrl)
    await expect(editor(tabB)).toHaveAttribute('contenteditable', 'true')
    await expect(editor(tabB)).toContainText('Typed while the host is unreachable.')

    await editor(page).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' Added in the first tab.')
    await hostHasText(page, alpha.id, alphaPageIds['Questions for the archivist']!, 'Added in the first tab.')

    await editor(tabB).click()
    await tabB.keyboard.press('Control+End')
    await tabB.keyboard.type(' Added in the second tab.')
    const banner = tabB.getByRole('alert').filter({ hasText: 'This page was changed in another window.' })
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(editor(tabB)).toHaveAttribute('contenteditable', 'false')
    await banner.getByRole('button', { name: 'Keep my version' }).click()
    await expect(status(tabB)).toHaveText(SAVED)
    await expect(banner).toHaveCount(0)
    await hostHasText(page, alpha.id, alphaPageIds['Questions for the archivist']!, 'Added in the second tab.')

    await tabB.getByRole('button', { name: 'History' }).click()
    const history = tabB.getByRole('dialog', { name: 'Page history' })
    await history.getByRole('button', { name: /Before restore · version \d+/ }).first().click()
    await expect(history.getByRole('region', { name: 'Preview' })).toContainText('Added in the first tab.')
    await expect(history.getByRole('region', { name: 'Preview' })).not.toContainText('Added in the second tab.')
    await history.getByRole('button', { name: 'Close' }).click()
    await tabB.close()
    await page.reload()
    await expect(editor(page)).toContainText('Added in the second tab.')
  })

  await test.step('8. bridge: link a journal entry and a task, create a task from a selection; records are never copied', async () => {
    await page.goto(alpha.url)
    await addTask(page, 'Order microfilm')
    await addJournalEntry(page, 'Archive search', 'Checked the baptism index for the Ejemplo family.')
    await expect(page.locator('li.task-item')).toHaveCount(1)
    await expect(page.locator('li.timeline-item.kind-journal')).toHaveCount(1)

    const letterId = alphaPageIds['Letter to the municipal archive']!
    await page.goto(`${origin}/#/cases/${alpha.id}/notebook/${letterId}`)
    await expect(page.getByLabel('Page title')).toHaveValue('Letter to the municipal archive')
    await expect(editor(page)).toHaveAttribute('contenteditable', 'true')
    await editor(page).click()
    await page.keyboard.type('Notes after the archive visit.')
    await toolbar(page).getByRole('button', { name: 'Link record' }).click()
    await page.getByRole('dialog', { name: 'Link a record' }).getByRole('button', { name: 'Task · Order microfilm (pending)' }).click()
    await toolbar(page).getByRole('button', { name: 'Link record' }).click()
    await page.getByRole('dialog', { name: 'Link a record' }).getByRole('button', { name: /^Journal · .* · Archive search$/ }).click()

    await editor(page).locator('p').first().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Request the 1884 baptism index')
    await page.keyboard.press('Shift+Home')
    await toolbar(page).getByRole('button', { name: 'Create task from selection' }).click()
    const taskDialog = page.getByRole('dialog', { name: 'Create a task from your notes' })
    await expect(taskDialog.getByLabel('What needs doing')).toHaveValue('Request the 1884 baptism index')
    // Nothing exists until the person confirms.
    await taskDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(editor(page).locator('.note-reference')).toHaveCount(2)
    await toolbar(page).getByRole('button', { name: 'Create task from selection' }).click()
    await page.getByRole('dialog', { name: 'Create a task from your notes' }).getByRole('button', { name: 'Create task' }).click()
    await expect(page.getByText(/Task “Request the 1884 baptism index” created and linked here/)).toBeVisible()
    const labels = editor(page).locator('.note-reference-label')
    await expect(labels).toHaveText(['Task · Request the 1884 baptism index (pending)', 'Task · Order microfilm (pending)', /^Journal · .* · Archive search$/])
    await hostHasText(page, alpha.id, letterId, 'Request the 1884 baptism index')
    await expect(status(page)).toHaveText(SAVED)

    // The page holds links (record ids), not copies of the records' text.
    const stored = JSON.stringify((await api<ApiPage>(page, 'getNotebookPage', alpha.id, letterId)).content)
    expect(stored).toContain('"type":"reference"')
    expect(stored).not.toContain('Checked the baptism index')
    expect(stored).not.toContain('Order microfilm')

    // The case screen shows each record exactly once.
    await page.goto(alpha.url)
    await expect(page.locator('li.task-item')).toHaveCount(2)
    await expect(page.locator('li.task-item .task-title').filter({ hasText: 'Order microfilm' })).toHaveCount(1)
    await expect(page.locator('li.task-item .task-title').filter({ hasText: 'Request the 1884 baptism index' })).toHaveCount(1)
    await expect(page.locator('li.timeline-item.kind-journal')).toHaveCount(1)
    await expect(page.getByRole('region', { name: 'Research notebook' })).toContainText('6 pages in 3 sections')

    // Rename the task on the case screen: the notebook label follows (a link, not a copy).
    const steps = page.getByRole('region', { name: 'Next steps' })
    await steps.getByRole('button', { name: 'Edit task: Order microfilm' }).click()
    await steps.getByRole('form', { name: 'Edit task' }).getByLabel('Task').fill('Order microfilm of the 1884 register')
    await steps.getByRole('form', { name: 'Edit task' }).getByRole('button', { name: 'Save changes' }).click()
    await expect(steps.locator('.task-title').filter({ hasText: 'Order microfilm of the 1884 register' })).toHaveCount(1)
    await page.goto(`${origin}/#/cases/${alpha.id}/notebook/${letterId}`)
    await expect(editor(page).locator('.note-reference-label')).toHaveText([
      'Task · Request the 1884 baptism index (pending)',
      'Task · Order microfilm of the 1884 register (pending)',
      /^Journal · .* · Archive search$/
    ])
  })

  await test.step('9. isolation: Beta has its own notebook; Alpha page ids are not reachable through Beta', async () => {
    await page.goto(beta.url)
    await expect(page.getByRole('region', { name: 'Research notebook' }).getByRole('link', { name: 'Start a notebook' })).toBeVisible()
    await startNotebook(page)
    expect(await outlineOf(page)).toEqual([{ section: 'Research notes', pages: ['First page'] }])
    await expect(page.locator('body')).not.toContainText('Archive visit notes')
    await expect(page.locator('body')).not.toContainText('Parish sources')

    const alphaId = alphaPageIds['Archive visit notes']!
    const before = await api<ApiPage>(page, 'getNotebookPage', alpha.id, alphaId)
    const revisionsBefore = await api<{ id: string }[]>(page, 'listPageRevisions', alpha.id, alphaId)
    expect(revisionsBefore.length).toBeGreaterThan(0)
    const outlineBefore = JSON.stringify(await api(page, 'getNotebook', alpha.id))

    // In the app: Alpha's page id under Beta's case is "not found".
    await page.goto(`${origin}/#/cases/${beta.id}/notebook/${alphaId}`)
    await expect(page.getByText('This page couldn’t be found any more.')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('Parish sources')

    // Through the API, with this session's CSRF header: nothing is read and nothing is changed.
    expect(await api(page, 'getNotebookPage', beta.id, alphaId)).toBeNull()
    expect(await api(page, 'saveNotebookPage', beta.id, alphaId, { baseVersion: before.version, content: { format: 'tg-note', version: 1, blocks: [] } })).toEqual({ ok: false, reason: 'not-found' })
    expect(await api(page, 'renameNotebookPage', beta.id, alphaId, { title: 'Hijacked' })).toEqual({ ok: false, reason: 'not-found' })
    expect(await api(page, 'archiveNotebookPage', beta.id, alphaId)).toEqual({ ok: false, reason: 'not-found' })
    expect(await api(page, 'listPageRevisions', beta.id, alphaId)).toEqual([])
    expect(await api(page, 'getPageRevision', beta.id, alphaId, revisionsBefore[0]!.id)).toBeNull()
    expect(await api(page, 'restorePageRevision', beta.id, alphaId, revisionsBefore[0]!.id, before.version)).toEqual({ ok: false, reason: 'not-found' })
    expect(await api(page, 'getNotebookPage', alpha.id, alphaId)).toEqual(before)
    expect(await api(page, 'listPageRevisions', alpha.id, alphaId)).toEqual(revisionsBefore)
    expect(JSON.stringify(await api(page, 'getNotebook', alpha.id))).toBe(outlineBefore)
  })

  await test.step('10. backup, change the notebook, restore: the notebook matches the backup', async () => {
    const archiveId = alphaPageIds['Archive visit notes']!
    const archiveUrl = `${origin}/#/cases/${alpha.id}/notebook/${archiveId}`
    await page.goto(`${origin}/#/settings`)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Create backup…' }).click()
    const backupFile = join(dataDir, 'Fictional release A backup.tgbackup')
    await (await download).saveAs(backupFile)
    await expect(page.getByText(/A copy is kept in the app’s backups folder/)).toBeVisible()

    await page.goto(archiveUrl)
    await expect(editor(page)).toHaveAttribute('contenteditable', 'true')
    await editor(page).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' Words added after the backup.')
    await hostHasText(page, alpha.id, archiveId, 'Words added after the backup.')
    await openPage(page, 'Recovery page')
    await nav(page).getByRole('button', { name: 'Options for page Recovery page' }).click()
    await page.getByRole('button', { name: 'Archive page' }).click()
    await dialog(page).getByRole('button', { name: 'Archive page' }).click()
    await expect(nav(page).getByText('Archived (1)')).toBeVisible()

    await page.goto(`${origin}/#/settings`)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Restore from backup…' }).click()
    await (await chooser).setFiles(backupFile)
    await dialog(page).getByRole('button', { name: 'Replace with backup' }).click()
    await expect(page.getByText(/Backup restored: 2 clients/)).toBeVisible()

    await page.goto(archiveUrl)
    await page.reload()
    await expectFormattedPage(editor(page))
    await expect(editor(page)).not.toContainText('Words added after the backup.')
    expect(await outlineOf(page)).toEqual(EXPECTED_OUTLINE)
    await expect(nav(page).getByText(/^Archived \(/)).toHaveCount(0)
    await openPage(page, 'Recovery page')
    await expect(editor(page)).toContainText('Original findings')
  })

  if (capture) {
    await test.step('screenshots: notebook, history, case screen, Pages drawer', async () => {
      mkdirSync(shotsDir, { recursive: true })
      for (const viewport of [
        { name: 'desktop-1280', width: 1280, height: 900 },
        { name: 'tablet-768', width: 768, height: 1024 }
      ]) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.goto(`${origin}/#/cases/${alpha.id}/notebook/${alphaPageIds['Archive visit notes']!}`)
        await page.reload()
        await expectFormattedPage(editor(page))
        await page.screenshot({ path: join(shotsDir, `${viewport.name}-notebook.png`) })

        await page.getByRole('button', { name: 'History' }).click()
        const history = page.getByRole('dialog', { name: 'Page history' })
        await history.getByRole('list', { name: 'Versions' }).getByRole('button').first().click()
        await expect(history.getByRole('region', { name: 'Preview' })).toContainText('Parish sources')
        await page.screenshot({ path: join(shotsDir, `${viewport.name}-history.png`) })
        await history.getByRole('button', { name: 'Close' }).click()

        await page.goto(alpha.url)
        await expect(page.getByRole('region', { name: 'Research notebook' })).toContainText('6 pages in 3 sections')
        await page.screenshot({ path: join(shotsDir, `${viewport.name}-case-screen.png`), fullPage: true })

        if (viewport.width < 1024) {
          await page.goto(`${origin}/#/cases/${alpha.id}/notebook/${alphaPageIds['Archive visit notes']!}`)
          const toggle = page.getByRole('button', { name: 'Pages', exact: true })
          await toggle.click()
          await expect(nav(page)).toBeVisible()
          await page.screenshot({ path: join(shotsDir, `${viewport.name}-pages-drawer.png`) })
          await toggle.click()
        }
      }
      await page.setViewportSize({ width: 1280, height: 800 })
    })
  }

  await test.step('11. an archived case makes the notebook read-only; unarchiving makes it editable again', async () => {
    await page.goto(alpha.url)
    await page.getByRole('button', { name: 'Archive case' }).click()
    await dialog(page).getByRole('button', { name: 'Archive case' }).click()
    await expect(page.getByText('Case archived.')).toBeVisible()
    await page.getByRole('link', { name: 'Open the notebook' }).click()
    await expect(page.getByText('This case is archived, so its notebook is read-only.')).toBeVisible()
    await openPage(page, 'Archive visit notes')
    await expectFormattedPage(editor(page))
    await expect(editor(page)).toHaveAttribute('contenteditable', 'false')
    await expect(page.getByLabel('Page title')).toHaveJSProperty('readOnly', true)
    await expect(toolbar(page)).toHaveCount(0)
    await expect(nav(page).getByRole('button', { name: '+ New section' })).toHaveCount(0)
    await expect(nav(page).getByRole('button', { name: /^Options for/ })).toHaveCount(0)
    await expect(nav(page).getByRole('button', { name: '+ Add a page' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Link record' })).toHaveCount(0)
    expect(await api(page, 'saveNotebookPage', alpha.id, alphaPageIds['Archive visit notes']!, {
      baseVersion: (await api<ApiPage>(page, 'getNotebookPage', alpha.id, alphaPageIds['Archive visit notes']!)).version,
      content: { format: 'tg-note', version: 1, blocks: [] }
    })).toEqual({ ok: false, reason: 'wrong-status' })

    await page.goto(alpha.url)
    await page.getByRole('button', { name: 'Unarchive case' }).click()
    await dialog(page).getByRole('button', { name: 'Unarchive case' }).click()
    await page.getByRole('link', { name: 'Open the notebook' }).click()
    await openPage(page, 'Archive visit notes')
    await expect(editor(page)).toHaveAttribute('contenteditable', 'true')
    await expect(toolbar(page)).toBeVisible()
    await expect(nav(page).getByRole('button', { name: '+ New section' })).toBeVisible()
    await expectFormattedPage(editor(page))
  })

  await test.step('12. the fictional demo shows only its own seeded notebook, and its build has no Live API path', async () => {
    const session = (await (await page.request.get(`${origin}/api/v1/session`)).json()) as { demoUrl: string | null }
    expect(session.demoUrl).toBe(`http://localhost:${port + 1}/?live=${port}`)
    const demoPaternalCase = 'de300000-0000-4000-8000-200000000001'
    const demo = await context.newPage()
    await demo.goto(`${session.demoUrl}#/cases/${demoPaternalCase}`)
    await expect(demo.getByRole('region', { name: 'Demo mode' })).toBeVisible()
    const card = demo.getByRole('region', { name: 'Research notebook' })
    await expect(card).toContainText('1 page in 1 section')
    await card.getByRole('link', { name: 'Open the notebook' }).click()
    await expect(demo.getByLabel('Page title')).toHaveValue('Diocesan archive, first visit')
    expect(await demo.evaluate(() => Array.from(document.querySelectorAll('.note-nav-page')).map((a) => a.textContent))).toEqual(['Diocesan archive, first visit'])
    const everything = (await demo.locator('body').innerText()) + (await editor(demo).innerText())
    for (const alphaText of ['Alpha', 'Beta', 'Parish sources', 'Archive visit notes', 'Recovery page', 'Original findings', 'Questions for the archivist', 'Photo register', 'Letters']) {
      expect(everything, `the demo must not show "${alphaText}"`).not.toContain(alphaText)
    }
    // The demo cannot reach the Live host and holds no Live cookie or storage.
    expect(await demo.evaluate(() => document.cookie)).not.toContain('tg_live')
    expect(await demo.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0])
    expect(
      await demo.evaluate(async (target) => {
        try {
          await fetch(`${target}/api/v1/call/getNotebookPage`, { method: 'POST', credentials: 'include' })
          return 'reached'
        } catch {
          return 'blocked'
        }
      }, origin)
    ).toBe('blocked')
    await demo.close()

    const assets = join(root, 'dist-demo', 'assets')
    for (const file of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
      const code = readFileSync(join(assets, file), 'utf8')
      expect(code, file).not.toContain('/api/v1')
      expect(code, file).not.toContain('X-TG-CSRF')
    }
    expect(readFileSync(join(root, 'dist-demo', 'index.html'), 'utf8')).toMatch(/connect-src (?:'|&#39;)none(?:'|&#39;)/)
  })

  await test.step('13. regression smoke: clients, profile, cases, case screen, Settings & Backup at 1280 and 768', async () => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 768, height: 1024 }
    ]) {
      await page.setViewportSize(viewport)
      const where = (what: string) => `${what} at ${viewport.width}px`
      const fits = async (what: string) => expect(await overflowOf(page), `${where(what)} overflows`).toBeLessThanOrEqual(0)

      await page.goto(`${origin}/#/clients`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.getByRole('link', { name: ALPHA })).toBeVisible()
      await expect(page.getByRole('link', { name: BETA })).toBeVisible()
      await fits('clients')

      await page.getByRole('link', { name: ALPHA }).click()
      await expect(page.getByRole('heading', { level: 1, name: ALPHA })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Research cases' })).toBeVisible()
      await fits('client profile')

      await page.goto(`${origin}/#/cases`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.getByRole('link', { name: /Alpha baptism search/ })).toBeVisible()
      await fits('cases list')

      await page.goto(alpha.url)
      await expect(page.getByRole('heading', { level: 1, name: 'Fictional: Alpha baptism search' })).toBeVisible()
      for (const card of ['Research brief', 'Research journal', 'Next steps', 'Research hours', 'Research notebook']) {
        await expect(page.getByRole('heading', { level: 2, name: card })).toBeVisible()
      }
      await fits('case screen')

      await page.goto(`${origin}/#/settings`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Create backup…' })).toBeVisible()
      await fits('settings')

      await page.goto(`${origin}/#/cases/${alpha.id}/notebook/${alphaPageIds['Archive visit notes']!}`)
      await expectFormattedPage(editor(page))
      await fits('notebook')
    }
  })

  await test.step('14. no content security policy violations or page errors in the whole journey', async () => {
    expect(violations).toEqual([])
  })
})
