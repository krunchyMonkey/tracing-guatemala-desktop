import { createContext, useContext, type ReactNode } from 'react'
import type { CaseBrief, CaseBriefInput, CaseBriefMutationResult } from '../../../shared/case-brief'
import type { JournalEntry, JournalEntryInput, JournalMutationResult } from '../../../shared/case-journal'
import type { NotebookApi } from './notebookApi'
import type { CaseTask, CaseTaskInput, CaseTaskMutationResult } from '../../../shared/case-tasks'
import type { StopOptions, TimeEntry, TimeEntryInput, TimeEntryMutationResult, TimerResult, TimerSnapshot } from '../../../shared/case-time'
import type { CaseEvent, CaseInput, CaseMutationResult, CaseQuery, CaseState, ResearchCase } from '../../../shared/case-model'
import type { StudioSummary } from '../../../shared/studio-summary'
import type { BackupStatus, TracingGuatemalaApi } from '../../../shared/ipc'

// Where the shared React UI gets its data (#100, #110). The desktop app reads and
// saves through the preload bridge (main process + SQLite). The Live web app
// (web/liveApi.ts) calls the loopback-only local web host (src/server), which
// uses the same repositories and contracts. The browser demo uses an in-memory,
// fictional implementation of the same calls and has no backups.

/** Client, note and app-info calls: the part both runtimes implement. */
export type AppDataApi = Omit<TracingGuatemalaApi, 'createBackup' | 'chooseBackupToRestore' | 'restoreBackup'>

export type BackupApi = Pick<TracingGuatemalaApi, 'createBackup' | 'chooseBackupToRestore' | 'restoreBackup'>

/**
 * How the person gets to the other mode (#114). Demo and Live are separate
 * origins, so switching is only ever a plain link, decided by each entry point
 * without any shared state; never a switch inside one page.
 */
export type ModeSwitch =
  | { kind: 'link'; href: string }
  | { kind: 'unavailable'; reason: 'not-on-host' | 'not-running' | 'not-available' }

/**
 * Research case calls (case-model/v1 §8). The desktop app is frozen and has none
 * (`cases: null`), the demo gets an in-memory adapter with #16.
 */
export type { NotebookApi }

export interface CaseApi extends NotebookApi {
  listCases(query: CaseQuery): Promise<ResearchCase[]>
  getCase(id: string): Promise<ResearchCase | null>
  listCaseEvents(caseId: string): Promise<CaseEvent[]>
  createCase(clientId: string, input: CaseInput): Promise<CaseMutationResult>
  updateCase(id: string, input: CaseInput): Promise<CaseMutationResult>
  setCaseState(id: string, to: CaseState): Promise<CaseMutationResult>
  archiveCase(id: string): Promise<CaseMutationResult>
  unarchiveCase(id: string): Promise<CaseMutationResult>
  /** The case's research brief (all-empty if never saved); null for an unknown case. */
  getCaseBrief(caseId: string): Promise<CaseBrief | null>
  saveCaseBrief(caseId: string, input: CaseBriefInput): Promise<CaseBriefMutationResult>
  /** The case's research journal, newest first; empty for an unknown case. */
  listJournalEntries(caseId: string): Promise<JournalEntry[]>
  createJournalEntry(caseId: string, input: JournalEntryInput): Promise<JournalMutationResult>
  updateJournalEntry(caseId: string, entryId: string, input: JournalEntryInput): Promise<JournalMutationResult>
  /** The case's tasks, pending first by due date; empty for an unknown case. */
  listCaseTasks(caseId: string): Promise<CaseTask[]>
  createCaseTask(caseId: string, input: CaseTaskInput): Promise<CaseTaskMutationResult>
  updateCaseTask(caseId: string, taskId: string, input: CaseTaskInput): Promise<CaseTaskMutationResult>
  completeCaseTask(caseId: string, taskId: string): Promise<CaseTaskMutationResult>
  reopenCaseTask(caseId: string, taskId: string): Promise<CaseTaskMutationResult>
  /** The case's research hours, newest work date first; empty for an unknown case. */
  listTimeEntries(caseId: string): Promise<TimeEntry[]>
  createTimeEntry(caseId: string, input: TimeEntryInput): Promise<TimeEntryMutationResult>
  updateTimeEntry(caseId: string, entryId: string, input: TimeEntryInput): Promise<TimeEntryMutationResult>
  /** Permanent. The browser asks for confirmation first. */
  deleteTimeEntry(caseId: string, entryId: string): Promise<TimeEntryMutationResult>
  /** The one pending timer (any case), or null. The host is the source of truth. */
  getActiveTimer(): Promise<TimerSnapshot | null>
  startTimer(caseId: string): Promise<TimerResult>
  pauseTimer(version: number): Promise<TimerResult>
  resumeTimer(version: number): Promise<TimerResult>
  heartbeatTimer(version: number): Promise<TimerResult>
  stopAndSaveTimer(version: number, options: StopOptions): Promise<TimerResult>
  discardTimer(version: number): Promise<TimerResult>
  /** The Research Studio dashboard figures in one read (active, non-archived work only). */
  getStudioSummary(): Promise<StudioSummary>
}

/**
 * When the last verified backup was made (#117). Only the Live host keeps this;
 * the desktop and the demo leave it out (null), and the UI then shows no
 * backup status or reminder.
 */
export type BackupStatusApi = () => Promise<BackupStatus>

/** A paired home-network device, as the host lists it (#136). Never carries a session id. */
export interface LanDevice {
  id: string
  name: string
  enrolledAt: string
  lastSeenAt: string
}

/** Host-only home-network administration (#136). Only the loopback (host) session can make these calls. */
export interface LanAdminApi {
  getLanStatus(): Promise<{ enabled: boolean; origin: string | null }>
  createPairingCode(): Promise<{ code: string; expiresAt: string }>
  listDevices(): Promise<LanDevice[]>
  revokeDevice(id: string): Promise<{ revoked: boolean }>
  revokeAllDevices(): Promise<{ revoked: number }>
  /** Closes the home-network listener for good (until the host restarts with --lan-host). */
  disableLan(): Promise<{ disabled: boolean }>
}

export type AppRuntime =
  | { mode: 'desktop'; data: AppDataApi; backup: BackupApi; cases: null; backupStatus?: null; switcher: ModeSwitch }
  | {
      mode: 'live'
      data: AppDataApi
      /** Null on a paired home-network device (#136): backups stay on the researcher's computer. */
      backup: BackupApi | null
      cases: CaseApi
      backupStatus?: BackupStatusApi | null
      switcher: ModeSwitch
      /** True on a paired home-network device. */
      remote?: boolean
      /** Host (loopback) only. */
      lan?: LanAdminApi
      /** Remote only: ends this device's session on the host. */
      signOut?: () => Promise<void>
    }
  | { mode: 'demo'; data: AppDataApi; backup: null; cases: CaseApi | null; backupStatus?: null; switcher: ModeSwitch }

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
  },
  cases: null,
  // The desktop app has no second mode to switch to.
  switcher: { kind: 'unavailable', reason: 'not-available' }
}

const AppRuntimeContext = createContext<AppRuntime>(desktopRuntime)

export function AppRuntimeProvider({ runtime, children }: { runtime: AppRuntime; children: ReactNode }) {
  return <AppRuntimeContext.Provider value={runtime}>{children}</AppRuntimeContext.Provider>
}

export function useAppRuntime(): AppRuntime {
  return useContext(AppRuntimeContext)
}
