import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ClientMutationResult, TracingGuatemalaApi } from '../../../shared/ipc'
import type { Client, ClientInput, DirectoryQuery, DuplicateCandidate } from './model'

// Client state for the renderer. Clients are persisted by the main process
// (#5/#6): this store caches every client, archived included (the duplicate
// advisory needs them), and updates the cache from each saved result. Notes are
// loaded per profile (useClientNotes).

/** A main-process outcome, or `failed` when the call itself did not complete. */
export type SaveResult = ClientMutationResult | { ok: false; reason: 'failed' }

export type LoadState = 'loading' | 'ready' | 'error'

export interface ClientStore {
  clients: Client[]
  loadState: LoadState
  reload(): void
  /** Re-reads one client from the main process into the cache (or drops it if it no longer exists). */
  refreshClient(id: string): Promise<void>
  /** Possible duplicates among all saved clients, archived included (advisory only). */
  findDuplicates(input: ClientInput, excludeId: string | null): Promise<DuplicateCandidate[]>
  /** Runs a directory query in the main process. */
  searchClients(query: DirectoryQuery): Promise<Client[]>
  /** The directory URL with the last-used search and filters, for "back to clients" links. */
  directoryHref: string
  rememberDirectorySearch(search: string): void
  createClient(input: ClientInput): Promise<SaveResult>
  updateClient(id: string, input: ClientInput): Promise<SaveResult>
  archiveClient(id: string): Promise<SaveResult>
  restoreClient(id: string): Promise<SaveResult>
}

const ClientStoreContext = createContext<ClientStore | null>(null)

const everyClient: DirectoryQuery = { text: '', status: 'all', sources: [], sort: 'name' }

function api(): TracingGuatemalaApi {
  return window.tracingGuatemala
}

export function ClientStoreProvider({ children }: { children: ReactNode }) {
  const [clients, setClients] = useState<Client[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [directorySearch, setDirectorySearch] = useState('')

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

  const refreshClient = useCallback(async (id: string) => {
    let fresh: Client | null
    try {
      fresh = await api().getClient(id)
    } catch {
      return // Keep showing the cached copy; the next save reports any real problem.
    }
    setClients((list) => {
      const others = list.filter((c) => c.id !== id)
      return fresh ? [...others, fresh] : others
    })
  }, [])

  const store = useMemo<ClientStore>(
    () => ({
      clients,
      loadState,
      reload,
      refreshClient,
      searchClients: (query) => api().listClients(query),
      findDuplicates: (input, excludeId) => api().findDuplicateClients(input, excludeId),
      directoryHref: `/clients${directorySearch}`,
      rememberDirectorySearch: setDirectorySearch,
      createClient: (input) => mutate(() => api().createClient(input)),
      updateClient: (id, input) => mutate(() => api().updateClient(id, input)),
      archiveClient: (id) => mutate(() => api().archiveClient(id)),
      restoreClient: (id) => mutate(() => api().restoreClient(id))
    }),
    [clients, loadState, directorySearch, reload, refreshClient, mutate]
  )

  return <ClientStoreContext.Provider value={store}>{children}</ClientStoreContext.Provider>
}

export function useClientStore(): ClientStore {
  const store = useContext(ClientStoreContext)
  if (!store) throw new Error('useClientStore must be used inside ClientStoreProvider')
  return store
}
