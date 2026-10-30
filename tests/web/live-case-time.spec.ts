import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, type Page } from '@playwright/test'

// Case research hours (#109) in the built Live web app, driven through the UI:
// start, pause, refresh, restart the host, resume, stop and save; manual entries
// added, edited, deleted with confirmation; archived and per-case behaviour; and
// layout at phone, tablet and desktop widths. Own port, so it never collides with
// the other web specs. Fictional data only. The 30-second minimum is real, so the
// saved session is given its counted time by editing the throwaway database while
// the host is stopped (the same file a real restart would find).
// Screenshots are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-case-time

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_CASE_TIME_PORT'] ?? 4197)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/issue-109')
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

/** Edits the stopped host's throwaway database. */
function editDatabase(sql: string, ...params: (string | number)[]): void {
  const db = new DatabaseSync(join(dataDir, 'data', 'tracing-guatemala.sqlite'))
  db.prepare(sql).run(...params)
  db.close()
}

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-case-time-e2e-'))
})

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stop))
  rmSync(dataDir, { recursive: true, force: true })
})

const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const dialog = (page: Page) => page.getByRole('alertdialog')
const hours = (page: Page) => page.getByRole('region', { name: 'Research hours' })
const pill = (page: Page) => page.getByRole('region', { name: 'Research timer' })
const entries = (page: Page) => hours(page).getByRole('list', { name: 'Hours entries' }).getByRole('listitem')
const total = (page: Page) => hours(page).getByText('Total hours').locator('xpath=following-sibling::dd')

