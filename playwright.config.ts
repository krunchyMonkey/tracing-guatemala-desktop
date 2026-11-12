import { defineConfig } from '@playwright/test'

// `npm run test:e2e` builds all three apps first. The electron project runs launch
// and security smoke tests against out/; browser-demo serves dist-demo/ over HTTP
// (#100); web-live runs the loopback Live web host from dist-web/ (#110).
// web-live keeps a Playwright trace (and a screenshot) only for a failed test, so a flaky
// failure has a timeline (#250). Every web-live test uses its own temporary, fictional
// data folder; CI uploads test-results/ only on failure, kept for 3 days.
export default defineConfig({
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'electron', testDir: 'tests/e2e' },
    {
      name: 'browser-demo',
      testDir: 'tests/demo',
      // Windows ships Edge (Chromium), so no browser download is needed there.
      use: { browserName: 'chromium', channel: process.platform === 'win32' ? 'msedge' : undefined }
    },
    {
      name: 'web-live',
      testDir: 'tests/web',
      use: {
        browserName: 'chromium',
        channel: process.platform === 'win32' ? 'msedge' : undefined,
        acceptDownloads: true,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
      }
    }
  ]
})
