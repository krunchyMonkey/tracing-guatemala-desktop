// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { createDemoApi } from '../../src/renderer/src/demo/demoApi'
import { buildDemoData, demoClientIds } from '../../src/renderer/src/demo/sampleData'
import { randomUuid } from '../../src/renderer/src/demo/uuid'
import type { AppRuntime } from '../../src/renderer/src/runtime/AppRuntime'
import type { ClientInput, DirectoryQuery, NoteInput } from '../../src/shared/client-model'
import { createFakeApi } from './fakeApi'

// The browser demo (#100): in-memory fictional data, no preload bridge, no backups.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const appInfo = { name: 'Tracing Guatemala browser demo', version: '0.1.0', platform: 'browser' }
const everyClient: DirectoryQuery = { text: '', status: 'all', sources: [], sort: 'name' }

const newClient: ClientInput = {
  displayName: 'Valeria Pop',
  source: 'direct',
  sourceDetail: null,
  fiverrUsername: null,
  email: 'valeria.pop@example.com',
  otherContact: null,
  preferredContactChannel: 'email'
}

const note: NoteInput = { kind: 'note', occurredAt: new Date().toISOString(), channel: null, direction: null, body: 'Hi' }

const demoRuntime = (): AppRuntime => ({ mode: 'demo', data: createDemoApi(buildDemoData(), appInfo), backup: null, switcher: { kind: 'unavailable', reason: 'not-available' } })

