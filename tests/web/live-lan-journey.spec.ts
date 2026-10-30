import { readFileSync } from 'node:fs'
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { channel, cleanupHosts, freePort, lanIp, startHost, stop, type Host } from './lan-helpers'

// The Phase 2.5 acceptance journey (#138): one paired device on this computer's own
// private address does the whole researcher workflow of Phase 2 over plain HTTP LAN,
// then logout, revoke, a browser restart and a host restart. One host and one
// profile for the whole journey. Skipped when the machine has no private IPv4
// address. Fictional data only. The address is discovered at run time.
//
// Limits: the device and the host share one machine, so this proves the app's LAN
// behaviour, not network isolation or real Wi-Fi (see docs/pilot/phase-2.5-lan-validation.md).

test.skip(!lanIp, 'This machine has no private IPv4 address.')
test.afterAll(cleanupHosts)

const CLIENT = 'Lucía Journey Ficticia'
const CLIENT_EMAIL = 'lucia.journey@example.com'
const CLIENT_OTHER = 'fictional-contact-0042'
const CASE_TITLE = 'Abuelos ficticios — Antigua'
const CASE_TITLE_EDITED = 'Abuelos ficticios — Antigua, 1900s'
const JOURNAL = 'Read the fictional parish index; nothing under Journey.'
const TASK = 'Request the fictional 1931 register'
const MANUAL_NOTE = 'Manual hours for the journey'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
const dialog = (page: Page) => page.getByRole('alertdialog')
const journal = (page: Page) => page.getByRole('region', { name: 'Research journal' })
const steps = (page: Page) => page.getByRole('region', { name: 'Next steps' })
const hours = (page: Page) => page.getByRole('region', { name: 'Research hours' })
const pill = (page: Page) => page.getByRole('region', { name: 'Research timer' })
const hoursEntries = (page: Page) => hours(page).getByRole('list', { name: 'Hours entries' }).getByRole('listitem')
const confirm = async (page: Page, button: string) => {
  await page.getByRole('button', { name: button }).click()
  await dialog(page).getByRole('button', { name: button }).click()
}

