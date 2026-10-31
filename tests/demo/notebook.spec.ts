import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

// The research notebook (#148) in the built browser demo, served by `npm run demo:lan`
// on 127.0.0.1 with its own port. The seeded fictional "Archive visits" notebook opens,
// the real editor works on it, and a refresh starts again from the fictional seed.

const root = resolve(__dirname, '../..')
const port = Number(process.env['DEMO_E2E_NOTEBOOK_PORT'] ?? 4198)
const url = `http://127.0.0.1:${port}/`
const paternalCase = 'de300000-0000-4000-8000-200000000001'
let child: ChildProcess

test.beforeAll(async () => {
  child = spawn(process.execPath, ['scripts/demo-lan.mjs', '--host', '127.0.0.1', '--port', String(port)], { cwd: root })
  let output = ''
  await new Promise<void>((ready, fail) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('Press Ctrl+C to stop')) ready()
    })
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.once('exit', (code) => fail(new Error(`demo:lan exited with ${code}: ${output}`)))
  })
})

test.afterAll(() => {
  child?.kill()
})

test('opens the seeded notebook, edits it with the real editor, and starts again from the fictional seed on refresh', async ({ page }) => {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(error.message))
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) problems.push(message.text())
  })

  await page.goto(`${url}#/cases/${paternalCase}`)
  const card = page.getByRole('region', { name: 'Research notebook' })
  await expect(card).toContainText('1 page in 1 section')
  await card.getByRole('link', { name: 'Open the notebook' }).click()

  const nav = page.getByRole('navigation', { name: 'Notebook' })
  await expect(nav.getByRole('button', { name: /^Archive visits/ })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Diocesan archive, first visit' })).toHaveAttribute('aria-current', 'page')
  const editor = page.getByRole('textbox', { name: 'Page text' })
  await expect(page.getByLabel('Page title')).toHaveValue('Diocesan archive, first visit')
  await expect(editor.locator('h1')).toHaveText('Diocesan archive, first visit')
  await expect(editor.locator('li[data-type="taskItem"]')).toHaveCount(3)
  await expect(editor.locator('li[data-type="taskItem"][data-checked="true"]')).toHaveCount(1)

  // Edit: type, tick a task, add a page.
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Added during the demo.')
  await editor.locator('li[data-type="taskItem"]').nth(1).getByRole('checkbox').check()
  await expect(page.locator('.note-save-status')).toHaveText(/^Saved at \d\d:\d\d$/)
  await nav.getByRole('button', { name: '+ Add a page' }).click()
  await expect(page.getByLabel('Page title')).toBeFocused()
  await page.keyboard.type('Second visit')
  await page.keyboard.press('Enter')
  await expect(nav.locator('.note-nav-page')).toHaveText(['Diocesan archive, first visit', 'Second visit'])
  await nav.getByRole('link', { name: 'Diocesan archive, first visit' }).click()
  await expect(editor).toContainText('Added during the demo.')
  await expect(editor.locator('li[data-type="taskItem"][data-checked="true"]')).toHaveCount(2)

  // Refresh: the demo's data is in memory, so the fictional seed is back.
  await page.reload()
  await expect(nav.getByRole('link', { name: 'Diocesan archive, first visit' })).toBeVisible()
  await expect(nav.locator('.note-nav-page')).toHaveText(['Diocesan archive, first visit'])
  await expect(editor).not.toContainText('Added during the demo.')
  await expect(editor.locator('li[data-type="taskItem"][data-checked="true"]')).toHaveCount(1)
  expect(problems).toEqual([])
})

test('invites a case without a notebook to start one', async ({ page }) => {
  await page.goto(`${url}#/cases/de300000-0000-4000-8000-200000000002`)
  await page.getByRole('region', { name: 'Research notebook' }).getByRole('link', { name: 'Start a notebook' }).click()
  await page.getByRole('button', { name: 'Start your research notebook' }).click()
  await expect(page.getByRole('navigation', { name: 'Notebook' }).locator('.note-nav-page')).toHaveText(['First page'])
  await expect(page.getByRole('textbox', { name: 'Page text' })).toHaveAttribute('contenteditable', 'true')
})
