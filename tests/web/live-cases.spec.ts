import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Research cases (#15) through the built Live web host in Edge/Chromium. There
// are no case screens yet (#16), so the signed-in page calls the typed local
// API with fetch, exactly as the web client's adapter does. Own port, so it
// never collides with live-web.spec.ts. Fictional data only.

const root = resolve(__dirname, '../..')
const port = Number(process.env['WEB_E2E_CASES_PORT'] ?? 4192)
const origin = `http://127.0.0.1:${port}`

let dataDir: string
const running: ChildProcess[] = []

async function startHost(): Promise<{ child: ChildProcess; launchUrl: string }> {
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
  dataDir = mkdtempSync(join(tmpdir(), 'tg-live-cases-e2e-'))
})

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stop))
  rmSync(dataDir, { recursive: true, force: true })
})

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

interface CaseResult {
  ok: boolean
  reason?: string
  case: { id: string; state: string; title: string; archivedAt: string | null }
}

test('creates, advances and archives a case, and finds it with its history after a host restart', async ({ page }) => {
  let host = await startHost()
  await page.goto(host.launchUrl)
  await expect(page).toHaveURL(`${origin}/`)

  const client = await api<{ ok: true; client: { id: string } }>(page, 'createClient', {
    displayName: 'Lucía Ficticia',
    source: 'direct',
    sourceDetail: null,
    fiverrUsername: null,
    email: null,
    otherContact: null,
    preferredContactChannel: 'unspecified'
  })
  const clientId = client.client.id

  const created = await api<CaseResult>(page, 'createCase', clientId, {
    title: 'Maternal grandparents — Quetzaltenango',
    goal: 'Find where my grandmother Rosa was born.\nAnd her parents’ names.',
    orderReference: 'FO-EXAMPLE-0042',
    dueDate: '2028-02-29'
  })
  expect(created.ok).toBe(true)
  expect(created.case.state).toBe('intake')
  const caseId = created.case.id

  expect((await api<CaseResult>(page, 'setCaseState', caseId, 'active')).case.state).toBe('active')
  expect(await api(page, 'setCaseState', caseId, 'intake')).toEqual({ ok: false, reason: 'invalid-transition' })
  expect((await api<CaseResult>(page, 'setCaseState', caseId, 'waiting')).case.state).toBe('waiting')
  expect(await api(page, 'createCase', clientId, { title: '', goal: null, orderReference: null, dueDate: '2026-02-29' })).toEqual({
    ok: false,
    reason: 'invalid',
    issues: [
      { field: 'title', code: 'required' },
      { field: 'dueDate', code: 'invalid-date' }
    ]
  })
  const archived = await api<CaseResult>(page, 'archiveCase', caseId)
  expect(archived.case.archivedAt).not.toBeNull()
  expect(await api(page, 'setCaseState', caseId, 'active')).toEqual({ ok: false, reason: 'wrong-status' })

  // Restarting the host signs the browser out but keeps the data.
  await stop(host.child)
  host = await startHost()
  await page.goto(host.launchUrl)
  await expect(page).toHaveURL(`${origin}/`)

  const stored = await api<{ id: string; title: string; state: string; archivedAt: string | null; dueDate: string; clientId: string }[]>(
    page,
    'listCases',
    { clientId, archived: 'all', states: [], text: 'quetzaltenango', sort: 'title' }
  )
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({
    id: caseId,
    clientId,
    title: 'Maternal grandparents — Quetzaltenango',
    state: 'waiting',
    dueDate: '2028-02-29'
  })
  expect(stored[0]!.archivedAt).toBe(archived.case.archivedAt)

  const events = await api<{ kind: string; fromState: string | null; toState: string | null }[]>(page, 'listCaseEvents', caseId)
  expect(events.map((e) => `${e.kind}:${e.fromState ?? '-'}>${e.toState ?? '-'}`)).toEqual([
    'archived:->-',
    'state:active>waiting',
    'state:intake>active',
    'created:->intake'
  ])

  // The case can be reopened and keeps its state.
  const reopened = await api<CaseResult>(page, 'unarchiveCase', caseId)
  expect(reopened.case).toMatchObject({ state: 'waiting', archivedAt: null })
})

test('refuses case writes from another site, even in a browser signed in to Live', async ({ page, context }) => {
  const host = await startHost()
  await page.goto(host.launchUrl)
  const client = await api<{ client: { id: string } }>(page, 'createClient', {
    displayName: 'Mateo Ficticio',
    source: 'direct',
    sourceDetail: null,
    fiverrUsername: null,
    email: null,
    otherContact: null,
    preferredContactChannel: 'unspecified'
  })

  await context.route('http://attacker.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Elsewhere</title>' }))
  const attacker = await context.newPage()
  await attacker.goto('http://attacker.test/')
  await attacker.evaluate(
    async ([target, clientId]) => {
      const body = JSON.stringify({ args: [clientId, { title: 'Injected', goal: null, orderReference: null, dueDate: null }] })
      await fetch(`${target}/api/v1/call/createCase`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {})
      await fetch(`${target}/api/v1/call/createCase`, { method: 'POST', mode: 'no-cors', credentials: 'include', body }).catch(() => {})
    },
    [origin, client.client.id] as const
  )

  expect(await api<unknown[]>(page, 'listCases', { clientId: null, archived: 'all', states: [], text: '', sort: 'title' })).toEqual([])
})
