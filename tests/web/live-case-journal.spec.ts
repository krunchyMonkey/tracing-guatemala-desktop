import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The case research journal (#18) in the built Live web app, driven through the UI
// only: add entries (one back-dated), check the order, edit, reload and restart the
// host, archive and unarchive, keep cases and the client's notes apart. Own port,
// so it never collides with the other web specs. Fictional data only.
// Screenshots are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-case-journal

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_CASE_JOURNAL_PORT'] ?? 4195)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/issue-18')
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
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-case-journal-e2e-'))
})

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stop))
  rmSync(dataDir, { recursive: true, force: true })
})

const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const dialog = (page: Page) => page.getByRole('alertdialog')
const journal = (page: Page) => page.getByRole('region', { name: 'Research journal' })
const entries = (page: Page) => journal(page).getByRole('list', { name: 'Journal entries, newest first' }).getByRole('listitem')
const bodies = (page: Page) => entries(page).locator('.timeline-body')

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

/** "2026-10-29T14:05" in the browser's local time, n days before now. */
async function daysAgo(page: Page, days: number): Promise<string> {
  return page.evaluate((n) => {
    const d = new Date(Date.now() - n * 86_400_000)
    const pad = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }, days)
}

async function addEntry(page: Page, body: string, options: { activity?: string; when?: string } = {}): Promise<void> {
  const form = journal(page).getByRole('form', { name: 'Add a journal entry' })
  if (options.when) await form.getByLabel('When').fill(options.when)
  if (options.activity) await form.getByLabel('Activity (optional)').fill(options.activity)
  await form.getByLabel('What you did or found').fill(body)
  await form.getByRole('button', { name: 'Add entry' }).click()
  await expect(form.getByLabel('What you did or found')).toHaveValue('')
}

test('adds entries through the UI, orders them, edits one, and finds them after a reload and a host restart', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseUrl = await addCase(page, 'Ana Ejemplo', 'Maternal grandparents')

  await expect(journal(page).getByText('No journal entries yet.')).toBeVisible()
  await expect(journal(page)).toContainText('separate from the client’s notes and contact history')

  await addEntry(page, 'First look at the parish index.\nNothing found yet.', { activity: 'Archive search' })
  await addEntry(page, 'Second session: read the baptism book.', { activity: 'Record analysis' })
  // Back-dated: lands at the bottom although it was added last.
  await addEntry(page, 'Earlier work the client asked about by phone.', { when: await daysAgo(page, 30) })

  await expect(bodies(page)).toHaveText([
    'Second session: read the baptism book.',
    'First look at the parish index.\nNothing found yet.',
    'Earlier work the client asked about by phone.'
  ])
  await expect(entries(page).nth(0)).toContainText('Record analysis')
  await expect(entries(page).nth(2).locator('.journal-activity')).toHaveCount(0)

  // Edit the middle entry.
  await entries(page).nth(1).getByRole('button', { name: /^Edit journal entry from/ }).click()
  const edit = journal(page).getByRole('form', { name: 'Edit journal entry' })
  await edit.getByLabel('Entry').fill('First look at the parish index. Corrected: found a possible match.')
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(journal(page).getByRole('form', { name: 'Edit journal entry' })).toHaveCount(0)
  await expect(bodies(page).nth(1)).toHaveText('First look at the parish index. Corrected: found a possible match.')
  await expect(entries(page).nth(1)).toContainText('Edited')
  await expect(entries(page).nth(0)).not.toContainText('Edited')

  // Reload, then restart the host.
  await page.reload()
  await expect(entries(page)).toHaveCount(3)
  await stop(host.child)
  host = await startHost()
  await page.goto(host.launchUrl)
  await page.goto(caseUrl)
  await expect(bodies(page)).toHaveText([
    'Second session: read the baptism book.',
    'First look at the parish index. Corrected: found a possible match.',
    'Earlier work the client asked about by phone.'
  ])
  await expect(entries(page).nth(1)).toContainText('Edited')
  await expect(entries(page).nth(0).locator('.journal-activity')).toHaveText('Record analysis')
})

test('keeps entries of one case off another case and off the client’s notes', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  const clientUrl = await addClient(page, 'Ana Ejemplo')
  const caseA = await addCase(page, 'Ana Ejemplo', 'Case A')
  const caseA2 = await addCase(page, 'Ana Ejemplo', 'Case A2')
  await addClient(page, 'Ana Ejemplar')
  const caseB = await addCase(page, 'Ana Ejemplar', 'Case B')

  await page.goto(caseA)
  await addEntry(page, 'Only in case A.')
  await page.goto(caseA2)
  await expect(journal(page).getByText('No journal entries yet.')).toBeVisible()
  await addEntry(page, 'Only in case A2.')
  await page.goto(caseB)
  await expect(journal(page).getByText('No journal entries yet.')).toBeVisible()
  await expect(journal(page)).not.toContainText('Only in case A')

  await page.goto(caseA)
  await expect(bodies(page)).toHaveText(['Only in case A.'])

  // The client's notes list never shows journal entries, and a client note never shows in the journal.
  await page.goto(clientUrl)
  await expect(page.getByRole('region', { name: 'Notes & contact history' })).not.toContainText('Only in case A')
  await expect(page.getByText('No notes or contact history yet.')).toBeVisible()
  await page.getByLabel('Your note').fill('A client note.')
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByRole('region', { name: 'Notes & contact history' })).toContainText('A client note.')
  await page.goto(caseA)
  await expect(journal(page)).not.toContainText('A client note.')
})

