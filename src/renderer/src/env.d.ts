import type { TracingGuatemalaApi } from '../../shared/ipc'

declare global {
  interface Window {
    /** Exposed by the preload script; the renderer's only route to the main process. */
    readonly tracingGuatemala: TracingGuatemalaApi
  }
}

export {}
