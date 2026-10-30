import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Case summary export (#20) in the built Live web app: the real download under the
// production CSP, what the file contains (and does not), and that exporting reads
// but never writes. Own port, so it never collides with the other web specs.
// Fictional data only. Screenshots are opt-in:
//   npm run web:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project web-live live-case-export

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_CASE_EXPORT_PORT'] ?? 4197)
const origin = `http://127.0.0.1:${port}`
const shotsDir = join(root, 'docs/screenshots/issue-20')
const capture = Boolean(process.env['CAPTURE_SCREENSHOTS'])

let dataDir: string
let child: ChildProcess | null = null

async function startHost(): Promise<string> {
  child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'dist-web/server/main.mjs', '--port', String(port), '--data-dir', dataDir],
    { cwd: root }
  )
  let output = ''
  return new Promise<string>((ready, fail) => {
    child!.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = /http:\/\/127\.0\.0\.1:\d+\/launch\?token=[\w-]+/.exec(output)
      if (match && output.includes('Press Ctrl+C to stop')) ready(match[0])
    })
    child!.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child!.once('exit', (code) => fail(new Error(`web:local exited with ${code}: ${output}`)))
  })
}

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-case-export-e2e-'))
})

test.afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child!.once('exit', done))
    child.kill()
    await exited
  }
  child = null
  rmSync(dataDir, { recursive: true, force: true })
})

/** Calls the host's API from the signed-in page, the way the app does. */
async function api<T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  const session = (await (await page.request.get(`${origin}/api/v1/session`)).json()) as { csrfToken: string }
  const reply = await page.request.post(`${origin}/api/v1/call/${name}`, {
    headers: { Origin: origin, 'X-TG-CSRF': session.csrfToken, 'Content-Type': 'application/json' },
    data: { args }
  })
  expect(reply.status(), name).toBe(200)
  return ((await reply.json()) as { result: T }).result
}

interface Seeded {
  caseId: string
  caseUrl: string
}

async function seed(page: Page, clientName: string, email: string, title: string, tag: string): Promise<Seeded> {
  const client = await api<{ ok: true; client: { id: string } }>(page, 'createClient', {
    displayName: clientName,
    source: 'fiverr',
    sourceDetail: null,
    fiverrUsername: `fiverr_${tag}`,
    email,
    otherContact: `phone-${tag}`,
    preferredContactChannel: 'email'
  })
  const made = await api<{ ok: true; case: { id: string } }>(page, 'createCase', client.client.id, {
    title,
    goal: `Goal text ${tag}`,
    orderReference: null,
    dueDate: '2026-11-15'
  })
  const caseId = made.case.id
  await api(page, 'saveCaseBrief', caseId, {
    objective: `Objective ${tag}`,
    facts: `Facts ${tag}`,
    people: null,
    hypotheses: `Maybe ${tag}`,
    questions: null
  })
  await api(page, 'createJournalEntry', caseId, { occurredAt: '2026-10-21T15:00:00.000Z', activity: 'Archive search', body: `Journal text ${tag}` })
  await api(page, 'createCaseTask', caseId, { title: `Task ${tag}`, description: null, dueDate: '2026-11-05' })
  return { caseId, caseUrl: `${origin}/#/cases/${caseId}` }
}

const READS = ['getCase', 'getClient', 'getCaseBrief', 'listJournalEntries', 'listCaseTasks', 'listCaseEvents']

