import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The browser demo (#100), served from dist-demo/ by `npm run demo:lan`
// (scripts/demo-lan.mjs) itself. It binds to one of this computer's private LAN
// addresses when there is one, so the page is a real non-secure HTTP origin (no
// crypto.randomUUID). Without one it falls back to 127.0.0.1 and the LAN-only
// test is skipped. Screenshots for the PR are opt-in:
//   npm run demo:build && CAPTURE_SCREENSHOTS=1 npx playwright test --project browser-demo

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
const lanAddress =
  process.env['DEMO_E2E_HOST'] ??
  Object.values(networkInterfaces())
    .flat()
    .find((a) => a?.family === 'IPv4' && PRIVATE_IPV4.test(a.address))?.address
const host = lanAddress ?? '127.0.0.1'
const port = Number(process.env['DEMO_E2E_PORT'] ?? 4183)
const root = resolve(__dirname, '../..')
const shotsDir = join(root, 'docs/screenshots/issue-100')
const switchShotsDir = join(root, 'docs/screenshots/issue-114')
const capture = Boolean(process.env['CAPTURE_SCREENSHOTS'])
const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/

const server = { url: `http://${host}:${port}/` }
let child: ChildProcess

test.beforeAll(async () => {
  child = spawn(process.execPath, ['scripts/demo-lan.mjs', '--host', host, '--port', String(port)], { cwd: root })
  let output = ''
  await new Promise<void>((ready, fail) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('Press Ctrl+C to stop')) ready()
    })
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.once('exit', (code) => fail(new Error(`demo:lan exited with ${code}: ${output}`)))
  })
  expect(output).toContain(`${server.url}#/clients`)
})

test.afterAll(() => {
  child?.kill()
})

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()

