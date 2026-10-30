import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Send feedback (#102) in the built browser demo. The default server must make no
// network request and keep its policy exactly; the opt-in server (--feedback) is
// tested against a FAKE GitHub GraphQL endpoint on 127.0.0.1 and a fictional token.

const root = resolve(__dirname, '../..')
const defaultPort = Number(process.env['DEMO_E2E_FEEDBACK_PORT'] ?? 4186)
const optInPort = defaultPort + 1
const publicPort = defaultPort + 2
const TOKEN = 'ghp_FAKE_TOKEN_for_playwright_only'
const children: ChildProcess[] = []
const fakes: Server[] = []

interface Fake {
  url: string
  mutations: { title: string; body: string }[]
  isPublic: boolean
}

async function fakeGithub(isPublic: boolean): Promise<Fake> {
  const fake: Fake = { url: '', mutations: [], isPublic }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { query: string; variables: { title: string; body: string } }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (body.query.includes('addProjectV2DraftIssue')) {
        fake.mutations.push({ title: body.variables.title, body: body.variables.body })
        res.end(JSON.stringify({ data: { addProjectV2DraftIssue: { projectItem: { id: 'PVTI_fake', project: { url: 'https://github.com/orgs/fake-org/projects/1' } } } } }))
      } else {
        res.end(JSON.stringify({ data: { node: { __typename: 'ProjectV2', id: 'PVT_fake', public: fake.isPublic } } }))
      }
    })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  fakes.push(server)
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`
  return fake
}

async function startServer(port: number, extraArgs: string[], env: Record<string, string> = {}): Promise<{ url: string; output: string }> {
  const child = spawn(process.execPath, ['scripts/demo-lan.mjs', '--host', '127.0.0.1', '--port', String(port), ...extraArgs], {
    cwd: root,
    env: { ...process.env, TG_FEEDBACK_GITHUB_TOKEN: '', TG_FEEDBACK_PROJECT_ID: '', TG_FEEDBACK_GITHUB_API: '', ...env }
  })
  children.push(child)
  let output = ''
  const ready = extraArgs.includes('--feedback') ? /Feedback access code[^\n]*\n\s+[A-Z2-9]{4}-[A-Z2-9]{4}\n/ : /Press Ctrl\+C to stop/
  await new Promise<void>((done, fail) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (ready.test(output)) done()
    })
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.once('exit', (code) => fail(new Error(`demo:lan exited with ${code}: ${output}`)))
  })
  return { url: `http://127.0.0.1:${port}/`, output }
}

const accessCodeIn = (output: string) => /Feedback access code[^\n]*\n\s+([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(output)![1]!

let plain: { url: string; output: string }
let optIn: { url: string; output: string }
let privateFake: Fake
let publicRefused: { url: string; output: string }

test.beforeAll(async () => {
  plain = await startServer(defaultPort, [])
  privateFake = await fakeGithub(false)
  optIn = await startServer(optInPort, ['--feedback'], {
    TG_FEEDBACK_GITHUB_TOKEN: TOKEN,
    TG_FEEDBACK_PROJECT_ID: 'PVT_fake',
    TG_FEEDBACK_GITHUB_API: privateFake.url
  })
  const publicFake = await fakeGithub(true)
  publicRefused = await startServer(publicPort, ['--feedback'], {
    TG_FEEDBACK_GITHUB_TOKEN: TOKEN,
    TG_FEEDBACK_PROJECT_ID: 'PVT_fake',
    TG_FEEDBACK_GITHUB_API: publicFake.url
  })
})

test.afterAll(async () => {
  children.forEach((c) => c.kill())
  await Promise.all(fakes.map((s) => new Promise((r) => s.close(r))))
})

const DEFAULT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

async function watchViolations(page: Page) {
  const problems: string[] = []
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      ;(window as unknown as { __csp: string[] }).__csp = [...((window as unknown as { __csp?: string[] }).__csp ?? []), `${event.violatedDirective} ${event.blockedURI}`]
    })
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) problems.push(`console: ${message.text()}`)
  })
  return async () => [...problems, ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []))]
}

