import { z } from 'zod'
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX, type CaseTask, type CaseTaskInput, type CaseTaskMutationResult } from '../shared/case-tasks'
import {
  INLINE_MARKS,
  NOTE_MAX_BLOCK_CHARS,
  NOTE_MAX_BLOCKS,
  NOTE_MAX_HREF,
  NOTE_MAX_RUNS_PER_BLOCK,
  type NoteBlock,
  type NoteContent,
  type TextRun
} from '../shared/note-content'
import {
  NOTEBOOK_MAX_SECTIONS,
  PAGE_TITLE_MAX,
  SECTION_MAX_PAGES,
  SECTION_TITLE_MAX,
  type NotebookOutline,
  type NotebookPage,
  type NotebookPageResult,
  type NotebookPageSaveResult,
  type NotebookPageSummary,
  type NotebookSection,
  type NotebookSectionResult,
  type PageInput,
  type PageMove,
  type PageRevision,
  type PageRevisionSummary,
  type PageSave,
  type SectionInput
} from '../shared/notebook'
import type { StudioSummary } from '../shared/studio-summary'
import {
  ACTIVITY_TYPES,
  TIME_NOTE_MAX,
  type StopOptions,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryMutationResult,
  type TimerResult,
  type TimerSnapshot
} from '../shared/case-time'
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

// ---------- research notebook (docs/architecture/research-notebook.md) ----------
// Structural schemas with raw bounds only (twice the limits, like the journal); the
// repository's checkNoteContent and title rules stay authoritative and answer with
// typed issues. A wrong block type or an unknown key is refused here, as invalid-arguments.

const noteRunSchema = z.strictObject({
  text: z.string().max(NOTE_MAX_BLOCK_CHARS * 2),
  marks: z.array(z.enum(INLINE_MARKS)).max(INLINE_MARKS.length * 2).optional(),
  href: z.string().max(NOTE_MAX_HREF * 2).optional()
}) satisfies z.ZodType<TextRun>

const noteRuns = z.array(noteRunSchema).max(NOTE_MAX_RUNS_PER_BLOCK * 2)
const noteBlockId = z.string().max(64)
const noteIndent = z.number().int().min(0).max(100)

const noteBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ id: noteBlockId, type: z.literal('paragraph'), indent: noteIndent, content: noteRuns }),
  z.strictObject({ id: noteBlockId, type: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), content: noteRuns }),
  z.strictObject({ id: noteBlockId, type: z.literal('bullet'), indent: noteIndent, content: noteRuns }),
  z.strictObject({ id: noteBlockId, type: z.literal('numbered'), indent: noteIndent, content: noteRuns }),
  z.strictObject({ id: noteBlockId, type: z.literal('check'), indent: noteIndent, checked: z.boolean(), content: noteRuns }),
  z.strictObject({ id: noteBlockId, type: z.literal('divider') }),
  z.strictObject({
    id: noteBlockId,
    type: z.literal('reference'),
    target: z.strictObject({ kind: z.enum(['journal', 'task', 'time']), id: z.string().max(64) })
  })
]) satisfies z.ZodType<NoteBlock>

const noteContentSchema = z.strictObject({
  format: z.literal('tg-note'),
  version: z.literal(1),
  blocks: z.array(noteBlockSchema).max(NOTE_MAX_BLOCKS * 2)
}) satisfies z.ZodType<NoteContent>

const notebookIndex = z.number().int().min(0).max(NOTEBOOK_MAX_SECTIONS * SECTION_MAX_PAGES)
const notebookVersion = z.number().int().min(1).max(2_000_000_000)

const sectionInputSchema = z.strictObject({ title: z.string().max(SECTION_TITLE_MAX * 2) }) satisfies z.ZodType<SectionInput>
const pageInputSchema = z.strictObject({ title: z.string().max(PAGE_TITLE_MAX * 2) }) satisfies z.ZodType<PageInput>
const pageMoveSchema = z.strictObject({ sectionId: idSchema, toIndex: notebookIndex }) satisfies z.ZodType<PageMove>
const pageSaveSchema = z.strictObject({ baseVersion: notebookVersion, content: noteContentSchema, keepPrevious: z.boolean().optional() }) satisfies z.ZodType<PageSave>

