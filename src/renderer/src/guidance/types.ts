// Vendor-neutral guidance contract (#102). Screens and the guide catalog know only
// these types. The rendering library (Driver.js today) lives behind
// `GuidanceService` in driverJsProvider.ts, the only file that imports it.

/** One stop of a guide. `title` and `body` are plain text, never HTML. */
export interface GuideStep {
  readonly stepId: string
  /** Hash route (no `#`) that must be showing, e.g. `/clients`. */
  readonly route: string
  /** Value of the `data-guide-id` attribute the step points at (see anchors.ts). */
  readonly anchorId: string
  readonly title: string
  readonly body: string
}

export interface Guide {
  readonly guideId: string
  /** Bump when steps change meaningfully, so a future provider can tell guides apart. */
  readonly version: number
  readonly steps: readonly GuideStep[]
}

export interface GuidanceState {
  readonly active: boolean
  readonly guideId: string | null
  /** Current step while a guide is running, otherwise null. */
  readonly stepId: string | null
  /** Guides finished in this tab (in memory only; a refresh forgets them). */
  readonly completedGuideIds: readonly string[]
  /** A short message when a guide could not run or ended early, otherwise null. */
  readonly notice: string | null
}

export interface GuidanceService {
  /** Starts (or restarts) a guide from its first step. Resolves once the first step is shown or the guide ended. */
  start(guideId: string): Promise<void>
  stop(): void
  isActive(): boolean
  getState(): GuidanceState
  /** Calls `listener` after every state change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
}