async function addClient(page: Page, name: string) {
  await page.goto(`${server.url}#/clients/new`)
  await page.getByLabel(/^Name/).fill(name)
  await pick(page, 'Direct')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

test('serves the shared UI over plain HTTP, with no Electron bridge and no other origins', async ({ page }) => {
  const origins = new Set<string>()
  page.on('request', (request) => origins.add(new URL(request.url()).origin))
  page.on('websocket', (ws) => origins.add(new URL(ws.url()).origin))

  const response = await page.goto(`${server.url}#/clients`)
  expect(page.url()).toBe(`http://${host}:${port}/#/clients`)
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'none'")

  await expect(page.getByRole('region', { name: 'Demo mode' })).toContainText('Demo Mode — Fictional Data Only')
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
  await expect(page.getByText('43 active · 5 archived')).toBeVisible()
  expect(await page.evaluate(() => 'tracingGuatemala' in window)).toBe(false)

  await nav(page).getByRole('link', { name: 'Settings & Backup' }).click()
  await expect(page.getByText(/only available in the desktop app/)).toBeVisible()
  await expect(page.getByRole('button', { name: /backup/i })).toHaveCount(0)
  await expect(page.getByTestId('app-version')).toHaveText(/^Tracing Guatemala browser demo version \d+\.\d+\.\d+$/)

  expect([...origins]).toEqual([`http://${host}:${port}`])
})

test('keeps roadmap links locked and preserves working navigation', async ({ page }) => {
  await page.goto(server.url)
  const navigation = nav(page)
  await expect(navigation.getByRole('heading', { name: /Coming soon/i })).toBeVisible()

  for (const [label, phase] of [
    ['Evidence Library', 3],
    ['Document AI', 4],
    ['Client Reports', 5],
    ['Family Trees', 6],
    ['Research Copilot', 7],
    ['Integrations', 8],
    ['Business Tools', 9]
  ] as const) {
    const placeholder = navigation.getByRole('button', { name: `${label}, coming soon in Phase ${phase}` })
    await expect(placeholder).toBeDisabled()
    await expect(placeholder.locator('svg')).toBeVisible()
    await expect(navigation.getByRole('link', { name: label, exact: true })).toHaveCount(0)
  }

  await navigation.getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
})

test('creates clients with v4 UUIDs on a non-secure LAN origin', async ({ page }) => {
  test.skip(!lanAddress, 'No private LAN address on this computer; the next test still covers the UUID fallback.')
  await page.goto(server.url)
  expect(await page.evaluate(() => [window.isSecureContext, typeof crypto.randomUUID])).toEqual([false, 'undefined'])

  await addClient(page, 'Valeria Pop')
  expect(page.url()).toMatch(new RegExp(`#/clients/${UUID_V4.source}$`))
})

test('creates clients with v4 UUIDs when crypto.randomUUID is missing on any origin', async ({ page }) => {
  await page.addInitScript(() => {
    delete (Crypto.prototype as Partial<Crypto>).randomUUID
  })
  await addClient(page, 'Valeria Pop')
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined')
  expect(page.url()).toMatch(new RegExp(`#/clients/${UUID_V4.source}$`))
})

test('walks through search, notes, duplicates and archive/restore, then resets on refresh', async ({ page }) => {
  await page.goto(`${server.url}#/clients`)

  // Directory search (accent-insensitive) and filters.
  await page.getByLabel('Search clients').fill('lucia')
  await expect(page.locator('.result-count')).toHaveText(/^1 client · /)
  await page.getByRole('button', { name: 'Clear search and filters' }).click()
  await pick(page, 'Referral')
  await expect(page.getByRole('link', { name: 'María José Alvarado' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Daniel Ochoa' })).toHaveCount(0)
  await pick(page, 'Archived')
  await expect(page.getByRole('link', { name: 'Rosa Chávez Ixcoy' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search and filters' }).click()

  // Profile, notes and contact entries.
  await page.getByRole('link', { name: 'Lucía Fernández (Quetzaltenango line)' }).click()
  const history = page.getByRole('region', { name: 'Notes & contact history' })
  await expect(history.getByText(/civil registry index/)).toBeVisible()
  await history.getByLabel('Your note').fill('Demo note: asked for the grandparents’ town.')
  await history.getByRole('button', { name: 'Add note' }).click()
  await expect(history.getByText('Demo note: asked for the grandparents’ town.')).toBeVisible()

  // Edit details.
  await page.getByRole('link', { name: 'Edit details' }).click()
  await page.getByLabel(/^Email/).fill('lucia.demo@example.com')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Changes saved.')).toBeVisible()

  // Duplicate advisory (advisory only: saving anyway works).
  await page.goto(`${server.url}#/clients/new`)
  await page.getByLabel(/^Name/).fill('daniel ochoa')
  await pick(page, 'Fiverr')
  await page.getByRole('button', { name: 'Save client' }).click()
  const advisory = page.getByRole('alert').filter({ hasText: 'This might be someone you already have' })
  await expect(advisory.getByText('Daniel Ochoa')).toBeVisible()
  await advisory.getByRole('button', { name: 'Save as a new client anyway' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'daniel ochoa' })).toBeVisible()

  // Archive (read-only profile) and restore.
  await page.getByRole('button', { name: 'Archive' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Archive client' }).click()
  await expect(page.getByText(/This profile is read-only/)).toBeVisible()
  await page.getByRole('button', { name: 'Restore client' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore client' }).click()
  await expect(page.getByText('Client restored.')).toBeVisible()

  await nav(page).getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByText('44 active · 5 archived')).toBeVisible()

  // Refresh: back to the documented sample set.
  await page.reload()
  await expect(page.getByText('43 active · 5 archived')).toBeVisible()
  await expect(page.getByRole('link', { name: 'daniel ochoa', exact: true })).toHaveCount(0)
  await page.getByRole('link', { name: 'Lucía Fernández (Quetzaltenango line)' }).click()
  await expect(page.getByRole('region', { name: 'Contact' }).getByText('lucia.fernandez@example.com')).toBeVisible()
  await expect(page.getByText('Demo note: asked for the grandparents’ town.')).toHaveCount(0)
})

const viewports = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 }
]

for (const viewport of viewports) {
  test(`fits a ${viewport.name} screen (${viewport.width}px) without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const routes = [
      ['home', ''],
      ['directory', '#/clients'],
      ['profile', '#/clients/de300000-0000-4000-8000-000000000001'],
      ['archived-profile', '#/clients/de300000-0000-4000-8000-000000000008'],
      ['form', '#/clients/new'],
      ['settings', '#/settings']
    ] as const

    for (const [name, hash] of routes) {
      await page.goto(`${server.url}${hash}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Demo mode' })).toBeVisible()
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow, `${name} overflows by ${overflow}px`).toBeLessThanOrEqual(0)
      if (capture) await page.screenshot({ path: join(shotsDir, `${viewport.name}-${name}.png`), fullPage: true })
    }

    // Main navigation stays reachable at every width.
    await nav(page).getByRole('link', { name: 'Clients' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
    await page.getByRole('link', { name: 'Grace Whitfield' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Grace Whitfield' })).toBeVisible()
  })
}

// Switching to Live (#114): the link is offered only when the demo page itself
// is on the researcher's computer. A phone or tablet on the LAN must never get a
// link to "its own" localhost, whatever the address bar says.
test('on the LAN address, never links to Live, even when asked to with ?live=4180', async ({ page }) => {
  test.skip(!lanAddress, 'No private LAN address on this computer; the unit tests cover every hostname.')
  await page.goto(`${server.url}?live=4180#/clients`)
  await expect(page.getByRole('region', { name: 'Workspace mode' })).toContainText('Demo · fictional, resets on refresh')
  await expect(page.getByText('Live mode opens only on the researcher’s own computer.')).toBeVisible()
  await expect(page.getByRole('link', { name: /Back to Live/ })).toHaveCount(0)
  const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''))
  expect(hrefs.filter((href) => ['http://127.', 'http://localhost', 'http://[::1]'].some((prefix) => href.toLowerCase().startsWith(prefix)))).toEqual([])
  expect(await page.locator('[href^="http://127.0.0.1"], [href^="http://localhost"]').count()).toBe(0)

  // Navigating inside the demo keeps it that way.
  await nav(page).getByRole('link', { name: 'Settings & Backup' }).click()
  await expect(page.getByText('Live mode opens only on the researcher’s own computer.')).toBeVisible()
  if (capture) {
    mkdirSync(switchShotsDir, { recursive: true })
    await page.screenshot({ path: join(switchShotsDir, 'lan-demo-live-unavailable.png') })
  }
})

test('without a usable live port, the demo says Live is not running on this computer and offers no link', async ({ page }) => {
  test.skip(lanAddress !== undefined, 'Needs the loopback fallback; this computer has a LAN address, which the test above covers.')
  await page.goto(`${server.url}#/clients`)
  await expect(page.getByText('Start Tracing Guatemala on this computer to use Live.')).toBeVisible()
  await expect(page.getByRole('link', { name: /Back to Live/ })).toHaveCount(0)
})

// ---------- 48-client fictional portfolio (#115) ----------

test('lists the 48 fictional clients, finds one by search, and opens it', async ({ page }) => {
  await page.goto(`${server.url}#/clients`)
  await pick(page, 'All')
  await expect(page.locator('.result-count')).toHaveText(/^48 clients · /)

  await page.getByRole('button', { name: 'Clear search and filters' }).click()
  await page.getByLabel('Search clients').fill('ixchel')
  await expect(page.locator('.result-count')).toHaveText(/^1 client · /)
  await page.getByRole('link', { name: 'Ixchel Barrios Mencos' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ixchel Barrios Mencos' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Contact' }).getByText('ixchel.barrios@example.com')).toBeVisible()
})

test('fits the full 48-client directory on a phone (375px) without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(`${server.url}#/clients`)
  await pick(page, 'All')
  await expect(page.locator('.result-count')).toHaveText(/^48 clients · /)
  await expect(page.getByRole('region', { name: 'Demo mode' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, `directory overflows by ${overflow}px`).toBeLessThanOrEqual(0)
})

test('keeps demo code and sample data out of the desktop bundle', () => {
  const assets = resolve(__dirname, '../../out/renderer/assets')
  const bundle = readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(assets, f), 'utf8'))
    .join('\n')
  expect(bundle).toContain('Settings & Backup')
  for (const marker of ['Tracing Guatemala browser demo', 'de300000-0000-4000', 'Lucía Fernández', 'getRandomValues']) {
    expect(bundle).not.toContain(marker)
  }
})

// ---------- research cases (#16) ----------

const casesShotsDir = join(root, 'docs/screenshots/issue-16')
const demoIds = {
  lucia: 'de300000-0000-4000-8000-000000000001',
  daniel: 'de300000-0000-4000-8000-000000000002',
  paternal: 'de300000-0000-4000-8000-200000000001',
  maternal: 'de300000-0000-4000-8000-200000000002',
  secondBranch: 'de300000-0000-4000-8000-200000000005',
  reunion: 'de300000-0000-4000-8000-200000000006'
}
const overflowOf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

test('walks through cases: filter, open, change state, create under a client, then resets on refresh', async ({ page }) => {
  await page.goto(`${server.url}#/clients`)
  await nav(page).getByRole('link', { name: 'Cases' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Cases' })).toBeVisible()
  await expect(page.locator('.result-count')).toHaveText('28 cases')
  await expect(page.getByText('Overdue')).toHaveCount(5)

  // Filter by state group, archived flag and client.
  await pick(page, 'Closed')
  await expect(page.locator('.result-count')).toHaveText(/^9 cases · /)
  await pick(page, 'Archived')
  await expect(page.getByRole('link', { name: 'Short family history for a reunion' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search and filters' }).click()
  await page.getByLabel('Client', { exact: true }).selectOption({ label: 'Daniel Ochoa' })
  await expect(page.locator('.result-count')).toHaveText(/^1 case · /)
  await page.getByRole('button', { name: 'Clear search and filters' }).click()

  // Open a case and change its state; delivered asks first.
  await page.getByRole('link', { name: 'Paternal line — Quetzaltenango, 1880s' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /Paternal line/ })).toBeVisible()
  await page.getByRole('button', { name: 'Waiting on someone' }).click()
  await expect(page.getByText('Case is now waiting.')).toBeVisible()
  await page.getByRole('button', { name: 'Mark delivered' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Mark delivered' }).click()
  await expect(page.getByText('Case is now delivered.')).toBeVisible()
  const history = page.getByRole('region', { name: 'History' })
  await expect(history.getByText('Marked delivered')).toBeVisible()
  await expect(history.getByText('Waiting on someone')).toBeVisible()

  // Create a case under a client from its profile.
  await page.goto(`${server.url}#/clients/${demoIds.daniel}`)
  await page.getByRole('link', { name: 'New case' }).click()
  await page.getByLabel(/^Title/).fill('Demo: parish records search')
  await page.getByLabel(/^Requested outcome/).fill('Find the parish where the family was baptized.')
  await page.getByRole('button', { name: 'Create case' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Demo: parish records search' })).toBeVisible()
  await expect(page.getByText('Case created.')).toBeVisible()

  await page.goto(`${server.url}#/cases`)
  await expect(page.getByRole('link', { name: 'Demo: parish records search' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Paternal line — Quetzaltenango, 1880s' })).toHaveCount(0) // delivered cases leave the Open list

  // Refresh: back to the documented sample set.
  await page.reload()
  await expect(page.locator('.result-count')).toHaveText('28 cases')
  await expect(page.getByRole('link', { name: 'Demo: parish records search' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Paternal line — Quetzaltenango, 1880s' }).click()
  await expect(page.locator('.state-now')).toContainText('Active')
})

test('locks a client’s cases in the demo when the client is archived', async ({ page }) => {
  await page.goto(`${server.url}#/clients/${demoIds.lucia}`)
  await page.getByRole('button', { name: 'Archive' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Archive client' }).click()
  await expect(page.getByText(/This profile is read-only/)).toBeVisible()
  await expect(page.getByText('Restore this client to start a new case')).toBeVisible()
  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)
  await expect(page.getByText(/Their cases are read-only/)).toBeVisible()
  await expect(page.getByRole('group', { name: 'Change state' })).toHaveCount(0)
})

for (const viewport of viewports) {
  test(`fits case screens on a ${viewport.name} (${viewport.width}px) without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const routes = [
      ['cases', '#/cases?state=all'],
      ['case', `#/cases/${demoIds.maternal}`],
      ['case-archived', `#/cases/${demoIds.reunion}`],
      ['case-brief-form', `#/cases/${demoIds.paternal}/brief`],
      ['case-form', `#/cases/new?client=${demoIds.daniel}`],
      ['profile-cases', `#/clients/${demoIds.lucia}`]
    ] as const
    for (const [name, hash] of routes) {
      await page.goto(`${server.url}${hash}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.locator('table, .card, form').first()).toBeVisible()
      expect(await overflowOf(page), `${name} overflows`).toBeLessThanOrEqual(0)
    }
  })
}

test('captures the demo case list for the PR', async ({ page }) => {
  test.skip(!capture, 'Screenshots are opt-in: CAPTURE_SCREENSHOTS=1')
  for (const viewport of [viewports[2]!, viewports[0]!]) {
    await page.setViewportSize(viewport)
    await page.goto(`${server.url}#/cases?state=all`)
    await expect(page.locator('.result-count')).toBeVisible()
    await page.screenshot({ path: join(casesShotsDir, `demo-${viewport.name}-case-list.png`), fullPage: true })
  }
})

test('shows a seeded fictional research brief, lets it be edited, and a refresh resets the edit', async ({ page }) => {
  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)
  const brief = page.getByRole('region', { name: 'Research brief' })
  await expect(brief.getByRole('heading', { name: 'Known facts (as reported)' })).toBeVisible()
  await expect(brief).toContainText('Teodoro Ejemplo')
  await expect(brief.locator('.brief-hypotheses')).toContainText('Hypothesis — not established')

  await brief.getByRole('link', { name: 'Edit brief' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Research brief' })).toBeVisible()
  await page.getByLabel(/^Open questions/).fill('A question added in the demo?')
  await page.getByRole('button', { name: 'Save brief' }).click()
  await expect(page.getByText('Brief saved.')).toBeVisible()
  await expect(brief.locator('.brief-questions .brief-text')).toHaveText('A question added in the demo?')

  // Refresh: back to the documented sample set.
  await page.reload()
  await expect(brief.locator('.brief-questions .brief-text')).toContainText('Which parish covered the village')
  await expect(brief.getByText('A question added in the demo?')).toHaveCount(0)

  // A case without a seeded brief shows the empty state.
  await page.goto(`${server.url}#/cases/${demoIds.secondBranch}`)
  await expect(page.getByRole('region', { name: 'Research brief' }).getByText('No research brief yet.')).toBeVisible()
})

test('shows a seeded fictional research journal, lets an entry be added, and a refresh resets it', async ({ page }) => {
  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)
  const journal = page.getByRole('region', { name: 'Research journal' })
  const list = journal.getByRole('list', { name: 'Journal entries, newest first' })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(list.getByRole('listitem').first()).toContainText('Client communication')
  await expect(journal).toContainText('diocesan index')
  await expect(journal).toContainText('separate from the client’s notes and contact history')

  // Another case of the same client has its own entries.
  await page.goto(`${server.url}#/cases/${demoIds.maternal}`)
  await expect(journal.getByRole('listitem')).toHaveCount(2)
  await expect(journal).not.toContainText('diocesan index')

  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)
  await journal.getByLabel('Activity (optional)').fill('Record analysis')
  await journal.getByLabel('What you did or found').fill('An entry added in the demo.')
  await journal.getByRole('button', { name: 'Add entry' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(4)
  await expect(list.getByRole('listitem').first()).toContainText('An entry added in the demo.')

  // Refresh: back to the documented sample set.
  await page.reload()
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(journal.getByText('An entry added in the demo.')).toHaveCount(0)

  // A case without seeded entries shows the empty state.
  await page.goto(`${server.url}#/cases/${demoIds.secondBranch}`)
  await expect(journal.getByText('No journal entries yet.')).toBeVisible()
})

test('shows seeded fictional next steps including an overdue one, lets one be completed, and a refresh resets it', async ({ page }) => {
  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)
  const steps = page.getByRole('region', { name: 'Next steps' })
  const open = steps.getByRole('list', { name: 'Open next steps' }).getByRole('listitem')
  await expect(open).toHaveCount(5)
  await expect(open.first()).toContainText('Ask the client for the photograph and letters')
  await expect(open.first()).toContainText('Overdue by 2 days')
  await expect(open.nth(1)).toContainText('Due today')
  await expect(open.nth(2)).toContainText('Due in 2 days')
  await expect(open.nth(4)).toContainText('No deadline')
  await expect(steps.getByText('Completed (1)')).toBeVisible()

  // Another case has its own steps.
  await page.goto(`${server.url}#/cases/${demoIds.maternal}`)
  await expect(open).toHaveCount(2)
  await expect(steps).not.toContainText('photograph')

  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)
  await open.first().getByRole('button', { name: /^Mark done:/ }).click()
  await expect(open).toHaveCount(4)
  await expect(steps.getByText('Completed (2)')).toBeVisible()
  await expect(steps.getByText('Overdue by 2 days')).toHaveCount(0)

  // Refresh: back to the documented sample set.
  await page.reload()
  await expect(open).toHaveCount(5)
  await expect(steps.getByText('Completed (1)')).toBeVisible()
  await expect(open.first()).toContainText('Overdue by 2 days')

  // A case without seeded steps shows the empty state.
  await page.goto(`${server.url}#/cases/${demoIds.secondBranch}`)
  await expect(steps.getByText('No next steps yet.')).toBeVisible()
})

test('exports a fictional case summary as a file under the demo CSP, without contact details or requests', async ({ page }) => {
  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)
  const requests: string[] = []
  page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`))
  await page.getByRole('button', { name: 'Export summary…' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('The file is not encrypted.')
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()])

  expect(download.suggestedFilename()).toMatch(/^case-summary-paternal-line-quetzaltenango-1880s-\d{4}-\d{2}-\d{2}\.md$/)
  const text = readFileSync((await download.path())!, 'utf8')
  expect(text.split('\n').slice(0, 3)).toEqual(['# Case summary: Paternal line — Quetzaltenango, 1880s', '', 'Fictional demo data — not a real client.'])
  expect(text).toContain('- Client: Lucía Fernández (Quetzaltenango line)')
  expect(text).toContain('Compare spelling variants of the surname')
  expect(text).not.toContain('@example.')
  expect(text).not.toContain('lucia_roots_demo')
  expect(text).not.toContain('Maternal grandparents')
  expect(requests.filter((request) => !request.includes(`http://${host}:${port}/`) || !request.startsWith('GET'))).toEqual([])
})

test('shows seeded fictional research hours, runs an in-memory timer, writes nothing to browser storage, and a refresh resets it', async ({ page }) => {
  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)
  const hours = page.getByRole('region', { name: 'Research hours' })
  const entries = hours.getByRole('list', { name: 'Hours entries' }).getByRole('listitem')
  const pill = page.getByRole('region', { name: 'Research timer' })
  const total = hours.getByText('Total hours').locator('xpath=following-sibling::dd')

  await expect(entries).toHaveCount(4)
  await expect(total).toHaveText('7:30')
  await expect(entries.first()).toContainText('1:30')
  await expect(entries.first()).toContainText('Research')
  await expect(hours).toContainText('Nothing here is billed or sent to anyone')
  await expect(pill).toHaveCount(0)

  // Another case has its own, separate hours.
  await page.goto(`${server.url}#/cases/${demoIds.maternal}`)
  await expect(total).toHaveText('1:50')
  await expect(entries).toHaveCount(2)
  await page.goto(`${server.url}#/cases/${demoIds.secondBranch}`)
  await expect(hours.getByText('No hours recorded yet.')).toBeVisible()

  // The timer runs in memory and follows the person across screens.
  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)
  await hours.getByRole('button', { name: 'Start timer' }).click()
  await expect(pill.getByText('Running')).toBeVisible()
  await pill.getByRole('button', { name: /^Pause timer on/ }).click()
  await expect(pill.getByText('Paused')).toBeVisible()
  await page.goto(`${server.url}#/clients`)
  await expect(pill).toBeVisible()
  await page.goto(`${server.url}#/cases/${demoIds.paternal}`)

  // A manual entry works too.
  const form = hours.getByRole('form', { name: 'Add hours by hand' })
  await form.getByLabel('Minutes').fill('30')
  await form.getByRole('button', { name: 'Add entry' }).click()
  await expect(entries).toHaveCount(5)
  await expect(total).toHaveText('8:00')

  // Nothing is kept in the browser, and the guidance on the banner stays truthful.
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0)
  expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0)
  await expect(page.getByRole('region', { name: 'Demo mode' })).toContainText('reset when you refresh')

  // Refresh: back to the documented sample set, and no timer.
  await page.reload()
  await expect(entries).toHaveCount(4)
  await expect(total).toHaveText('7:30')
  await expect(pill).toHaveCount(0)
})
