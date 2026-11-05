import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { APP_NAME, APP_ORIGIN, opensslAvailable, startHttpsFront, type HttpsFront } from './https-front'

// Google sign-in, Users administration and the account UI, end to end (#181).
// The built host runs in HTTPS-proxy mode with the FAKE identity provider
// (TG_TEST_HOOKS=1 + TG_TEST_FAKE_IDENTITY=1; it verifies nothing and exists
// only in automated tests). A throwaway TLS front (https-front.ts) terminates
// HTTPS for tg.example.test and serves a fake Google consent page, so the
// __Host- Secure cookie and the exact Origin check run for real. Fictional
// people only: Alex (owner), Bea (researcher), Cara (approved during the test).

test.skip(!opensslAvailable(), 'openssl is not available, so the throwaway test certificate cannot be made.')

const root = resolve(__dirname, '../..')
const shots = join(root, 'docs/screenshots/issue-181')
const channel = process.platform === 'win32' ? 'msedge' : undefined
const NOT_APPROVED = /isn’t approved for Tracing Guatemala yet/

async function freePort(): Promise<number> {
  const free = (port: number) =>
    new Promise<boolean>((done) => {
      const probe = createServer()
      probe.once('error', () => done(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)))
    })
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise<number>((done, fail) => {
      const probe = createServer()
      probe.once('error', fail)
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port
        probe.close(() => done(p))
      })
    })
    if ((await free(port)) && (await free(port + 1)) && (await free(port + 2))) return port
  }
  throw new Error('no free port triple')
}

