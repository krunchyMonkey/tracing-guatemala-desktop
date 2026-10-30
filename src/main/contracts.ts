import { z } from 'zod'
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX, type CaseTask, type CaseTaskInput, type CaseTaskMutationResult } from '../shared/case-tasks'
import {
  JOURNAL_ACTIVITY_MAX,
  JOURNAL_BODY_MAX,
  type JournalEntry,
  type JournalEntryInput,
  type JournalMutationResult
} from '../shared/case-journal'
import {
  BRIEF_FIELDS,
  BRIEF_LIMITS,
  type BriefField,
  type CaseBrief,
  type CaseBriefInput,
  type CaseBriefMutationResult
} from '../shared/case-brief'
import {
  CASE_STATES,
  type CaseEvent,
  type CaseInput,
  type CaseMutationResult,
  type CaseQuery,
  type CaseState,
  type ResearchCase
} from '../shared/case-model'
import {
  CLIENT_SOURCES,
  CLIENT_STATUSES,
  CONTACT_CHANNELS,
  NOTE_CHANNELS,
  NOTE_DIRECTIONS,
  NOTE_MAX,
  type Client,
  type ClientInput,
  type ClientNote,
  type ClientSource,
  type ContactChannel,
  type DirectoryQuery,
  type DuplicateCandidate,
  type NoteChannel,
  type NoteDirection,
  type NoteInput
} from '../shared/client-model'
import {
  IpcChannel,
  type AppInfo,
  type BackupChoice,
  type BackupCreateResult,
  type BackupRestoreResult,
  type BackupStatus,
  type ClientMutationResult,
  type IpcChannelName,
  type NoteMutationResult
} from '../shared/ipc'

// Argument and result schemas of every data call, shared by the Electron IPC
// handlers (ipc.ts) and the local web host (src/server, #110), so both
// transports validate exactly the same shapes. No Electron imports here.

/** Argument and result schemas of one call. Calls without an IPC channel (cases, #15) are only this. */
export interface CallContract<Args extends z.ZodTuple, Result extends z.ZodType> {
  args: Args
  result: Result
}

export interface ChannelContract<Args extends z.ZodTuple, Result extends z.ZodType> extends CallContract<Args, Result> {
  channel: IpcChannelName
}

// Raw text bounds only stop oversized payloads. The field rules (lengths,
// formats) run in the repository and come back as typed issues, not rejections.
const RAW_TEXT_MAX = 1_000

const sourceSchema = z.enum(CLIENT_SOURCES as [ClientSource, ...ClientSource[]])
const channelSchema = z.enum(CONTACT_CHANNELS as [ContactChannel, ...ContactChannel[]])
const rawText = z.string().max(RAW_TEXT_MAX)
const idSchema = z.uuid()
const timestamp = z.iso.datetime()

/** Strict: system fields (id, status, timestamps) or any other extra key reject the call. */
const clientInputSchema = z.strictObject({
  displayName: rawText,
  source: sourceSchema,
  sourceDetail: rawText.nullable(),
  fiverrUsername: rawText.nullable(),
  email: rawText.nullable(),
  otherContact: rawText.nullable(),
  preferredContactChannel: channelSchema
}) satisfies z.ZodType<ClientInput>

const directoryQuerySchema = z.strictObject({
  text: z.string().max(200),
  status: z.enum(['active', 'archived', 'all']),
  sources: z.array(sourceSchema).max(CLIENT_SOURCES.length),
  sort: z.enum(['name', 'updated', 'created'])
}) satisfies z.ZodType<DirectoryQuery>

const clientSchema = z.strictObject({
  id: idSchema,
  displayName: z.string(),
  source: sourceSchema,
  sourceDetail: z.string().nullable(),
  fiverrUsername: z.string().nullable(),
  email: z.string().nullable(),
  otherContact: z.string().nullable(),
  preferredContactChannel: channelSchema,
  status: z.enum(CLIENT_STATUSES as ['active', 'archived']),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable()
}) satisfies z.ZodType<Client>

const issueSchema = z.strictObject({
  field: z
    .enum(['displayName', 'source', 'sourceDetail', 'fiverrUsername', 'email', 'otherContact', 'preferredContactChannel'])
    .nullable(),
  severity: z.enum(['error', 'warning', 'info']),
  code: z.enum([
    'required',
    'too-long',
    'invalid-characters',
    'invalid-format',
    'contains-spaces',
    'required-for-channel',
    'missing-for-channel',
    'no-contact-details'
  ])
})

const mutationResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), client: clientSchema }),
  z.strictObject({ ok: z.literal(false), reason: z.literal('invalid'), issues: z.array(issueSchema) }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['not-found', 'wrong-status']) })
]) satisfies z.ZodType<ClientMutationResult>

const noteChannelSchema = z.enum(NOTE_CHANNELS as [NoteChannel, ...NoteChannel[]])
const noteDirectionSchema = z.enum(NOTE_DIRECTIONS as [NoteDirection, ...NoteDirection[]])

/** Strict: ids, timestamps, the client id and `system` entries cannot come from the renderer. */
const noteInputSchema = z.strictObject({
  kind: z.enum(['note', 'contact']),
  occurredAt: z.string().max(64),
  channel: noteChannelSchema.nullable(),
  direction: noteDirectionSchema.nullable(),
  // Room for surrounding whitespace; the trimmed length rule runs in the repository.
  body: z.string().max(NOTE_MAX * 2)
}) satisfies z.ZodType<NoteInput>

const noteSchema = z.strictObject({
  id: idSchema,
  clientId: idSchema,
  kind: z.enum(['note', 'contact', 'system']),
  occurredAt: timestamp,
  channel: noteChannelSchema.nullable(),
  direction: noteDirectionSchema.nullable(),
  body: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp
}) satisfies z.ZodType<ClientNote>

const noteResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), note: noteSchema }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.literal('invalid'),
    issues: z.array(
      z.strictObject({
        field: z.enum(['kind', 'occurredAt', 'channel', 'direction', 'body']),
        code: z.enum(['required', 'too-long', 'invalid-format', 'in-future'])
      })
    )
  }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['not-found', 'wrong-status']) })
]) satisfies z.ZodType<NoteMutationResult>

const caseStateSchema = z.enum(CASE_STATES as [CaseState, ...CaseState[]])

/** Strict: id, client, state and timestamps cannot come from the browser. Field rules run in the repository. */
const caseInputSchema = z.strictObject({
  title: rawText,
  goal: z.string().max(8_000).nullable(),
  orderReference: rawText.nullable(),
  dueDate: z.string().max(64).nullable()
}) satisfies z.ZodType<CaseInput>

const caseQuerySchema = z.strictObject({
  clientId: idSchema.nullable(),
  archived: z.enum(['active', 'archived', 'all']),
  states: z.array(caseStateSchema).max(CASE_STATES.length),
  text: z.string().max(200),
  sort: z.enum(['due', 'updated', 'created', 'title'])
}) satisfies z.ZodType<CaseQuery>

const researchCaseSchema = z.strictObject({
  id: idSchema,
  clientId: idSchema,
  title: z.string(),
  goal: z.string().nullable(),
  orderReference: z.string().nullable(),
  dueDate: z.string().nullable(),
  state: caseStateSchema,
  stateChangedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable()
}) satisfies z.ZodType<ResearchCase>

const caseEventSchema = z.strictObject({
  id: idSchema,
  caseId: idSchema,
  kind: z.enum(['created', 'state', 'archived', 'unarchived']),
  fromState: caseStateSchema.nullable(),
  toState: caseStateSchema.nullable(),
  occurredAt: timestamp
}) satisfies z.ZodType<CaseEvent>

const caseResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), case: researchCaseSchema }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.literal('invalid'),
    issues: z.array(
      z.strictObject({
        field: z.enum(['title', 'goal', 'orderReference', 'dueDate']),
        code: z.enum(['required', 'too-long', 'invalid-characters', 'invalid-format', 'invalid-date'])
      })
    )
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(['not-found', 'client-archived', 'wrong-status', 'invalid-transition'])
  })
]) satisfies z.ZodType<CaseMutationResult>

/** Strict: only the five sections. Raw bounds are twice the limits; the trimmed-length rule runs in the repository. */
const briefInputSchema = z.strictObject(
  Object.fromEntries(BRIEF_FIELDS.map((field) => [field, z.string().max(BRIEF_LIMITS[field] * 2).nullable()])) as Record<
    BriefField,
    z.ZodNullable<z.ZodString>
  >
) satisfies z.ZodType<CaseBriefInput>