test('validates inline and keeps what was typed', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Bruno Ficticio')
  await addCase(page, 'Bruno Ficticio', 'Validation walkthrough')
  const form = journal(page).getByRole('form', { name: 'Add a journal entry' })

  await form.getByRole('button', { name: 'Add entry' }).click()
  await expect(form.getByText('Write what you did or found before adding it.')).toBeVisible()
  await expect(form.getByLabel('What you did or found')).toHaveAttribute('aria-invalid', 'true')

  await form.getByLabel('What you did or found').fill('Some work.')
  await form.getByLabel('Activity (optional)').fill('a'.repeat(61))
  await form.getByRole('button', { name: 'Add entry' }).click()
  await expect(form.getByText('Keep the activity under 60 characters.')).toBeVisible()
  await expect(form.getByLabel('What you did or found')).toHaveValue('Some work.')

  await form.getByLabel('Activity (optional)').fill('Archive search')
  await form.getByLabel('When').fill(await daysAgo(page, -5))
  await form.getByRole('button', { name: 'Add entry' }).click()
  await expect(form.getByText('This date is in the future. Choose when the work happened.')).toBeVisible()
  await expect(entries(page)).toHaveCount(0)

  // Keyboard: fix the date and submit with Enter from the activity field.
  await form.getByLabel('When').fill(await daysAgo(page, 1))
  await form.getByLabel('Activity (optional)').focus()
  await page.keyboard.press('Enter')
  await expect(entries(page)).toHaveCount(1)
})

test('keeps accents, quotes and markup-like text exactly as typed, and shows it as text', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Carmen Muestra')
  const caseUrl = await addCase(page, 'Carmen Muestra', 'Special characters')
  const special = 'Niño “Ángel” O’Brien — <script>window.__pwned = 1</script> <b>not bold</b> & "quotes" \'; DROP TABLE case_journal_entries; --'

  await addEntry(page, `${special}\nLínea 2`, { activity: 'Búsqueda <i>x</i>' })
  await expect(bodies(page).first()).toHaveText(`${special}\nLínea 2`)
  await expect(entries(page).first().locator('.journal-activity')).toHaveText('Búsqueda <i>x</i>')
  await expect(journal(page).locator('b, i, script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  await page.goto(caseUrl)
  await page.reload()
  await expect(bodies(page).first()).toHaveText(`${special}\nLínea 2`)
})

test('is read-only but still visible once the case is archived, and editable again after unarchiving', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Diana Prueba')
  const caseUrl = await addCase(page, 'Diana Prueba', 'Archive and journal')
  await addEntry(page, 'Kept while archived.', { activity: 'Document review' })

  await page.getByRole('button', { name: 'Archive case' }).click()
  await dialog(page).getByRole('button', { name: 'Archive case' }).click()
  await expect(page.getByText('Case archived.')).toBeVisible()
  await expect(bodies(page)).toHaveText(['Kept while archived.'])
  await expect(journal(page)).toContainText('This case is archived, so the journal can’t be changed.')
  await expect(journal(page).getByRole('form')).toHaveCount(0)
  await expect(journal(page).getByRole('button', { name: /Add entry|Edit journal entry/ })).toHaveCount(0)

  await page.reload()
  await expect(bodies(page)).toHaveText(['Kept while archived.'])
  await expect(journal(page).getByRole('form')).toHaveCount(0)

  await page.goto(caseUrl)
  await page.getByRole('button', { name: 'Unarchive case' }).click()
  await dialog(page).getByRole('button', { name: 'Unarchive case' }).click()
  await expect(journal(page).getByRole('form', { name: 'Add a journal entry' })).toBeVisible()
  await entries(page).first().getByRole('button', { name: /^Edit journal entry from/ }).click()
  const edit = journal(page).getByRole('form', { name: 'Edit journal entry' })
  await edit.getByLabel('Entry').fill('Edited after unarchiving.')
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(bodies(page)).toHaveText(['Edited after unarchiving.'])
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
  const caseUrl = await addCase(
    page,
    'Ana Ejemplo',
    'Paternal line — Quetzaltenango, 1880s, including the neighbouring parishes and every surname variant'
  )
  await addEntry(page, 'Searched the fictional diocesan index for baptisms of the Ejemplo family, 1880 to 1890.\nFound two possible entries; neither names a father.', {
    activity: 'Archive search',
    when: await daysAgo(page, 12)
  })
  await addEntry(page, 'Compared the two possible baptisms with the family story. The second one fits the date the client gave, but this is a long unbroken token: ' + 'Ejemplo'.repeat(20), {
    activity: 'Record analysis',
    when: await daysAgo(page, 5)
  })
  await addEntry(page, 'Asked the client for the photograph and any letters. Waiting for a reply.', { activity: 'Client communication' })
  await expect(entries(page)).toHaveCount(3)
  if (capture) mkdirSync(shotsDir, { recursive: true })

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.goto(caseUrl)
    await expect(entries(page)).toHaveCount(3)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, `overflows by ${overflow}px at ${viewport.width}px`).toBeLessThanOrEqual(0)
    if (capture && viewport.name !== 'tablet') {
      await journal(page).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(shotsDir, `${viewport.name}-journal.png`), fullPage: true })
    }
  }
})
