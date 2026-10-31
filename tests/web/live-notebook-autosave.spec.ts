import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Resilient autosave, conflicts, history and the case workflow bridge (#149) in the built
// Live web app with the real rich-text editor, driven through the UI only. The Live
// sign-in is a one-time launch link, so "two windows" are two tabs of the SAME browser
// context. Own port; fictional data only.
// Screenshots are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-notebook-autosave

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_AUTOSAVE_PORT'] ?? 4200)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/issue-149')
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
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-autosave-e2e-'))
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
const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const editor = (page: Page) => page.getByRole('textbox', { name: 'Page text' })
const status = (page: Page) => page.locator('.note-save-status')
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Formatting' })
const SAVE_CALL = '**/api/v1/call/saveNotebookPage'

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

/** From the case page: start the notebook. Leaves the first page open and returns its address. */
async function startNotebook(page: Page): Promise<string> {
  await page.getByRole('region', { name: 'Research notebook' }).getByRole('link', { name: 'Start a notebook' }).click()
  await page.getByRole('button', { name: 'Start your research notebook' }).click()
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true')
  await expect(page.getByLabel('Page title')).toHaveValue('First page')
  return page.url()
}

/** A client, a case and a started notebook: the shared start of most tests. */
async function scenario(page: Page, hostUrl: string): Promise<{ caseUrl: string; pageUrl: string }> {
  await page.goto(hostUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseUrl = await addCase(page, 'Ana Ejemplo', 'Fictional: Sample family baptism search')
  const pageUrl = await startNotebook(page)
  return { caseUrl, pageUrl }
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

test('failed saves keep the text, show "Not saved", and recover by themselves', async ({ page }) => {
  const host = await startHost()
  await scenario(page, host.launchUrl)

  await page.route(SAVE_CALL, (route) => route.abort())
  await editor(page).click()
  await page.keyboard.type('Words that must not be lost.')
  await expect(status(page)).toHaveText('Not saved — retrying', { timeout: 10_000 })
  await expect(editor(page)).toContainText('Words that must not be lost.')
  await expect(page.getByRole('button', { name: 'Retry now' })).toBeVisible()

  // The connection comes back: the next retry saves without any click.
  await page.unroute(SAVE_CALL)
  await expect(status(page)).toHaveText(SAVED, { timeout: 20_000 })
  await page.reload()
  await expect(editor(page)).toContainText('Words that must not be lost.')
  expect(violations).toEqual([])
})

test('keeps unsaved text across a visit to the case screen, and warns before the tab closes', async ({ page }) => {
  const host = await startHost()
  const { caseUrl } = await scenario(page, host.launchUrl)

  await page.route(SAVE_CALL, (route) => route.abort())
  await editor(page).click()
  await page.keyboard.type('Draft kept in memory.')
  await expect(status(page)).toHaveText('Not saved — retrying', { timeout: 10_000 })
  const warned = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(warned).toBe(true)

  // Leave the notebook (client-side), see the reminder, come back.
  await page.getByRole('link', { name: /^←/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Fictional: Sample family baptism search' })).toBeVisible()
  expect(page.url()).toBe(caseUrl)
  await expect(page.getByRole('link', { name: '1 page not saved yet' })).toBeVisible()
  await page.unroute(SAVE_CALL)
  await expect(page.getByRole('link', { name: '1 page not saved yet' })).toHaveCount(0, { timeout: 20_000 })
  await page.getByRole('link', { name: 'Open the notebook' }).click()
  await expect(editor(page)).toContainText('Draft kept in memory.')
  const closing = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(closing).toBe(false)
})

test('two tabs: the second gets the conflict banner, Keep my version keeps the other text in the history', async ({ page, context }) => {
  const host = await startHost()
  const { pageUrl } = await scenario(page, host.launchUrl)
  const tabB = await context.newPage()
  await tabB.goto(pageUrl)
  await expect(editor(tabB)).toHaveAttribute('contenteditable', 'true')

  // Tab A saves first.
  await editor(page).click()
  await page.keyboard.type('Written in tab A.')
  await expect(status(page)).toHaveText(SAVED)

  // Tab B still has the old version: its save is refused, nothing is overwritten.
  await editor(tabB).click()
  await tabB.keyboard.type('Written in tab B.')
  const banner = tabB.getByRole('alert').filter({ hasText: 'This page was changed in another window.' })
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await expect(editor(tabB)).toContainText('Written in tab B.')
  await expect(editor(tabB)).toHaveAttribute('contenteditable', 'false')
  await page.reload()
  await expect(editor(page)).toContainText('Written in tab A.')
  await expect(editor(page)).not.toContainText('tab B')

  await banner.getByRole('button', { name: 'Keep my version' }).click()
  await expect(status(tabB)).toHaveText(SAVED)
  await expect(banner).toHaveCount(0)

  // The other tab's text is in the history, and can be restored.
  await tabB.getByRole('button', { name: 'History' }).click()
  const history = tabB.getByRole('dialog', { name: 'Page history' })
  await expect(history.getByRole('button', { name: /Before restore · version 2/ })).toBeVisible()
  await history.getByRole('button', { name: /Before restore · version 2/ }).click()
  await expect(history.getByRole('region', { name: 'Preview' })).toContainText('Written in tab A.')
  await history.getByRole('button', { name: 'Restore this version' }).click()
  await tabB.getByRole('alertdialog').getByRole('button', { name: 'Restore version' }).click()
  await history.getByRole('button', { name: 'Close' }).click()
  await expect(editor(tabB)).toContainText('Written in tab A.')
  await expect(editor(tabB)).not.toContainText('tab B')
  await expect(history).toHaveCount(0)
  expect(violations).toEqual([])
})

test('Use the saved version drops the draft; Copy my text is offered before choosing', async ({ page, context }) => {
  const host = await startHost()
  const { pageUrl } = await scenario(page, host.launchUrl)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  const tabB = await context.newPage()
  await tabB.goto(pageUrl)
  await expect(editor(tabB)).toHaveAttribute('contenteditable', 'true')
  await editor(page).click()
  await page.keyboard.type('Saved first.')
  await expect(status(page)).toHaveText(SAVED)
  await editor(tabB).click()
  await tabB.keyboard.type('Second window words.')
  const banner = tabB.getByRole('alert').filter({ hasText: 'This page was changed in another window.' })
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await banner.getByRole('button', { name: 'Copy my text' }).click()
  await expect(banner).toContainText('Your text was copied to the clipboard.')
  expect(await tabB.evaluate(() => navigator.clipboard.readText())).toContain('Second window words.')
  await banner.getByRole('button', { name: 'Use the saved version' }).click()
  await expect(editor(tabB)).toContainText('Saved first.')
  await expect(editor(tabB)).not.toContainText('Second window words.')
  await expect(editor(tabB)).toHaveAttribute('contenteditable', 'true')
})

test('survives a refresh after saving, and the host restart keeps the history', async ({ page }) => {
  let host = await startHost()
  const { pageUrl } = await scenario(page, host.launchUrl)
  await editor(page).click()
  await page.keyboard.type('Before the refresh.')
  await expect(status(page)).toHaveText(SAVED)
  await page.reload()
  await expect(editor(page)).toContainText('Before the refresh.')

  await stop(host.child)
  host = await startHost()
  await page.goto(host.launchUrl)
  await page.goto(pageUrl)
  await expect(editor(page)).toContainText('Before the refresh.')
  await page.getByRole('button', { name: 'History' }).click()
  const history = page.getByRole('dialog', { name: 'Page history' })
  await expect(history.getByRole('list', { name: 'Versions' }).getByRole('button')).toHaveCount(1)
  await history.getByRole('button', { name: /Autosave · version 2/ }).click()
  await expect(history.getByRole('region', { name: 'Preview' })).toContainText('Before the')
})

test('links records and creates a task from the selection, without ever duplicating records', async ({ page }) => {
  const host = await startHost()
  const { caseUrl } = await scenario(page, host.launchUrl)
  await page.goto(caseUrl)
  await addTask(page, 'Order microfilm')
  await addJournalEntry(page, 'Archive search', 'Checked the baptism index.')
  await expect(page.locator('li.task-item')).toHaveCount(1)
  await expect(page.locator('li.timeline-item.kind-journal')).toHaveCount(1)
  await page.getByRole('link', { name: 'Open the notebook' }).click()
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true')

  // Link the task and the journal entry.
  await editor(page).click()
  await page.keyboard.type('Notes after the archive visit.')
  await toolbar(page).getByRole('button', { name: 'Link record' }).click()
  const linkDialog = page.getByRole('dialog', { name: 'Link a record' })
  await linkDialog.getByLabel('Filter records').fill('microfilm')
  await linkDialog.getByRole('button', { name: 'Task · Order microfilm (pending)' }).click()
  await toolbar(page).getByRole('button', { name: 'Link record' }).click()
  await page.getByRole('dialog', { name: 'Link a record' }).getByRole('button', { name: /^Journal · .* · Archive search$/ }).click()

  // Create a task from selected text: nothing exists until Create task is pressed.
  // (Click on the first paragraph: a click on a reference opens its record.)
  await editor(page).locator('p').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Request the 1884 baptism index')
  await page.keyboard.press('Shift+Home')
  await toolbar(page).getByRole('button', { name: 'Create task from selection' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task from your notes' })
  await expect(taskDialog.getByLabel('What needs doing')).toHaveValue('Request the 1884 baptism index')
  await taskDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.note-reference')).toHaveCount(2)
  await toolbar(page).getByRole('button', { name: 'Create task from selection' }).click()
  await page.getByRole('dialog', { name: 'Create a task from your notes' }).getByRole('button', { name: 'Create task' }).click()
  await expect(page.getByText(/Task “Request the 1884 baptism index” created and linked here/)).toBeVisible()
  await expect(editor(page)).toContainText('Request the 1884 baptism index')

  // The three references show readable labels.
  const labels = editor(page).locator('.note-reference-label')
  await expect(labels).toHaveCount(3)
  // The new task's reference sits right after the selected line, before the two earlier links.
  await expect(labels).toHaveText(['Task · Request the 1884 baptism index (pending)', 'Task · Order microfilm (pending)', /^Journal · .* · Archive search$/])
  await expect(status(page)).toHaveText(SAVED)

  // Activating a reference opens the case at that record.
  await labels.nth(1).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Fictional: Sample family baptism search' })).toBeVisible()

  // The case lists exactly the expected records: two tasks, one journal entry, no copies.
  await expect(page.locator('li.task-item')).toHaveCount(2)
  await expect(page.locator('li.timeline-item.kind-journal')).toHaveCount(1)
  await expect(page.getByRole('region', { name: 'Next steps' })).toContainText('Request the 1884 baptism index')
  expect(violations).toEqual([])
})

test('research hours control in the notebook header uses the existing timer', async ({ page }) => {
  const host = await startHost()
  await scenario(page, host.launchUrl)
  const hours = page.getByRole('group', { name: 'Research hours' })
  await hours.getByRole('button', { name: 'Start timer' }).click()
  await expect(hours.getByRole('button', { name: 'Pause timer' })).toBeVisible()
  await hours.getByRole('button', { name: 'Pause timer' }).click()
  await expect(hours.getByRole('button', { name: 'Resume timer' })).toBeVisible()
  await hours.getByRole('button', { name: 'Resume timer' }).click()
  await hours.getByRole('button', { name: 'Stop & save time' }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
  // It is the one app timer: the sidebar shows it too.
  await expect(page.getByRole('region', { name: 'Research timer' })).toBeVisible()
})

test('after restoring a backup, the notebook shows the backed-up content', async ({ page }) => {
  const host = await startHost()
  await scenario(page, host.launchUrl)
  await editor(page).click()
  await page.keyboard.type('Backed up words.')
  await expect(status(page)).toHaveText(SAVED)
  const pageUrl = page.url()

  await page.goto(`${origin}/#/settings`)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Create backup…' }).click()
  const backupFile = join(dataDir, 'Fictional notebook backup.tgbackup')
  await (await download).saveAs(backupFile)
  await expect(page.getByText(/A copy is kept in the app’s backups folder/)).toBeVisible()

  // Change the page after the backup.
  await page.goto(pageUrl)
  await editor(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Words added after the backup.')
  await expect(status(page)).toHaveText(SAVED)
  await expect(editor(page)).toContainText('Words added after the backup.')

  // Restore the backup: pick the file, confirm.
  await page.goto(`${origin}/#/settings`)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Restore from backup…' }).click()
  await (await chooser).setFiles(backupFile)
  const confirm = page.getByRole('alertdialog', { name: 'Replace all data with this backup?' })
  await confirm.getByRole('button', { name: 'Replace with backup' }).click()
  await expect(page.getByText(/Backup restored: 1 client/)).toBeVisible()

  await page.goto(pageUrl)
  await expect(editor(page)).toContainText('Backed up words.')
  await expect(editor(page)).not.toContainText('Words added after the backup.')
  expect(violations).toEqual([])
})

test('captures the conflict dialog, history and link-record dialog on request', async ({ page, context }) => {
  test.skip(!capture, 'Set CAPTURE_SCREENSHOTS=1 to capture screenshots.')
  mkdirSync(shotsDir, { recursive: true })
  const host = await startHost()
  const { caseUrl } = await scenario(page, host.launchUrl)
  await page.goto(caseUrl)
  await addTask(page, 'Order microfilm of the 1884 baptism register')
  await addJournalEntry(page, 'Archive search', 'Checked the baptism index for the Ejemplo family.')
  await page.getByRole('link', { name: 'Open the notebook' }).click()
  await editor(page).click()
  await page.keyboard.type('# Parish sources')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Fictional: Sample family baptism search. Two entries found for the Ejemplo family.')
  await expect(status(page)).toHaveText(SAVED)
  const pageUrl = page.url()
  const other = await context.newPage()
  await other.goto(pageUrl)
  await expect(editor(other)).toContainText('Two entries found')
  await expect(editor(other)).toHaveAttribute('contenteditable', 'true')

  const viewports = [
    { name: 'desktop-1280', width: 1280, height: 900 },
    { name: 'tablet-768', width: 768, height: 1024 }
  ]
  for (const viewport of viewports) {
    await other.setViewportSize({ width: viewport.width, height: viewport.height })

    await toolbar(other).getByRole('button', { name: 'Link record' }).click()
    await expect(other.getByRole('dialog', { name: 'Link a record' }).getByRole('button', { name: /Order microfilm/ })).toBeVisible()
    await other.screenshot({ path: join(shotsDir, `${viewport.name}-link-record.png`) })
    await other.keyboard.press('Escape')

    await other.getByRole('button', { name: 'History' }).click()
    const history = other.getByRole('dialog', { name: 'Page history' })
    await history.getByRole('list', { name: 'Versions' }).getByRole('button').first().click()
    await expect(history.getByRole('region', { name: 'Preview' })).toContainText('Parish sources')
    await other.screenshot({ path: join(shotsDir, `${viewport.name}-history.png`) })
    await history.getByRole('button', { name: 'Close' }).click()

    // The first window saves; this one then edits an old version and is told about it.
    await editor(page).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(` Update from the first window (${viewport.name}).`)
    await expect(status(page)).toHaveText(SAVED)
    await editor(other).click()
    await other.keyboard.press('Control+End')
    await other.keyboard.type(' A different note typed in the second window.')
    const banner = other.getByRole('alert').filter({ hasText: 'This page was changed in another window.' })
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await other.screenshot({ path: join(shotsDir, `${viewport.name}-conflict.png`) })
    await banner.getByRole('button', { name: 'Use the saved version' }).click()
    await expect(editor(other)).toHaveAttribute('contenteditable', 'true')
  }
  expect(violations).toEqual([])
})