const caseBriefSchema = z.strictObject({
  caseId: idSchema,
  objective: z.string().nullable(),
  facts: z.string().nullable(),
  people: z.string().nullable(),
  hypotheses: z.string().nullable(),
  questions: z.string().nullable(),
  updatedAt: timestamp.nullable()
}) satisfies z.ZodType<CaseBrief>

const briefResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), brief: caseBriefSchema }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.literal('invalid'),
    issues: z.array(
      z.strictObject({
        field: z.enum(BRIEF_FIELDS),
        code: z.enum(['too-long', 'invalid-characters'])
      })
    )
  }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['not-found', 'wrong-status']) })
]) satisfies z.ZodType<CaseBriefMutationResult>

/** Strict: only the three writable fields. Raw bounds are twice the limits; the trimmed-length rule runs in the repository. */
const journalInputSchema = z.strictObject({
  occurredAt: z.string().max(64),
  activity: z
    .string()
    .max(JOURNAL_ACTIVITY_MAX * 2)
    .nullable(),
  body: z.string().max(JOURNAL_BODY_MAX * 2)
}) satisfies z.ZodType<JournalEntryInput>

const journalEntrySchema = z.strictObject({
  id: idSchema,
  caseId: idSchema,
  occurredAt: timestamp,
  activity: z.string().nullable(),
  body: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp
}) satisfies z.ZodType<JournalEntry>

const journalResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), entry: journalEntrySchema }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.literal('invalid'),
    issues: z.array(
      z.strictObject({
        field: z.enum(['occurredAt', 'activity', 'body']),
        code: z.enum(['required', 'too-long', 'invalid-characters', 'invalid-format', 'in-future'])
      })
    )
  }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['not-found', 'wrong-status']) })
]) satisfies z.ZodType<JournalMutationResult>

/** Strict: only the three writable fields. Raw bounds are twice the limits; dueDate is a short string. */
const taskInputSchema = z.strictObject({
  title: z.string().max(TASK_TITLE_MAX * 2),
  description: z
    .string()
    .max(TASK_DESCRIPTION_MAX * 2)
    .nullable(),
  dueDate: z.string().max(64).nullable()
}) satisfies z.ZodType<CaseTaskInput>

const taskSchema = z.strictObject({
  id: idSchema,
  caseId: idSchema,
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(['pending', 'completed']),
  dueDate: z.string().nullable(),
  completedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp
}) satisfies z.ZodType<CaseTask>

const taskResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), task: taskSchema }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.literal('invalid'),
    issues: z.array(
      z.strictObject({
        field: z.enum(['title', 'description', 'dueDate']),
        code: z.enum(['required', 'too-long', 'invalid-characters', 'invalid-format', 'invalid-date'])
      })
    )
  }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['not-found', 'wrong-status']) })
]) satisfies z.ZodType<CaseTaskMutationResult>

const backupProblem = z.enum(['not-a-backup', 'damaged', 'too-new'])
const count = z.number().int().nonnegative()