describe('randomUuid', () => {
  it('uses crypto.randomUUID where the browser provides it', () => {
    const source = { randomUUID: () => '11111111-1111-4111-8111-111111111111', getRandomValues: vi.fn() }
    expect(randomUuid(source)).toBe('11111111-1111-4111-8111-111111111111')
    expect(source.getRandomValues).not.toHaveBeenCalled()
  })

  it('builds a version 4 UUID from getRandomValues on plain-HTTP origins, never Math.random', () => {
    const random = vi.spyOn(Math, 'random')
    const source = { getRandomValues: (array: Uint8Array<ArrayBuffer>) => crypto.getRandomValues(array) }
    const ids = Array.from({ length: 200 }, () => randomUuid(source))
    for (const id of ids) expect(id).toMatch(UUID_V4)
    expect(new Set(ids).size).toBe(ids.length)
    expect(random).not.toHaveBeenCalled()
    random.mockRestore()
  })

  it('sets the version and variant bits whatever the random bytes are', () => {
    const allOnes = { getRandomValues: (array: Uint8Array) => array.fill(0xff) }
    expect(randomUuid(allOnes)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })

  it('refuses to create IDs without Web Crypto', () => {
    expect(() => randomUuid(null)).toThrow(/Web Crypto is unavailable/)
  })
})

describe('demo data', () => {
  it('starts with fictional active, archived and returning clients and their history', async () => {
    const api = createDemoApi(buildDemoData(), appInfo)
    const clients = await api.listClients(everyClient)
    expect(clients).toHaveLength(8)
    expect(clients.filter((c) => c.status === 'archived').map((c) => c.displayName)).toEqual(['Rosa Chávez Ixcoy'])
    expect(new Set(clients.map((c) => c.source))).toEqual(new Set(['fiverr', 'referral', 'direct', 'other']))
    for (const c of clients) if (c.email) expect(c.email).toMatch(/@example\.(com|org)$/)

    const returning = await api.listNotes(demoClientIds.tomas)
    expect(returning.filter((n) => n.kind === 'system').map((n) => n.body)).toEqual(['Restored.', 'Archived.'])
    expect((await api.listNotes(demoClientIds.lucia)).some((n) => n.kind === 'contact')).toBe(true)
  })

  it('keeps every sample note date in the past, so editing one passes the future-date rule', () => {
    const now = new Date()
    for (const n of buildDemoData(now).notes) expect(Date.parse(n.occurredAt)).toBeLessThanOrEqual(now.getTime())
  })

  it('creates clients with v4 UUIDs, validates input and flags duplicates like the desktop', async () => {
    const api = createDemoApi(buildDemoData(), appInfo)
    const created = await api.createClient(newClient)
    expect(created.ok && created.client.id).toMatch(UUID_V4)

    const invalid = await api.createClient({ ...newClient, displayName: '  ' })
    expect(invalid).toEqual({ ok: false, reason: 'invalid', issues: [expect.objectContaining({ field: 'displayName', code: 'required' })] })

    const dupes = await api.findDuplicateClients({ ...newClient, displayName: 'daniel  OCHOA', email: null, preferredContactChannel: 'unspecified' }, null)
    expect(dupes.map((d) => [d.client.id, d.signals])).toEqual([[demoClientIds.daniel, ['displayName']]])
  })

  it('makes archived profiles read-only and records archive and restore as system entries', async () => {
    const api = createDemoApi(buildDemoData(), appInfo)
    expect(await api.createNote(demoClientIds.rosa, note)).toEqual({ ok: false, reason: 'wrong-status' })
    expect(await api.updateClient(demoClientIds.rosa, newClient)).toEqual({ ok: false, reason: 'wrong-status' })

    const restored = await api.restoreClient(demoClientIds.rosa)
    expect(restored.ok && restored.client.status).toBe('active')
    expect((await api.listNotes(demoClientIds.rosa))[0]).toMatchObject({ kind: 'system', body: 'Restored.' })
    expect((await api.createNote(demoClientIds.rosa, note)).ok).toBe(true)

    const system = (await api.listNotes(demoClientIds.rosa)).find((n) => n.kind === 'system')!
    expect(await api.updateNote(demoClientIds.rosa, system.id, note)).toEqual({ ok: false, reason: 'wrong-status' })
  })

  it('returns copies, so the UI cannot change stored data in place', async () => {
    const api = createDemoApi(buildDemoData(), appInfo)
    const client = (await api.getClient(demoClientIds.grace))!
    client.displayName = 'Changed in place'
    expect((await api.getClient(demoClientIds.grace))!.displayName).toBe('Grace Whitfield')
  })

  it('starts from the sample set again on every page load', async () => {
    const data = buildDemoData()
    const firstLoad = createDemoApi(data, appInfo)
    await firstLoad.createClient(newClient)
    await firstLoad.archiveClient(demoClientIds.daniel)

    const reload = createDemoApi(data, appInfo)
    const clients = await reload.listClients(everyClient)
    expect(clients).toHaveLength(8)
    expect(clients.find((c) => c.id === demoClientIds.daniel)!.status).toBe('active')
  })
})

describe('App in demo mode', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the demo banner on every screen and never touches the preload bridge', async () => {
    expect('tracingGuatemala' in window).toBe(false)
    render(<App runtime={demoRuntime()} />)
    const banner = screen.getByRole('region', { name: 'Demo mode' })
    expect(within(banner).getByText('Demo Mode — Fictional Data Only')).toBeTruthy()
    expect(banner.textContent).toMatch(/reset when you refresh/)
    expect(screen.queryByText(/stays on this computer/)).toBeNull()

    fireEvent.click(screen.getAllByRole('link', { name: 'Clients' })[0]!)
    expect(await screen.findByRole('link', { name: 'Lucía Fernández (Quetzaltenango line)' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Demo mode' })).toBeTruthy()
  })

  it('explains that backups are desktop-only instead of offering the controls', async () => {
    window.location.hash = '#/settings'
    render(<App runtime={demoRuntime()} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Demo data' })).toBeTruthy()
    expect(screen.getByText(/only available in the desktop app/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /backup/i })).toBeNull()
    expect(screen.queryByText(/stored only on this computer/)).toBeNull()
    expect((await screen.findByTestId('app-version')).textContent).toBe('Tracing Guatemala browser demo version 0.1.0')
  })

  it('leaves the desktop app without a banner', () => {
    vi.stubGlobal('tracingGuatemala', createFakeApi().api)
    render(<App />)
    expect(screen.queryByRole('region', { name: 'Demo mode' })).toBeNull()
    vi.unstubAllGlobals()
  })
})