async function fillForm(page: Page) {
  await page.getByRole('button', { name: 'Send feedback' }).click()
  const dialog = page.getByRole('dialog', { name: 'Send feedback' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('What kind of feedback?').selectOption('confusing')
  await dialog.getByLabel('Short title').fill('Where is the archive button?')
  await dialog.getByLabel('Comments').fill('I could not find it at first. Fictional test comment.')
  return dialog
}

test('default demo: Copy feedback only, no request, and the policy is exactly as before', async ({ page }) => {
  const problems = await watchViolations(page)
  const response = await page.goto(`${plain.url}#/clients`)
  expect(response?.headers()['content-security-policy']).toBe(DEFAULT_CSP)
  const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(meta).toContain("connect-src 'none'")
  expect(meta).not.toContain("connect-src 'self'")
  await expect(page.locator('meta[name="tg-feedback"]')).toHaveCount(0)
  expect(response?.headers()['access-control-allow-origin']).toBeUndefined()

  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  const dialog = await fillForm(page)
  await expect(dialog.getByText(/goes to a private Tracing Guatemala project/)).toBeVisible()
  await expect(dialog.getByText(/plain HTTP on your home network/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^Submit/ })).toHaveCount(0)
  await expect(dialog.getByLabel('Access code')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Copy feedback' }).click()
  await expect(dialog.getByLabel('Feedback to copy')).toHaveValue(/Title: Where is the archive button\?[\s\S]*Screen: Directory/)
  await expect(dialog.getByLabel('Feedback to copy')).not.toHaveValue(/de300000|http|192\.168|127\.0\.0\.1/)
  expect(requests).toEqual([])

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send feedback' })).toBeFocused()
  expect(requests).toEqual([])
  expect(await problems()).toEqual([])

  // No feedback route exists on the default server: the status URL is just the app page.
  const status = await page.request.get(`${plain.url}__feedback/status`)
  expect(status.headers()['content-type']).toContain('text/html')
  const post = await page.request.post(`${plain.url}__feedback`, { data: {} })
  expect(post.headers()['content-type'] ?? '').not.toContain('application/json')
})

test('opt-in server: only connect-src changes, and a private project accepts feedback', async ({ page }) => {
  const problems = await watchViolations(page)
  const response = await page.goto(`${optIn.url}#/clients`)
  const header = response?.headers()['content-security-policy'] ?? ''
  expect(header).toBe(DEFAULT_CSP.replace("connect-src 'none'", "connect-src 'self'"))
  const meta = (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')) ?? ''
  expect(meta).toContain("connect-src 'self'")
  expect(meta.replace("connect-src 'self'", "connect-src 'none'")).not.toContain("connect-src 'self'")
  expect(response?.headers()['access-control-allow-origin']).toBeUndefined()
  expect(optIn.output).not.toContain(TOKEN)
  expect(optIn.output).toMatch(/private GitHub Project verified/)

  const code = accessCodeIn(optIn.output)
  const dialog = await fillForm(page)
  await expect(dialog.getByRole('button', { name: 'Submit feedback' })).toBeVisible()

  // A wrong code is refused and the text stays.
  await dialog.getByLabel('Access code').fill('ZZZZ-9999')
  await dialog.getByRole('button', { name: 'Submit feedback' }).click()
  await expect(dialog.getByRole('alert')).toContainText('access code was not accepted')
  await expect(dialog.getByLabel('Comments')).toHaveValue(/Fictional test comment/)
  expect(privateFake.mutations).toHaveLength(0)

  await dialog.getByLabel('Access code').fill(code)
  await dialog.getByRole('button', { name: 'Submit feedback' }).dblclick()
  await expect(dialog.getByText('Feedback added to private project.')).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Open the private project' })).toHaveAttribute('href', 'https://github.com/orgs/fake-org/projects/1')
  expect(privateFake.mutations).toHaveLength(1)
  expect(privateFake.mutations[0]!.title).toBe('[confusing] Where is the archive button?')
  expect(privateFake.mutations[0]!.body).toContain('**Screen:** Directory')
  expect(JSON.stringify(privateFake.mutations)).not.toMatch(/de300000|192\.168|127\.0\.0\.1|#\/clients/)
  // The only console error is the browser's note about the deliberate wrong-code 401.
  expect((await problems()).filter((p) => !p.includes('401 (Unauthorized)'))).toEqual([])

  // The code stays out of the page source and assets.
  const html = await (await page.request.get(optIn.url)).text()
  expect(html).not.toContain(code)
  expect(html).not.toContain(TOKEN)
})

test('opt-in server with a public project: sending stays off and the demo still works', async ({ page }) => {
  expect(publicRefused.output).toMatch(/not private/)
  const status = await page.request.get(`${publicRefused.url}__feedback/status`)
  expect(await status.json()).toEqual({ enabled: false })
  await page.goto(`${publicRefused.url}#/clients`)
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
  const dialog = await fillForm(page)
  await expect(dialog.getByText(/Sending isn’t turned on/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^Submit/ })).toHaveCount(0)
})