async function addClient(page: Page, name: string): Promise<void> {
  await page.goto(`${origin}/#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
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

async function addEntry(page: Page, options: { hours?: string; minutes?: string; date?: string; activity?: string; note?: string }): Promise<void> {
  const form = hours(page).getByRole('form', { name: 'Add hours by hand' })
  if (options.date) await form.getByLabel('Date').fill(options.date)
  await form.getByLabel('Hours').fill(options.hours ?? '')
  await form.getByLabel('Minutes').fill(options.minutes ?? '')
  if (options.activity) await form.getByLabel('Activity (optional)').selectOption({ label: options.activity })
  if (options.note) await form.getByLabel('Note (optional)').fill(options.note)
  await form.getByRole('button', { name: 'Add entry' }).click()
}

test('starts, pauses, survives a refresh and a host restart, resumes, and stops and saves once', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseUrl = await addCase(page, 'Ana Ejemplo', 'Maternal grandparents')
  await expect(hours(page).getByText('No hours recorded yet.')).toBeVisible()
  await expect(pill(page)).toHaveCount(0)

  await hours(page).getByRole('button', { name: 'Start timer' }).click()
  await expect(pill(page).getByText('Maternal grandparents')).toBeVisible()
  await expect(pill(page).getByText('Running')).toBeVisible()

  // Under 30 seconds can't be saved; the dialog says so and Cancel leaves the timer alone.
  await pill(page).getByRole('button', { name: 'Stop and save timer on Maternal grandparents' }).click()
  await expect(dialog(page)).toContainText('can’t be saved')
  await expect(dialog(page).getByRole('button', { name: 'Save time' })).toBeDisabled()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(pill(page).getByText('Running')).toBeVisible()

  await pill(page).getByRole('button', { name: 'Pause timer on Maternal grandparents' }).click()
  await expect(pill(page).getByText('Paused')).toBeVisible()

  // A refresh and a navigation keep the timer.
  await page.reload()
  await expect(pill(page).getByText('Paused')).toBeVisible()
  await page.goto(`${origin}/#/settings`)
  await expect(pill(page).getByText('Maternal grandparents')).toBeVisible()
  await pill(page).getByRole('link', { name: /Go to the case being timed/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Maternal grandparents' })).toBeVisible()

  // Restart the host: still there, still paused, count unchanged. Give it 2.5 minutes counted.
  await stop(host.child)
  editDatabase('UPDATE case_active_timer SET accumulated_seconds = 150')
  host = await startHost()
  await page.goto(host.launchUrl)
  await page.goto(caseUrl)
  await expect(pill(page).getByText('Paused')).toBeVisible()
  await expect(pill(page).getByRole('timer')).toHaveText('0:02:30')

  await pill(page).getByRole('button', { name: 'Resume timer on Maternal grandparents' }).click()
  await expect(pill(page).getByText('Running')).toBeVisible()
  await pill(page).getByRole('button', { name: 'Stop and save timer on Maternal grandparents' }).click()
  await expect(dialog(page)).toContainText('Save this time?')
  await dialog(page).getByLabel('Activity (optional)').selectOption({ label: 'Analysis' })
  await dialog(page).getByLabel('Note (optional)').fill('Compared the two registers')
  await dialog(page).getByRole('button', { name: 'Save time' }).click()

  await expect(pill(page)).toHaveCount(0)
  await expect(entries(page)).toHaveCount(1)
  await expect(entries(page).first()).toContainText('Analysis')
  await expect(entries(page).first()).toContainText('From the timer')
  await expect(entries(page).first()).toContainText('Compared the two registers')
  await expect(total(page)).toHaveText('0:03')

  // Saved exactly once, and still there after a reload.
  await page.reload()
  await expect(entries(page)).toHaveCount(1)
  await expect(hours(page).getByRole('button', { name: 'Start timer' })).toBeVisible()
})

test('asks for a review, with only the observed time suggested, after the host was away', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseUrl = await addCase(page, 'Ana Ejemplo', 'Review walkthrough')
  await hours(page).getByRole('button', { name: 'Start timer' }).click()
  await expect(pill(page).getByText('Running')).toBeVisible()
  await stop(host.child)

  // The host was off for hours: the heartbeat is old, so the running time cannot be vouched for.
  const earlier = new Date(Date.now() - 6 * 3600 * 1000)
  const heartbeat = new Date(earlier.getTime() + 3 * 60 * 1000)
  editDatabase('UPDATE case_active_timer SET segment_started_at = ?, started_at = ?, last_heartbeat_at = ?', earlier.toISOString(), earlier.toISOString(), heartbeat.toISOString())
  host = await startHost()
  await page.goto(host.launchUrl)
  await page.goto(caseUrl)

  await expect(dialog(page)).toContainText('Review the time before saving')
  await expect(dialog(page)).toContainText('Nothing has been saved')
  await expect(dialog(page).getByLabel('Minutes to save')).toHaveValue('3')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(pill(page).getByText('Needs review')).toBeVisible()
  await expect(pill(page).getByRole('button', { name: /^Pause/ })).toHaveCount(0)
  await expect(entries(page)).toHaveCount(0)

  await pill(page).getByRole('button', { name: 'Review time' }).click()
  await dialog(page).getByLabel('Minutes to save').fill('20')
  await dialog(page).getByRole('button', { name: 'Save time' }).click()
  await expect(pill(page)).toHaveCount(0)
  await expect(entries(page)).toHaveCount(1)
  await expect(total(page)).toHaveText('0:20')
})

test('asks before switching a running timer to another case', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  await addCase(page, 'Ana Ejemplo', 'First case')
  await hours(page).getByRole('button', { name: 'Start timer' }).click()
  await expect(pill(page).getByText('First case')).toBeVisible()
  await addCase(page, 'Ana Ejemplo', 'Second case')

  await hours(page).getByRole('button', { name: 'Start timer' }).click()
  await expect(dialog(page)).toContainText('Stop and save the timer on First case, then start here (Second case)?')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(pill(page).getByText('First case')).toBeVisible()
  await expect(pill(page).getByText('Second case')).toHaveCount(0)

  // The first timer has under 30 seconds, which cannot be saved: offer to discard it instead.
  await hours(page).getByRole('button', { name: 'Start timer' }).click()
  await dialog(page).getByRole('button', { name: 'Stop, save and start here' }).click()
  await expect(dialog(page)).toContainText('under 30 seconds')
  await dialog(page).getByRole('button', { name: 'Discard it and start here' }).click()
  await expect(pill(page).getByText('Second case')).toBeVisible()
  await expect(entries(page)).toHaveCount(0)
})

