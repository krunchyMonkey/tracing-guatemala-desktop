import { createContext, useContext, type ReactNode } from 'react'
import type { TracingGuatemalaApi } from '../../../shared/ipc'

// Where the shared React UI gets its data (#100, #110). The desktop app reads and
// saves through the preload bridge (main process + SQLite). The Live web app
// (web/liveApi.ts) calls the loopback-only local web host (src/server), which
// uses the same repositories and contracts. The browser demo uses an in-memory,
// fictional implementation of the same calls and has no backups.

/** Client, note and app-info calls: the part both runtimes implement. */
export type AppDataApi = Omit<TracingGuatemalaApi, 'createBackup' | 'chooseBackupToRestore' | 'restoreBackup'>

export type BackupApi = Pick<TracingGuatemalaApi, 'createBackup' | 'chooseBackupToRestore' | 'restoreBackup'>

export type AppRuntime =
  | { mode: 'desktop'; data: AppDataApi; backup: BackupApi }
  | { mode: 'live'; data: AppDataApi; backup: BackupApi }
  | { mode: 'demo'; data: AppDataApi; backup: null }

/**
 * The Electron runtime. Getters read the preload bridge at call time, so the
 * renderer tests can stub window.tracingGuatemala per test.
 */
export const desktopRuntime: AppRuntime = {
  mode: 'desktop',
  get data() {
    return window.tracingGuatemala
  },
  get backup() {
    return window.tracingGuatemala
  }
}

const AppRuntimeContext = createContext<AppRuntime>(desktopRuntime)

export function AppRuntimeProvider({ runtime, children }: { runtime: AppRuntime; children: ReactNode }) {
  return <AppRuntimeContext.Provider value={runtime}>{children}</AppRuntimeContext.Provider>
}

export function useAppRuntime(): AppRuntime {
  return useContext(AppRuntimeContext)
}
