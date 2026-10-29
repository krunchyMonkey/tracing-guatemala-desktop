// Contract shared by main, preload, and renderer. Keep this file free of runtime
// dependencies: the sandboxed preload bundles everything it imports.

export const IpcChannel = {
  getAppInfo: 'app:get-info'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface AppInfo {
  name: string
  version: string
  platform: string
}

/** The only surface the renderer has into the main process (window.tracingGuatemala). */
export interface TracingGuatemalaApi {
  getAppInfo(): Promise<AppInfo>
}
