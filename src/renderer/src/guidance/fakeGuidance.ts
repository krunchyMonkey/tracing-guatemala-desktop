import type { GuidanceService, GuidanceState } from './types'

// Test doubles for GuidanceService (#102): screens and the toolbar can run with
// these without any guidance library.

const idle: GuidanceState = { active: false, guideId: null, stepId: null, completedGuideIds: [], notice: null }

/** Does nothing and is never active. */
export const noopGuidanceService: GuidanceService = {
  start: () => Promise.resolve(),
  stop: () => undefined,
  isActive: () => false,
  getState: () => idle,
  subscribe: () => () => undefined
}

/** Records calls and lets a test set the step the "tour" is on. */
export function createFakeGuidanceService() {
  let state = idle
  const listeners = new Set<() => void>()
  const calls: string[] = []
  const emit = (next: GuidanceState) => {
    state = next
    listeners.forEach((l) => l())
  }
  const service: GuidanceService = {
    start(guideId) {
      calls.push(`start:${guideId}`)
      emit({ ...state, active: true, guideId, stepId: null, notice: null })
      return Promise.resolve()
    },
    stop() {
      calls.push('stop')
      emit({ ...state, active: false, guideId: null, stepId: null })
    },
    isActive: () => state.active,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { service, calls, setStep: (stepId: string | null) => emit({ ...state, stepId }) }
}
