import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The case research brief (#17) in the built Live web app, driven through the UI
// only: write a brief, reload, restart the host, find it again; edit one case
// without touching another; back/forward navigation; special characters. Own
// port, so it never collides with the other web specs. Fictional data only.
// Screenshots are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-case-brief

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_CASE_BRIEF_PORT'] ?? 4194)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/issue-17')
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
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-case-brief-e2e-'))
})

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stop))
  rmSync(dataDir, { recursive: true, force: true })
})

const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const dialog = (page: Page) => page.getByRole('alertdialog')
const brief = (page: Page) => page.getByRole('region', { name: 'Research brief' })

async function addClient(page: Page, name: string): Promise<void> {
  await page.goto(`${origin}/#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

/** Creates a case through the client picker and the form; returns the case's address. */
async function addCase(page: Page, clientName: string, title: string, goal?: string): Promise<string> {
  await page.goto(`${origin}/#/cases/new`)
  await page.getByLabel('Client', { exact: true }).selectOption({ label: clientName })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel(/^Title/).fill(title)
  if (goal) await page.getByLabel(/^Requested outcome/).fill(goal)
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  return page.url()
}

const objective = (page: Page) => page.getByLabel(/^Working research objective/)
const facts = (page: Page) => page.getByLabel(/^Known facts/)
const people = (page: Page) => page.getByLabel(/^Known people/)
const hypotheses = (page: Page) => page.getByLabel(/^Hypotheses/)
const questions = (page: Page) => page.getByLabel(/^Open questions/)

test('writes a brief through the UI and finds it after a reload and a host restart', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  const caseUrl = await addCase(page, 'Ana Ejemplo', 'Maternal grandparents', 'Find where my grandmother Rosa was born.')

  // Empty state first, with the client's outcome shown for reference.
  await expect(brief(page).getByText('No research brief yet.')).toBeVisible()
  await expect(brief(page).getByRole('heading', { name: 'Client’s requested outcome' })).toBeVisible()
  await expect(brief(page)).toContainText('Find where my grandmother Rosa was born.')

  await brief(page).getByRole('link', { name: 'Write the brief' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Research brief' })).toBeVisible()
  await objective(page).fill('  Establish where Rosa was born.  ')
  await facts(page).fill('The client says she was born in 1931.\nNo document seen yet.')
  await people(page).fill('Rosa Ejemplo (grandmother)')
  await hypotheses(page).fill('She may have been born in Totonicapán.')
  await questions(page).fill('Which parish book covers 1931?')
  await page.getByRole('button', { name: 'Save brief' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Maternal grandparents' })).toBeVisible()
  await expect(page.getByText('Brief saved.')).toBeVisible()
  await expect(page).toHaveURL(caseUrl)
  const text = brief(page)
  await expect(text.getByRole('heading', { level: 3 })).toHaveText([
    'Client’s requested outcome',
    'Working research objective',
    'Known facts (as reported)',
    'Known people and family context',
    'Hypotheses',
    'Open questions'
  ])
  await expect(text.locator('.brief-objective .brief-text')).toHaveText('Establish where Rosa was born.')
  await expect(text.locator('.brief-facts .brief-text')).toHaveText('The client says she was born in 1931.\nNo document seen yet.')
  await expect(text.getByText('Recorded from the client or sources; not verified by the app.')).toBeVisible()
  await expect(text.locator('.brief-hypotheses')).toContainText('Hypothesis — not established')
  await expect(text.locator('.brief-facts')).not.toContainText('Hypothesis — not established')

  // Reload, then restart the host.
  await page.reload()
  await expect(brief(page).locator('.brief-people .brief-text')).toHaveText('Rosa Ejemplo (grandmother)')
  await stop(host.child)
  host = await startHost()
  await page.goto(host.launchUrl)
  await page.goto(caseUrl)
  await expect(brief(page).locator('.brief-objective .brief-text')).toHaveText('Establish where Rosa was born.')
  await expect(brief(page).locator('.brief-questions .brief-text')).toHaveText('Which parish book covers 1931?')
  await expect(brief(page).getByRole('link', { name: 'Edit brief' })).toBeVisible()
})

test('editing one case’s brief never changes another client’s, even with similar names', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Ana Ejemplo')
  await addClient(page, 'Ana Ejemplar')
  const caseA = await addCase(page, 'Ana Ejemplo', 'Same title')
  const caseB = await addCase(page, 'Ana Ejemplar', 'Same title')

  await page.goto(`${caseA}/brief`)
  await objective(page).fill('Objective of Ejemplo')
  await facts(page).fill('Fact for A')
  await page.getByRole('button', { name: 'Save brief' }).click()
  await expect(page.getByText('Brief saved.')).toBeVisible()

  await page.goto(caseB)
  await expect(brief(page).getByText('No research brief yet.')).toBeVisible()
  await page.goto(`${caseB}/brief`)
  await expect(objective(page)).toHaveValue('')
  await objective(page).fill('Objective of Ejemplar')
  await page.getByRole('button', { name: 'Save brief' }).click()
  await expect(brief(page).locator('.brief-objective .brief-text')).toHaveText('Objective of Ejemplar')

  await page.goto(caseA)
  await expect(brief(page).locator('.brief-objective .brief-text')).toHaveText('Objective of Ejemplo')
  await expect(brief(page).locator('.brief-facts .brief-text')).toHaveText('Fact for A')
  await expect(brief(page)).not.toContainText('Ejemplar')

  // Editing A again leaves B alone.
  await page.goto(`${caseA}/brief`)
  await facts(page).fill('Changed fact for A')
  await page.getByRole('button', { name: 'Save brief' }).click()
  await expect(brief(page).locator('.brief-facts .brief-text')).toHaveText('Changed fact for A')
  await page.goto(caseB)
  await expect(brief(page).locator('.brief-objective .brief-text')).toHaveText('Objective of Ejemplar')
  await expect(brief(page).locator('.brief-facts')).toHaveCount(0)
})

test('validates, asks before discarding, and keeps back and forward navigation sane', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Bruno Ficticio')
  const caseUrl = await addCase(page, 'Bruno Ficticio', 'Navigation walkthrough')

  await brief(page).getByRole('link', { name: 'Write the brief' }).click()
  await expect(page).toHaveURL(`${caseUrl}/brief`)
  await questions(page).fill('x'.repeat(10_001))
  await page.getByRole('button', { name: 'Save brief' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Keep “open questions” under 10,000 characters' })).toBeVisible()
  await expect(questions(page)).toHaveAttribute('aria-invalid', 'true')
  await expect(questions(page)).toHaveValue('x'.repeat(10_001))
  await questions(page).fill('A short question?')

  // Cancel asks first; keep editing, then discard.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(questions(page)).toHaveValue('A short question?')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await dialog(page).getByRole('button', { name: 'Discard changes' }).click()
  await expect(page).toHaveURL(caseUrl)
  await expect(brief(page).getByText('No research brief yet.')).toBeVisible()

  // Save, then back goes to the form, and forward returns to the case with the brief.
  await brief(page).getByRole('link', { name: 'Write the brief' }).click()
  await questions(page).fill('A saved question?')
  await page.getByRole('button', { name: 'Save brief' }).click()
  await expect(brief(page).locator('.brief-questions .brief-text')).toHaveText('A saved question?')
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Research brief' })).toBeVisible()
  await expect(questions(page)).toHaveValue('A saved question?')
  await page.goForward()
  await expect(page.getByRole('heading', { level: 1, name: 'Navigation walkthrough' })).toBeVisible()
  await expect(brief(page).locator('.brief-questions .brief-text')).toHaveText('A saved question?')

  // Keyboard: the edit link is reachable and Enter opens the form.
  await brief(page).getByRole('link', { name: 'Edit brief' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Research brief' })).toBeVisible()
})

test('keeps accents, quotes and markup-like text exactly as typed, and shows it as text', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Carmen Muestra')
  const caseUrl = await addCase(page, 'Carmen Muestra', 'Special characters')
  const special = 'Niño “Ángel” O’Brien — <script>window.__pwned = 1</script> <b>not bold</b> & "quotes" \'; DROP TABLE case_briefs; --'

  await page.goto(`${caseUrl}/brief`)
  await hypotheses(page).fill(special)
  await people(page).fill('Línea 1\nLínea 2')
  await page.getByRole('button', { name: 'Save brief' }).click()
  await expect(brief(page).locator('.brief-hypotheses .brief-text')).toHaveText(special)
  await expect(brief(page).locator('.brief-people .brief-text')).toHaveText('Línea 1\nLínea 2')
  await expect(brief(page).locator('b, script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()

  await page.reload()
  await expect(brief(page).locator('.brief-hypotheses .brief-text')).toHaveText(special)
  await page.goto(`${caseUrl}/brief`)
  await expect(hypotheses(page)).toHaveValue(special)
})

test('is read-only once the case is archived, and writable again after unarchiving', async ({ page }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  await addClient(page, 'Diana Prueba')
  const caseUrl = await addCase(page, 'Diana Prueba', 'Archive and brief')
  await page.goto(`${caseUrl}/brief`)
  await objective(page).fill('Kept while archived')
  await page.getByRole('button', { name: 'Save brief' }).click()
  await expect(brief(page).getByRole('link', { name: 'Edit brief' })).toBeVisible()

  await page.getByRole('button', { name: 'Archive case' }).click()
  await dialog(page).getByRole('button', { name: 'Archive case' }).click()
  await expect(page.getByText('Case archived.')).toBeVisible()
  await expect(brief(page).locator('.brief-objective .brief-text')).toHaveText('Kept while archived')
  await expect(brief(page).getByRole('link', { name: 'Edit brief' })).toHaveCount(0)
  await expect(brief(page)).toContainText('This case is archived, so its brief can’t be changed.')
  await page.goto(`${caseUrl}/brief`)
  await expect(page.getByText('This case is archived')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save brief' })).toHaveCount(0)

  await page.goto(caseUrl)
  await page.getByRole('button', { name: 'Unarchive case' }).click()
  await dialog(page).getByRole('button', { name: 'Unarchive case' }).click()
  await expect(brief(page).getByRole('link', { name: 'Edit brief' })).toBeVisible()
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
  await addClient(page, 'Ana Ejemplo')
  const caseUrl = await addCase(
    page,
    'Ana Ejemplo',
    'Paternal line — Quetzaltenango, 1880s, including the neighbouring parishes and every surname variant',
    'I would like to know where my great-grandfather was born and the names of his parents.'
  )
  await page.goto(`${caseUrl}/brief`)
  await objective(page).fill('Identify the birthplace and parents of Teodoro Ejemplo (born about 1884).')
  await facts(page).fill(
    'The client says Teodoro was born in a village near Quetzaltenango.\nA photograph is said to exist, but has not been sent yet.'
  )
  await people(page).fill('Teodoro Ejemplo (great-grandfather).\nHis wife, reported as Rosalía.')
  await hypotheses(page).fill('Teodoro may be the son of a Julián Ejemplo listed in a fictional parish book.')
  await questions(page).fill('Which parish covered the village in the 1880s?\nCan the client send the photograph?')
  await page.getByRole('button', { name: 'Save brief' }).click()
  await expect(brief(page).locator('.brief-hypotheses')).toBeVisible()
  if (capture) mkdirSync(shotsDir, { recursive: true })

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    for (const [name, url, heading] of [
      ['brief-read', caseUrl, null],
      ['brief-edit', `${caseUrl}/brief`, 'Research brief']
    ] as const) {
      await page.goto(url)
      if (heading) await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      else await expect(brief(page).locator('.brief-hypotheses')).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, `${name} overflows by ${overflow}px at ${viewport.width}px`).toBeLessThanOrEqual(0)
      const shot = name === 'brief-read' ? viewport.name !== 'tablet' : viewport.name === 'desktop'
      if (capture && shot) await page.screenshot({ path: join(shotsDir, `${viewport.name}-${name}.png`), fullPage: true })
    }
  }
})
