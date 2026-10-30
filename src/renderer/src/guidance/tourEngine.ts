import type { GuidanceService, GuidanceState, Guide, GuideStep } from './types'
import { waitForAnchor } from './waitForAnchor'

// Provider-neutral tour engine (#102): owns guide progress, route changes, missing
// anchors and cleanup. A `StepRenderer` only draws one step; Driver.js is one
// (driverJsProvider.ts), tests use a fake. The tour never clicks, types or submits.

export interface StepView {
  guide: Guide
  step: GuideStep
  index: number
  total: number
  isFirst: boolean
  isLast: boolean
}

export interface StepControls {
  next(): void
  back(): void
  /** Close without finishing (Escape, the close button). */
  close(): void
  /** Close after the last step. */
  finish(): void
}

export interface StepRenderer {
  show(view: StepView, controls: StepControls): void
  /** Removes every overlay and popover. Must be safe to call when nothing is shown. */
  hide(): void
}

export interface TourEngineOptions {
  guides: readonly Guide[]
  renderer: StepRenderer
  /** Moves the app to a hash route such as `/clients`. */
  navigate(route: string): void
  /** The hash route showing now, without `#` or query. */
  currentRoute(): string
  /** Calls back after the app route changes by any means. Returns an unsubscribe function. */
  onRouteChange(listener: () => void): () => void
  anchorTimeoutMs?: number
}

const NOTHING_FOUND = 'The tour could not find its place on this screen, so it ended. You can start it again any time.'
const UNKNOWN_GUIDE = 'That tour is not available.'

export function routePath(hashOrRoute: string): string {
  const withoutHash = hashOrRoute.replace(/^#/, '')
  const path = withoutHash.split('?')[0] ?? ''
  return path === '' ? '/' : path
}

export function createTourEngine(options: TourEngineOptions): GuidanceService {
  const { guides, renderer, navigate, currentRoute, onRouteChange, anchorTimeoutMs = 5000 } = options
  const listeners = new Set<() => void>()
  let state: GuidanceState = { active: false, guideId: null, stepId: null, completedGuideIds: [], notice: null }
  let run = 0
  let abort: AbortController | null = null
  let guide: Guide | null = null
  let index = -1
  let busy = false
  let expectedRoute: string | null = null
  let shownAny = false
  let unwatchRoute: (() => void) | null = null

  const set = (patch: Partial<GuidanceState>) => {
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  const teardown = () => {
    run += 1
    abort?.abort()
    abort = null
    unwatchRoute?.()
    unwatchRoute = null
    renderer.hide()
    guide = null
    index = -1
    busy = false
    expectedRoute = null
    shownAny = false
  }

  const end = (patch: Partial<GuidanceState>) => {
    teardown()
    set({ active: false, guideId: null, stepId: null, ...patch })
  }

  async function goTo(from: number, direction: 1 | -1, myRun: number): Promise<void> {
    const g = guide
    if (!g) return
    busy = true
    let i = from
    while (i >= 0 && i < g.steps.length) {
      const step = g.steps[i]!
      expectedRoute = routePath(step.route)
      if (routePath(currentRoute()) !== expectedRoute) {
        // An old popover would point at a screen that is about to unmount.
        renderer.hide()
        navigate(step.route)
      }
      const element = await waitForAnchor(step.anchorId, { timeoutMs: anchorTimeoutMs, signal: abort?.signal })
      if (myRun !== run) return
      if (element) {
        index = i
        shownAny = true
        busy = false
        set({ stepId: step.stepId })
        renderer.show(
          { guide: g, step, index: i, total: g.steps.length, isFirst: i === 0, isLast: i === g.steps.length - 1 },
          { next, back, close: stop, finish }
        )
        return
      }
      i += direction // Missing anchor: skip this step.
    }
    busy = false
    if (!shownAny) {
      end({ notice: NOTHING_FOUND })
    } else if (direction > 0) {
      finish()
    } else if (index >= 0) {
      // No earlier step could be shown: stay where we were.
      await goTo(index, 1, myRun)
    }
  }

  function next() {
    if (!guide || busy) return
    if (index >= guide.steps.length - 1) finish()
    else void goTo(index + 1, 1, run)
  }

  function back() {
    if (!guide || busy || index <= 0) return
    void goTo(index - 1, -1, run)
  }

  function finish() {
    if (!guide) return
    const done = guide.guideId
    end({ completedGuideIds: state.completedGuideIds.includes(done) ? state.completedGuideIds : [...state.completedGuideIds, done], notice: null })
  }

  function stop() {
    if (!state.active) return
    end({ notice: null })
  }

  async function start(guideId: string): Promise<void> {
    if (state.active) teardown()
    const found = guides.find((g) => g.guideId === guideId)
    if (!found || found.steps.length === 0) {
      set({ active: false, guideId: null, stepId: null, notice: UNKNOWN_GUIDE })
      return
    }
    guide = found
    abort = new AbortController()
    const myRun = ++run
    set({ active: true, guideId, stepId: null, notice: null })
    // Leaving the screen a step expects (browser Back, a typed address) ends the tour.
    unwatchRoute = onRouteChange(() => {
      if (!guide) return
      if (routePath(currentRoute()) !== expectedRoute) stop()
    })
    await goTo(0, 1, myRun)
  }

  return {
    start,
    stop,
    isActive: () => state.active,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
