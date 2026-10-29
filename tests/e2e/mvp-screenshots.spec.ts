import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Client, ClientInput, NoteInput } from '../../src/shared/client-model'
import type { TracingGuatemalaApi } from '../../src/shared/ipc'
import { sampleClients, sampleNotes } from '../renderer/fixtures/sampleClients'
import { launchBuiltApp } from './launch'

// Captures the Phase 1 MVP screenshots in docs/screenshots/mvp/ for the #12
// pilot guide. Seeds the FICTIONAL sample clients through the real preload API
// into a throwaway profile. Opt-in:
//   npm run build && CAPTURE_SCREENSHOTS=1 npx playwright test mvp-screenshots

const outDir = resolve(__dirname, '../../docs/screenshots/mvp')

test.skip(!process.env['CAPTURE_SCREENSHOTS'], 'Set CAPTURE_SCREENSHOTS=1 to refresh the MVP screenshots.')

async function seed(page: Page): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const sample of sampleClients) {
    const input: ClientInput = {
      displayName: sample.displayName,
      source: sample.source,
      sourceDetail: sample.sourceDetail,
      fiverrUsername: sample.fiverrUsername,
      email: sample.email,
      otherContact: sample.otherContact,
      preferredContactChannel: sample.preferredContactChannel
    }
    const created = await page.evaluate((i) => (window as unknown as { tracingGuatemala: TracingGuatemalaApi }).tracingGuatemala.createClient(i), input)
    if (!created.ok) throw new Error(`seed failed for a fictional client: ${created.reason}`)
    ids.set(sample.id, created.client.id)
  }
  for (const note of sampleNotes.filter((n) => n.kind !== 'system')) {
    const clientId = ids.get(note.clientId)!
    const input: NoteInput = {
      kind: note.kind as NoteInput['kind'],
      occurredAt: note.occurredAt,
      channel: note.channel,
      direction: note.direction,
      body: note.body
    }
    await page.evaluate(([id, i]) => (window as unknown as { tracingGuatemala: TracingGuatemalaApi }).tracingGuatemala.createNote(id, i), [clientId, input] as const)
  }
  for (const sample of sampleClients.filter((c: Client) => c.status === 'archived')) {
    await page.evaluate((id) => (window as unknown as { tracingGuatemala: TracingGuatemalaApi }).tracingGuatemala.archiveClient(id), ids.get(sample.id)!)
  }
  return ids
}

test('capture MVP screenshots', async () => {
  const app = await launchBuiltApp()
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 1000 })
  const shot = (name: string, fullPage = true) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage })
  const go = (hash: string) => page.evaluate((h) => (window.location.hash = h), hash)
  const pick = (name: string) => page.locator('label').filter({ hasText: new RegExp(`^${name}$`) }).click()

  try {
    const ids = await seed(page)
    const lucia = ids.get(sampleClients[0]!.id)!
    await page.reload()

    await go('#/clients')
    await expect(page.getByRole('table')).toBeVisible()
    await shot('01-directory')

    await page.getByLabel('Search clients').fill('ochoa')
    await pick('All')
    await expect(page.getByText(/^1 client/)).toBeVisible()
    await shot('02-search')

    await go(`#/clients/${lucia}`)
    await expect(page.getByText(/Repeat client/)).toBeVisible()
    await shot('03-profile-with-history')

    await go('#/clients/new')
    await page.getByLabel(/^Name/).fill('Tomas Herrera')
    await pick('Referral')
    await page.getByRole('button', { name: 'Save client' }).click()
    await expect(page.getByText('This might be someone you already have')).toBeVisible()
    await shot('04-duplicate-advisory')

    await go('#/clients?status=archived')
    await page.getByRole('link', { name: 'Tomás Herrera' }).click()
    await expect(page.getByText(/This profile is read-only/)).toBeVisible()
    await shot('05-archived-profile')

    await go('#/settings')
    await expect(page.getByRole('button', { name: 'Create backup…' })).toBeVisible()
    await shot('06-settings-backup')
  } finally {
    await app.close()
  }
})
