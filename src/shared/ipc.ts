// Contract shared by main, preload, and renderer. Keep this file free of runtime
// dependencies: the sandboxed preload bundles everything it imports.

import type {
  Client,
  ClientInput,
  ClientIssue,
  ClientNote,
  DirectoryQuery,
  DuplicateCandidate,
  NoteInput,
  NoteIssue
} from './client-model'

export const IpcChannel = {
  getAppInfo: 'app:get-info',
  listClients: 'clients:list',
  getClient: 'clients:get',
  createClient: 'clients:create',
  updateClient: 'clients:update',
  archiveClient: 'clients:archive',
  restoreClient: 'clients:restore',
  findDuplicateClients: 'clients:find-duplicates',
  createBackup: 'backup:create',
  chooseBackupToRestore: 'backup:choose-restore',
  restoreBackup: 'backup:restore',
  listNotes: 'notes:list',
  createNote: 'notes:create',
  updateNote: 'notes:update'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface AppInfo {
  name: string
  version: string
  platform: string
}

/**
 * Expected outcomes of a client change. Validation failures carry only field
 * names and rule codes, never the submitted values.
 */
export type ClientMutationResult =
  | { ok: true; client: Client }
  | { ok: false; reason: 'invalid'; issues: ClientIssue[] }
  | { ok: false; reason: 'not-found' }
  /** Edit or archive of an archived client, or restore of an active one. */
  | { ok: false; reason: 'wrong-status' }

/** Expected outcomes of a note change, with the same no-echo rule as clients. */
export type NoteMutationResult =
  | { ok: true; note: ClientNote }
  | { ok: false; reason: 'invalid'; issues: NoteIssue[] }
  | { ok: false; reason: 'not-found' }
  /** The client is archived (read-only), or the entry is a system entry. */
  | { ok: false; reason: 'wrong-status' }

/** Why a chosen file cannot be restored. */
export type BackupProblem = 'not-a-backup' | 'damaged' | 'too-new'

export type BackupCreateResult =
  | { ok: true; fileName: string; clients: number; notes: number }
  | { ok: false; reason: 'cancelled' | 'failed' }

/** A checked backup waiting for confirmation. The renderer gets a token and the file name, never the path. */
export type BackupChoice =
  | { ok: true; token: string; fileName: string; savedAt: string; clients: number; notes: number }
  | { ok: false; reason: 'cancelled' | 'failed' | BackupProblem }

export type BackupRestoreResult =
  | { ok: true; clients: number; notes: number }
  /** `expired`: the token is unknown or was already used. `failed`: the previous data was kept. */
  | { ok: false; reason: 'expired' | 'failed' | BackupProblem }

/** The only surface the renderer has into the main process (window.tracingGuatemala). */
export interface TracingGuatemalaApi {
  getAppInfo(): Promise<AppInfo>
  listClients(query: DirectoryQuery): Promise<Client[]>
  getClient(id: string): Promise<Client | null>
  createClient(input: ClientInput): Promise<ClientMutationResult>
  updateClient(id: string, input: ClientInput): Promise<ClientMutationResult>
  archiveClient(id: string): Promise<ClientMutationResult>
  restoreClient(id: string): Promise<ClientMutationResult>
  /** Possible duplicates of `input` (archived included), ignoring the client being edited. */
  findDuplicateClients(input: ClientInput, excludeId: string | null): Promise<DuplicateCandidate[]>
  /** Asks where to save, then writes a verified backup of all data. */
  createBackup(): Promise<BackupCreateResult>
  /** Asks for a backup file and checks it, without changing any data. */
  chooseBackupToRestore(): Promise<BackupChoice>
  /** Replaces all data with the chosen backup, after a safety copy of the current data. */
  restoreBackup(token: string): Promise<BackupRestoreResult>
  listNotes(clientId: string): Promise<ClientNote[]>
  createNote(clientId: string, input: NoteInput): Promise<NoteMutationResult>
  updateNote(clientId: string, noteId: string, input: NoteInput): Promise<NoteMutationResult>
}
