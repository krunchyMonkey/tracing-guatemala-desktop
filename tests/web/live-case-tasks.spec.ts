import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Case tasks, "Next steps" (#19), in the built Live web app, driven through the UI
// only: add steps (one overdue, one undated), complete and reopen, reload and restart
// the host, archive, keep cases apart. Own port, so it never collides with the other
// web specs. Fictional data only.
// Screenshots are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-case-tasks

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_CASE_TASKS_PORT'] ?? 4196)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/issue-19')
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

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-case-tasks-e2e-'))
})

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stop))
  rmSync(dataDir, { recursive: true, force: true })
})

const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const dialog = (page: Page) => page.getByRole('alertdialog')
const steps = (page: Page) => page.getByRole('region', { name: 'Next steps' })
const open = (page: Page) => steps(page).getByRole('list', { name: 'Open next steps' }).getByRole('listitem')
const titles = (page: Page) => open(page).locator('.task-title')

async function addClient(page: Page, name: string): Promise<string> {
  await page.goto(`${origin}/#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  return page.url()
}

/** Creates a case through the client picker and the form; returns the case's address. */
async function addCase(page: Page, clientName: string, title: string): Promise<string> {
  await page.goto(`${origin}/#/cases/new`)
  await page.getByLabel('Client', { exact: true }).selectOption({ label: clientName })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel(/^Title/).fill(title)
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  return page.url()
}

/** YYYY-MM-DD in the browser's local time, n days from today (negative = past). */
async function dateIn(page: Page, days: number): Promise<string> {
  return page.evaluate((n) => {
    const now = new Date()
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n)
    const pad = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }, days)
}

async function addStep(page: Page, title: string, options: { details?: string; due?: string } = {}): Promise<void> {
  const form = steps(page).getByRole('form', { name: 'Add a next step' })
  await form.getByLabel('What needs doing').fill(title)
  if (options.details) await form.getByLabel('Details (optional)').fill(options.details)
  if (options.due) await form.getByLabel('Deadline (optional)').fill(options.due)
  await form.getByRole('button', { name: 'Add next step' }).click()
  await expect(form.getByLabel('What needs doing')).toHaveValue('')
}

test('adds steps, shows overdue in words, completes and reopens, and finds them after a reload and a host restart', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseUrl = await addCase(page, 'Ana Ejemplo', 'Maternal grandparents')
  await expect(steps(page).getByText('No next steps yet.')).toBeVisible()

  await addStep(page, 'Plan the next archive visit')
  await addStep(page, 'Request the 1931 register', { details: 'Ask the municipal archive.\nMention the fictional parish.', due: await dateIn(page, -3) })
  await addStep(page, 'Write the interim summary', { due: await dateIn(page, 10) })

  await expect(titles(page)).toHaveText(['Request the 1931 register', 'Write the interim summary', 'Plan the next archive visit'])
  await expect(open(page).nth(0)).toContainText('Overdue by 3 days')
  await expect(open(page).nth(0)).toContainText('Mention the fictional parish.')
  await expect(open(page).nth(1)).toContainText('Due in 10 days')
  await expect(open(page).nth(2)).toContainText('No deadline')

  // Complete the overdue one: it moves to Completed and loses its overdue marker.
  await open(page).nth(0).getByRole('button', { name: 'Mark done: Request the 1931 register' }).click()
  await expect(titles(page)).toHaveText(['Write the interim summary', 'Plan the next archive visit'])
  await expect(steps(page).getByText('Overdue by 3 days')).toHaveCount(0)
  await steps(page).getByText('Completed (1)').click()
  const done = steps(page).getByRole('list', { name: 'Completed next steps' })
  await expect(done).toContainText('Request the 1931 register')

  // Reload and restart the host: the same state comes back.
  await page.reload()
  await expect(titles(page)).toHaveCount(2)
  await stop(host.child)
  host = await startHost()
  await page.goto(host.launchUrl)
  await page.goto(caseUrl)
  await expect(titles(page)).toHaveText(['Write the interim summary', 'Plan the next archive visit'])
  await steps(page).getByText('Completed (1)').click()
  await expect(done).toContainText('Request the 1931 register')

  // Reopen: back at the top, overdue again.
  await done.getByRole('button', { name: 'Reopen: Request the 1931 register' }).click()
  await expect(titles(page).first()).toHaveText('Request the 1931 register')
  await expect(open(page).first()).toContainText('Overdue by 3 days')
  await expect(steps(page).getByText(/Completed \(/)).toHaveCount(0)
})

