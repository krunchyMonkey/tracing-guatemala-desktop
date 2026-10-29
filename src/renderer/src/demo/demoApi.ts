import {
  checkClient,
  checkNote,
  compareNotes,
  findDuplicates,
  queryClients,
  type Client,
  type ClientInput,
  type ClientNote,
  type NoteInput
} from '../../../shared/client-model'
import type { AppInfo, ClientMutationResult, NoteMutationResult } from '../../../shared/ipc'
import type { AppDataApi } from '../runtime/AppRuntime'
import { randomUuid } from './uuid'

// The browser demo's data (#100): fictional clients and notes held in this page's
// memory only. It follows the same shared rules as the desktop repositories
// (src/main/database), so validation, search, duplicates, read-only archived
// profiles and system entries behave alike. Nothing is written to storage, so a
// refresh starts again from the sample set.

export interface DemoClock {
  now: () => Date
  newId: () => string
}

const defaultClock: DemoClock = { now: () => new Date(), newId: () => randomUuid() }

export interface DemoData {
  clients: Client[]
  notes: ClientNote[]
}

export function createDemoApi(initial: DemoData, appInfo: AppInfo, clock: DemoClock = defaultClock): AppDataApi {
  let clients = structuredClone(initial.clients)
  let notes = structuredClone(initial.notes)

  // Copies on the way out, like IPC, so the UI can never change stored data in place.
  const reply = async <T>(work: () => T): Promise<T> => structuredClone(work())

  function saveClient(id: string | null, raw: ClientInput): ClientMutationResult {
    const existing = id === null ? null : clients.find((c) => c.id === id)
    if (id !== null && !existing) return { ok: false, reason: 'not-found' }
    if (existing && existing.status !== 'active') return { ok: false, reason: 'wrong-status' }
    const { input, issues } = checkClient(raw)
    if (!input) return { ok: false, reason: 'invalid', issues: issues.filter((i) => i.severity === 'error') }

    const at = clock.now().toISOString()
    const client: Client = existing
      ? { ...existing, ...input, updatedAt: at }
      : { ...input, id: clock.newId(), status: 'active', createdAt: at, updatedAt: at, archivedAt: null }
    clients = existing ? clients.map((c) => (c.id === client.id ? client : c)) : [...clients, client]
    return { ok: true, client }
  }

  function setStatus(id: string, status: Client['status']): ClientMutationResult {
    const existing = clients.find((c) => c.id === id)
    if (!existing) return { ok: false, reason: 'not-found' }
    if (existing.status === status) return { ok: false, reason: 'wrong-status' }

    const at = clock.now().toISOString()
    const client: Client = { ...existing, status, archivedAt: status === 'archived' ? at : null, updatedAt: at }
    clients = clients.map((c) => (c.id === id ? client : c))
    notes = [
      ...notes,
      {
        id: clock.newId(),
        clientId: id,
        kind: 'system',
        occurredAt: at,
        channel: null,
        direction: null,
        body: status === 'archived' ? 'Archived.' : 'Restored.',
        createdAt: at,
        updatedAt: at
      }
    ]
    return { ok: true, client }
  }

  function saveNote(clientId: string, noteId: string | null, raw: NoteInput): NoteMutationResult {
    const client = clients.find((c) => c.id === clientId)
    if (!client) return { ok: false, reason: 'not-found' }
    if (client.status !== 'active') return { ok: false, reason: 'wrong-status' }
    const existing = noteId === null ? null : notes.find((n) => n.id === noteId && n.clientId === clientId)
    if (noteId !== null && !existing) return { ok: false, reason: 'not-found' }
    if (existing?.kind === 'system') return { ok: false, reason: 'wrong-status' }
    const now = clock.now()
    const { input, issues } = checkNote(raw, now)
    if (!input) return { ok: false, reason: 'invalid', issues }

    const at = now.toISOString()
    const note: ClientNote = existing
      ? { ...existing, ...input, updatedAt: at }
      : { ...input, id: clock.newId(), clientId, createdAt: at, updatedAt: at }
    notes = existing ? notes.map((n) => (n.id === note.id ? note : n)) : [...notes, note]
    return { ok: true, note }
  }

  return {
    getAppInfo: () => reply(() => appInfo),
    listClients: (query) => reply(() => queryClients(clients, query)),
    getClient: (id) => reply(() => clients.find((c) => c.id === id) ?? null),
    createClient: (input) => reply(() => saveClient(null, input)),
    updateClient: (id, input) => reply(() => saveClient(id, input)),
    archiveClient: (id) => reply(() => setStatus(id, 'archived')),
    restoreClient: (id) => reply(() => setStatus(id, 'active')),
    findDuplicateClients: (raw, excludeId) =>
      reply(() => {
        const { input } = checkClient(raw)
        return input ? findDuplicates(input, clients, excludeId ?? undefined) : []
      }),
    listNotes: (clientId) => reply(() => notes.filter((n) => n.clientId === clientId).sort(compareNotes)),
    createNote: (clientId, input) => reply(() => saveNote(clientId, null, input)),
    updateNote: (clientId, noteId, input) => reply(() => saveNote(clientId, noteId, input))
  }
}