const notebookSectionSchema = z.strictObject({
  id: idSchema,
  notebookId: idSchema,
  caseId: idSchema,
  title: z.string(),
  position: z.number().int().nonnegative(),
  archivedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp
}) satisfies z.ZodType<NotebookSection>

const notebookPageSummaryShape = {
  id: idSchema,
  sectionId: idSchema,
  caseId: idSchema,
  title: z.string(),
  position: z.number().int().nonnegative(),
  version: notebookVersion,
  archivedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp
}
const notebookPageSummarySchema = z.strictObject(notebookPageSummaryShape) satisfies z.ZodType<NotebookPageSummary>
const notebookPageSchema = z.strictObject({ ...notebookPageSummaryShape, content: noteContentSchema }) satisfies z.ZodType<NotebookPage>

const notebookOutlineSchema = z.strictObject({
  caseId: idSchema,
  notebookId: idSchema.nullable(),
  sections: z.array(z.strictObject({ ...notebookSectionSchema.shape, pages: z.array(notebookPageSummarySchema) }))
}) satisfies z.ZodType<NotebookOutline>

const revisionSummaryShape = {
  id: idSchema,
  pageId: idSchema,
  caseId: idSchema,
  version: notebookVersion,
  title: z.string(),
  reason: z.enum(['autosave', 'restore-point', 'restored']),
  createdAt: timestamp
}
const pageRevisionSummarySchema = z.strictObject(revisionSummaryShape) satisfies z.ZodType<PageRevisionSummary>
const pageRevisionSchema = z.strictObject({ ...revisionSummaryShape, content: noteContentSchema }) satisfies z.ZodType<PageRevision>

const notebookInvalidSchema = z.strictObject({
  ok: z.literal(false),
  reason: z.literal('invalid'),
  issues: z.array(
    z.union([
      z.strictObject({ field: z.literal('title'), code: z.enum(['required', 'too-long', 'invalid-characters']) }),
      z.strictObject({ field: z.literal('limit'), code: z.literal('too-many') }),
      z.strictObject({ field: z.literal('content'), code: z.string().max(64), blockIndex: z.number().int().nonnegative().optional() })
    ])
  )
})
const notebookRefusedSchema = z.strictObject({ ok: z.literal(false), reason: z.enum(['not-found', 'wrong-status']) })

const notebookSectionResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), section: notebookSectionSchema }),
  notebookInvalidSchema,
  notebookRefusedSchema
]) as unknown as z.ZodType<NotebookSectionResult>

const notebookPageResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), page: notebookPageSchema }),
  notebookInvalidSchema,
  notebookRefusedSchema
]) as unknown as z.ZodType<NotebookPageResult>

const notebookPageSaveResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), page: notebookPageSchema }),
  z.strictObject({ ok: z.literal(false), reason: z.literal('conflict'), page: notebookPageSchema }),
  notebookInvalidSchema,
  notebookRefusedSchema
]) as unknown as z.ZodType<NotebookPageSaveResult>

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

const activityTypeSchema = z.enum(ACTIVITY_TYPES)

/** Strict: only the four writable fields. Raw bounds are twice the limits; the repository checks the rules. */
const timeEntryInputSchema = z.strictObject({
  workDate: z.string().max(64),
  durationMinutes: z.number(),
  activityType: activityTypeSchema.nullable(),
  note: z.string().max(TIME_NOTE_MAX * 2).nullable()
}) satisfies z.ZodType<TimeEntryInput>

const timeEntrySchema = z.strictObject({
  id: idSchema,
  caseId: idSchema,
  workDate: z.string(),
  durationMinutes: z.number().int(),
  activityType: activityTypeSchema.nullable(),
  note: z.string().nullable(),
  source: z.enum(['timer', 'manual']),
  createdAt: timestamp,
  updatedAt: timestamp
}) satisfies z.ZodType<TimeEntry>

const timeIssueSchema = z.strictObject({
  field: z.enum(['workDate', 'durationMinutes', 'activityType', 'note']),
  code: z.enum(['required', 'too-long', 'too-short', 'invalid-characters', 'invalid-format', 'invalid-date', 'invalid-value'])
})

const timeEntryResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), entry: timeEntrySchema }),
  z.strictObject({ ok: z.literal(false), reason: z.literal('invalid'), issues: z.array(timeIssueSchema) }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['not-found', 'wrong-status']) })
]) satisfies z.ZodType<TimeEntryMutationResult>

const timerVersionSchema = z.number().int().min(0).max(2_000_000_000)

const stopOptionsSchema = z.strictObject({
  activityType: activityTypeSchema.nullable(),
  note: z.string().max(TIME_NOTE_MAX * 2).nullable(),
  durationMinutesOverride: z.number().nullable()
}) satisfies z.ZodType<StopOptions>

const timerSnapshotSchema = z.strictObject({
  caseId: idSchema,
  state: z.enum(['running', 'paused']),
  version: z.number().int(),
  startedAt: timestamp,
  elapsedSeconds: z.number().int().nonnegative(),
  needsReview: z.boolean(),
  reviewReason: z.enum(['heartbeat-gap', 'clock-moved-back', 'too-long']).nullable(),
  suggestedSeconds: z.number().int().nonnegative().nullable()
}) satisfies z.ZodType<TimerSnapshot>

const timerResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), timer: timerSnapshotSchema.nullable(), entry: timeEntrySchema.nullable() }),
  z.strictObject({ ok: z.literal(false), reason: z.literal('conflict'), timer: timerSnapshotSchema.nullable() }),
  z.strictObject({ ok: z.literal(false), reason: z.literal('other-case-timer'), timer: timerSnapshotSchema }),
  z.strictObject({ ok: z.literal(false), reason: z.literal('needs-review'), timer: timerSnapshotSchema }),
  z.strictObject({ ok: z.literal(false), reason: z.literal('invalid'), issues: z.array(timeIssueSchema) }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['not-found', 'wrong-status', 'too-short']) })
]) satisfies z.ZodType<TimerResult>

const studioRef = {
  caseId: idSchema,
  clientId: idSchema,
  caseTitle: z.string(),
  clientDisplayName: z.string()
}
const studioCaseSchema = z.strictObject({ ...studioRef, state: caseStateSchema, dueDate: z.string().nullable() })
const studioCounts = z.number().int().nonnegative()