test.describe.serial('Google sign-in over HTTPS', () => {
  let browser: Browser
  let front: HttpsFront
  let child: ChildProcess
  let parent: string
  let port: number
  let launchUrl = ''
  let hostCtx: BrowserContext
  let hostPage: Page
  const contexts: BrowserContext[] = []
  const pages: Record<string, Page> = {}

  async function person(name: string, viewport?: { width: number; height: number }): Promise<Page> {
    const context = await browser.newContext({ proxy: { server: front.proxyUrl }, ignoreHTTPSErrors: true, ...(viewport ? { viewport } : {}) })
    contexts.push(context)
    return context.newPage()
  }

  /** From the sign-in page through the fake Google page, back to the app. */
  async function chooseOnGoogle(page: Page, choice: string) {
    await page.goto(`${APP_ORIGIN}/`)
    await page.getByRole('link', { name: 'Sign in with Google' }).click()
    await expect(page.getByRole('heading', { name: 'Fake Google sign-in' })).toBeVisible()
    await page.getByRole('link', { name: choice }).click()
    await page.waitForURL(`${APP_ORIGIN}/**`)
  }

  const signIn = async (page: Page, who: string) => {
    await chooseOnGoogle(page, `Continue as ${who}`)
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  }
  const signInDenied = async (page: Page, who: string) => {
    await chooseOnGoogle(page, `Continue as ${who}`)
    await expect(page.getByText(NOT_APPROVED)).toBeVisible()
  }

  const openSettings = async (page: Page) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings & Backup' }).click()
    await expect(page.getByRole('heading', { name: 'Settings & Backup' })).toBeVisible()
  }

  const requestCard = (page: Page, email: string) => page.locator('[data-testid^="request-"]').filter({ hasText: email })
  const userRow = (page: Page, name: string) => page.locator('[data-testid^="user-"]').filter({ hasText: name })

  async function approve(page: Page, email: string, role: 'Owner' | 'Researcher') {
    await requestCard(page, email).getByRole('button', { name: /as new user/ }).click()
    await page.getByRole('alertdialog').getByLabel('Role').selectOption({ label: role })
    await page.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByText(/can now sign in as/)).toBeVisible()
  }

  const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

  test.beforeAll(async () => {
    mkdirSync(shots, { recursive: true })
    parent = mkdtempSync(join(tmpdir(), 'tg-google-e2e-'))
    port = await freePort()
    child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        'dist-web/server/main.mjs',
        '--port',
        String(port),
        '--data-dir',
        join(parent, 'profile'),
        '--no-demo',
        '--https-host',
        APP_NAME,
        // Never read: the fake provider replaces Google. The flag must still be present.
        '--google-client',
        join(parent, 'unused-client.json'),
        '--init-lan-test-profile'
      ],
      { cwd: root, env: { ...process.env, TG_TEST_HOOKS: '1', TG_TEST_FAKE_IDENTITY: '1' } }
    )
    let output = ''
    launchUrl = await new Promise<string>((ready, fail) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const match = /http:\/\/127\.0\.0\.1:\d+\/launch\?token=[\w-]+/.exec(output)
        if (match && output.includes('Press Ctrl+C to stop')) ready(match[0])
      })
      child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
      child.once('exit', (code) => fail(new Error(`web:local exited with ${code}: ${output}`)))
    })
    front = await startHttpsFront(port)
    browser = await chromium.launch({ channel })
    hostCtx = await browser.newContext()
    contexts.push(hostCtx)
    hostPage = await hostCtx.newPage()
  })

  test.afterAll(async () => {
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)))
    await browser?.close()
    await front?.close()
    if (child && child.exitCode === null) {
      const exited = new Promise((done) => child.once('exit', done))
      child.kill()
      await exited
    }
    rmSync(parent, { recursive: true, force: true })
  })

  test('a stranger sees the sign-in page and nothing else', async () => {
    pages['stranger'] = await person('stranger')
    const page = pages['stranger']!
    await page.goto(`${APP_ORIGIN}/`)
    await expect(page.getByRole('heading', { name: 'Tracing Guatemala' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
    await expect(page.getByText(/pairing code/i)).toHaveCount(0)
    const response = await page.request.post(`${APP_ORIGIN}/api/v1/call/listClients`, { data: { args: [] } })
    expect([401, 403]).toContain(response.status())
  })

  test('unapproved people are told so; the owner approves them from Users on the host', async () => {
    pages['alex'] = await person('alex')
    pages['bea'] = await person('bea')
    await signInDenied(pages['alex']!, 'alex')
    // The reason is read once and removed from the address bar.
    expect(pages['alex']!.url()).toBe(`${APP_ORIGIN}/`)
    await expect(pages['alex']!.getByText(/notified/i)).toHaveCount(0)
    await signInDenied(pages['bea']!, 'bea')
    await pages['alex']!.screenshot({ path: join(shots, 'sign-in-not-approved.png') })

    // The owner opens the private launch link on the host's own computer.
    await hostPage.goto(launchUrl)
    await openSettings(hostPage)
    await expect(hostPage.getByRole('heading', { name: 'Users' })).toBeVisible()
    await expect(requestCard(hostPage, 'alex@example.test').getByText('Google-managed address')).toBeVisible()
    await expect(requestCard(hostPage, 'bea@example.test')).toBeVisible()
    // The name is prefilled from the request.
    await requestCard(hostPage, 'alex@example.test').getByRole('button', { name: /as new user/ }).click()
    await expect(hostPage.getByRole('alertdialog').getByLabel('Name')).toHaveValue('Alex Fictional')
    await hostPage.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
    await approve(hostPage, 'alex@example.test', 'Owner')
    await approve(hostPage, 'bea@example.test', 'Researcher')
    await expect(userRow(hostPage, 'Alex Fictional').getByText('Owner')).toBeVisible()
    await expect(userRow(hostPage, 'Bea Fictional').getByText('Researcher')).toBeVisible()
  })

  test('the owner signs in and sees Account and Users; the cookie is a host-only __Host- cookie', async () => {
    const page = pages['alex']!
    await signIn(page, 'alex')
    await expect(page.getByTestId('signed-in-person')).toContainText('Alex Fictional (Owner)')
    await openSettings(page)
    await expect(page.getByTestId('account-name')).toHaveText('Alex Fictional')
    await expect(page.getByTestId('account-role')).toHaveText('Owner')
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
    await expect(userRow(page, 'Bea Fictional')).toBeVisible()
    await page.screenshot({ path: join(shots, 'owner-account-users.png'), fullPage: true })

    const cookies = (await page.context().cookies()).filter((cookie) => cookie.name === '__Host-tg_session')
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', domain: APP_NAME, path: '/' })
    expect(cookies[0]!.domain.startsWith('.')).toBe(false)
  })

  test('declined Google sign-in says so and changes nothing', async () => {
    const page = await person('declined')
    await page.goto(`${APP_ORIGIN}/`)
    await page.getByRole('link', { name: 'Sign in with Google' }).click()
    await page.getByRole('link', { name: 'Cancel' }).click()
    await expect(page.getByText('Sign-in was cancelled.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible()
    expect(page.url()).toBe(`${APP_ORIGIN}/`)
  })

  test('a new person asks, the owner approves, and a researcher has no Users section', async () => {
    pages['cara'] = await person('cara')
    await signInDenied(pages['cara']!, 'cara')

    const owner = pages['alex']!
    await owner.reload()
    await openSettings(owner)
    await expect(requestCard(owner, 'cara@example.test')).toBeVisible()
    await approve(owner, 'cara@example.test', 'Researcher')

    const cara = pages['cara']!
    await signIn(cara, 'cara')
    await expect(cara.getByTestId('signed-in-person')).toContainText('Cara Fictional (Researcher)')
    await openSettings(cara)
    await expect(cara.getByTestId('account-role')).toHaveText('Researcher')
    await expect(cara.getByRole('heading', { name: 'Users' })).toHaveCount(0)
    await expect(cara.getByRole('button', { name: 'Sign out on all devices' })).toBeVisible()
    await cara.screenshot({ path: join(shots, 'researcher-account.png'), fullPage: true })
    // The server is the control: a researcher is refused even when the call is made by hand.
    const csrf = (await (await cara.request.get(`${APP_ORIGIN}/api/v1/session`)).json()).csrfToken as string
    const refused = await cara.request.post(`${APP_ORIGIN}/api/v1/call/listUsers`, {
      data: { args: [] },
      headers: { 'X-TG-CSRF': csrf, Origin: APP_ORIGIN }
    })
    expect(refused.status()).toBe(403)
  })

  test('turning someone off ends their open session on the next action', async () => {
    const bea = pages['bea']!
    await signIn(bea, 'bea')
    await expect(bea.getByTestId('signed-in-person')).toContainText('Bea Fictional (Researcher)')

    const owner = pages['alex']!
    await userRow(owner, 'Bea Fictional').getByRole('button', { name: 'Turn off Bea Fictional' }).click()
    await owner.getByRole('alertdialog').getByRole('button', { name: 'Turn off' }).click()
    await expect(userRow(owner, 'Bea Fictional').getByText('Turned off')).toBeVisible()

    // Bea's page is still open; her next request is refused and she lands on sign-in.
    await bea.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Cases' }).click()
    await expect(bea.getByText('Your session ended. Sign in again.')).toBeVisible()
    await expect(bea.getByRole('link', { name: 'Sign in with Google' })).toBeVisible()
    await bea.screenshot({ path: join(shots, 'session-ended.png') })

    // Signing in again says the account is turned off, and nothing about anyone else.
    await chooseOnGoogle(bea, 'Continue as bea')
    await expect(bea.getByText('This account has been turned off.', { exact: false })).toBeVisible()

    // Turning her back on restores access.
    await userRow(owner, 'Bea Fictional').getByRole('button', { name: 'Turn Bea Fictional back on' }).click()
    await expect(userRow(owner, 'Bea Fictional').getByText('Active')).toBeVisible()
    await signIn(bea, 'bea')
  })

  test('the last owner cannot be removed', async () => {
    const owner = pages['alex']!
    await userRow(owner, 'Alex Fictional').getByRole('button', { name: 'Make Alex Fictional a researcher' }).click()
    await owner.getByRole('alertdialog').getByRole('button', { name: 'Make researcher' }).click()
    await expect(owner.getByText('You can’t remove the last active owner. Make someone else an owner first.')).toBeVisible()
    await expect(userRow(owner, 'Alex Fictional').getByText('Owner')).toBeVisible()
  })

  test('sign out returns to sign-in and Back does not restore access', async () => {
    const page = pages['cara']!
    await page.goto(`${APP_ORIGIN}/#/clients`)
    await openSettings(page)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
    const response = await page.request.post(`${APP_ORIGIN}/api/v1/call/listClients`, { data: { args: [] } })
    expect([401, 403]).toContain(response.status())
    expect((await page.context().cookies()).filter((cookie) => cookie.name === '__Host-tg_session')).toHaveLength(0)
  })

  test('sign out on all devices ends every session of that person', async () => {
    const first = pages['bea']!
    const second = await person('bea-second')
    await signIn(second, 'bea')
    await openSettings(first)
    await first.getByRole('button', { name: 'Sign out on all devices' }).click()
    await first.getByRole('alertdialog').getByRole('button', { name: 'Sign out everywhere' }).click()
    await expect(first.getByRole('link', { name: 'Sign in with Google' })).toBeVisible()
    await second.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Cases' }).click()
    await expect(second.getByText('Your session ended. Sign in again.')).toBeVisible()
  })

  test('works on a phone-sized screen', async () => {
    const phone = { width: 390, height: 844 }
    const page = await person('phone', phone)
    await page.goto(`${APP_ORIGIN}/`)
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible()
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: join(shots, 'mobile-sign-in.png') })

    await signIn(page, 'alex')
    await openSettings(page)
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
    await expect(userRow(page, 'Cara Fictional')).toBeVisible()
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    await page.getByRole('heading', { name: 'Users' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, 'mobile-users.png') })
  })
})
