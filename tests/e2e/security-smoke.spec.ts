import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchBuiltApp } from './launch'

// Launches the built app (out/) exactly as production would load it: from
// app://renderer with no dev server, then probes the security boundary.

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await launchBuiltApp()
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
})

test('launches from app://renderer and navigates between placeholder screens', async () => {
  expect(page.url()).toMatch(/^app:\/\/renderer\/index\.html/)
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()

  await nav.getByRole('link', { name: 'Settings & Backup' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings & Backup' })).toBeVisible()
  await expect(page.getByTestId('app-version')).toHaveText(/^Tracing Guatemala version \d+\.\d+\.\d+/)

  await nav.getByRole('link', { name: 'Home' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible()
})

test('client screens render under the production CSP without violations', async () => {
  await page.evaluate(() => {
    const w = window as unknown as { __cspViolations: string[] }
    w.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (event) => w.__cspViolations.push(event.violatedDirective))
  })

  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Clients' }).click()
  await page.getByRole('link', { name: /Add client/ }).click()
  await page.getByLabel(/^Name/).fill('Daniel Ochoa')
  await page.locator('label').filter({ hasText: /^Direct$/ }).click()
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Daniel Ochoa' })).toBeVisible()
  await page.getByRole('button', { name: 'Archive' }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('link', { name: 'Edit details' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Edit Daniel Ochoa' })).toBeVisible()

  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations)
  expect(violations).toEqual([])
  await nav.getByRole('link', { name: 'Home' }).click()
})

test('main window uses hardened web preferences', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // Undocumented but stable WebContents API that reports the effective preferences.
    const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
      getLastWebPreferences(): Electron.WebPreferences
    }
    const p = contents.getLastWebPreferences()
    return {
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      nodeIntegrationInWorker: p.nodeIntegrationInWorker,
      nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames,
      sandbox: p.sandbox,
      webSecurity: p.webSecurity,
      webviewTag: p.webviewTag
    }
  })
  expect(prefs).toEqual({
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false
  })
})

test('renderer has no Node.js or Electron access and only the typed API', async () => {
  const globals = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    return {
      require: typeof w['require'],
      process: typeof w['process'],
      module: typeof w['module'],
      Buffer: typeof w['Buffer'],
      ipcRenderer: typeof w['ipcRenderer'],
      electron: typeof w['electron'],
      apiKeys: Object.keys(w['tracingGuatemala'] as object)
    }
  })
  expect(globals).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    Buffer: 'undefined',
    ipcRenderer: 'undefined',
    electron: 'undefined',
    apiKeys: [
      'getAppInfo',
      'listClients',
      'getClient',
      'createClient',
      'updateClient',
      'archiveClient',
      'restoreClient',
      'findDuplicateClients',
      'listNotes',
      'createNote',
      'updateNote'
    ]
  })
})

test('responses carry a restrictive content security policy', async () => {
  const csp = await app.evaluate(async ({ net }) => {
    const response = await net.fetch('app://renderer/index.html')
    return response.headers.get('content-security-policy')
  })
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("connect-src 'none'")
  expect(csp).not.toContain('unsafe')
})

test('CSP blocks eval and injected inline scripts', async () => {
  // Code that Playwright evaluates over DevTools is exempt from CSP, so each probe
  // schedules work the page itself must run (string timer, injected <script>).
  const result = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>
    const violations: string[] = []
    document.addEventListener('securitypolicyviolation', (event) => violations.push(event.violatedDirective))

    setTimeout('window.__evalRan = true' as unknown as TimerHandler, 0)
    const script = document.createElement('script')
    script.textContent = 'window.__inlineRan = true'
    document.head.appendChild(script)

    await new Promise((done) => setTimeout(done, 200))
    return { evalRan: w['__evalRan'] === true, inlineRan: w['__inlineRan'] === true, violations }
  })
  expect(result.evalRan).toBe(false)
  expect(result.inlineRan).toBe(false)
  expect(result.violations.length).toBeGreaterThanOrEqual(2)
  expect(result.violations.every((directive) => directive.startsWith('script-src'))).toBe(true)
})

test('renderer cannot reach the network or the file system', async () => {
  const result = await page.evaluate(async () => {
    const attempt = async (url: string) => {
      try {
        await fetch(url)
        return 'reached'
      } catch {
        return 'blocked'
      }
    }
    return {
      https: await attempt('https://example.com/'),
      file: await attempt('file:///C:/Windows/win.ini'),
      mainBundle: await attempt('app://renderer/../main/index.js')
    }
  })
  expect(result).toEqual({ https: 'blocked', file: 'blocked', mainBundle: 'blocked' })
})

test('session-level request filter blocks outbound traffic from the main process too', async () => {
  const message = await app.evaluate(async ({ session }) => {
    try {
      await session.defaultSession.fetch('https://example.com/')
      return 'reached'
    } catch (error) {
      return String(error)
    }
  })
  expect(message).toContain('ERR_BLOCKED_BY_CLIENT')
})

test('new windows, external navigation and permission prompts are denied', async () => {
  const opened = await page.evaluate(() => window.open('https://example.com/') === null)
  expect(opened).toBe(true)
  expect(app.windows()).toHaveLength(1)

  await page.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await page.waitForTimeout(500)
  expect(page.url()).toMatch(/^app:\/\/renderer\//)

  const notification = await page.evaluate(() => Notification.requestPermission())
  expect(notification).toBe('denied')
})
