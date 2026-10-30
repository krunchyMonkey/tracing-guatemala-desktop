import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The case screens (#16) in the built Live web app, driven through the UI only:
// create a client and cases, edit, change state (with confirmation), archive,
// restart the host and find everything again. Own port, so it never collides
// with the other web specs. Fictional data only. Screenshots are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-case-screens

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_CASE_SCREENS_PORT'] ?? 4193)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/issue-16')
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
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-case-screens-e2e-'))
})

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stop))
  rmSync(dataDir, { recursive: true, force: true })
})

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const dialog = (page: Page) => page.getByRole('alertdialog')

/** Local calendar date n days from today, like the app's own "today". */
function localDate(offsetDays: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

async function addClient(page: Page, name: string): Promise<string> {
  await page.goto(`${origin}/#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  return page.url()
}

interface Draft {
  title: string
  goal?: string
  reference?: string
  due?: string
}

/** Creates a case through the client picker and the form; returns the case's address. */
async function addCase(page: Page, clientName: string, draft: Draft): Promise<string> {
  await page.goto(`${origin}/#/cases/new`)
  await page.getByLabel('Client', { exact: true }).selectOption({ label: clientName })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel(/^Title/).fill(draft.title)
  if (draft.goal) await page.getByLabel(/^Requested outcome/).fill(draft.goal)
  if (draft.reference) await page.getByLabel(/^Order reference/).fill(draft.reference)
  if (draft.due) await page.getByLabel(/^Due date/).fill(draft.due)
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('heading', { level: 1, name: draft.title })).toBeVisible()
  return page.url()
}

const confirm = async (page: Page, button: string) => {
  await page.getByRole('button', { name: button }).click()
  await dialog(page).getByRole('button', { name: button }).click()
}

test('creates, edits, moves and archives a case through the UI, and finds it all after a host restart', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await expect(page).toHaveURL(`${origin}/`)
  await expect(nav(page).getByRole('link', { name: 'Cases' })).toBeVisible()

  await nav(page).getByRole('link', { name: 'Cases' }).click()
  await expect(page.getByText('No cases yet — open a client to start one')).toBeVisible()

  const clientUrl = await addClient(page, 'Ana Ejemplo')
  await expect(page.getByRole('region', { name: 'Research cases' })).toContainText('No cases yet')

  // Create from the client's profile; the form keeps input when validation fails.
  await page.getByRole('link', { name: 'New case' }).click()
  await page.getByLabel(/^Requested outcome/).fill('Find where my grandmother Rosa was born.\nAnd her parents’ names.')
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Give the case a title' })).toBeVisible()
  await expect(page.getByLabel(/^Requested outcome/)).toHaveValue(/grandmother Rosa/)
  await page.getByLabel(/^Title/).fill('Maternal grandparents — Quetzaltenango')
  await page.getByLabel(/^Order reference/).fill('FO-EXAMPLE-0042')
  await page.getByLabel(/^Due date/).fill(localDate(10))
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Maternal grandparents — Quetzaltenango' })).toBeVisible()
  await expect(page.getByText('Case created.')).toBeVisible()
  const caseUrl = page.url()
  expect(caseUrl).toMatch(/#\/cases\/[0-9a-f-]{36}$/)
  const details = page.getByRole('region', { name: 'Details' })
  await expect(details).toContainText('FO-EXAMPLE-0042')
  await expect(details.locator('.preserve-lines')).toHaveText('Find where my grandmother Rosa was born.\nAnd her parents’ names.')

  // Edit.
  await page.getByRole('link', { name: 'Edit details' }).click()
  await page.getByLabel(/^Title/).fill('Maternal grandparents — Quetzaltenango, 1900s')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click() // keep editing
  await expect(page.getByLabel(/^Title/)).toHaveValue('Maternal grandparents — Quetzaltenango, 1900s')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /1900s/ })).toBeVisible()
  await expect(page.getByText('Changes saved.')).toBeVisible()

  // State changes: only the allowed ones are offered; confirmed ones ask first.
  const states = page.getByRole('group', { name: 'Change state' })
  await expect(states.getByRole('button')).toHaveText(['Start research', 'Waiting on someone', 'Close case'])
  await page.getByRole('button', { name: 'Start research' }).click()
  await expect(page.getByText('Case is now active.')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Waiting on someone' }).click()
  await expect(page.getByText('Case is now waiting.')).toBeVisible()
  await page.getByRole('button', { name: 'Resume research' }).click()
  await expect(page.getByText('Case is now active.')).toBeVisible()
  await confirm(page, 'Mark delivered')
  await expect(page.getByText('Case is now delivered.')).toBeVisible()
  await expect(states.getByRole('button')).toHaveText(['Reopen', 'Close case'])
  await confirm(page, 'Reopen')
  await expect(page.getByText('Case is now active.')).toBeVisible()

  // Archive and unarchive.
  await confirm(page, 'Archive case')
  await expect(page.getByText('Case archived.')).toBeVisible()
  await expect(page.getByText(/This case is read-only/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Edit details' })).toHaveCount(0)
  await expect(states).toHaveCount(0)
  await page.goto(`${origin}/#/cases`)
  await expect(page.getByText('No matching cases')).toBeVisible() // archived cases are hidden by default
  await pick(page, 'Archived')
  await expect(page.getByRole('link', { name: /1900s/ })).toBeVisible()
  await page.getByRole('link', { name: /1900s/ }).click()
  await confirm(page, 'Unarchive case')
  await expect(page.getByText('Case unarchived.')).toBeVisible()
  await expect(states).toBeVisible()

  // An archived client makes its cases read-only.
  await page.goto(clientUrl)
  await page.getByRole('button', { name: 'Archive' }).click()
  await dialog(page).getByRole('button', { name: 'Archive client' }).click()
  await expect(page.getByText('Restore this client to start a new case')).toBeVisible()
  await page.goto(caseUrl)
  await expect(page.getByText(/Their cases are read-only/)).toBeVisible()
  await expect(page.getByRole('group', { name: 'Change state' })).toHaveCount(0)
  await page.goto(clientUrl)
  await page.getByRole('button', { name: 'Restore client' }).click()
  await dialog(page).getByRole('button', { name: 'Restore client' }).click()
  await expect(page.getByRole('link', { name: 'New case' })).toBeVisible()

  // Restart the host: signed out, but the case and its history are still there.
  await stop(host.child)
  host = await startHost()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Open Tracing Guatemala from its link' })).toBeVisible()
  await page.goto(host.launchUrl)
  await page.goto(caseUrl)
  await expect(page.getByRole('heading', { level: 1, name: 'Maternal grandparents — Quetzaltenango, 1900s' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Details' })).toContainText('FO-EXAMPLE-0042')
  await expect(page.getByRole('group', { name: 'Change state' })).toBeVisible()
  const history = page.getByRole('region', { name: 'History' })
  await expect(history.locator('.kind-label')).toHaveText([
    'Restored from the archive',
    'Archived',
    'Reopened (was delivered)',
    'Marked delivered',
    'Research resumed',
    'Waiting on someone',
    'Research started',
    'Case created'
  ])
  await page.goto(clientUrl)
  await expect(page.getByRole('region', { name: 'Research cases' })).toContainText('Maternal grandparents — Quetzaltenango, 1900s')
})

test('works from the keyboard: Tab reaches the state controls, and the confirmation takes Escape and Enter', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Bruno Ficticio')
  await addCase(page, 'Bruno Ficticio', { title: 'Keyboard walkthrough' })
  await page.getByRole('button', { name: 'Start research' }).click()
  await expect(page.getByText('Case is now active.')).toBeVisible()

  // Tab from the page heading until a state control has focus.
  await page.getByRole('heading', { level: 1, name: 'Keyboard walkthrough' }).focus()
  let focused = ''
  for (let step = 0; step < 12 && focused !== 'Waiting on someone'; step++) {
    await page.keyboard.press('Tab')
    focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
  }
  expect(focused).toBe('Waiting on someone')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Mark delivered' })).toBeFocused()

  // Enter opens the confirmation with focus on the safe choice; Escape cancels and returns focus.
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mark delivered' })).toBeFocused()
  await expect(page.locator('.state-now')).toContainText('Active')

  // Enter again, Tab to the confirm button, Enter confirms.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(dialog(page).getByRole('button', { name: 'Mark delivered' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Case is now delivered.')).toBeVisible()
  await expect(dialog(page)).toHaveCount(0)
})

const viewports = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 }
]

test('fits phone, tablet and desktop widths without sideways scrolling, and captures screenshots on request', async ({
  page
}) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  const anaUrl = await addClient(page, 'Ana Ejemplo')
  await addClient(page, 'Bruno Ficticio')

  const longTitle = 'Paternal line — Totonicapán, 1880s, including the neighbouring parishes and every surname variant'
  await addCase(page, 'Ana Ejemplo', {
    title: 'Maternal grandparents — Quetzaltenango',
    goal: 'Find where my grandmother Rosa was born and her parents’ names.\nAny photographs would be a bonus.',
    reference: 'FO-EXAMPLE-0042',
    due: localDate(9)
  })
  await page.getByRole('button', { name: 'Start research' }).click()
  await expect(page.getByText('Case is now active.')).toBeVisible()

  const overdueUrl = await addCase(page, 'Ana Ejemplo', {
    title: longTitle,
    goal: 'Confirm the marriage year and the great-grandmother’s maiden name.',
    reference: 'FO-EXAMPLE-0039',
    due: localDate(-3)
  })
  await page.getByRole('button', { name: 'Start research' }).click()
  await page.getByRole('button', { name: 'Waiting on someone' }).click()
  await expect(page.getByText('Case is now waiting.')).toBeVisible()

  await addCase(page, 'Bruno Ficticio', { title: 'Baptism search — San Pedro (fictional parish)' })
  await addCase(page, 'Bruno Ficticio', { title: 'Second branch report', reference: 'FO-EXAMPLE-0044', due: localDate(-1) })
  await page.getByRole('button', { name: 'Start research' }).click()
  await confirm(page, 'Mark delivered')
  await expect(page.getByText('Case is now delivered.')).toBeVisible()

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    const screens = [
      ['case-list', `${origin}/#/cases?state=all`, 'Cases'],
      ['case-overview', overdueUrl, longTitle],
      ['case-form', `${origin}/#/cases/new`, 'New case'],
      ['client-profile-cases', anaUrl, 'Ana Ejemplo']
    ] as const
    for (const [name, url, heading] of screens) {
      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      if (name === 'case-list') await expect(page.locator('.result-count')).toContainText('4 cases')
      if (name === 'case-overview') await expect(page.getByRole('region', { name: 'History' }).getByRole('listitem').first()).toBeVisible()
      if (name === 'client-profile-cases') await expect(page.getByRole('region', { name: 'Research cases' }).getByRole('listitem').first()).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, `${name} overflows by ${overflow}px at ${viewport.width}px`).toBeLessThanOrEqual(0)
      if (capture && viewport.name !== 'tablet') {
        await page.screenshot({ path: join(shotsDir, `${viewport.name}-${name}.png`), fullPage: true })
      }
    }
  }
})
