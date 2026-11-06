import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

// Public demo artifact (#191, #192): dist-demo/ exactly as GitHub Pages will serve
// it, at its real origin and base path. Playwright answers that origin from the
// built files and aborts *every* other request, so nothing ever reaches the
// network, and each attempt is recorded and fails the test. No server, no port.

const ORIGIN = 'https://krunchymonkey.github.io'
const BASE = `${ORIGIN}/tracing-guatemala-desktop/`
const dist = resolve(__dirname, '../../dist-demo')
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }
const ids = {
  daniel: 'de300000-0000-4000-8000-000000000002',
  paternal: 'de300000-0000-4000-8000-200000000001'
}

async function servePages(context: BrowserContext): Promise<{ outside: string[]; served: string[] }> {
  const outside: string[] = []
  const served: string[] = []
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/tracing-guatemala-desktop/') || route.request().method() !== 'GET') {
      outside.push(`${route.request().method()} ${url.href}`)
      return route.abort('blockedbyclient')
    }
    const rel = url.pathname.slice('/tracing-guatemala-desktop/'.length) || 'index.html'
    const file = join(dist, rel)
    if (!file.startsWith(dist) || !existsSync(file)) {
      served.push(`404 ${rel}`)
      return route.fulfill({ status: 404, body: 'Not found' })
    }
    served.push(rel)
    return route.fulfill({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
  })
  return { outside, served }
}

function watchProblems(page: Page): string[] {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  return problems
}

const storageState = (page: Page) =>
  page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length
  }))

test.skip(!existsSync(join(dist, 'index.html')), 'run `npm run demo:build` first')

test('serves the fictional demo at its GitHub Pages path with no other requests, no storage and a refresh reset', async ({ context, page }) => {
  const net = await servePages(context)
  const problems = watchProblems(page)

  await page.goto(BASE)
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await page.goto(`${BASE}#/clients`)
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
  await page.locator('label').filter({ hasText: /^All$/ }).click()
  await expect(page.locator('.result-count')).toHaveText(/^48 clients · /)
  await page.getByLabel('Search clients').fill('ixchel')
  await page.getByRole('link', { name: 'Ixchel Barrios Mencos' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ixchel Barrios Mencos' })).toBeVisible()

  // A multi-step fictional workflow: create a case under a client, then add a journal entry to another case.
  await page.goto(`${BASE}#/clients/${ids.daniel}`)
  await page.getByRole('link', { name: 'New case' }).click()
  await page.getByLabel(/^Title/).fill('Public demo: parish records search')
  await page.getByLabel(/^Requested outcome/).fill('Find the parish where the family was baptized.')
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Public demo: parish records search' })).toBeVisible()

  await page.goto(`${BASE}#/cases/${ids.paternal}`)
  const journal = page.getByRole('region', { name: 'Research journal' })
  const entries = journal.getByRole('list', { name: 'Journal entries, newest first' }).getByRole('listitem')
  await expect(entries).toHaveCount(3)
  await journal.getByLabel('What you did or found').fill('Entry added in the public demo.')
  await journal.getByRole('button', { name: 'Add entry' }).click()
  await expect(entries).toHaveCount(4)
  await expect(page.getByRole('region', { name: 'Research notebook' })).toBeVisible()

  // Everything stayed in memory.
  expect(await storageState(page)).toEqual({ local: 0, session: 0, cookie: '', databases: 0 })

  // Refresh: back to the fictional seed.
  await page.reload()
  await expect(entries).toHaveCount(3)
  await expect(journal.getByText('Entry added in the public demo.')).toHaveCount(0)
  await page.goto(`${BASE}#/cases`)
  await expect(page.getByRole('link', { name: 'Public demo: parish records search' })).toHaveCount(0)

  expect(net.outside).toEqual([])
  expect(net.served.filter((s) => s.startsWith('404'))).toEqual([])
  expect(problems).toEqual([])
})

test('cannot reach the Live API, the private Live host or any other origin, even when page code tries', async ({ context, page }) => {
  const net = await servePages(context)
  await page.goto(`${BASE}#/clients`)
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()

  const attempts = await page.evaluate(async () => {
    const tryFetch = async (url: string) => {
      try {
        await fetch(url, { credentials: 'include' })
        return 'reached'
      } catch {
        return 'blocked'
      }
    }
    const trySocket = (url: string) =>
      new Promise<string>((done) => {
        try {
          const socket = new WebSocket(url)
          socket.onopen = () => done('reached')
          socket.onerror = () => done('blocked')
        } catch {
          done('blocked')
        }
      })
    return {
      sameOriginApi: await tryFetch('/api/v1/listClients'),
      feedbackRelay: await tryFetch('/__feedback/status'),
      privateLive: await tryFetch('https://tg.krunchymonkey.dev/api/v1/listClients'),
      loopbackLive: await tryFetch('http://127.0.0.1:4190/api/v1/listClients'),
      socket: await trySocket('wss://tg.krunchymonkey.dev/'),
      // sendBeacon only queues; CSP drops the send itself, checked below via the router.
      beacon: (navigator.sendBeacon('https://tg.krunchymonkey.dev/', 'x'), 'attempted')
    }
  })
  expect(attempts).toEqual({ sameOriginApi: 'blocked', feedbackRelay: 'blocked', privateLive: 'blocked', loopbackLive: 'blocked', socket: 'blocked', beacon: 'attempted' })
  // CSP stopped every one in the browser; none, including the beacon, ever reached the router.
  await page.waitForTimeout(1000)
  expect(net.outside).toEqual([])

  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  expect(csp).toContain("connect-src 'none'")
  expect(csp).toContain("default-src 'none'")
})

test('harness self-check: with CSP bypassed, an outside request is caught and recorded by the router', async ({ browser }) => {
  const context = await browser.newContext({ bypassCSP: true })
  const net = await servePages(context)
  const page = await context.newPage()
  await page.goto(`${BASE}#/clients`)
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
  const result = await page.evaluate(() => fetch('https://tg.krunchymonkey.dev/api/v1/listClients').then(() => 'reached', () => 'blocked'))
  expect(result).toBe('blocked')
  expect(net.outside).toEqual(['GET https://tg.krunchymonkey.dev/api/v1/listClients'])
  await context.close()
})

test('offers no link to Live and only copy-only feedback', async ({ context, page }) => {
  const net = await servePages(context)
  await page.goto(`${BASE}#/clients`)
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
  await expect(page.getByText('Live mode opens only on the researcher’s own computer.')).toBeAttached()
  const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((a) => (a as HTMLAnchorElement).href))
  for (const href of hrefs) {
    expect(href.startsWith(BASE) || href.startsWith('https://github.com/') || href.startsWith('mailto:'), href).toBe(true)
  }

  await page.getByRole('button', { name: 'Send feedback' }).click()
  const dialog = page.getByRole('dialog', { name: 'Send feedback' })
  await expect(dialog.getByRole('button', { name: 'Copy feedback' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Submit feedback' })).toHaveCount(0)
  expect(net.outside).toEqual([])
})

for (const viewport of [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 }
]) {
  test(`fits a ${viewport.name} (${viewport.width}px) at the Pages path without sideways scrolling`, async ({ context, page }) => {
    const net = await servePages(context)
    await page.setViewportSize(viewport)
    for (const route of ['#/clients', `#/cases/${ids.paternal}`]) {
      await page.goto(`${BASE}${route}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    }
    expect(net.outside).toEqual([])
  })
}
