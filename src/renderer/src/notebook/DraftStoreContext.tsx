import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useAppRuntime } from '../runtime/AppRuntime'
import { NotebookDraftStore } from './draftStore'

// The one draft store of this browser tab, provided above the router (App), so unsaved
// notebook text outlives every screen. Leaving the browser tab while something is not
// saved yet asks first (beforeunload); nothing is ever written to browser storage.

const DraftStoreContext = createContext<NotebookDraftStore | null>(null)

export function DraftStoreProvider({ children }: { children: ReactNode }) {
  const { cases } = useAppRuntime()
  const casesRef = useRef(cases)
  useEffect(() => {
    casesRef.current = cases
  })
  const [store] = useState(() => new NotebookDraftStore(() => casesRef.current))

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!store.hasUnsaved()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [store])

  return <DraftStoreContext.Provider value={store}>{children}</DraftStoreContext.Provider>
}

/** Like useDraftStore, but null outside a provider (layout pieces that also render alone). */
export function useOptionalDraftStore(): NotebookDraftStore | null {
  const store = useContext(DraftStoreContext)
  useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getVersion ?? noVersion)
  return store
}

const noSubscribe = (): (() => void) => () => undefined
const noVersion = (): number => 0

/** The store, and a re-render whenever any draft changes. */
export function useDraftStore(): NotebookDraftStore {
  const store = useContext(DraftStoreContext)
  if (!store) throw new Error('useDraftStore must be used inside a DraftStoreProvider.')
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store
}
