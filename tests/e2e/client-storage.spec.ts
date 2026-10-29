import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Client, ClientInput } from '../../src/shared/client-model'
import type { ClientMutationResult, TracingGuatemalaApi } from '../../src/shared/ipc'
import { createTestUserData, launchBuiltApp } from './launch'

// Drives client storage through the real preload bridge and main-process IPC,
// then restarts the app against the same profile. Fictional data only.

const input: ClientInput = {
  displayName: 'Rosa Ficticia',
  source: 'referral',
  sourceDetail: 'Referred by a previous client',
  fiverrUsername: null,
  email: 'rosa.example@example.com',
  otherContact: null,
  preferredContactChannel: 'email'
}

function api(page: Page) {
  return {
    call<K extends keyof TracingGuatemalaApi>(name: K, ...args: unknown[]) {
      return page.evaluate(
        ([n, a]) => {
          const bridge = (window as unknown as { tracingGuatemala: Record<string, (...x: unknown[]) => Promise<unknown>> })
            .tracingGuatemala
          return bridge[n as string]!(...(a as unknown[])).then(
            (value) => ({ value, error: null }),
            (error: Error) => ({ value: null, error: error.message })
          )
        },
        [name, args] as const
      )
    }
  }
}

test('persists clients across restarts and keeps the IPC boundary strict', async () => {
  const userData = createTestUserData()

  let app = await launchBuiltApp(userData)
  let page = await app.firstWindow()
  let bridge = api(page)

  const created = (await bridge.call('createClient', input)).value as ClientMutationResult
  expect(created.ok).toBe(true)
  const client = (created as { client: Client }).client
  expect(client).toMatchObject({ ...input, status: 'active', archivedAt: null })

  const archived = (await bridge.call('archiveClient', client.id)).value as ClientMutationResult
  expect(archived).toMatchObject({ ok: true, client: { status: 'archived' } })

  const invalid = await bridge.call('createClient', { ...input, email: 'incomplete@' })
  expect(invalid.value).toEqual({
    ok: false,
    reason: 'invalid',
    issues: [{ field: 'email', severity: 'error', code: 'invalid-format' }]
  })

  const forged = await bridge.call('createClient', { ...input, id: client.id, status: 'active' })
  expect(forged.error).toContain('invalid-arguments')
  expect(forged.error).not.toContain(input.displayName)

  await app.close()
  expect(existsSync(join(userData, 'data', 'tracing-guatemala.sqlite'))).toBe(true)

  app = await launchBuiltApp(userData)
  page = await app.firstWindow()
  bridge = api(page)

  const all = (await bridge.call('listClients', { text: 'rosa', status: 'all', sources: [], sort: 'name' })).value
  expect(all).toEqual([{ ...client, status: 'archived', archivedAt: expect.any(String), updatedAt: expect.any(String) }])
  const active = (await bridge.call('listClients', { text: '', status: 'active', sources: [], sort: 'name' })).value
  expect(active).toEqual([])

  const restored = (await bridge.call('restoreClient', client.id)).value
  expect(restored).toMatchObject({ ok: true, client: { id: client.id, status: 'active', archivedAt: null } })
  await app.close()
})

test('a client created, edited and archived in the UI is unchanged after a restart', async () => {
  const userData = createTestUserData()
  // Option inputs are visually hidden; click their visible labels as a person would.
  const pick = (page: Page, name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()

  let app = await launchBuiltApp(userData)
  let page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Clients' }).click()
  await page.getByRole('link', { name: 'Add your first client' }).click()
  await page.getByLabel(/^Name/).fill('Grace Ejemplo')
  await pick(page, 'Fiverr')
  await page.getByLabel(/^Fiverr username/).fill('@grace_demo')
  await page.getByRole('button', { name: 'Save client' }).click()
  await expect(page.getByText('Client added.')).toBeVisible()

  await page.getByRole('link', { name: 'Edit details' }).click()
  await page.getByLabel(/^Email/).fill('grace.example@example.com')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Changes saved.')).toBeVisible()

  await page.getByRole('button', { name: 'Archive' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Archive client' }).click()
  await expect(page.getByText(/This profile is read-only/)).toBeVisible()
  const profileUrl = page.url()
  await app.close()

  app = await launchBuiltApp(userData)
  page = await app.firstWindow()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Clients' }).click()
  await expect(page.getByText('0 active · 1 archived')).toBeVisible()
  await pick(page, 'All')
  await page.getByLabel('Search clients').fill('GRACE ejemplo')
  await page.getByRole('link', { name: 'Grace Ejemplo' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Grace Ejemplo' })).toBeVisible()
  expect(page.url()).toBe(profileUrl)
  await expect(page.getByText(/This profile is read-only/)).toBeVisible()
  const contact = page.getByRole('region', { name: 'Contact' })
  await expect(contact.getByText('@grace_demo')).toBeVisible()
  await expect(contact.getByText('grace.example@example.com')).toBeVisible()

  await page.getByRole('button', { name: 'Restore client' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restore client' }).click()
  await expect(page.getByText('Client restored.')).toBeVisible()
  expect(page.url()).toBe(profileUrl)
  await app.close()
})

test('notes and contact entries persist across restarts and stay with their client', async () => {
  const userData = createTestUserData()
  let app = await launchBuiltApp(userData)
  let page = await app.firstWindow()
  const bridge = api(page)

  const a = ((await bridge.call('createClient', input)).value as { client: Client }).client
  const b = ((await bridge.call('createClient', { ...input, displayName: 'Bea Muestra', email: null, preferredContactChannel: 'unspecified' })).value as { client: Client }).client

  await page.evaluate((h) => (window.location.hash = h), `#/clients/${a.id}`)
  const history = page.getByRole('region', { name: 'Notes & contact history' })
  await history.getByLabel('Your note').fill('Custom offer sent: Basic package.')
  await history.getByRole('button', { name: 'Add note' }).click()
  await expect(history.getByText('Custom offer sent: Basic package.')).toBeVisible()
  await history.getByRole('button', { name: /^Edit note from/ }).click()
  const editor = history.getByRole('form', { name: 'Edit note' })
  await editor.getByLabel('Note', { exact: true }).fill('Custom offer sent: Standard package.')
  await editor.getByRole('button', { name: 'Save changes' }).click()
  await expect(history.getByText(/^Edited /)).toBeVisible()

  const [saved] = (await bridge.call('listNotes', a.id)).value as { id: string }[]
  const crossEdit = await bridge.call('updateNote', b.id, saved!.id, {
    kind: 'note',
    occurredAt: new Date().toISOString(),
    channel: null,
    direction: null,
    body: 'Edited through the wrong client'
  })
  expect(crossEdit.value).toEqual({ ok: false, reason: 'not-found' })
  expect((await bridge.call('listNotes', b.id)).value).toEqual([])
  await app.close()

  app = await launchBuiltApp(userData)
  page = await app.firstWindow()
  await page.evaluate((h) => (window.location.hash = h), `#/clients/${a.id}`)
  const reopened = page.getByRole('region', { name: 'Notes & contact history' })
  await expect(reopened.getByText('Custom offer sent: Standard package.')).toBeVisible()
  await expect(reopened.getByText(/^Edited /)).toBeVisible()
  await page.evaluate((h) => (window.location.hash = h), `#/clients/${b.id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Bea Muestra' })).toBeVisible()
  await expect(page.getByText('No notes or contact history yet.')).toBeVisible()
  await app.close()
})