export const contracts = {
  getAppInfo: {
    channel: IpcChannel.getAppInfo,
    args: z.tuple([]),
    result: z.strictObject({
      name: z.string().min(1),
      version: z.string().min(1),
      platform: z.string().min(1)
    }) satisfies z.ZodType<AppInfo>
  },
  listClients: {
    channel: IpcChannel.listClients,
    args: z.tuple([directoryQuerySchema]),
    result: z.array(clientSchema)
  },
  getClient: {
    channel: IpcChannel.getClient,
    args: z.tuple([idSchema]),
    result: clientSchema.nullable()
  },
  createClient: {
    channel: IpcChannel.createClient,
    args: z.tuple([clientInputSchema]),
    result: mutationResultSchema
  },
  updateClient: {
    channel: IpcChannel.updateClient,
    args: z.tuple([idSchema, clientInputSchema]),
    result: mutationResultSchema
  },
  archiveClient: {
    channel: IpcChannel.archiveClient,
    args: z.tuple([idSchema]),
    result: mutationResultSchema
  },
  restoreClient: {
    channel: IpcChannel.restoreClient,
    args: z.tuple([idSchema]),
    result: mutationResultSchema
  },
  findDuplicateClients: {
    channel: IpcChannel.findDuplicateClients,
    args: z.tuple([clientInputSchema, idSchema.nullable()]),
    result: z.array(
      z.strictObject({
        client: clientSchema,
        signals: z.array(z.enum(['email', 'fiverrUsername', 'displayName'])).min(1)
      })
    ) satisfies z.ZodType<DuplicateCandidate[]>
  },
  createBackup: {
    channel: IpcChannel.createBackup,
    args: z.tuple([]),
    result: z.union([
      z.strictObject({ ok: z.literal(true), fileName: z.string().min(1), clients: count, notes: count }),
      z.strictObject({ ok: z.literal(false), reason: z.enum(['cancelled', 'failed']) })
    ]) satisfies z.ZodType<BackupCreateResult>
  },
  chooseBackupToRestore: {
    channel: IpcChannel.chooseBackupToRestore,
    args: z.tuple([]),
    result: z.union([
      z.strictObject({
        ok: z.literal(true),
        token: idSchema,
        fileName: z.string().min(1),
        savedAt: timestamp,
        clients: count,
        notes: count
      }),
      z.strictObject({ ok: z.literal(false), reason: z.union([z.enum(['cancelled', 'failed']), backupProblem]) })
    ]) satisfies z.ZodType<BackupChoice>
  },
  restoreBackup: {
    channel: IpcChannel.restoreBackup,
    args: z.tuple([idSchema]),
    result: z.union([
      z.strictObject({ ok: z.literal(true), clients: count, notes: count }),
      z.strictObject({ ok: z.literal(false), reason: z.union([z.enum(['expired', 'failed']), backupProblem]) })
    ]) satisfies z.ZodType<BackupRestoreResult>
  },
  listNotes: {
    channel: IpcChannel.listNotes,
    args: z.tuple([idSchema]),
    result: z.array(noteSchema)
  },
  createNote: {
    channel: IpcChannel.createNote,
    args: z.tuple([idSchema, noteInputSchema]),
    result: noteResultSchema
  },
  updateNote: {
    channel: IpcChannel.updateNote,
    args: z.tuple([idSchema, idSchema, noteInputSchema]),
    result: noteResultSchema
  }
} as const

/** Research case calls (case-model/v1 §8). Served by the local web host only: desktop is frozen, so no IPC channels. */
export const caseContracts = {
  listCases: { args: z.tuple([caseQuerySchema]), result: z.array(researchCaseSchema) },
  getCase: { args: z.tuple([idSchema]), result: researchCaseSchema.nullable() },
  listCaseEvents: { args: z.tuple([idSchema]), result: z.array(caseEventSchema) },
  createCase: { args: z.tuple([idSchema, caseInputSchema]), result: caseResultSchema },
  updateCase: { args: z.tuple([idSchema, caseInputSchema]), result: caseResultSchema },
  setCaseState: { args: z.tuple([idSchema, caseStateSchema]), result: caseResultSchema },
  archiveCase: { args: z.tuple([idSchema]), result: caseResultSchema },
  unarchiveCase: { args: z.tuple([idSchema]), result: caseResultSchema },
  getCaseBrief: { args: z.tuple([idSchema]), result: caseBriefSchema.nullable() },
  saveCaseBrief: { args: z.tuple([idSchema, briefInputSchema]), result: briefResultSchema },
  listJournalEntries: { args: z.tuple([idSchema]), result: z.array(journalEntrySchema) },
  createJournalEntry: { args: z.tuple([idSchema, journalInputSchema]), result: journalResultSchema },
  updateJournalEntry: { args: z.tuple([idSchema, idSchema, journalInputSchema]), result: journalResultSchema },
  listCaseTasks: { args: z.tuple([idSchema]), result: z.array(taskSchema) },
  createCaseTask: { args: z.tuple([idSchema, taskInputSchema]), result: taskResultSchema },
  updateCaseTask: { args: z.tuple([idSchema, idSchema, taskInputSchema]), result: taskResultSchema },
  completeCaseTask: { args: z.tuple([idSchema, idSchema]), result: taskResultSchema },
  reopenCaseTask: { args: z.tuple([idSchema, idSchema]), result: taskResultSchema }
} as const satisfies Record<string, CallContract<z.ZodTuple, z.ZodType>>

/** Live-only calls (#117): no IPC channel, because the desktop app is frozen. */
export const liveContracts = {
  getBackupStatus: {
    args: z.tuple([]),
    result: z.strictObject({
      lastBackupAt: timestamp.nullable(),
      fileName: z.string().min(1).nullable(),
      backupCount: count
    }) satisfies z.ZodType<BackupStatus>
  }
} as const satisfies Record<string, CallContract<z.ZodTuple, z.ZodType>>