/** Strict, allowlisted fields only (studio-summary/v1): no note, journal or task text, no contacts. */
const studioSummarySchema = z.strictObject({
  today: z.string(),
  counts: z.strictObject({
    activeClients: studioCounts,
    openCases: studioCounts,
    casesByState: z.strictObject({
      intake: studioCounts,
      active: studioCounts,
      waiting: studioCounts,
      delivered: studioCounts,
      closed: studioCounts
    }),
    overdueTasks: studioCounts,
    tasksDueSoon: studioCounts
  }),
  continueCase: studioCaseSchema.nullable(),
  activeCases: z.array(studioCaseSchema),
  upcomingTasks: z.array(
    z.strictObject({ ...studioRef, taskId: idSchema, title: z.string(), dueDate: z.string(), overdue: z.boolean() })
  ),
  recentActivity: z.array(
    z.strictObject({ ...studioRef, id: z.string(), kind: z.enum(['journal', 'event', 'time']), at: timestamp, label: z.string() })
  ),
  hours: z.strictObject({ weekMinutes: studioCounts, monthMinutes: studioCounts })
}) satisfies z.ZodType<StudioSummary>

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
  getNotebook: { args: z.tuple([idSchema]), result: notebookOutlineSchema.nullable() },
  createNotebookSection: { args: z.tuple([idSchema, sectionInputSchema]), result: notebookSectionResultSchema },
  renameNotebookSection: { args: z.tuple([idSchema, idSchema, sectionInputSchema]), result: notebookSectionResultSchema },
  moveNotebookSection: { args: z.tuple([idSchema, idSchema, notebookIndex]), result: notebookSectionResultSchema },
  archiveNotebookSection: { args: z.tuple([idSchema, idSchema]), result: notebookSectionResultSchema },
  unarchiveNotebookSection: { args: z.tuple([idSchema, idSchema]), result: notebookSectionResultSchema },
  createNotebookPage: { args: z.tuple([idSchema, idSchema, pageInputSchema]), result: notebookPageResultSchema },
  getNotebookPage: { args: z.tuple([idSchema, idSchema]), result: notebookPageSchema.nullable() },
  renameNotebookPage: { args: z.tuple([idSchema, idSchema, pageInputSchema]), result: notebookPageResultSchema },
  moveNotebookPage: { args: z.tuple([idSchema, idSchema, pageMoveSchema]), result: notebookPageResultSchema },
  archiveNotebookPage: { args: z.tuple([idSchema, idSchema]), result: notebookPageResultSchema },
  unarchiveNotebookPage: { args: z.tuple([idSchema, idSchema]), result: notebookPageResultSchema },
  saveNotebookPage: { args: z.tuple([idSchema, idSchema, pageSaveSchema]), result: notebookPageSaveResultSchema },
  listPageRevisions: { args: z.tuple([idSchema, idSchema]), result: z.array(pageRevisionSummarySchema) },
  getPageRevision: { args: z.tuple([idSchema, idSchema, idSchema]), result: pageRevisionSchema.nullable() },
  restorePageRevision: { args: z.tuple([idSchema, idSchema, idSchema, notebookVersion]), result: notebookPageSaveResultSchema },
  listCaseTasks: { args: z.tuple([idSchema]), result: z.array(taskSchema) },
  createCaseTask: { args: z.tuple([idSchema, taskInputSchema]), result: taskResultSchema },
  updateCaseTask: { args: z.tuple([idSchema, idSchema, taskInputSchema]), result: taskResultSchema },
  completeCaseTask: { args: z.tuple([idSchema, idSchema]), result: taskResultSchema },
  reopenCaseTask: { args: z.tuple([idSchema, idSchema]), result: taskResultSchema },
  listTimeEntries: { args: z.tuple([idSchema]), result: z.array(timeEntrySchema) },
  createTimeEntry: { args: z.tuple([idSchema, timeEntryInputSchema]), result: timeEntryResultSchema },
  updateTimeEntry: { args: z.tuple([idSchema, idSchema, timeEntryInputSchema]), result: timeEntryResultSchema },
  deleteTimeEntry: { args: z.tuple([idSchema, idSchema]), result: timeEntryResultSchema },
  getActiveTimer: { args: z.tuple([]), result: timerSnapshotSchema.nullable() },
  startTimer: { args: z.tuple([idSchema]), result: timerResultSchema },
  pauseTimer: { args: z.tuple([timerVersionSchema]), result: timerResultSchema },
  resumeTimer: { args: z.tuple([timerVersionSchema]), result: timerResultSchema },
  heartbeatTimer: { args: z.tuple([timerVersionSchema]), result: timerResultSchema },
  stopAndSaveTimer: { args: z.tuple([timerVersionSchema, stopOptionsSchema]), result: timerResultSchema },
  discardTimer: { args: z.tuple([timerVersionSchema]), result: timerResultSchema },
  getStudioSummary: { args: z.tuple([]), result: studioSummarySchema }
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
  },
  // Host-only home-network device administration (#136): loopback session only, never callable from a paired device.
  getLanStatus: {
    args: z.tuple([]),
    result: z.strictObject({ enabled: z.boolean(), origin: z.string().min(1).max(200).nullable() })
  },
  createPairingCode: {
    args: z.tuple([]),
    result: z.strictObject({ code: z.string().min(1).max(20), expiresAt: timestamp })
  },
  listDevices: {
    args: z.tuple([]),
    result: z.array(z.strictObject({ id: z.string().min(1).max(64), name: z.string().min(1).max(80), enrolledAt: timestamp, lastSeenAt: timestamp }))
  },
  revokeDevice: {
    args: z.tuple([z.string().min(1).max(64)]),
    result: z.strictObject({ revoked: z.boolean() })
  },
  revokeAllDevices: {
    args: z.tuple([]),
    result: z.strictObject({ revoked: count })
  },
  disableLan: {
    args: z.tuple([]),
    result: z.strictObject({ disabled: z.boolean() })
  }
} as const satisfies Record<string, CallContract<z.ZodTuple, z.ZodType>>
