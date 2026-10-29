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
