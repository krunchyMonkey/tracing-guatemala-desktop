import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { noopGuidanceService } from './fakeGuidance'
import type { GuidanceService, GuidanceState } from './types'

// React seam for guidance (#102). Without a provider (Live web, desktop) there is
// no service, so no tour button appears and nothing guidance-related loads.

const GuidanceContext = createContext<GuidanceService | null>(null)

export function GuidanceProvider({ service, children }: { service: GuidanceService; children: ReactNode }) {
  return <GuidanceContext.Provider value={service}>{children}</GuidanceContext.Provider>
}

/** The service, or null where guidance is not enabled. */
export function useGuidance(): GuidanceService | null {
  return useContext(GuidanceContext)
}

export function useGuidanceState(): GuidanceState {
  const service = useGuidance() ?? noopGuidanceService
  return useSyncExternalStore(service.subscribe, service.getState, service.getState)
}
