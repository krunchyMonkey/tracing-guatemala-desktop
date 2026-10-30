import { createContext, useContext, type ReactNode } from 'react'
import type { CaseBrief, CaseBriefInput, CaseBriefMutationResult } from '../../../shared/case-brief'
import type { JournalEntry, JournalEntryInput, JournalMutationResult } from '../../../shared/case-journal'
import type { CaseTask, CaseTaskInput, CaseTaskMutationResult } from '../../../shared/case-tasks'
import type { CaseEvent, CaseInput, CaseMutationResult, CaseQuery, CaseState, ResearchCase } from '../../../shared/case-model'
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
 * Research case calls (case-model/v1 §8). The desktop app is frozen and has none
 * (`cases: null`), the demo gets an in-memory adapter with #16.
 */
export interface CaseApi {
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
}

/**
 * When the last verified backup was made (#117). Only the Live host keeps this;
 * the desktop and the demo leave it out (null), and the UI then shows no
 * backup status or reminder.
 */
export type BackupStatusApi = () => Promise<BackupStatus>

export type AppRuntime =
  | { mode: 'desktop'; data: AppDataApi; backup: BackupApi; cases: null; backupStatus?: null }
  | { mode: 'live'; data: AppDataApi; backup: BackupApi; cases: CaseApi; backupStatus?: BackupStatusApi | null }
  | { mode: 'demo'; data: AppDataApi; backup: null; cases: CaseApi | null; backupStatus?: null }

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
  cases: null
}

const AppRuntimeContext = createContext<AppRuntime>(desktopRuntime)

export function AppRuntimeProvider({ runtime, children }: { runtime: AppRuntime; children: ReactNode }) {
  return <AppRuntimeContext.Provider value={runtime}>{children}</AppRuntimeContext.Provider>
}

export function useAppRuntime(): AppRuntime {
  return useContext(AppRuntimeContext)
}
