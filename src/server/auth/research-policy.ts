import type { CallName } from '../live-host'

// The research-resource layer of authorization (#210), beside the role layer in policy.ts.
// `authorizeCall` answers "may this principal use this call at all" (host, device, owner, researcher).
// This table answers "what kind of research resource does the call touch", which decides whether the
// request gets a research scope and what the data services enforce for it.
//
// The table is EXHAUSTIVE over CallName: adding a call to the host without classifying it here is a
// compile error. Enforcement itself lives in the data services (src/main/data-services.ts) and the SQL
// in src/main/database/research-access.ts; this table is the reviewable map of which call needs what.

export type ResearchClass =
  /** No research content at all: app info, backups, LAN/device admin, user admin, own account. */
  | 'no-research'
  /** Lists or aggregates across records; filtered in SQL to what the caller may read. */
  | 'scoped-list'
  /** Creates a new top-level record owned by the signed-in user (clients). */
  | 'client-create'
  /** Reads one client (or its notes): needs client-level read. */
  | 'client-read'
  /** Changes a client, its notes, or creates a case under it: needs client-level write. */
  | 'client-write'
  /** Reads a case or anything under it: needs case-level read. */
  | 'case-read'
  /** Changes a case or anything under it: needs case-level write. */
  | 'case-write'
  /** The global pending timer, read: returned only if the caller may read its case. */
  | 'timer-read'
  /** The global pending timer, changed: acts only if the caller may write its case, else like "no timer". */
  | 'timer-write'
  /** Starts the global timer: needs case-level write on the case; a timer the caller cannot read is only "busy". */
  | 'timer-start'

export const RESEARCH_CLASS = {
  getAppInfo: 'no-research',
  listClients: 'scoped-list',
  getClient: 'client-read',
  createClient: 'client-create',
  updateClient: 'client-write',
  archiveClient: 'client-write',
  restoreClient: 'client-write',
  findDuplicateClients: 'scoped-list',
  listNotes: 'client-read',
  createNote: 'client-write',
  updateNote: 'client-write',
  createBackup: 'no-research',
  restoreBackup: 'no-research',
  getBackupStatus: 'no-research',
  listCases: 'scoped-list',
  getCase: 'case-read',
  listCaseEvents: 'case-read',
  createCase: 'client-write',
  updateCase: 'case-write',
  setCaseState: 'case-write',
  archiveCase: 'case-write',
  unarchiveCase: 'case-write',
  getCaseBrief: 'case-read',
  saveCaseBrief: 'case-write',
  listJournalEntries: 'case-read',
  createJournalEntry: 'case-write',
  updateJournalEntry: 'case-write',
  getNotebook: 'case-read',
  createNotebookSection: 'case-write',
  renameNotebookSection: 'case-write',
  moveNotebookSection: 'case-write',
  archiveNotebookSection: 'case-write',
  unarchiveNotebookSection: 'case-write',
  createNotebookPage: 'case-write',
  getNotebookPage: 'case-read',
  renameNotebookPage: 'case-write',
  moveNotebookPage: 'case-write',
  archiveNotebookPage: 'case-write',
  unarchiveNotebookPage: 'case-write',
  saveNotebookPage: 'case-write',
  listPageRevisions: 'case-read',
  getPageRevision: 'case-read',
  restorePageRevision: 'case-write',
  listCaseTasks: 'case-read',
  createCaseTask: 'case-write',
  updateCaseTask: 'case-write',
  completeCaseTask: 'case-write',
  reopenCaseTask: 'case-write',
  listTimeEntries: 'case-read',
  createTimeEntry: 'case-write',
  updateTimeEntry: 'case-write',
  deleteTimeEntry: 'case-write',
  getActiveTimer: 'timer-read',
  startTimer: 'timer-start',
  pauseTimer: 'timer-write',
  resumeTimer: 'timer-write',
  heartbeatTimer: 'timer-write',
  stopAndSaveTimer: 'timer-write',
  discardTimer: 'timer-write',
  getStudioSummary: 'scoped-list',
  getLanStatus: 'no-research',
  createPairingCode: 'no-research',
  listDevices: 'no-research',
  revokeDevice: 'no-research',
  revokeAllDevices: 'no-research',
  disableLan: 'no-research',
  listUsers: 'no-research',
  listSignInRequests: 'no-research',
  createUser: 'no-research',
  approveSignInRequest: 'no-research',
  dismissSignInRequest: 'no-research',
  setUserRole: 'no-research',
  setUserStatus: 'no-research',
  revokeUserSessions: 'no-research',
  getMyAccount: 'no-research',
  revokeMySessions: 'no-research'
} as const satisfies Record<CallName, ResearchClass>

/** True when the call reads or changes research content and so needs a research scope. */
export function isResearchCall(name: CallName): boolean {
  return RESEARCH_CLASS[name] !== 'no-research'
}
