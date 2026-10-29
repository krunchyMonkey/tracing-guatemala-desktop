import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// Captures the #3 prototype screenshots in docs/screenshots/issue-3/ from the
// built app, using only the fictional sample data. Opt-in:
//   CAPTURE_SCREENSHOTS=1 npm run test:e2e -- prototype-screenshots

const outDir = resolve(__dirname, '../../docs/screenshots/issue-3')

test.skip(!process.env['CAPTURE_SCREENSHOTS'], 'Set CAPTURE_SCREENSHOTS=1 to refresh the prototype screenshots.')

test('capture client prototype screenshots', async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[0] !== 'ELECTRON_RENDERER_URL'
    )
  )
  const app = await electron.launch({ args: ['.'], cwd: resolve(__dirname, '../..'), env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 1000 })
  const shot = (name: string, fullPage = true) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage })
  // Option inputs are visually hidden; click their visible labels as a person would.
  const pick = (name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()
  const go = (hash: string) => page.evaluate((h) => (window.location.hash = h), hash)

  try {
    await go('#/clients')
    await expect(page.getByRole('heading', { level: 1, name: 'Clients' })).toBeVisible()
    await shot('01-directory')

    await page.getByLabel('Search clients').fill('zzz')
    await pick('All')
    await shot('02-no-matches')

    await go('#/clients?status=all&source=fiverr&sort=updated')
    await expect(page.getByRole('table')).toBeVisible()
    await shot('03-filtered-all-fiverr')

    await page.getByRole('button', { name: 'Show empty directory' }).click()
    await shot('04-empty-directory')
    await page.getByRole('button', { name: 'Load sample clients' }).click()

    await go('#/clients/new')
    await page.getByRole('button', { name: 'Save client' }).click()
    await shot('05-add-validation-errors')

    await page.getByLabel(/^Name/).fill('Tomas Herrera')
    await pick('Referral')
    await page.getByLabel(/^Email/).fill('t.herrera@example.com')
    await page.getByRole('button', { name: 'Save client' }).click()
    await expect(page.getByText('This might be someone you already have')).toBeVisible()
    await shot('06-duplicate-warning')

    await go('#/clients/7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a01')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await shot('07-profile')

    await page.getByRole('button', { name: 'Archive' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await shot('08-archive-confirm', false)
    await page.getByRole('button', { name: 'Archive client' }).click()
    await shot('09-archived-profile')

    await page.getByRole('button', { name: 'Restore client' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore client' }).click()

    await go('#/clients/7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a04/edit')
    await page.getByLabel('Preferred way to contact').selectOption('email')
    await page.getByLabel(/^Email/).fill('')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await shot('10-edit-validation')

    await go('#/clients/7b0d1a52-3c1e-4c0a-9a51-0f6f1d2b1a06')
    await page.getByLabel('Simulate save errors').check()
    await page.getByLabel('Your note').fill('Fictional follow-up note.')
    await page.getByRole('button', { name: 'Add note' }).click()
    await shot('11-save-error')
  } finally {
    await app.close()
  }
})