test.describe.serial('the LAN journey: one device, one profile, restarts', () => {
  let browser: Browser
  let hostCtx: BrowserContext
  let deviceCtx: BrowserContext
  let hostPage: Page
  let devicePage: Page
  let host: Host
  let dataDir: string
  let port: number
  let lan: string
  let loopback: string
  let caseId: string

  test.beforeAll(async () => {
    port = await freePort()
    lan = `http://${lanIp}:${port}`
    loopback = `http://127.0.0.1:${port}`
    const started = await startHost(port, { withLan: true, demo: false })
    host = started.host
    dataDir = started.dataDir
    browser = await chromium.launch({ channel, args: ['--no-proxy-server'] })
    hostCtx = await browser.newContext()
    deviceCtx = await browser.newContext({ acceptDownloads: true })
    hostPage = await hostCtx.newPage()
    devicePage = await deviceCtx.newPage()
    await hostPage.goto(host.launchUrl)
    await expect(nav(hostPage)).toBeVisible()
  })

  test.afterAll(async () => {
    await browser?.close()
  })

  /** The host shows a pairing code in Settings; the device types it. */
  async function pairDevice(device: Page, name: string): Promise<void> {
    await hostPage.goto(`${loopback}/#/settings`)
    await hostPage.reload()
    await expect(hostPage.getByRole('heading', { name: 'Home-network devices' })).toBeVisible()
    await hostPage.getByRole('button', { name: 'Show pairing code' }).click()
    const code = (await hostPage.getByTestId('pairing-code').locator('strong').innerText()).trim()
    await device.goto(`${lan}/`)
    await device.getByLabel('Pairing code').fill(code)
    await device.getByLabel('Device name (optional)').fill(name)
    await device.getByRole('button', { name: 'Pair this device' }).click()
    await expect(nav(device)).toBeVisible()
  }

  const sessionEnded = (page: Page) =>
    expect(page.getByText('Your session ended. Ask for a new pairing code on the researcher’s computer.')).toBeVisible()

  /** Everything the journey stored, read through a page on the given origin. */
  async function expectAllData(page: Page, base: string): Promise<void> {
    await page.goto(`${base}/#/clients`)
    await expect(page.getByText(CLIENT).first()).toBeVisible()
    await page.goto(`${base}/#/cases/${caseId}`)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: CASE_TITLE_EDITED })).toBeVisible()
    await expect(page.locator('.state-now')).toContainText('Active')
    await expect(journal(page)).toContainText(JOURNAL)
    await expect(steps(page).getByRole('list', { name: 'Open next steps' })).toContainText(TASK)
    await expect(hoursEntries(page)).toHaveCount(2)
    await expect(hoursEntries(page).filter({ hasText: 'From the timer' })).toHaveCount(1)
    await expect(hoursEntries(page).filter({ hasText: MANUAL_NOTE })).toHaveCount(1)
    await expect(page.getByRole('region', { name: 'History' })).toContainText('Reopened (was delivered)')
  }

  test('pairs the device and creates a client and a case', async () => {
    await pairDevice(devicePage, 'Journey tablet')
    await devicePage.goto(`${lan}/#/clients/new`)
    await devicePage.getByLabel(/^Name/).fill(CLIENT)
    await pick(devicePage, 'Direct')
    await devicePage.getByLabel('Email').fill(CLIENT_EMAIL)
    await devicePage.getByLabel('Other contact').fill(CLIENT_OTHER)
    await devicePage.getByRole('button', { name: 'Save client' }).click()
    await expect(devicePage.getByRole('heading', { level: 1, name: CLIENT })).toBeVisible()

    await devicePage.goto(`${lan}/#/cases/new`)
    await devicePage.getByLabel('Client', { exact: true }).selectOption({ label: CLIENT })
    await devicePage.getByRole('button', { name: 'Continue' }).click()
    await devicePage.getByLabel(/^Title/).fill(CASE_TITLE)
    await devicePage.getByRole('button', { name: 'Create case' }).click()
    await expect(devicePage.getByRole('heading', { level: 1, name: CASE_TITLE })).toBeVisible()
    const match = /#\/cases\/([0-9a-f-]{36})$/.exec(devicePage.url())
    expect(match).not.toBeNull()
    caseId = match![1]!
  })

  test('updates the case, changes its state and reopens it', async () => {
    await devicePage.getByRole('link', { name: 'Edit details' }).click()
    await devicePage.getByLabel(/^Title/).fill(CASE_TITLE_EDITED)
    await devicePage.getByRole('button', { name: 'Save changes' }).click()
    await expect(devicePage.getByRole('heading', { level: 1, name: CASE_TITLE_EDITED })).toBeVisible()

    await devicePage.getByRole('button', { name: 'Start research' }).click()
    await expect(devicePage.getByText('Case is now active.')).toBeVisible()
    await confirm(devicePage, 'Mark delivered')
    await expect(devicePage.getByText('Case is now delivered.')).toBeVisible()
    await confirm(devicePage, 'Reopen')
    await expect(devicePage.getByText('Case is now active.')).toBeVisible()
  })

  test('adds a journal entry, then adds, completes and reopens a task', async () => {
    const form = journal(devicePage).getByRole('form', { name: 'Add a journal entry' })
    await form.getByLabel('Activity (optional)').fill('Archive search')
    await form.getByLabel('What you did or found').fill(JOURNAL)
    await form.getByRole('button', { name: 'Add entry' }).click()
    await expect(journal(devicePage)).toContainText(JOURNAL)

    const add = steps(devicePage).getByRole('form', { name: 'Add a next step' })
    await add.getByLabel('What needs doing').fill(TASK)
    await add.getByRole('button', { name: 'Add next step' }).click()
    const open = steps(devicePage).getByRole('list', { name: 'Open next steps' })
    await expect(open).toContainText(TASK)
    await open.getByRole('button', { name: `Mark done: ${TASK}` }).click()
    await expect(steps(devicePage).getByText('Completed (1)')).toBeVisible()
    await steps(devicePage).getByText('Completed (1)').click()
    await steps(devicePage).getByRole('list', { name: 'Completed next steps' }).getByRole('button', { name: `Reopen: ${TASK}` }).click()
    await expect(open).toContainText(TASK)
  })

  test('adds manual hours, then starts, stops and saves a timer', async () => {
    test.setTimeout(120_000)
    const form = hours(devicePage).getByRole('form', { name: 'Add hours by hand' })
    await form.getByLabel('Hours').fill('1')
    await form.getByLabel('Minutes').fill('15')
    await form.getByLabel('Note (optional)').fill(MANUAL_NOTE)
    await form.getByRole('button', { name: 'Add entry' }).click()
    await expect(hoursEntries(devicePage)).toHaveCount(1)

    await hours(devicePage).getByRole('button', { name: 'Start timer' }).click()
    await expect(pill(devicePage).getByText('Running')).toBeVisible()
    // The 30-second minimum is real; wait it out rather than editing the database.
    await devicePage.waitForTimeout(32_000)
    await pill(devicePage).getByRole('button', { name: `Stop and save timer on ${CASE_TITLE_EDITED}` }).click()
    await dialog(devicePage).getByRole('button', { name: 'Save time' }).click()
    await expect(pill(devicePage)).toHaveCount(0)
    await expect(hoursEntries(devicePage)).toHaveCount(2)
    await expect(hoursEntries(devicePage).filter({ hasText: 'From the timer' })).toHaveCount(1)
  })

  test('exports the case summary as a real download with no client contact fields', async () => {
    await devicePage.goto(`${lan}/#/cases/${caseId}`)
    await devicePage.getByRole('button', { name: 'Export summary…' }).click()
    const [download] = await Promise.all([devicePage.waitForEvent('download'), dialog(devicePage).getByRole('button', { name: 'Download' }).click()])
    expect(download.suggestedFilename()).toMatch(/^case-summary-.*\.md$/)
    const text = readFileSync((await download.path())!, 'utf8')
    expect(text).toContain(`# Case summary: ${CASE_TITLE_EDITED}`)
    expect(text).toContain(`- Client: ${CLIENT}`)
    expect(text).toContain(JOURNAL)
    for (const absent of [CLIENT_EMAIL, CLIENT_OTHER, '@example.com']) expect(text).not.toContain(absent)
  })

  test('logs out to enrollment, then pairs again with the data still there', async () => {
    await devicePage.goto(`${lan}/#/settings`)
    await devicePage.getByRole('button', { name: 'Sign out this device' }).click()
    await expect(devicePage.getByRole('heading', { name: 'Pair this device' })).toBeVisible()
    await pairDevice(devicePage, 'Journey tablet')
    await devicePage.goto(`${lan}/#/cases`)
    await expect(devicePage.getByText(CASE_TITLE_EDITED).first()).toBeVisible()
  })

  test('the host revokes the device: the next action shows session-ended', async () => {
    await hostPage.goto(`${loopback}/#/settings`)
    await hostPage.reload()
    await hostPage.getByRole('button', { name: 'Revoke Journey tablet' }).click()
    await expect(hostPage.getByText('No devices are paired.')).toBeVisible()
    await nav(devicePage).getByRole('link', { name: 'Clients' }).click()
    await sessionEnded(devicePage)
    await expect(devicePage.getByLabel('Pairing code')).toBeVisible()
  })

  test('browser restart: a new context is not signed in, re-pairs, and finds the data', async () => {
    await deviceCtx.close()
    deviceCtx = await browser.newContext({ acceptDownloads: true })
    devicePage = await deviceCtx.newPage()
    await devicePage.goto(`${lan}/`)
    await expect(devicePage.getByRole('heading', { name: 'Pair this device' })).toBeVisible()
    await expect(nav(devicePage)).toHaveCount(0)
    expect(await deviceCtx.cookies()).toEqual([])
    const session = (await (await deviceCtx.request.get(`${lan}/api/v1/session`)).json()) as { authenticated: boolean }
    expect(session.authenticated).toBe(false)

    await pairDevice(devicePage, 'Journey tablet, new browser')
    await expectAllData(devicePage, lan)
  })

  test('host restart: every device pairs again, and all data is there for both host and device', async () => {
    await stop(host.child)
    host = (await startHost(port, { withLan: true, demo: false, dataDir })).host

    // The old device session is gone with the host's memory.
    await nav(devicePage).getByRole('link', { name: 'Cases' }).click()
    await sessionEnded(devicePage)
    const probe = (await (await deviceCtx.request.get(`${lan}/api/v1/session`)).json()) as { authenticated: boolean }
    expect(probe.authenticated).toBe(false)

    // The host's own browser signs in again with the new private link and sees everything.
    await hostPage.goto(host.launchUrl)
    await expect(nav(hostPage)).toBeVisible()
    await hostPage.goto(`${loopback}/#/settings`)
    await hostPage.reload()
    await expect(hostPage.getByText('No devices are paired.')).toBeVisible()
    await expectAllData(hostPage, loopback)

    await pairDevice(devicePage, 'Journey tablet, after host restart')
    await expectAllData(devicePage, lan)
  })
})
