import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Client, ClientInput, ClientNote, NoteChannel, NoteDirection } from './model'
import { sampleClients, sampleNotes } from './sampleData'

// In-memory store for the #3 prototype. Nothing is persisted: closing or
// reloading the app resets to the fictional sample data. #5 replaces this with
// typed IPC calls to the main process once the model is approved.

export interface NewNote {
  kind: 'note' | 'contact'
  occurredAt: string
  channel: NoteChannel | null
  direction: NoteDirection | null
  body: string
}

/** Every mutation can fail; the prototype can simulate that to show error states. */
export type MutationResult<T = void> = { ok: true; value: T } | { ok: false }

export interface ClientStore {
  clients: Client[]
  notes: ClientNote[]
  simulateFailures: boolean
  setSimulateFailures(value: boolean): void
  loadSample(): void
  clearAll(): void
  createClient(input: ClientInput): MutationResult<Client>
  updateClient(id: string, input: ClientInput): MutationResult<Client>
  archiveClient(id: string): MutationResult
  restoreClient(id: string): MutationResult
  addNote(clientId: string, note: NewNote): MutationResult
}

const ClientStoreContext = createContext<ClientStore | null>(null)

function newId(): string {
  return crypto.randomUUID()
}

function systemNote(clientId: string, body: string, at: string): ClientNote {
  return { id: newId(), clientId, kind: 'system', occurredAt: at, channel: null, direction: null, body }
}

export function ClientStoreProvider({ children, initialEmpty = false }: { children: ReactNode; initialEmpty?: boolean }) {
  const [clients, setClients] = useState<Client[]>(() => (initialEmpty ? [] : sampleClients))
  const [notes, setNotes] = useState<ClientNote[]>(() => (initialEmpty ? [] : sampleNotes))
  const [simulateFailures, setSimulateFailures] = useState(false)

  const setStatus = useCallback(
    (id: string, status: Client['status']): MutationResult => {
      if (simulateFailures) return { ok: false }
      const now = new Date().toISOString()
      setClients((list) =>
        list.map((c) =>
          c.id === id ? { ...c, status, updatedAt: now, archivedAt: status === 'archived' ? now : null } : c
        )
      )
      setNotes((list) => [...list, systemNote(id, status === 'archived' ? 'Archived.' : 'Restored.', now)])
      return { ok: true, value: undefined }
    },
    [simulateFailures]
  )

  const store = useMemo<ClientStore>(
    () => ({
      clients,
      notes,
      simulateFailures,
      setSimulateFailures,
      loadSample() {
        setClients(sampleClients)
        setNotes(sampleNotes)
      },
      clearAll() {
        setClients([])
        setNotes([])
      },
      createClient(input) {
        if (simulateFailures) return { ok: false }
        const now = new Date().toISOString()
        const created: Client = { ...input, id: newId(), status: 'active', createdAt: now, updatedAt: now, archivedAt: null }
        setClients((list) => [...list, created])
        return { ok: true, value: created }
      },
      updateClient(id, input) {
        const existing = clients.find((c) => c.id === id)
        if (simulateFailures || !existing || existing.status !== 'active') return { ok: false }
        const updated: Client = { ...existing, ...input, updatedAt: new Date().toISOString() }
        setClients((list) => list.map((c) => (c.id === id ? updated : c)))
        return { ok: true, value: updated }
      },
      archiveClient: (id) => setStatus(id, 'archived'),
      restoreClient: (id) => setStatus(id, 'active'),
      addNote(clientId, note) {
        if (simulateFailures) return { ok: false }
        setNotes((list) => [...list, { ...note, id: newId(), clientId }])
        return { ok: true, value: undefined }
      }
    }),
    [clients, notes, simulateFailures, setStatus]
  )

  return <ClientStoreContext.Provider value={store}>{children}</ClientStoreContext.Provider>
}

export function useClientStore(): ClientStore {
  const store = useContext(ClientStoreContext)
  if (!store) throw new Error('useClientStore must be used inside ClientStoreProvider')
  return store
}
