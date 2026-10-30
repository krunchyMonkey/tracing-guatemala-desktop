import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import type { JournalEntry, JournalEntryInput, JournalMutationResult } from '../shared/case-journal'
import type { CaseTask, CaseTaskInput, CaseTaskMutationResult } from '../shared/case-tasks'
import type { CaseBrief, CaseBriefInput, CaseBriefMutationResult } from '../shared/case-brief'
import type {
  CaseEvent,
  CaseInput,
  CaseMutationResult,
  CaseQuery,
  CaseState,
  ResearchCase
} from '../shared/case-model'
import type { Client, ClientInput, ClientNote, DirectoryQuery, DuplicateCandidate, NoteInput } from '../shared/client-model'
import type {
  AppInfo,
  BackupChoice,
  BackupCreateResult,
  BackupRestoreResult,
  ClientMutationResult,
  NoteMutationResult
} from '../shared/ipc'
import { contracts, type ChannelContract } from './contracts'

export { contracts }

/** Thrown to the renderer without echoing its input (which may contain personal data). */
export class IpcRejectedError extends Error {
  constructor(reason: 'untrusted-sender' | 'invalid-arguments' | 'internal-error') {
    super(`IPC request rejected: ${reason}`)
    this.name = 'IpcRejectedError'
  }
}

/**
 * Wrap a handler so every call checks that it came from the trusted renderer
 * origin, validates arguments against the contract, and validates the result.
 * Unexpected failures reach the renderer as a generic rejection: database and
 * schema errors can quote stored values, so only the error name is logged.
 */
export function createValidatedHandler<Args extends z.ZodTuple, Result extends z.ZodType>(
  contract: ChannelContract<Args, Result>,
  isTrustedSender: (url: string) => boolean,
  impl: (args: z.output<Args>) => z.input<Result> | Promise<z.input<Result>>
): (event: Pick<IpcMainInvokeEvent, 'senderFrame'>, ...rawArgs: unknown[]) => Promise<z.output<Result>> {
  return async (event, ...rawArgs) => {
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isTrustedSender(senderUrl)) throw new IpcRejectedError('untrusted-sender')

    const parsed = contract.args.safeParse(rawArgs)
    if (!parsed.success) throw new IpcRejectedError('invalid-arguments')

    try {
      return contract.result.parse(await impl(parsed.data))
    } catch (error) {
      console.error(`IPC ${contract.channel} failed: ${error instanceof Error ? error.name : 'unknown error'}`)
      throw new IpcRejectedError('internal-error')
    }
  }
}

/** Client operations backing the clients:* channels (ClientRepository in production). */
export interface ClientService {
  list(query: DirectoryQuery): Client[]
  get(id: string): Client | null
  create(input: ClientInput): ClientMutationResult
  update(id: string, input: ClientInput): ClientMutationResult
  archive(id: string): ClientMutationResult
  restore(id: string): ClientMutationResult
  findDuplicates(input: ClientInput, excludeId: string | null): DuplicateCandidate[]
}

/** Note operations backing the notes:* channels (NoteRepository in production). */
export interface NoteService {
  list(clientId: string): ClientNote[]
  create(clientId: string, input: NoteInput): NoteMutationResult
  update(clientId: string, noteId: string, input: NoteInput): NoteMutationResult
}

/** Research case operations for the local web host (CaseRepository in production). No IPC channels: desktop is frozen. */
export interface CaseService {
  list(query: CaseQuery): ResearchCase[]
  get(id: string): ResearchCase | null
  listEvents(caseId: string): CaseEvent[]
  create(clientId: string, input: CaseInput): CaseMutationResult
  update(id: string, input: CaseInput): CaseMutationResult
  setState(id: string, to: CaseState): CaseMutationResult
  archive(id: string): CaseMutationResult
  unarchive(id: string): CaseMutationResult
}

/** Case research brief operations for the local web host (CaseBriefRepository in production). */
export interface BriefService {
  get(caseId: string): CaseBrief | null
  save(caseId: string, input: CaseBriefInput): CaseBriefMutationResult
}

/** Case research journal operations for the local web host (CaseJournalRepository in production). */
export interface JournalService {
  list(caseId: string): JournalEntry[]
  create(caseId: string, input: JournalEntryInput): JournalMutationResult
  update(caseId: string, entryId: string, input: JournalEntryInput): JournalMutationResult
}

/** Case task operations for the local web host (CaseTaskRepository in production). */
export interface TaskService {
  list(caseId: string): CaseTask[]
  create(caseId: string, input: CaseTaskInput): CaseTaskMutationResult
  update(caseId: string, taskId: string, input: CaseTaskInput): CaseTaskMutationResult
  complete(caseId: string, taskId: string): CaseTaskMutationResult
  reopen(caseId: string, taskId: string): CaseTaskMutationResult
}

/** Backup operations backing the backup:* channels (createBackupService in production). */
export interface BackupService {
  create(): Promise<BackupCreateResult>
  chooseRestore(): Promise<BackupChoice>
  restore(token: string): Promise<BackupRestoreResult>
}

export interface IpcDependencies {
  isTrustedSender: (url: string) => boolean
  getAppInfo: () => AppInfo
  clients: ClientService
  notes: NoteService
  backup: BackupService
}

export function registerIpcHandlers(ipcMain: Pick<IpcMain, 'handle'>, deps: IpcDependencies): void {
  const c = contracts
  const { isTrustedSender, clients, notes, backup } = deps
  const register = <Args extends z.ZodTuple, Result extends z.ZodType>(
    contract: ChannelContract<Args, Result>,
    impl: (args: z.output<Args>) => z.input<Result> | Promise<z.input<Result>>
  ) => ipcMain.handle(contract.channel, createValidatedHandler(contract, isTrustedSender, impl))

  register(c.getAppInfo, () => deps.getAppInfo())
  register(c.listClients, ([query]) => clients.list(query))
  register(c.getClient, ([id]) => clients.get(id))
  register(c.createClient, ([input]) => clients.create(input))
  register(c.updateClient, ([id, input]) => clients.update(id, input))
  register(c.archiveClient, ([id]) => clients.archive(id))
  register(c.restoreClient, ([id]) => clients.restore(id))
  register(c.findDuplicateClients, ([input, excludeId]) => clients.findDuplicates(input, excludeId))
  register(c.createBackup, () => backup.create())
  register(c.chooseBackupToRestore, () => backup.chooseRestore())
  register(c.restoreBackup, ([token]) => backup.restore(token))
  register(c.listNotes, ([clientId]) => notes.list(clientId))
  register(c.createNote, ([clientId, input]) => notes.create(clientId, input))
  register(c.updateNote, ([clientId, noteId, input]) => notes.update(clientId, noteId, input))
}
