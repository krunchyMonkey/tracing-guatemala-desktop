import { describe, expect, it, vi } from 'vitest'
import {
  contracts,
  createValidatedHandler,
  IpcRejectedError,
  registerIpcHandlers,
  type ClientService,
  type NoteService
} from '../../src/main/ipc'
import { defaultQuery, type Client, type ClientInput, type ClientNote, type NoteInput } from '../../src/shared/client-model'
import { IpcChannel } from '../../src/shared/ipc'

const trustedOrigin = 'app://renderer'
const isTrustedSender = (url: string) => url.startsWith(`${trustedOrigin}/`)
const trustedEvent = { senderFrame: { url: 'app://renderer/index.html' } } as never
const appInfo = { name: 'Tracing Guatemala', version: '0.1.0', platform: 'win32' }

describe('createValidatedHandler', () => {
  it('returns validated results for a trusted sender with valid arguments', async () => {
    const handler = createValidatedHandler(contracts.getAppInfo, isTrustedSender, () => appInfo)
    await expect(handler(trustedEvent)).resolves.toEqual(appInfo)
  })

  it.each([
    ['a foreign origin', { senderFrame: { url: 'https://example.com/' } }],
    ['a missing frame', { senderFrame: null }]
  ])('rejects calls from %s without running the handler', async (_label, event) => {
    const impl = vi.fn(() => appInfo)
    const handler = createValidatedHandler(contracts.getAppInfo, isTrustedSender, impl)
    await expect(handler(event as never)).rejects.toThrow(IpcRejectedError)
    expect(impl).not.toHaveBeenCalled()
  })

  it('rejects unexpected arguments without echoing them', async () => {
    const impl = vi.fn(() => appInfo)
    const handler = createValidatedHandler(contracts.getAppInfo, isTrustedSender, impl)
    const error = await handler(trustedEvent, 'Fictional Client Name').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(IpcRejectedError)
    expect((error as Error).message).not.toContain('Fictional Client Name')
    expect(impl).not.toHaveBeenCalled()
  })

  it('refuses to return results that break the contract', async () => {
    const handler = createValidatedHandler(contracts.getAppInfo, isTrustedSender, () => ({
      ...appInfo,
      extra: 'not part of the contract'
    }))
    await expect(handler(trustedEvent)).rejects.toThrow()
  })
})

describe('registerIpcHandlers', () => {
  it('registers exactly the channels in the shared contract', () => {
    const handle = vi.fn()
    registerIpcHandlers({ handle }, { isTrustedSender, getAppInfo: () => appInfo, clients: fakeClients(), notes: fakeNotes() })
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual(Object.values(IpcChannel))
  })

  it('routes validated client calls to the client service', async () => {
    const handlers = new Map<string, (event: never, ...args: unknown[]) => Promise<unknown>>()
    const clients = fakeClients()
    registerIpcHandlers(
      { handle: (channel, listener) => void handlers.set(channel, listener as never) },
      { isTrustedSender, getAppInfo: () => appInfo, clients, notes: fakeNotes() }
    )

    await expect(handlers.get(IpcChannel.createClient)!(trustedEvent, input)).resolves.toEqual({ ok: true, client })
    expect(clients.create).toHaveBeenCalledWith(input)
    await handlers.get(IpcChannel.updateClient)!(trustedEvent, client.id, input)
    expect(clients.update).toHaveBeenCalledWith(client.id, input)
    await expect(handlers.get(IpcChannel.listClients)!(trustedEvent, defaultQuery)).resolves.toEqual([client])
    await expect(handlers.get(IpcChannel.getClient)!(trustedEvent, client.id)).resolves.toEqual(client)
  })
})

// ---------- client contracts (fictional data) ----------

const client: Client = {
  id: '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f',
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: 'fictional_buyer_01',
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr',
  status: 'active',
  createdAt: '2026-10-29T12:00:00.000Z',
  updatedAt: '2026-10-29T12:00:00.000Z',
  archivedAt: null
}

const input: ClientInput = {
  displayName: client.displayName,
  source: client.source,
  sourceDetail: null,
  fiverrUsername: client.fiverrUsername,
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
}

function fakeClients() {
  return {
    list: vi.fn(() => [client]),
    get: vi.fn(() => client),
    create: vi.fn(() => ({ ok: true as const, client })),
    update: vi.fn(() => ({ ok: true as const, client })),
    archive: vi.fn(() => ({ ok: true as const, client })),
    restore: vi.fn(() => ({ ok: true as const, client })),
    findDuplicates: vi.fn(() => [{ client, signals: ['displayName' as const] }])
  } satisfies ClientService
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(IpcRejectedError)
  return error as Error
}