test('adds, edits and deletes manual entries with validation, confirmation and per-case totals', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseA = await addCase(page, 'Ana Ejemplo', 'Case A')
  const caseB = await addCase(page, 'Ana Ejemplo', 'Case B')
  await page.goto(caseA)
  const form = hours(page).getByRole('form', { name: 'Add hours by hand' })

  // Invalid durations are refused inline and nothing is saved.
  await addEntry(page, {})
  await expect(form.getByText('Enter at least 1 minute.')).toBeVisible()
  await addEntry(page, { hours: '0', minutes: '0' })
  await expect(form.getByText('Enter at least 1 minute.')).toBeVisible()
  await addEntry(page, { hours: '-2' })
  await expect(form.getByText('Enter at least 1 minute.')).toBeVisible()
  await addEntry(page, { hours: '13' })
  await expect(form.getByText(/Enter at most 12 hours per entry/)).toBeVisible()
  await addEntry(page, { hours: '1', minutes: '75' })
  await expect(form.getByText('Use whole numbers for hours and minutes.')).toBeVisible()
  await expect(entries(page)).toHaveCount(0)

  await addEntry(page, { hours: '1', minutes: '30', date: await dateIn(page, 0), activity: 'Research', note: 'Read the 1931 register.' })
  await expect(entries(page)).toHaveCount(1)
  await addEntry(page, { minutes: '45', date: await dateIn(page, -1), activity: 'Correspondence' })
  await expect(entries(page)).toHaveCount(2)
  await expect(total(page)).toHaveText('2:15')
  await expect(entries(page).first()).toContainText('1:30')
  await expect(entries(page).first()).toContainText('Added by hand')
  await expect(entries(page).nth(1)).toContainText('0:45')

  // Edit.
  await entries(page).first().getByRole('button', { name: /^Edit entry: 1:30 on/ }).click()
  const edit = hours(page).getByRole('form', { name: 'Edit hours entry' })
  await edit.getByLabel('Hours').fill('2')
  await edit.getByLabel('Minutes').fill('0')
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(entries(page).first()).toContainText('2:00')
  await expect(total(page)).toHaveText('2:45')

  // Delete needs confirmation; cancelling keeps it.
  await entries(page).nth(1).getByRole('button', { name: /^Delete entry: 0:45 on/ }).click()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(entries(page)).toHaveCount(2)
  await entries(page).nth(1).getByRole('button', { name: /^Delete entry: 0:45 on/ }).click()
  await expect(dialog(page)).toContainText('Delete this entry?')
  await dialog(page).getByRole('button', { name: 'Delete entry' }).click()
  await expect(entries(page)).toHaveCount(1)
  await expect(total(page)).toHaveText('2:00')

  // Another case never shows or adds to this one; history survives a reload and a host restart.
  await page.goto(caseB)
  await expect(hours(page).getByText('No hours recorded yet.')).toBeVisible()
  await expect(total(page)).toHaveText('0:00')
  await stop(host.child)
  host = await startHost()
  await page.goto(host.launchUrl)
  await page.goto(caseA)
  await expect(entries(page)).toHaveCount(1)
  await expect(total(page)).toHaveText('2:00')
})

test('keeps hours visible but read-only once the case is archived', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Diana Prueba')
  const caseUrl = await addCase(page, 'Diana Prueba', 'Archive and hours')
  await addEntry(page, { minutes: '40', note: 'Kept while archived' })
  await expect(entries(page)).toHaveCount(1)

  await page.getByRole('button', { name: 'Archive case' }).click()
  await dialog(page).getByRole('button', { name: 'Archive case' }).click()
  await expect(page.getByText('Case archived.')).toBeVisible()
  await expect(entries(page)).toHaveCount(1)
  await expect(hours(page)).toContainText('This case is archived, so its hours can’t be changed.')
  await expect(hours(page).getByRole('form')).toHaveCount(0)
  await expect(hours(page).getByRole('button', { name: /Start timer|Add entry|Edit entry|Delete entry/ })).toHaveCount(0)

  await page.goto(caseUrl)
  await page.getByRole('button', { name: 'Unarchive case' }).click()
  await dialog(page).getByRole('button', { name: 'Unarchive case' }).click()
  await expect(hours(page).getByRole('form', { name: 'Add hours by hand' })).toBeVisible()
})

test('keeps special characters exactly as typed and shows them as text', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Carmen Muestra')
  const caseUrl = await addCase(page, 'Carmen Muestra', 'Special characters')
  const special = 'Niño “Ángel” <script>window.__pwned = 1</script> <b>not bold</b> & \'; DROP TABLE case_time_entries; --'
  await addEntry(page, { minutes: '10', note: special })
  await expect(entries(page).first()).toContainText(special)
  await expect(hours(page).locator('b, script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  await page.goto(caseUrl)
  await page.reload()
  await expect(entries(page).first()).toContainText(special)
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
  await addEntry(page, { hours: '1', minutes: '30', date: await dateIn(page, -1), activity: 'Research', note: 'Went through the diocesan baptism index, 1880 to 1890, page by page ' + 'Ejemplo'.repeat(10) })
  await expect(entries(page)).toHaveCount(1)
  await addEntry(page, { hours: '2', date: await dateIn(page, -3), activity: 'Analysis', note: 'Compared the two possible baptisms.' })
  await expect(entries(page)).toHaveCount(2)
  await addEntry(page, { minutes: '45', date: await dateIn(page, -9), activity: 'Correspondence' })
  await expect(entries(page)).toHaveCount(3)
  await hours(page).getByRole('button', { name: 'Start timer' }).click()
  await expect(pill(page).getByText('Running')).toBeVisible()
  if (capture) mkdirSync(shotsDir, { recursive: true })

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.goto(caseUrl)
    await expect(entries(page)).toHaveCount(3)
    await expect(pill(page)).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, `overflows by ${overflow}px at ${viewport.width}px`).toBeLessThanOrEqual(0)
    if (capture && viewport.name !== 'tablet') {
      await hours(page).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shotsDir, `${viewport.name}-hours.png`), fullPage: true })
    }
  }

  // The stop dialog fits the phone too.
  await page.setViewportSize({ width: 375, height: 812 })
  await pill(page).getByRole('button', { name: /^Stop and save timer on/ }).click()
  await expect(dialog(page)).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})
