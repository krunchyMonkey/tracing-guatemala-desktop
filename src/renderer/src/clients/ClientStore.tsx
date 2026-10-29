import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ClientMutationResult, TracingGuatemalaApi } from '../../../shared/ipc'
import type { Client, ClientInput, ClientNote, DirectoryQuery, NoteChannel, NoteDirection } from './model'

// Client state for the renderer. Clients are persisted by the main process
// (#5/#6): this store caches every client, archived included (the duplicate
// advisory needs them), and updates the cache from each saved result. Notes are
// still session-only until #9 adds note storage.

export interface NewNote {
  kind: 'note' | 'contact'
  occurredAt: string
  channel: NoteChannel | null
  direction: NoteDirection | null
  body: string
}

/** A main-process outcome, or `failed` when the call itself did not complete. */
export type SaveResult = ClientMutationResult | { ok: false; reason: 'failed' }

export type LoadState = 'loading' | 'ready' | 'error'

export interface ClientStore {
  clients: Client[]
  notes: ClientNote[]
  loadState: LoadState
  reload(): void
  createClient(input: ClientInput): Promise<SaveResult>
  updateClient(id: string, input: ClientInput): Promise<SaveResult>
  archiveClient(id: string): Promise<SaveResult>
  restoreClient(id: string): Promise<SaveResult>
  addNote(clientId: string, note: NewNote): void
}

const ClientStoreContext = createContext<ClientStore | null>(null)

const everyClient: DirectoryQuery = { text: '', status: 'all', sources: [], sort: 'name' }

function api(): TracingGuatemalaApi {
  return window.tracingGuatemala
}

function systemNote(clientId: string, body: string, at: string): ClientNote {
  return { id: crypto.randomUUID(), clientId, kind: 'system', occurredAt: at, channel: null, direction: null, body }
}

export function ClientStoreProvider({ children }: { children: ReactNode }) {
  const [clients, setClients] = useState<Client[]>([])
  const [notes, setNotes] = useState<ClientNote[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    let current = true
    api()
      .listClients(everyClient)
      .then(
        (list) => {
          if (!current) return
          setClients(list)
          setLoadState('ready')
        },
        () => {
          if (current) setLoadState('error')
        }
      )
    return () => {
      current = false
    }
  }, [loadAttempt])

  const reload = useCallback(() => {
    setLoadState('loading')
    setLoadAttempt((n) => n + 1)
  }, [])

  const mutate = useCallback(async (call: () => Promise<ClientMutationResult>): Promise<SaveResult> => {
    let result: ClientMutationResult
    try {
      result = await call()
    } catch {
      return { ok: false, reason: 'failed' }
    }
    if (result.ok) {
      const saved = result.client
      setClients((list) =>
        list.some((c) => c.id === saved.id) ? list.map((c) => (c.id === saved.id ? saved : c)) : [...list, saved]
      )
    }
    return result
  }, [])

  const setStatus = useCallback(
    async (id: string, archive: boolean): Promise<SaveResult> => {
      const result = await mutate(() => (archive ? api().archiveClient(id) : api().restoreClient(id)))
      // The main process stores this system note too; #9 shows notes from storage instead.
      if (result.ok)
        setNotes((list) => [...list, systemNote(id, archive ? 'Archived.' : 'Restored.', result.client.updatedAt)])
      return result
    },
    [mutate]
  )

  const store = useMemo<ClientStore>(
    () => ({
      clients,
      notes,
      loadState,
      reload,
      createClient: (input) => mutate(() => api().createClient(input)),
      updateClient: (id, input) => mutate(() => api().updateClient(id, input)),
      archiveClient: (id) => setStatus(id, true),
      restoreClient: (id) => setStatus(id, false),
      addNote(clientId, note) {
        setNotes((list) => [...list, { ...note, id: crypto.randomUUID(), clientId }])
      }
    }),
    [clients, notes, loadState, reload, mutate, setStatus]
  )

  return <ClientStoreContext.Provider value={store}>{children}</ClientStoreContext.Provider>
}

export function useClientStore(): ClientStore {
  const store = useContext(ClientStoreContext)
  if (!store) throw new Error('useClientStore must be used inside ClientStoreProvider')
  return store
}
