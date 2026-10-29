import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createTestUserData, launchBuiltApp } from './launch'

// Backup → change → restore through the real UI, IPC and files. Native file
// dialogs are replaced in the main process so the test can choose paths.
// Fictional data only.

async function answerDialogs(app: ElectronApplication, paths: { save?: string; open?: string }) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p.save })) as typeof dialog.showSaveDialog
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p.open ? [p.open] : [] })) as typeof dialog.showOpenDialog
  }, paths)
}

async function addClient(page: Page, name: string) {
  await page.evaluate((h) => (window.location.hash = h), '#/clients/new')
  await page.getByLabel(/^Name/).fill(name)
  await page.locator('label').filter({ hasText: /^Direct$/ }).click()
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByText('Client added.')).toBeVisible()
}

async function directoryNames(page: Page): Promise<string[]> {
  await page.evaluate((h) => (window.location.hash = h), '#/clients?status=all')
  await expect(page.getByText(/active · \d+ archived/)).toBeVisible()
  return page.getByRole('rowheader').allTextContents()
}

test('backup, change data, then restore the backup', async () => {
  const userData = createTestUserData()
  const backupFile = join(userData, 'Fictional backup.tgbackup')
  const app = await launchBuiltApp(userData)
  const page = await app.firstWindow()

  await addClient(page, 'Ana Ejemplo')
  await answerDialogs(app, { save: backupFile, open: backupFile })
  await page.evaluate((h) => (window.location.hash = h), '#/settings')
  await page.getByRole('button', { name: 'Create backup…' }).click()
  await expect(page.getByText(/Backup saved as “Fictional backup.tgbackup”, with 1 client/)).toBeVisible()

  await addClient(page, 'Added After Backup')
  expect(await directoryNames(page)).toEqual(['Added After Backup', 'Ana Ejemplo'])

  await page.evaluate((h) => (window.location.hash = h), '#/settings')
  await page.getByRole('button', { name: 'Restore from backup…' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Replace all data with this backup?' })
  await expect(dialog.getByText(/contains 1 client and 0 notes/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Replace with backup' }).click()
  await expect(page.getByText(/Backup restored: 1 client/)).toBeVisible()

  expect(await directoryNames(page)).toEqual(['Ana Ejemplo'])
  await app.close()

  // The restored data is what the app opens next time.
  const reopened = await launchBuiltApp(userData)
  const again = await reopened.firstWindow()
  expect(await directoryNames(again)).toEqual(['Ana Ejemplo'])
  await reopened.close()
})

test('refuses a file that is not a backup and changes nothing', async () => {
  const userData = createTestUserData()
  const notABackup = join(userData, 'notes.txt')
  writeFileSync(notABackup, 'Just some text, not a backup. '.repeat(50))
  const app = await launchBuiltApp(userData)
  const page = await app.firstWindow()
  await addClient(page, 'Keep Me')

  await answerDialogs(app, { open: notABackup })
  await page.evaluate((h) => (window.location.hash = h), '#/settings')
  await page.getByRole('button', { name: 'Restore from backup…' }).click()
  await expect(page.getByText(/isn’t a Tracing Guatemala backup/)).toBeVisible()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(await directoryNames(page)).toEqual(['Keep Me'])
  await app.close()
})
