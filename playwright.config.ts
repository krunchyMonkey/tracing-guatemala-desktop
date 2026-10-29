import { defineConfig } from '@playwright/test'

// Launch + security smoke tests against the built app (`npm run test:e2e` builds first).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']]
})