test('edits a step, validates inline and keeps what was typed', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Bruno Ficticio')
  await addCase(page, 'Bruno Ficticio', 'Validation walkthrough')
  const form = steps(page).getByRole('form', { name: 'Add a next step' })

  await form.getByRole('button', { name: 'Add next step' }).click()
  await expect(form.getByText('Write what needs doing before adding it.')).toBeVisible()
  await form.getByLabel('What needs doing').fill('x'.repeat(161))
  await form.getByLabel('Details (optional)').fill('Keep these details.')
  await form.getByRole('button', { name: 'Add next step' }).click()
  await expect(form.getByText('Keep the title under 160 characters.')).toBeVisible()
  await expect(form.getByLabel('Details (optional)')).toHaveValue('Keep these details.')
  await expect(steps(page).getByText('No next steps yet.')).toBeVisible()

  // Keyboard: fix the title and submit with Enter.
  await form.getByLabel('What needs doing').fill('Short title')
  await page.keyboard.press('Enter')
  await expect(titles(page)).toHaveText(['Short title'])

  await open(page).first().getByRole('button', { name: 'Edit task: Short title' }).click()
  const edit = steps(page).getByRole('form', { name: 'Edit task' })
  await edit.getByLabel('Task').fill('Renamed title')
  await edit.getByLabel('Deadline (optional)').fill(await dateIn(page, 0))
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(titles(page)).toHaveText(['Renamed title'])
  await expect(open(page).first()).toContainText('Due today')
})

test('keeps steps of one case off another case', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseA = await addCase(page, 'Ana Ejemplo', 'Case A')
  const caseA2 = await addCase(page, 'Ana Ejemplo', 'Case A2')
  await addClient(page, 'Ana Ejemplar')
  const caseB = await addCase(page, 'Ana Ejemplar', 'Case B')

  await page.goto(caseA)
  await addStep(page, 'Only in case A')
  await page.goto(caseA2)
  await expect(steps(page).getByText('No next steps yet.')).toBeVisible()
  await addStep(page, 'Only in case A2')
  await page.goto(caseB)
  await expect(steps(page).getByText('No next steps yet.')).toBeVisible()
  await expect(steps(page)).not.toContainText('Only in case A')
  await page.goto(caseA)
  await expect(titles(page)).toHaveText(['Only in case A'])
})

test('is read-only but still visible once the case is archived, and editable again after unarchiving', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Diana Prueba')
  const caseUrl = await addCase(page, 'Diana Prueba', 'Archive and steps')
  await addStep(page, 'Kept while archived', { due: await dateIn(page, 1) })

  await page.getByRole('button', { name: 'Archive case' }).click()
  await dialog(page).getByRole('button', { name: 'Archive case' }).click()
  await expect(page.getByText('Case archived.')).toBeVisible()
  await expect(titles(page)).toHaveText(['Kept while archived'])
  await expect(steps(page)).toContainText('This case is archived, so its next steps can’t be changed.')
  await expect(steps(page).getByRole('form')).toHaveCount(0)
  await expect(steps(page).getByRole('button', { name: /Add next step|Edit task|Mark done|Reopen/ })).toHaveCount(0)

  await page.reload()
  await expect(titles(page)).toHaveText(['Kept while archived'])
  await expect(steps(page).getByRole('form')).toHaveCount(0)

  await page.goto(caseUrl)
  await page.getByRole('button', { name: 'Unarchive case' }).click()
  await dialog(page).getByRole('button', { name: 'Unarchive case' }).click()
  await expect(steps(page).getByRole('form', { name: 'Add a next step' })).toBeVisible()
  await open(page).first().getByRole('button', { name: 'Mark done: Kept while archived' }).click()
  await expect(steps(page).getByText('Completed (1)')).toBeVisible()
})

test('keeps accents, quotes and markup-like text exactly as typed, and shows it as text', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Carmen Muestra')
  const caseUrl = await addCase(page, 'Carmen Muestra', 'Special characters')
  const special = 'Niño “Ángel” <script>window.__pwned = 1</script> <b>not bold</b> & \'; DROP TABLE case_tasks; --'
  await addStep(page, special, { details: `${special}\nLínea 2` })
  await expect(titles(page).first()).toHaveText(special)
  await expect(steps(page).locator('b, script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  await page.goto(caseUrl)
  await page.reload()
  await expect(titles(page).first()).toHaveText(special)
})

const viewports = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 }
]

test('fits phone, tablet and desktop widths without sideways scrolling, and captures screenshots on request', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseUrl = await addCase(page, 'Ana Ejemplo', 'Paternal line — Quetzaltenango, 1880s, including the neighbouring parishes and every surname variant')
  await addStep(page, 'Ask the client for the photograph and letters', {
    details: 'They mentioned a photograph of Teodoro; ask whether any letters survive too.',
    due: await dateIn(page, -2)
  })
  await addStep(page, 'Search the 1880s baptism index for the second parish', { due: await dateIn(page, 0) })
  await addStep(page, 'Compare spelling variants of the surname ' + 'Ejemplo'.repeat(8), { due: await dateIn(page, 2) })
  await addStep(page, 'Draft the interim findings summary', { due: await dateIn(page, 14) })
  await addStep(page, 'Note down archive opening hours')
  await addStep(page, 'Confirm the grandfather’s birth year', { due: await dateIn(page, -20) })
  await open(page).filter({ hasText: 'Confirm the grandfather’s birth year' }).getByRole('button', { name: /^Mark done/ }).click()
  await expect(open(page)).toHaveCount(5)
  if (capture) mkdirSync(shotsDir, { recursive: true })

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.goto(caseUrl)
    await expect(open(page)).toHaveCount(5)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, `overflows by ${overflow}px at ${viewport.width}px`).toBeLessThanOrEqual(0)
    if (capture && viewport.name !== 'tablet') {
      await steps(page).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shotsDir, `${viewport.name}-tasks.png`), fullPage: true })
    }
  }
})
