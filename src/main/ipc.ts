import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
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
  type NoteChannel,
  type NoteDirection,
  type NoteInput,
  type ClientSource,
  type ContactChannel,
  type DirectoryQuery
} from '../shared/client-model'
import {
  IpcChannel,
  type AppInfo,
  type ClientMutationResult,
  type IpcChannelName,
  type NoteMutationResult
} from '../shared/ipc'

/** Thrown to the renderer without echoing its input (which may contain personal data). */
export class IpcRejectedError extends Error {
  constructor(reason: 'untrusted-sender' | 'invalid-arguments' | 'internal-error') {
    super(`IPC request rejected: ${reason}`)
    this.name = 'IpcRejectedError'
  }
}

interface ChannelContract<Args extends z.ZodTuple, Result extends z.ZodType> {
  channel: IpcChannelName
  args: Args
  result: Result
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
}

/** Note operations backing the notes:* channels (NoteRepository in production). */
export interface NoteService {
  list(clientId: string): ClientNote[]
  create(clientId: string, input: NoteInput): NoteMutationResult
  update(clientId: string, noteId: string, input: NoteInput): NoteMutationResult
}

export interface IpcDependencies {
  isTrustedSender: (url: string) => boolean
  getAppInfo: () => AppInfo
  clients: ClientService
  notes: NoteService
}

export function registerIpcHandlers(ipcMain: Pick<IpcMain, 'handle'>, deps: IpcDependencies): void {
  const c = contracts
  const { isTrustedSender, clients, notes } = deps
  const register = <Args extends z.ZodTuple, Result extends z.ZodType>(
    contract: ChannelContract<Args, Result>,
    impl: (args: z.output<Args>) => z.input<Result>
  ) => ipcMain.handle(contract.channel, createValidatedHandler(contract, isTrustedSender, impl))

  register(c.getAppInfo, () => deps.getAppInfo())
  register(c.listClients, ([query]) => clients.list(query))
  register(c.getClient, ([id]) => clients.get(id))
  register(c.createClient, ([input]) => clients.create(input))
  register(c.updateClient, ([id, input]) => clients.update(id, input))
  register(c.archiveClient, ([id]) => clients.archive(id))
  register(c.restoreClient, ([id]) => clients.restore(id))
  register(c.listNotes, ([clientId]) => notes.list(clientId))
  register(c.createNote, ([clientId, input]) => notes.create(clientId, input))
  register(c.updateNote, ([clientId, noteId, input]) => notes.update(clientId, noteId, input))
}