describe('client contracts', () => {
  it.each([
    ['an id', { ...input, id: client.id }],
    ['a status', { ...input, status: 'archived' }],
    ['timestamps', { ...input, createdAt: client.createdAt }],
    ['an unknown source', { ...input, source: 'website' }],
    ['a missing field', { displayName: input.displayName, source: input.source }],
    ['an oversized payload', { ...input, sourceDetail: 'x'.repeat(5_000) }]
  ])('rejects create input with %s before reaching storage', async (_label, payload) => {
    const create = vi.fn()
    const handler = createValidatedHandler(contracts.createClient, isTrustedSender, create)
    const error = await rejection(handler(trustedEvent, payload))
    expect(error.message).toBe('IPC request rejected: invalid-arguments')
    expect(error.message).not.toContain(input.displayName)
    expect(create).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-UUID id', ["1 OR 1=1"]],
    ['a missing id', []],
    ['extra arguments', [client.id, 'extra']]
  ])('rejects archive calls with %s', async (_label, args) => {
    const archive = vi.fn()
    const handler = createValidatedHandler(contracts.archiveClient, isTrustedSender, archive)
    await rejection(handler(trustedEvent, ...args))
    expect(archive).not.toHaveBeenCalled()
  })

  it('rejects directory queries with unknown filters', async () => {
    const handler = createValidatedHandler(contracts.listClients, isTrustedSender, () => [])
    await rejection(handler(trustedEvent, { ...defaultQuery, status: 'deleted' }))
    await rejection(handler(trustedEvent, { ...defaultQuery, sql: 'x' }))
  })

  it('passes typed validation outcomes through as results', async () => {
    const invalid = {
      ok: false as const,
      reason: 'invalid' as const,
      issues: [{ field: 'email' as const, severity: 'error' as const, code: 'invalid-format' as const }]
    }
    const handler = createValidatedHandler(contracts.createClient, isTrustedSender, () => invalid)
    await expect(handler(trustedEvent, input)).resolves.toEqual(invalid)
  })

  it('turns storage failures into a generic rejection without their message', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const handler = createValidatedHandler(contracts.createClient, isTrustedSender, () => {
      throw new Error(`constraint failed for ${input.displayName}`)
    })
    const error = await rejection(handler(trustedEvent, input))
    expect(error.message).toBe('IPC request rejected: internal-error')
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(input.displayName)
    errorLog.mockRestore()
  })

  it('refuses client results that leak extra fields', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const handler = createValidatedHandler(contracts.getClient, isTrustedSender, () => ({ ...client, notes: [] }))
    await rejection(handler(trustedEvent, client.id))
    vi.restoreAllMocks()
  })
})

// ---------- note contracts (fictional data) ----------

const note: ClientNote = {
  id: '5a6b7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  clientId: client.id,
  kind: 'contact',
  occurredAt: '2026-10-29T12:00:00.000Z',
  channel: 'fiverr',
  direction: 'outbound',
  body: 'Sent a fictional status update.',
  createdAt: '2026-10-29T12:00:00.000Z',
  updatedAt: '2026-10-29T12:00:00.000Z'
}

const noteInput: NoteInput = {
  kind: 'contact',
  occurredAt: note.occurredAt,
  channel: 'fiverr',
  direction: 'outbound',
  body: note.body
}

function fakeNotes() {
  return {
    list: vi.fn(() => [note]),
    create: vi.fn(() => ({ ok: true as const, note })),
    update: vi.fn(() => ({ ok: true as const, note }))
  } satisfies NoteService
}

describe('note contracts', () => {
  it.each([
    ['a system entry', { ...noteInput, kind: 'system' }],
    ['an id', { ...noteInput, id: note.id }],
    ['a client id', { ...noteInput, clientId: client.id }],
    ['timestamps', { ...noteInput, createdAt: note.createdAt }],
    ['an unknown channel', { ...noteInput, channel: 'phone' }],
    ['an oversized body', { ...noteInput, body: 'x'.repeat(20_001) }]
  ])('rejects note input with %s before reaching storage', async (_label, payload) => {
    const create = vi.fn()
    const handler = createValidatedHandler(contracts.createNote, isTrustedSender, create)
    const error = await rejection(handler(trustedEvent, client.id, payload))
    expect(error.message).toBe('IPC request rejected: invalid-arguments')
    expect(error.message).not.toContain(note.body)
    expect(create).not.toHaveBeenCalled()
  })

  it('requires UUIDs for the client and the note on update', async () => {
    const update = vi.fn()
    const handler = createValidatedHandler(contracts.updateNote, isTrustedSender, update)
    await rejection(handler(trustedEvent, client.id, 'not-a-uuid', noteInput))
    await rejection(handler(trustedEvent, 'not-a-uuid', note.id, noteInput))
    await rejection(handler(trustedEvent, client.id, noteInput))
    expect(update).not.toHaveBeenCalled()
  })

  it('routes note calls with the client id', async () => {
    const handlers = new Map<string, (event: never, ...args: unknown[]) => Promise<unknown>>()
    const notes = fakeNotes()
    registerIpcHandlers(
      { handle: (channel, listener) => void handlers.set(channel, listener as never) },
      { isTrustedSender, getAppInfo: () => appInfo, clients: fakeClients(), notes }
    )
    await expect(handlers.get(IpcChannel.listNotes)!(trustedEvent, client.id)).resolves.toEqual([note])
    await handlers.get(IpcChannel.createNote)!(trustedEvent, client.id, noteInput)
    expect(notes.create).toHaveBeenCalledWith(client.id, noteInput)
    await handlers.get(IpcChannel.updateNote)!(trustedEvent, client.id, note.id, noteInput)
    expect(notes.update).toHaveBeenCalledWith(client.id, note.id, noteInput)
  })
})
