import { vi } from 'vitest'
import {
  checkClient,
  checkNote,
  compareNotes,
  queryClients,
  type Client,
  type ClientInput,
  type ClientNote,
  type NoteInput
} from '../../src/shared/client-model'
import type { ClientMutationResult, NoteMutationResult, TracingGuatemalaApi } from '../../src/shared/ipc'
import { sampleClients, sampleNotes } from './fixtures/sampleClients'

/**
 * In-memory stand-in for window.tracingGuatemala, following the same rules as
 * the main process. `failing` makes every call reject, like a broken IPC call.
 */
export function createFakeApi(initial: Client[] = sampleClients, initialNotes: ClientNote[] = sampleNotes) {
  let clients = initial.map((c) => ({ ...c }))
  let notes = initialNotes.filter((n) => clients.some((c) => c.id === n.clientId)).map((n) => ({ ...n }))
  const state = { failing: false }
  let tick = 0
  const now = () => new Date(Date.UTC(2026, 9, 29, 12, 0, tick++)).toISOString()

  async function guard<T>(work: () => T): Promise<T> {
    await Promise.resolve()
    if (state.failing) throw new Error('IPC request rejected: internal-error')
    return work()
  }

  function save(id: string | null, raw: ClientInput): ClientMutationResult {
    const existing = id === null ? null : clients.find((c) => c.id === id)
    if (id !== null && !existing) return { ok: false, reason: 'not-found' }
    if (existing && existing.status !== 'active') return { ok: false, reason: 'wrong-status' }
    const { input, issues } = checkClient(raw)
    if (!input) return { ok: false, reason: 'invalid', issues: issues.filter((i) => i.severity === 'error') }
    const at = now()
    const client: Client = existing
      ? { ...existing, ...input, updatedAt: at }
      : { ...input, id: crypto.randomUUID(), status: 'active', createdAt: at, updatedAt: at, archivedAt: null }
    clients = existing ? clients.map((c) => (c.id === client.id ? client : c)) : [...clients, client]
    return { ok: true, client }
  }

  function setStatus(id: string, archive: boolean): ClientMutationResult {
    const existing = clients.find((c) => c.id === id)
    if (!existing) return { ok: false, reason: 'not-found' }
    if ((existing.status === 'archived') === archive) return { ok: false, reason: 'wrong-status' }
    const at = now()
    const client: Client = {
      ...existing,
      status: archive ? 'archived' : 'active',
      archivedAt: archive ? at : null,
      updatedAt: at
    }
    clients = clients.map((c) => (c.id === id ? client : c))
    notes.push({
      id: crypto.randomUUID(),
      clientId: id,
      kind: 'system',
      occurredAt: at,
      channel: null,
      direction: null,
      body: archive ? 'Archived.' : 'Restored.',
      createdAt: at,
      updatedAt: at
    })
    return { ok: true, client }
  }

  function saveNote(clientId: string, noteId: string | null, raw: NoteInput): NoteMutationResult {
    const client = clients.find((c) => c.id === clientId)
    if (!client) return { ok: false, reason: 'not-found' }
    if (client.status !== 'active') return { ok: false, reason: 'wrong-status' }
    const existing = noteId === null ? null : notes.find((n) => n.id === noteId && n.clientId === clientId)
    if (noteId !== null && !existing) return { ok: false, reason: 'not-found' }
    if (existing?.kind === 'system') return { ok: false, reason: 'wrong-status' }
    const { input, issues } = checkNote(raw)
    if (!input) return { ok: false, reason: 'invalid', issues }
    const at = now()
    const note: ClientNote = existing
      ? { ...existing, ...input, updatedAt: at }
      : { ...input, id: crypto.randomUUID(), clientId, createdAt: at, updatedAt: at }
    notes = existing ? notes.map((n) => (n.id === note.id ? note : n)) : [...notes, note]
    return { ok: true, note }
  }

  const api: TracingGuatemalaApi = {
    getAppInfo: vi.fn(() => guard(() => ({ name: 'Tracing Guatemala', version: '0.1.0', platform: 'win32' }))),
    listClients: vi.fn((query) => guard(() => queryClients(clients, query))),
    getClient: vi.fn((id) => guard(() => clients.find((c) => c.id === id) ?? null)),
    createClient: vi.fn((input) => guard(() => save(null, input))),
    updateClient: vi.fn((id, input) => guard(() => save(id, input))),
    archiveClient: vi.fn((id) => guard(() => setStatus(id, true))),
    restoreClient: vi.fn((id) => guard(() => setStatus(id, false))),
    listNotes: vi.fn((clientId) => guard(() => notes.filter((n) => n.clientId === clientId).sort(compareNotes))),
    createNote: vi.fn((clientId, input) => guard(() => saveNote(clientId, null, input))),
    updateNote: vi.fn((clientId, noteId, input) => guard(() => saveNote(clientId, noteId, input)))
  }

  /** Changes stored data behind the renderer's back, as another save or a restart would. */
  function replace(client: Client) {
    clients = clients.map((c) => (c.id === client.id ? client : c))
  }

  return { api, state, clients: () => clients, notes: () => notes, replace }
}
