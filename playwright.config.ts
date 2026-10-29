import { defineConfig } from '@playwright/test'

// `npm run test:e2e` builds both apps first. The electron project runs launch and
// security smoke tests against out/; browser-demo serves dist-demo/ over HTTP (#100).
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
    }
  ]
})