test('downloads a summary of one case from the built app and changes nothing', async ({ page }) => {
  await page.goto(await startHost())
  const a = await seed(page, 'Ana Ejemplo', 'ana.secret@example.com', 'Maternal line — Totonicapán', 'AAA')
  const b = await seed(page, 'Ana Ejemplar', 'anita.secret@example.com', 'Maternal line — Totonicapán', 'BBB')

  // The production policy: blob downloads need no connect-src, and the page may only call its own origin.
  expect((await page.request.get(`${origin}/`)).headers()['content-security-policy']).toContain("connect-src 'self'")
  await page.goto(a.caseUrl)
  await expect(page.getByRole('heading', { level: 1, name: 'Maternal line — Totonicapán' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Research journal' })).toContainText('Journal text AAA')

  const snapshot = async () =>
    JSON.stringify([
      await api(page, 'getCase', a.caseId),
      await api(page, 'getCaseBrief', a.caseId),
      await api(page, 'listJournalEntries', a.caseId),
      await api(page, 'listCaseTasks', a.caseId),
      await api(page, 'listCaseEvents', a.caseId),
      await api(page, 'getCase', b.caseId)
    ])
  const before = await snapshot()

  await page.getByRole('button', { name: 'Export summary…' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('The file is not encrypted.')
  await expect(dialog).toContainText('no contact details')
  await expect(dialog).toContainText('Your browser will save or ask where to save it.')
  if (capture) {
    mkdirSync(shotsDir, { recursive: true })
    for (const [name, size] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 375, height: 812 }]] as const) {
      await page.setViewportSize(size)
      await page.screenshot({ path: join(shotsDir, `${name}-export-dialog.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 800 })
  }

  const requests: { method: string; url: string; body: string | null }[] = []
  page.on('request', (request) => requests.push({ method: request.method(), url: request.url(), body: request.postData() }))
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Download' }).click()
  ])

  expect(download.suggestedFilename()).toMatch(/^case-summary-maternal-line-totonicapan-\d{4}-\d{2}-\d{2}\.md$/)
  const text = readFileSync((await download.path())!, 'utf8')
  expect(text).toContain('# Case summary: Maternal line — Totonicapán')
  expect(text).toContain('- Client: Ana Ejemplo')
  for (const present of ['Goal text AAA', 'Objective AAA', 'Facts AAA', 'Hypothesis — not established: Maybe AAA', 'Task AAA', 'Journal text AAA', 'Archive search', 'Case created']) {
    expect(text).toContain(present)
  }
  // Nothing of the other case or its client, and no contact detail of this client either.
  for (const absent of ['BBB', 'Ana Ejemplar', 'ana.secret@example.com', 'anita.secret@example.com', 'fiverr_AAA', 'phone-AAA', '@example.com', 'Fictional demo data']) {
    expect(text).not.toContain(absent)
  }

  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(page.getByText('Summary prepared. Your browser will save it or ask where to save it.')).toBeVisible()

  // Only reads went over the wire: the case's own read calls, on this origin, nothing else.
  const calls = requests.map((request) => {
    const url = new URL(request.url)
    expect(url.origin, request.url).toBe(origin)
    expect(['GET', 'POST']).toContain(request.method)
    const name = /^\/api\/v1\/call\/(\w+)$/.exec(url.pathname)?.[1]
    expect(name, `${request.method} ${request.url}`).toBeDefined()
    return name!
  })
  expect(calls.sort()).toEqual([...READS].sort())
  for (const request of requests) {
    const args = (JSON.parse(request.body ?? '{}') as { args?: unknown[] }).args ?? []
    expect(args[0], request.url).not.toBe(b.caseId)
  }

  // Stored data is untouched, including updatedAt.
  expect(await snapshot()).toBe(before)

  // The page keeps working: a second export of the same case gives the same text apart from "Generated".
  await page.getByRole('button', { name: 'Export summary…' }).click()
  const [second] = await Promise.all([page.waitForEvent('download'), page.getByRole('alertdialog').getByRole('button', { name: 'Download' }).click()])
  const strip = (value: string) => value.replace(/^- Generated: .*$/m, '')
  expect(strip(readFileSync((await second.path())!, 'utf8'))).toBe(strip(text))
})

test('exports an archived case too, and Cancel exports nothing', async ({ page }) => {
  await page.goto(await startHost())
  const a = await seed(page, 'Carmen Muestra', 'carmen@example.com', 'Archive test', 'CCC')
  await api(page, 'archiveCase', a.caseId)
  await page.goto(a.caseUrl)
  await expect(page.getByText(/Archived on/)).toBeVisible()

  let downloads = 0
  page.on('download', () => (downloads += 1))
  await page.getByRole('button', { name: 'Export summary…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(downloads).toBe(0)

  await page.getByRole('button', { name: 'Export summary…' }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('alertdialog').getByRole('button', { name: 'Download' }).click()])
  const text = readFileSync((await download.path())!, 'utf8')
  expect(text).toContain('- Archived: yes, since')
  expect(text).toContain('Journal text CCC')
  expect(text).not.toContain('carmen@example.com')
})
