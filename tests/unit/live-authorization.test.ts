import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppData } from '../../src/main/database/app-data'
import { DATABASE_FILE_NAME } from '../../src/main/database/connection'
import { createFakeIdentityProvider } from '../../src/server/auth/fake-provider'
import type { VerifiedIdentity } from '../../src/server/auth/identity'
import { authorizeCall } from '../../src/server/auth/policy'
import { RESEARCH_CLASS, type ResearchClass } from '../../src/server/auth/research-policy'
import { initLanTestProfile, LAN_TEST_MARKER } from '../../src/server/lan-profile'
import { CALL_NAMES, type CallName } from '../../src/server/live-host'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import type { NoteContent } from '../../src/shared/note-content'
import type { AppUser, UserMutationResult } from '../../src/shared/users'
import { diffManifests, manifestOf } from './helpers/db-manifest'
import { activeUser, newCase, newClient } from './helpers/ownership-helpers'
import { call, send, signIn, writeHeaders, type Reply, type Signed } from './live-helpers'

// #210: per-user research authorization over real HTTP. The Google identity provider is the
// deterministic fake (no Google, no network). Users A to F and O are seeded as approved, active
// people; every record, name and body below is made up.

const appInfo = { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' } as const
const NAME = 'tg.example.com'
const ORIGIN = `https://${NAME}`
const SESSION = '__Host-tg_session'
const LOGIN = '__Host-tg_login'
const nav = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }
const cb = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }

type Key = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'o'
const ALL_KEYS: Key[] = ['a', 'b', 'c', 'd', 'e', 'f', 'o']
const identityOf = (key: Key): VerifiedIdentity => ({
  provider: 'google',
  subject: `sub-${key}`,
  email: `sub-${key}@example.test`,
  emailVerified: true,
  emailAuthoritative: false,
  name: `Person ${key.toUpperCase()}`
})
const PEOPLE = Object.fromEntries(ALL_KEYS.map((key) => [`code-${key}`, identityOf(key)]))

// Each test seeds a profile and makes many requests or builds a world of people: allow for a loaded CI machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

let root: string
let dataDir: string
let staticDir: string
let running: RunningLiveServer | null

// ---- plumbing -------------------------------------------------------------------------------

function viaProxy(live: RunningLiveServer, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: live.port + 2, method, path, agent: false, setHost: false, headers: { Host: NAME, ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

const json = (headers: Record<string, string> = {}) => ({ 'Content-Type': 'application/json', ...headers })
const cookieOf = (reply: Reply, name: string): string | null => {
  const cookies = (reply.headers['set-cookie'] as string[] | undefined) ?? []
  const found = cookies.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
  return found ? found.split(';')[0]! : null
}

/** Port 0 picks the Live port; port + 2 may be taken, so retry a few times. */
async function startServer(options: { mode: 'plain' | 'pairing' | 'google' }): Promise<RunningLiveServer> {
  if (!existsSync(join(dataDir, LAN_TEST_MARKER))) initLanTestProfile(dataDir)
  let last: unknown
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      running = await startLiveServer({
        dataDir,
        port: 0,
        staticDir,
        appInfo,
        ...(options.mode === 'google' ? { httpsHost: NAME, identity: createFakeIdentityProvider({ identities: PEOPLE }) } : {}),
        ...(options.mode === 'pairing' ? { httpsHost: NAME } : {}),
        log: () => undefined
      })
      return running
    } catch (error) {
      last = error
      if (!(error instanceof Error) || !error.message.startsWith('Port ')) throw error
    }
  }
  throw last
}

/** A whole Google sign-in through the fake provider; returns the session cookie and CSRF token. */
async function signInAs(live: RunningLiveServer, key: Key): Promise<Signed> {
  const started = await viaProxy(live, 'GET', '/api/v1/auth/google/start', nav)
  expect(started.status, started.text).toBe(303)
  const callback = await viaProxy(live, 'GET', `/api/v1/auth/google/callback?code=code-${key}&state=s`, { Cookie: cookieOf(started, LOGIN)!, ...cb })
  expect(callback.status, callback.text).toBe(303)
  expect(callback.headers['location']).toBe('/')
  const cookie = cookieOf(callback, SESSION)
  expect(cookie).not.toBeNull()
  const probe = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: cookie! })).json() as { authenticated: boolean; csrfToken: string }
  expect(probe.authenticated).toBe(true)
  return { cookie: cookie!, csrf: probe.csrfToken }
}

const pcall = (live: RunningLiveServer, who: Signed, name: string, ...args: unknown[]) =>
  viaProxy(live, 'POST', `/api/v1/call/${name}`, json({ Origin: ORIGIN, Cookie: who.cookie, 'X-TG-CSRF': who.csrf }), JSON.stringify({ args }))

const hostCall = (live: RunningLiveServer, host: Signed, name: string, ...args: unknown[]) =>
  send(live, 'POST', `/api/v1/call/${name}`, writeHeaders(live, host), JSON.stringify({ args }))

const result = <T>(reply: Reply): T => {
  expect(reply.status, reply.text).toBe(200)
  return (reply.json() as { result: T }).result
}

/** The id inside a successful mutation result, e.g. `{ ok: true, client: { id } }` with key "client". */
function idOf(reply: Reply, key: string): string {
  const body = result<{ ok: boolean } & Record<string, unknown>>(reply)
  expect(body.ok, reply.text).toBe(true)
  return (body[key] as { id: string }).id
}

/** Runs `work` on a second connection to the profile (the running host keeps its own). */
function withData<T>(work: (data: AppData) => T): T {
  const side = new AppData(dataDir)
  try {
    return work(side)
  } finally {
    side.close()
  }
}

/** A read-only look at every table of the profile while the host is running. */
function manifestNow() {
  const db = new DatabaseSync(join(dataDir, 'data', DATABASE_FILE_NAME))
  try {
    return manifestOf(db)
  } finally {
    db.close()
  }
}

// ---- the fictional world ----------------------------------------------------------------------

type Users = Record<Key, AppUser>

interface World {
  live: RunningLiveServer
  host: Signed
  users: Users
  sessions: Partial<Record<Key, Signed>>
}

/**
 * Seeds an isolated fictional profile with the seven people (optionally after `beforeUsers`, which
 * creates pre-ownership data), starts the Google-mode host and signs `signedIn` people in.
 */
async function boot(options: { beforeUsers?: (data: AppData) => void; seed?: (data: AppData, users: Users) => void; signedIn?: Key[]; breakSchema?: boolean } = {}): Promise<World> {
  initLanTestProfile(dataDir)
  const users = withData((data) => {
    options.beforeUsers?.(data)
    const made = Object.fromEntries(ALL_KEYS.map((key) => [key, activeUser(data, `sub-${key}`, `Person ${key.toUpperCase()}`, key === 'o' ? 'owner' : 'researcher')])) as Users
    options.seed?.(data, made)
    return made
  })
  if (options.breakSchema) {
    const raw = new DatabaseSync(join(dataDir, 'data', DATABASE_FILE_NAME))
    try {
      raw.exec('PRAGMA foreign_keys = ON; DROP TABLE case_grants; DROP TABLE client_grants; DROP TABLE ownership_events; DROP TABLE client_ownership;')
    } finally {
      raw.close()
    }
  }
  const live = await startServer({ mode: 'google' })
  const host = await signIn(live)
  const sessions: Partial<Record<Key, Signed>> = {}
  for (const key of options.signedIn ?? ALL_KEYS) sessions[key] = await signInAs(live, key)
  return { live, host, users, sessions }
}

const sessionOf = (w: World, key: Key): Signed => w.sessions[key]!

// ---- fictional payloads ------------------------------------------------------------------------

const listQuery = { text: '', status: 'all', sources: [], sort: 'name' }
const everything = { clientId: null, archived: 'all', states: [], text: '', sort: 'created' }
const clientIn = (displayName: string) => ({
  displayName,
  source: 'direct',
  sourceDetail: null,
  fiverrUsername: null,
  email: null,
  otherContact: null,
  preferredContactChannel: 'unspecified'
})
const noteIn = (body: string) => ({ kind: 'note', occurredAt: '2026-10-20T10:00:00.000Z', channel: null, direction: null, body })
const caseIn = (title: string) => ({ title, goal: null, orderReference: null, dueDate: null })
const entryIn = (body: string) => ({ occurredAt: '2026-10-20T15:30:00.000Z', activity: null, body })
const taskIn = (title: string) => ({ title, description: null, dueDate: '2026-11-20' })
const timeIn = (durationMinutes: number) => ({ workDate: '2026-10-28', durationMinutes, activityType: 'research', note: null })
const briefIn = (objective: string) => ({ objective, facts: null, people: null, hypotheses: null, questions: null })
const stopIn = { activityType: null, note: null, durationMinutesOverride: null }
const doc = (text: string): NoteContent => ({
  format: 'tg-note',
  version: 1,
  blocks: [{ id: 'b0000000-0000-4000-8000-000000000001', type: 'paragraph', indent: 0, content: [{ text }] }]
})

interface Ids {
  clientId: string
  caseId: string
  case2Id: string
  noteId: string
  entryId: string
  taskId: string
  timeId: string
  sectionId: string
  pageId: string
  revisionId: string
  timerVersion: number
}

const freshIds = (): Ids => ({
  clientId: randomUUID(),
  caseId: randomUUID(),
  case2Id: randomUUID(),
  noteId: randomUUID(),
  entryId: randomUUID(),
  taskId: randomUUID(),
  timeId: randomUUID(),
  sectionId: randomUUID(),
  pageId: randomUUID(),
  revisionId: randomUUID(),
  timerVersion: 77
})

/** Everything a person's tag marks as theirs, so a leak shows up as a substring in a response. */
const markers = (tag: string): string[] => [`${tag} Client`, `${tag} Case`, `${tag} Second`, `${tag}-note`, `${tag}-journal`, `${tag}-task`, `${tag}-brief`, `${tag}-page`, `${tag} Section`]

/** Creates one person's client, two cases and one of every kind of record under the first, over HTTP. */
async function populate(live: RunningLiveServer, who: Signed, tag: string): Promise<Ids> {
  const clientId = idOf(await pcall(live, who, 'createClient', clientIn(`${tag} Client`)), 'client')
  const noteId = idOf(await pcall(live, who, 'createNote', clientId, noteIn(`${tag}-note body`)), 'note')
  const caseId = idOf(await pcall(live, who, 'createCase', clientId, caseIn(`${tag} Case`)), 'case')
  const case2Id = idOf(await pcall(live, who, 'createCase', clientId, caseIn(`${tag} Second`)), 'case')
  expect((await pcall(live, who, 'saveCaseBrief', caseId, briefIn(`${tag}-brief objective`))).status).toBe(200)
  await pcall(live, who, 'createJournalEntry', case2Id, entryIn(`${tag}-journal in the second case`))
  const entryId = idOf(await pcall(live, who, 'createJournalEntry', caseId, entryIn(`${tag}-journal entry`)), 'entry')
  const taskId = idOf(await pcall(live, who, 'createCaseTask', caseId, taskIn(`${tag}-task`)), 'task')
  const timeId = idOf(await pcall(live, who, 'createTimeEntry', caseId, timeIn(45)), 'entry')
  const sectionId = idOf(await pcall(live, who, 'createNotebookSection', caseId, { title: `${tag} Section` }), 'section')
  const pageId = idOf(await pcall(live, who, 'createNotebookPage', caseId, sectionId, { title: `${tag} Page` }), 'page')
  expect((await pcall(live, who, 'saveNotebookPage', caseId, pageId, { baseVersion: 1, content: doc(`${tag}-page text`) })).status).toBe(200)
  const revisions = result<{ id: string }[]>(await pcall(live, who, 'listPageRevisions', caseId, pageId))
  expect(revisions.length).toBeGreaterThan(0)
  return { clientId, caseId, case2Id, noteId, entryId, taskId, timeId, sectionId, pageId, revisionId: revisions[0]!.id, timerVersion: 1 }
}

// ---- the deny matrix: one entry per call name ---------------------------------------------------

type Probes = (i: Ids) => unknown[][]
type MatrixEntry = Probes | 'no-research'

const MATRIX: Record<CallName, MatrixEntry> = {
  getAppInfo: 'no-research',
  listClients: () => [[listQuery]],
  getClient: (i) => [[i.clientId]],
  createClient: () => [[clientIn('Matrix Probe Client')]],
  updateClient: (i) => [[i.clientId, clientIn('Changed')], [i.clientId, clientIn('')]],
  archiveClient: (i) => [[i.clientId]],
  restoreClient: (i) => [[i.clientId]],
  findDuplicateClients: (i) => [[clientIn('Alfa Client'), i.clientId], [clientIn(''), null]],
  listNotes: (i) => [[i.clientId]],
  createNote: (i) => [[i.clientId, noteIn('x')], [i.clientId, noteIn('')]],
  updateNote: (i) => [[i.clientId, i.noteId, noteIn('x')], [i.clientId, i.noteId, noteIn('')]],
  createBackup: 'no-research',
  restoreBackup: 'no-research',
  getBackupStatus: 'no-research',
  listCases: (i) => [[everything], [{ ...everything, clientId: i.clientId }]],
  getCase: (i) => [[i.caseId]],
  listCaseEvents: (i) => [[i.caseId]],
  createCase: (i) => [[i.clientId, caseIn('Planted')], [i.clientId, caseIn('')]],
  updateCase: (i) => [[i.caseId, caseIn('Changed')], [i.caseId, caseIn('')]],
  setCaseState: (i) => [[i.caseId, 'active']],
  archiveCase: (i) => [[i.caseId]],
  unarchiveCase: (i) => [[i.caseId]],
  getCaseBrief: (i) => [[i.caseId]],
  saveCaseBrief: (i) => [[i.caseId, briefIn('Overwritten')]],
  listJournalEntries: (i) => [[i.caseId]],
  createJournalEntry: (i) => [[i.caseId, entryIn('x')], [i.caseId, entryIn('')]],
  updateJournalEntry: (i) => [[i.caseId, i.entryId, entryIn('x')], [i.caseId, i.entryId, entryIn('')]],
  getNotebook: (i) => [[i.caseId]],
  createNotebookSection: (i) => [[i.caseId, { title: 'Planted' }], [i.caseId, { title: '' }]],
  renameNotebookSection: (i) => [[i.caseId, i.sectionId, { title: 'Renamed' }]],
  moveNotebookSection: (i) => [[i.caseId, i.sectionId, 0]],
  archiveNotebookSection: (i) => [[i.caseId, i.sectionId]],
  unarchiveNotebookSection: (i) => [[i.caseId, i.sectionId]],
  createNotebookPage: (i) => [[i.caseId, i.sectionId, { title: 'Planted' }], [i.caseId, i.sectionId, { title: '' }]],
  getNotebookPage: (i) => [[i.caseId, i.pageId]],
  renameNotebookPage: (i) => [[i.caseId, i.pageId, { title: 'Renamed' }]],
  moveNotebookPage: (i) => [[i.caseId, i.pageId, { sectionId: i.sectionId, toIndex: 0 }]],
  archiveNotebookPage: (i) => [[i.caseId, i.pageId]],
  unarchiveNotebookPage: (i) => [[i.caseId, i.pageId]],
  saveNotebookPage: (i) => [[i.caseId, i.pageId, { baseVersion: 2, content: doc('Overwritten') }], [i.caseId, i.pageId, { baseVersion: 99, content: doc('Stale') }]],
  listPageRevisions: (i) => [[i.caseId, i.pageId]],
  getPageRevision: (i) => [[i.caseId, i.pageId, i.revisionId]],
  restorePageRevision: (i) => [[i.caseId, i.pageId, i.revisionId, 2]],
  listCaseTasks: (i) => [[i.caseId]],
  createCaseTask: (i) => [[i.caseId, taskIn('Planted')], [i.caseId, taskIn('')]],
  updateCaseTask: (i) => [[i.caseId, i.taskId, taskIn('Changed')], [i.caseId, i.taskId, taskIn('')]],
  completeCaseTask: (i) => [[i.caseId, i.taskId]],
  reopenCaseTask: (i) => [[i.caseId, i.taskId]],
  listTimeEntries: (i) => [[i.caseId]],
  createTimeEntry: (i) => [[i.caseId, timeIn(30)], [i.caseId, timeIn(0)]],
  updateTimeEntry: (i) => [[i.caseId, i.timeId, timeIn(30)], [i.caseId, i.timeId, timeIn(0)]],
  deleteTimeEntry: (i) => [[i.caseId, i.timeId]],
  getActiveTimer: () => [[]],
  startTimer: (i) => [[i.caseId]],
  pauseTimer: (i) => [[i.timerVersion]],
  resumeTimer: (i) => [[i.timerVersion]],
  heartbeatTimer: (i) => [[i.timerVersion]],
  stopAndSaveTimer: (i) => [[i.timerVersion, stopIn]],
  discardTimer: (i) => [[i.timerVersion]],
  getStudioSummary: () => [[]],
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
}

/** Calls that create a record owned by the caller rather than touching an existing one: not part of the identical-answer check. */
const CREATES_OWN: ReadonlySet<CallName> = new Set(['createClient'])

type Caller = (name: string, ...args: unknown[]) => Promise<Reply>

/**
 * For every research call (optionally only some classes), `caller` using real ids it may not use must get
 * a response byte-identical (status and body) to the same call with fresh random ids, and no marker of
 * the real owner may appear anywhere.
 */
async function expectDeniedLikeMissing(label: string, caller: Caller, real: Ids, leaks: string[], classes?: ReadonlySet<ResearchClass>): Promise<number> {
  let compared = 0
  for (const name of CALL_NAMES) {
    const entry = MATRIX[name]
    if (entry === 'no-research' || CREATES_OWN.has(name)) continue
    const cls = RESEARCH_CLASS[name]
    if (classes && !classes.has(cls)) continue
    const denied = entry(real)
    const missing = entry(freshIds())
    expect(denied.length, `${name} probes`).toBe(missing.length)
    for (const [index, args] of denied.entries()) {
      const a = await caller(name, ...args)
      const b = await caller(name, ...missing[index]!)
      expect({ status: a.status, body: a.text }, `${label}: ${name} probe ${index}`).toEqual({ status: b.status, body: b.text })
      for (const secret of [...leaks, real.clientId, real.caseId, real.case2Id, real.noteId, real.entryId, real.taskId, real.timeId, real.sectionId, real.pageId, real.revisionId]) {
        expect(a.text.includes(secret), `${label}: ${name} probe ${index} leaked ${secret}`).toBe(false)
      }
      compared++
    }
  }
  return compared
}

const WRITES: ReadonlySet<ResearchClass> = new Set<ResearchClass>(['client-write', 'case-write', 'timer-start', 'timer-write'])

// ---- lifecycle ------------------------------------------------------------------------------------

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-live-authorization-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  running = null
})

afterEach(async () => {
  await running?.close()
  rmSync(root, { recursive: true, force: true })
})

// ---- tests ----------------------------------------------------------------------------------------

describe('the matrix covers every call', () => {
  it('has an entry for every call name, and the classification agrees with it', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...CALL_NAMES].sort())
    for (const name of CALL_NAMES) {
      const cls = RESEARCH_CLASS[name]
      expect(MATRIX[name] === 'no-research', `${name} is ${cls}`).toBe(cls === 'no-research')
      if (MATRIX[name] !== 'no-research') expect((MATRIX[name] as Probes)(freshIds()).length, name).toBeGreaterThan(0)
    }
  })
})

describe('two researchers', () => {
  it('each create their own records and see only their own in every list, count, summary and duplicate check', async () => {
    const w = await boot({ signedIn: ['a', 'b'] })
    const a = sessionOf(w, 'a')
    const b = sessionOf(w, 'b')
    const idsA = await populate(w.live, a, 'Alfa')
    const idsB = await populate(w.live, b, 'Bravo')

    const clientsA = result<{ id: string; displayName: string }[]>(await pcall(w.live, a, 'listClients', listQuery))
    const clientsB = result<{ id: string; displayName: string }[]>(await pcall(w.live, b, 'listClients', listQuery))
    expect(clientsA.map((c) => c.id)).toEqual([idsA.clientId])
    expect(clientsB.map((c) => c.id)).toEqual([idsB.clientId])
    expect(result<{ id: string }[]>(await pcall(w.live, a, 'listCases', everything)).map((c) => c.id).sort()).toEqual([idsA.caseId, idsA.case2Id].sort())
    expect(result<{ id: string }[]>(await pcall(w.live, b, 'listCases', everything)).map((c) => c.id).sort()).toEqual([idsB.caseId, idsB.case2Id].sort())

    // Search and filters never cross over.
    expect(result<unknown[]>(await pcall(w.live, b, 'listClients', { ...listQuery, text: 'Alfa' }))).toEqual([])
    expect(result<unknown[]>(await pcall(w.live, a, 'listCases', { ...everything, text: 'Bravo' }))).toEqual([])
    expect(result<unknown[]>(await pcall(w.live, b, 'listCases', { ...everything, clientId: idsA.clientId }))).toEqual([])

    // Duplicate check: the same name is a duplicate of one's own client only.
    const probe = clientIn('Alfa Client')
    expect(result<{ client: { id: string } }[]>(await pcall(w.live, a, 'findDuplicateClients', probe, null)).map((d) => d.client.id)).toEqual([idsA.clientId])
    expect(result<unknown[]>(await pcall(w.live, b, 'findDuplicateClients', probe, null))).toEqual([])
    expect(result<unknown[]>(await pcall(w.live, b, 'findDuplicateClients', probe, idsA.clientId))).toEqual([])

    // Summary, counts and activity.
    for (const [who, own, other] of [[a, idsA, idsB], [b, idsB, idsA]] as const) {
      const summary = result<{ counts: { activeClients: number; openCases: number }; activeCases: { caseId: string }[]; recentActivity: { caseId: string }[]; upcomingTasks: { caseId: string }[] }>(
        await pcall(w.live, who, 'getStudioSummary')
      )
      expect(summary.counts).toMatchObject({ activeClients: 1, openCases: 2 })
      expect(summary.activeCases.map((c) => c.caseId).sort()).toEqual([own.caseId, own.case2Id].sort())
      expect(summary.upcomingTasks.map((t) => t.caseId)).toEqual([own.caseId])
      expect(summary.recentActivity.every((e) => e.caseId === own.caseId || e.caseId === own.case2Id)).toBe(true)
      expect(JSON.stringify(summary)).not.toContain(other.caseId)
    }

    // Each sees their own children, and none of the other's.
    expect(result<{ id: string }[]>(await pcall(w.live, b, 'listCaseTasks', idsB.caseId))).toHaveLength(1)
    expect(result<{ id: string }[]>(await pcall(w.live, b, 'listCaseTasks', idsA.caseId))).toEqual([])
    expect(result(await pcall(w.live, b, 'getClient', idsA.clientId))).toBeNull()
    expect(result(await pcall(w.live, b, 'getNotebookPage', idsA.caseId, idsA.pageId))).toBeNull()
    expect(result<{ id: string }[]>(await pcall(w.live, a, 'listNotes', idsA.clientId)).map((n) => n.id)).toContain(idsA.noteId)

    // A full read sweep as B with A's ids shows nothing of A.
    const sweep = await expectDeniedLikeMissing('B reads A', (name, ...args) => pcall(w.live, b, name, ...args), idsA, markers('Alfa'))
    expect(sweep).toBeGreaterThan(50)
  })

  it('answers B exactly as for a missing id on every call, for valid and invalid input, and changes no data', async () => {
    const w = await boot({ signedIn: ['a', 'b'] })
    const a = sessionOf(w, 'a')
    const b = sessionOf(w, 'b')
    const idsA = await populate(w.live, a, 'Alfa')
    await populate(w.live, b, 'Bravo')
    // A's pending timer, so the timer calls have something to hide.
    const started = result<{ ok: true; timer: { version: number } }>(await pcall(w.live, a, 'startTimer', idsA.caseId))
    const real: Ids = { ...idsA, timerVersion: started.timer.version }

    const before = manifestNow()
    const compared = await expectDeniedLikeMissing('B', (name, ...args) => pcall(w.live, b, name, ...args), real, markers('Alfa'))
    expect(compared).toBeGreaterThan(55)
    expect(diffManifests(before, manifestNow())).toEqual([])
    // A's data and timer are exactly as they were.
    expect(result<{ caseId: string; version: number }>(await pcall(w.live, a, 'getActiveTimer'))).toMatchObject({ caseId: idsA.caseId, version: started.timer.version })
    expect(result<{ title: string }>(await pcall(w.live, a, 'getCase', idsA.caseId)).title).toBe('Alfa Case')
  })

  it('refuses the host-only and admin calls to a researcher and leaves their own account readable', async () => {
    const w = await boot({ signedIn: ['b'] })
    const b = sessionOf(w, 'b')
    for (const name of CALL_NAMES) {
      if (MATRIX[name] !== 'no-research' || name === 'revokeMySessions') continue
      const reply = await pcall(w.live, b, name)
      const decision = authorizeCall(name, { kind: 'user', role: 'researcher', userId: w.users.b.id })
      if (decision.allowed) expect(reply.status, name).toBe(200)
      else {
        expect(reply.status, name).toBe(403)
        expect(reply.json(), name).toEqual({ error: decision.code })
      }
    }
    expect(result<AppUser>(await pcall(w.live, b, 'getMyAccount')).id).toBe(w.users.b.id)
  })

  it('does not keep working for a person who was turned off, through a research call', async () => {
    const w = await boot({ signedIn: ['b', 'o'] })
    const b = sessionOf(w, 'b')
    const o = sessionOf(w, 'o')
    expect((await pcall(w.live, b, 'listClients', listQuery)).status).toBe(200)
    const current = result<AppUser[]>(await pcall(w.live, o, 'listUsers')).find((u) => u.id === w.users.b.id)!
    expect(result<UserMutationResult>(await pcall(w.live, o, 'setUserStatus', current.id, 'disabled', current.version))).toMatchObject({ ok: true })
    for (const [name, args] of [['listClients', [listQuery]], ['getStudioSummary', []], ['createClient', [clientIn('After off')]]] as const) {
      const reply = await pcall(w.live, b, name, ...args)
      expect(reply.status, name).toBe(401)
      expect(reply.json(), name).toEqual({ error: 'not-signed-in' })
    }
    expect(withData((d) => d.clients.list({ text: '', status: 'all', sources: [], sort: 'name' }).map((c) => c.displayName))).not.toContain('After off')
  })
})

describe('the app owner role', () => {
  it('reads no researcher content without a grant, and role changes never create one', async () => {
    const w = await boot({ signedIn: ['a', 'b', 'o'] })
    const a = sessionOf(w, 'a')
    const o = sessionOf(w, 'o')
    const idsA = await populate(w.live, a, 'Alfa')

    expect(result<unknown[]>(await pcall(w.live, o, 'listClients', listQuery))).toEqual([])
    expect(result<unknown[]>(await pcall(w.live, o, 'listCases', everything))).toEqual([])
    expect(result(await pcall(w.live, o, 'getClient', idsA.clientId))).toBeNull()
    expect(result<{ counts: { activeClients: number } }>(await pcall(w.live, o, 'getStudioSummary')).counts.activeClients).toBe(0)
    const before = manifestNow()
    await expectDeniedLikeMissing('owner role', (name, ...args) => pcall(w.live, o, name, ...args), idsA, markers('Alfa'))
    expect(diffManifests(before, manifestNow())).toEqual([])

    // The owner can administer accounts: promote B to owner, demote A to researcher is not needed here.
    const users = result<AppUser[]>(await pcall(w.live, o, 'listUsers'))
    const bUser = users.find((u) => u.id === w.users.b.id)!
    expect(result<UserMutationResult>(await pcall(w.live, o, 'setUserRole', bUser.id, 'owner', bUser.version))).toMatchObject({ ok: true })
    const promoted = await signInAs(w.live, 'b')
    expect((await pcall(w.live, promoted, 'listUsers')).status).toBe(200)
    // B is now an app owner and still cannot read A's records.
    expect(result(await pcall(w.live, promoted, 'getClient', idsA.clientId))).toBeNull()
    expect(result<unknown[]>(await pcall(w.live, promoted, 'listClients', listQuery))).toEqual([])
    expect(withData((d) => d.ownership.listGrants({ clientId: idsA.clientId }))).toEqual([])
  })
})

describe('unclaimed legacy records and the host', () => {
  it('stay invisible to every user and to the host session, and the host cannot create ownerless clients', async () => {
    const legacy = { clientId: '', caseId: '' }
    const w = await boot({
      signedIn: ['a', 'b', 'o'],
      beforeUsers: (data) => {
        legacy.clientId = newClient(data, 'Legacy Client', null)
        legacy.caseId = newCase(data, legacy.clientId, 'Legacy Case')
        expect(data.notes.create(legacy.clientId, { kind: 'note', occurredAt: '2026-10-20T10:00:00.000Z', channel: null, direction: null, body: 'legacy-note body' }).ok).toBe(true)
      }
    })
    for (const key of ['a', 'b', 'o'] as const) {
      const who = sessionOf(w, key)
      expect(result<unknown[]>(await pcall(w.live, who, 'listClients', listQuery))).toEqual([])
      expect(result<unknown[]>(await pcall(w.live, who, 'listCases', everything))).toEqual([])
      expect(result(await pcall(w.live, who, 'getClient', legacy.clientId))).toBeNull()
      expect(result(await pcall(w.live, who, 'getCase', legacy.caseId))).toBeNull()
      expect(result<unknown[]>(await pcall(w.live, who, 'listNotes', legacy.clientId))).toEqual([])
      expect(result<unknown[]>(await pcall(w.live, who, 'findDuplicateClients', clientIn('Legacy Client'), null))).toEqual([])
      expect(result<{ counts: { activeClients: number } }>(await pcall(w.live, who, 'getStudioSummary')).counts.activeClients).toBe(0)
      expect(JSON.stringify(result(await pcall(w.live, who, 'getStudioSummary')))).not.toContain('Legacy')
    }

    // The host session (loopback) in a profile with users: empty lists, nothing by id, no create.
    expect(result<unknown[]>(await hostCall(w.live, w.host, 'listClients', listQuery))).toEqual([])
    expect(result<unknown[]>(await hostCall(w.live, w.host, 'listCases', everything))).toEqual([])
    expect(result(await hostCall(w.live, w.host, 'getClient', legacy.clientId))).toBeNull()
    expect(result(await hostCall(w.live, w.host, 'getCase', legacy.caseId))).toBeNull()
    expect(result<{ counts: { activeClients: number } }>(await hostCall(w.live, w.host, 'getStudioSummary')).counts.activeClients).toBe(0)
    const create = await hostCall(w.live, w.host, 'createClient', clientIn('Host Attempt'))
    expect(create.status).toBe(409)
    expect(create.json()).toEqual({ error: 'owner-required' })
    const real: Ids = { ...freshIds(), clientId: legacy.clientId, caseId: legacy.caseId }
    const before = manifestNow()
    await expectDeniedLikeMissing('host', (name, ...args) => hostCall(w.live, w.host, name, ...args), real, ['Legacy', 'legacy-note'])
    expect(diffManifests(before, manifestNow())).toEqual([])

    // Backup and user administration are not research calls: they keep working for the host.
    expect((await hostCall(w.live, w.host, 'getBackupStatus')).status).toBe(200)
    const backup = result<{ ok: boolean; clients: number }>(await hostCall(w.live, w.host, 'createBackup'))
    expect(backup).toMatchObject({ ok: true, clients: 1 })
    expect(result<AppUser[]>(await hostCall(w.live, w.host, 'listUsers'))).toHaveLength(ALL_KEYS.length)
  })
})

describe('grants', () => {
  /** A owns the world; C is a client viewer, D a client editor, E a case viewer and F a case editor of A's first case. */
  async function grantedWorld() {
    const w = await boot({ signedIn: ['a', 'b', 'c', 'd', 'e', 'f', 'o'] })
    const ids = await populate(w.live, sessionOf(w, 'a'), 'Alfa')
    withData((d) => {
      const grant = (outcome: { ok: boolean }) => expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
      grant(d.ownership.setClientGrant({ clientId: ids.clientId, granteeUserId: w.users.c.id, permission: 'viewer', grantedBy: w.users.a.id }))
      grant(d.ownership.setClientGrant({ clientId: ids.clientId, granteeUserId: w.users.d.id, permission: 'editor', grantedBy: w.users.a.id }))
      grant(d.ownership.setCaseGrant({ caseId: ids.caseId, granteeUserId: w.users.e.id, permission: 'viewer', grantedBy: w.users.a.id }))
      grant(d.ownership.setCaseGrant({ caseId: ids.caseId, granteeUserId: w.users.f.id, permission: 'editor', grantedBy: w.users.a.id }))
    })
    return { w, ids }
  }

  it('lets a client viewer read the client, all its cases and descendants, and denies every write', async () => {
    const { w, ids } = await grantedWorld()
    const c = sessionOf(w, 'c')
    expect(result<{ id: string }>(await pcall(w.live, c, 'getClient', ids.clientId)).id).toBe(ids.clientId)
    expect(result<{ id: string }[]>(await pcall(w.live, c, 'listClients', listQuery)).map((x) => x.id)).toEqual([ids.clientId])
    expect(result<{ id: string }[]>(await pcall(w.live, c, 'listCases', everything)).map((x) => x.id).sort()).toEqual([ids.caseId, ids.case2Id].sort())
    expect(result<{ id: string }[]>(await pcall(w.live, c, 'listNotes', ids.clientId)).map((n) => n.id)).toContain(ids.noteId)
    expect(result<{ title: string }>(await pcall(w.live, c, 'getCase', ids.case2Id)).title).toBe('Alfa Second')
    expect(result<{ objective: string }>(await pcall(w.live, c, 'getCaseBrief', ids.caseId)).objective).toContain('Alfa-brief')
    expect(result<unknown[]>(await pcall(w.live, c, 'listJournalEntries', ids.caseId))).toHaveLength(1)
    expect(result<unknown[]>(await pcall(w.live, c, 'listCaseTasks', ids.caseId))).toHaveLength(1)
    expect(result<unknown[]>(await pcall(w.live, c, 'listTimeEntries', ids.caseId))).toHaveLength(1)
    expect(result<{ sections: unknown[] }>(await pcall(w.live, c, 'getNotebook', ids.caseId)).sections).toHaveLength(1)
    expect(result<{ id: string }>(await pcall(w.live, c, 'getNotebookPage', ids.caseId, ids.pageId)).id).toBe(ids.pageId)
    expect(result<unknown[]>(await pcall(w.live, c, 'listPageRevisions', ids.caseId, ids.pageId)).length).toBeGreaterThan(0)
    expect(result<{ counts: { activeClients: number; openCases: number } }>(await pcall(w.live, c, 'getStudioSummary')).counts).toMatchObject({ activeClients: 1, openCases: 2 })

    const before = manifestNow()
    const compared = await expectDeniedLikeMissing('client viewer writes', (name, ...args) => pcall(w.live, c, name, ...args), ids, [], WRITES)
    expect(compared).toBeGreaterThan(30)
    expect(diffManifests(before, manifestNow())).toEqual([])
    // The grant does not reach A's other clients or anyone else's data.
    expect(withData((d) => d.ownership.getClientOwner(ids.clientId)?.ownerUserId)).toBe(w.users.a.id)
  })

  it('lets a client editor write and leaves the owner as the owner', async () => {
    const { w, ids } = await grantedWorld()
    const d = sessionOf(w, 'd')
    expect(result<{ ok: boolean }>(await pcall(w.live, d, 'updateClient', ids.clientId, clientIn('Alfa Client Edited'))).ok).toBe(true)
    const note = idOf(await pcall(w.live, d, 'createNote', ids.clientId, noteIn('Alfa-note by the editor')), 'note')
    const madeCase = idOf(await pcall(w.live, d, 'createCase', ids.clientId, caseIn('Alfa Case by editor')), 'case')
    expect(result<{ ok: boolean }>(await pcall(w.live, d, 'createJournalEntry', madeCase, entryIn('Alfa-journal by the editor'))).ok).toBe(true)
    expect(result<{ ok: boolean }>(await pcall(w.live, d, 'saveNotebookPage', ids.caseId, ids.pageId, { baseVersion: 2, content: doc('Alfa-page edited') })).ok).toBe(true)
    expect(result<{ ok: boolean }>(await pcall(w.live, d, 'setCaseState', ids.caseId, 'active')).ok).toBe(true)
    expect(note).not.toBe('')
    // The editor sees only that client; the owner sees everything, including what the editor made.
    expect(result<{ id: string }[]>(await pcall(w.live, d, 'listClients', listQuery)).map((x) => x.id)).toEqual([ids.clientId])
    expect(result<{ title: string }[]>(await pcall(w.live, sessionOf(w, 'a'), 'listCases', everything)).map((x) => x.title)).toContain('Alfa Case by editor')
    const owners = withData((data) => ({ client: data.ownership.getClientOwner(ids.clientId), made: data.ownership.getCaseOwner(madeCase), grants: data.ownership.listGrants({ clientId: ids.clientId }) }))
    expect(owners.client).toMatchObject({ ownerUserId: w.users.a.id })
    expect(owners.made).toMatchObject({ ownerUserId: w.users.a.id })
    expect(owners.grants.map((g) => g.granteeUserId).sort()).toEqual([w.users.c.id, w.users.d.id].sort())
    // Not the other account's data.
    expect(result<unknown[]>(await pcall(w.live, d, 'listCases', { ...everything, clientId: randomUUID() }))).toEqual([])
  })

  it('shows a case viewer that one case only: not its siblings, not the client, not the client notes', async () => {
    const { w, ids } = await grantedWorld()
    const e = sessionOf(w, 'e')
    expect(result<{ id: string }[]>(await pcall(w.live, e, 'listCases', everything)).map((x) => x.id)).toEqual([ids.caseId])
    expect(result<{ id: string }>(await pcall(w.live, e, 'getCase', ids.caseId)).id).toBe(ids.caseId)
    expect(result(await pcall(w.live, e, 'getCase', ids.case2Id))).toBeNull()
    expect(result<unknown[]>(await pcall(w.live, e, 'listJournalEntries', ids.case2Id))).toEqual([])
    expect(result<unknown[]>(await pcall(w.live, e, 'listJournalEntries', ids.caseId))).toHaveLength(1)
    expect(result(await pcall(w.live, e, 'getClient', ids.clientId))).toBeNull()
    expect(result<unknown[]>(await pcall(w.live, e, 'listClients', listQuery))).toEqual([])
    expect(result<unknown[]>(await pcall(w.live, e, 'listNotes', ids.clientId))).toEqual([])
    expect(result<unknown[]>(await pcall(w.live, e, 'findDuplicateClients', clientIn('Alfa Client'), null))).toEqual([])
    const summary = result<{ counts: { activeClients: number }; activeCases: { caseId: string; clientDisplayName: string }[] }>(await pcall(w.live, e, 'getStudioSummary'))
    expect(summary.counts.activeClients).toBe(0)
    expect(summary.activeCases.map((x) => x.caseId)).toEqual([ids.caseId])
    expect(JSON.stringify(summary)).not.toContain('Alfa Client')
    // A case viewer cannot write, create cases under the client or change the client.
    const before = manifestNow()
    await expectDeniedLikeMissing('case viewer writes', (name, ...args) => pcall(w.live, e, name, ...args), ids, [], WRITES)
    expect(result(await pcall(w.live, e, 'createJournalEntry', ids.caseId, entryIn('x')))).toEqual({ ok: false, reason: 'not-found' })
    expect(result(await pcall(w.live, e, 'createCase', ids.clientId, caseIn('Sneaky')))).toEqual({ ok: false, reason: 'not-found' })
    expect(result(await pcall(w.live, e, 'updateClient', ids.clientId, clientIn('Sneaky')))).toEqual({ ok: false, reason: 'not-found' })
    expect(diffManifests(before, manifestNow())).toEqual([])
  })

  it('lets a case editor write only inside that case', async () => {
    const { w, ids } = await grantedWorld()
    const f = sessionOf(w, 'f')
    expect(result<{ ok: boolean }>(await pcall(w.live, f, 'createJournalEntry', ids.caseId, entryIn('Alfa-journal by the case editor'))).ok).toBe(true)
    expect(result<{ ok: boolean }>(await pcall(w.live, f, 'createCaseTask', ids.caseId, taskIn('Alfa-task by the case editor'))).ok).toBe(true)
    expect(result(await pcall(w.live, f, 'createJournalEntry', ids.case2Id, entryIn('x')))).toEqual({ ok: false, reason: 'not-found' })
    expect(result(await pcall(w.live, f, 'updateClient', ids.clientId, clientIn('Sneaky')))).toEqual({ ok: false, reason: 'not-found' })
    // A child of the sibling case addressed through the case the editor may use.
    const sibling = result<{ id: string }[]>(await pcall(w.live, sessionOf(w, 'a'), 'listJournalEntries', ids.case2Id))[0]!
    expect(result(await pcall(w.live, f, 'updateJournalEntry', ids.caseId, sibling.id, entryIn('Hijacked')))).toEqual({ ok: false, reason: 'not-found' })
    expect(result<{ body: string }[]>(await pcall(w.live, sessionOf(w, 'a'), 'listJournalEntries', ids.case2Id))[0]!.body).toContain('Alfa-journal in the second case')
  })

  it('ends a grant on the very next request with the same session', async () => {
    const { w, ids } = await grantedWorld()
    const c = sessionOf(w, 'c')
    const e = sessionOf(w, 'e')
    expect(result(await pcall(w.live, c, 'getClient', ids.clientId))).not.toBeNull()
    expect(result(await pcall(w.live, e, 'getCase', ids.caseId))).not.toBeNull()
    withData((d) => {
      expect(d.ownership.revokeClientGrant({ clientId: ids.clientId, granteeUserId: w.users.c.id, revokedBy: w.users.a.id })).toMatchObject({ ok: true, revoked: true })
      expect(d.ownership.revokeCaseGrant({ caseId: ids.caseId, granteeUserId: w.users.e.id, revokedBy: w.users.a.id })).toMatchObject({ ok: true, revoked: true })
    })
    expect(result(await pcall(w.live, c, 'getClient', ids.clientId))).toBeNull()
    expect(result<unknown[]>(await pcall(w.live, c, 'listClients', listQuery))).toEqual([])
    expect(result<unknown[]>(await pcall(w.live, c, 'listCases', everything))).toEqual([])
    expect(result(await pcall(w.live, e, 'getCase', ids.caseId))).toBeNull()
    expect(result<unknown[]>(await pcall(w.live, e, 'listCases', everything))).toEqual([])
    await expectDeniedLikeMissing('revoked', (name, ...args) => pcall(w.live, c, name, ...args), ids, markers('Alfa'))
  })

  it('stops working when the grantee is turned off (the session ends) or when the owner is turned off (the grant is void)', async () => {
    const { w, ids } = await grantedWorld()
    const o = sessionOf(w, 'o')
    const c = sessionOf(w, 'c')
    const d = sessionOf(w, 'd')
    const users = result<AppUser[]>(await pcall(w.live, o, 'listUsers'))
    const find = (id: string) => users.find((u) => u.id === id)!

    // Turn the grantee C off: the session ends, and the SQL would deny it anyway.
    expect(result<UserMutationResult>(await pcall(w.live, o, 'setUserStatus', w.users.c.id, 'disabled', find(w.users.c.id).version))).toMatchObject({ ok: true })
    expect((await pcall(w.live, c, 'getClient', ids.clientId)).status).toBe(401)

    // Turn the owner A off: D's session stays valid, but the grant of a disabled owner is void.
    expect(result(await pcall(w.live, d, 'getClient', ids.clientId))).not.toBeNull()
    expect(result<UserMutationResult>(await pcall(w.live, o, 'setUserStatus', w.users.a.id, 'disabled', find(w.users.a.id).version))).toMatchObject({ ok: true })
    expect((await pcall(w.live, sessionOf(w, 'a'), 'listClients', listQuery)).status).toBe(401)
    expect(result(await pcall(w.live, d, 'getClient', ids.clientId))).toBeNull()
    expect(result<unknown[]>(await pcall(w.live, d, 'listClients', listQuery))).toEqual([])
    expect(result<unknown[]>(await pcall(w.live, d, 'listCases', everything))).toEqual([])
    expect(result(await pcall(w.live, d, 'updateClient', ids.clientId, clientIn('After owner off')))).toEqual({ ok: false, reason: 'not-found' })
    expect(withData((data) => data.clients.get(ids.clientId)?.displayName)).toBe('Alfa Client')
    // The case grantee F is cut off the same way.
    expect(result(await pcall(w.live, sessionOf(w, 'f'), 'getCase', ids.caseId))).toBeNull()
  })

  it('keeps everything private across a restart of the host', async () => {
    const { w, ids } = await grantedWorld()
    expect(result<unknown[]>(await pcall(w.live, sessionOf(w, 'b'), 'listClients', listQuery))).toEqual([])
    await w.live.close()
    running = null
    const live = await startServer({ mode: 'google' })
    const a = await signInAs(live, 'a')
    const b = await signInAs(live, 'b')
    const c = await signInAs(live, 'c')
    expect(result<{ id: string }[]>(await pcall(live, a, 'listClients', listQuery)).map((x) => x.id)).toEqual([ids.clientId])
    expect(result<unknown[]>(await pcall(live, b, 'listClients', listQuery))).toEqual([])
    expect(result(await pcall(live, b, 'getClient', ids.clientId))).toBeNull()
    expect(result(await pcall(live, c, 'getClient', ids.clientId))).not.toBeNull()
    expect(result(await pcall(live, c, 'updateClient', ids.clientId, clientIn('x')))).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('the global timer between accounts', () => {
  it('hides a timer from people who cannot read its case and only reports "busy" on start', async () => {
    const w = await boot({ signedIn: ['a', 'b'] })
    const a = sessionOf(w, 'a')
    const b = sessionOf(w, 'b')
    const idsA = await populate(w.live, a, 'Alfa')
    const idsB = await populate(w.live, b, 'Bravo')
    const started = result<{ ok: true; timer: { version: number } }>(await pcall(w.live, a, 'startTimer', idsA.caseId))
    expect(result(await pcall(w.live, b, 'getActiveTimer'))).toBeNull()
    const busy = await pcall(w.live, b, 'startTimer', idsB.caseId)
    expect(busy.status).toBe(200)
    expect(busy.json()).toEqual({ result: { ok: false, reason: 'conflict', timer: null } })
    expect(busy.text).not.toContain(idsA.caseId)
    for (const name of ['pauseTimer', 'resumeTimer', 'heartbeatTimer', 'discardTimer'] as const) {
      expect(result(await pcall(w.live, b, name, started.timer.version)), name).toEqual({ ok: false, reason: 'not-found' })
    }
    expect(result(await pcall(w.live, b, 'stopAndSaveTimer', started.timer.version, stopIn))).toEqual({ ok: false, reason: 'not-found' })
    expect(result<{ caseId: string }>(await pcall(w.live, a, 'getActiveTimer')).caseId).toBe(idsA.caseId)
  })
})

describe('a profile without users', () => {
  it('keeps the host working with full access, as before', async () => {
    initLanTestProfile(dataDir)
    const live = await startServer({ mode: 'plain' })
    const host = await signIn(live)
    const made = await call<{ ok: true; client: { id: string } }>(live, host, 'createClient', clientIn('Solo Client'))
    expect(made.ok).toBe(true)
    const caseId = (await call<{ ok: true; case: { id: string } }>(live, host, 'createCase', made.client.id, caseIn('Solo Case'))).case.id
    expect((await call<{ id: string }[]>(live, host, 'listClients', listQuery)).map((c) => c.id)).toEqual([made.client.id])
    expect(await call<{ id: string }>(live, host, 'getClient', made.client.id)).toMatchObject({ id: made.client.id })
    expect((await call<{ id: string }[]>(live, host, 'listCases', everything)).map((c) => c.id)).toEqual([caseId])
    expect(await call<{ counts: { activeClients: number } }>(live, host, 'getStudioSummary')).toMatchObject({ counts: { activeClients: 1 } })
    expect(await call(live, host, 'startTimer', caseId)).toMatchObject({ ok: true })
    expect(await call(live, host, 'getActiveTimer')).toMatchObject({ caseId })
  })

  it('turns to nothing the moment the first user exists', async () => {
    initLanTestProfile(dataDir)
    const live = await startServer({ mode: 'plain' })
    const host = await signIn(live)
    const made = await call<{ ok: true; client: { id: string } }>(live, host, 'createClient', clientIn('Solo Client'))
    expect(await call<unknown[]>(live, host, 'listClients', listQuery)).toHaveLength(1)
    withData((d) => activeUser(d, 'sub-first', 'First Person'))
    expect(await call<unknown[]>(live, host, 'listClients', listQuery)).toEqual([])
    expect(await call(live, host, 'getClient', made.client.id)).toBeNull()
    expect((await hostCall(live, host, 'createClient', clientIn('Late'))).status).toBe(409)
  })

  it('gives a paired device no research access once the profile has users', async () => {
    initLanTestProfile(dataDir)
    withData((d) => {
      const legacy = newClient(d, 'Legacy Client', null)
      newCase(d, legacy, 'Legacy Case')
      activeUser(d, 'sub-first', 'First Person')
    })
    // Pairing-mode HTTPS (no identity provider): devices, not people.
    await startServer({ mode: 'pairing' })
    if (!running) throw new Error('not running')
    const host = await signIn(running)
    const { code } = await call<{ code: string }>(running, host, 'createPairingCode')
    const enrolled = await viaProxy(running, 'POST', '/api/v1/lan/enroll', json({ Origin: ORIGIN }), JSON.stringify({ code, deviceName: 'Kitchen tablet' }))
    expect(enrolled.status, enrolled.text).toBe(200)
    const cookie = String(enrolled.headers['set-cookie']?.[0]).split(';')[0]!
    const session = (await viaProxy(running, 'GET', '/api/v1/session', { Cookie: cookie })).json() as { csrfToken: string }
    const device: Signed = { cookie, csrf: session.csrfToken }
    expect(result<unknown[]>(await pcall(running, device, 'listClients', listQuery))).toEqual([])
    expect(result<unknown[]>(await pcall(running, device, 'listCases', everything))).toEqual([])
    expect(result<{ counts: { activeClients: number } }>(await pcall(running, device, 'getStudioSummary')).counts.activeClients).toBe(0)
    const create = await pcall(running, device, 'createClient', clientIn('Device Attempt'))
    expect(create.status).toBe(409)
    expect(create.json()).toEqual({ error: 'owner-required' })
  })
})

describe('an incompatible schema', () => {
  it('refuses every research call with 503 research-unavailable for users and the host, and never falls back to shared access', async () => {
    const w = await boot({ signedIn: ['a'], breakSchema: true })
    const a = sessionOf(w, 'a')
    const callers: [string, Caller][] = [
      ['user', (name, ...args) => pcall(w.live, a, name, ...args)],
      ['host', (name, ...args) => hostCall(w.live, w.host, name, ...args)]
    ]
    for (const [label, caller] of callers) {
      let refused = 0
      for (const name of CALL_NAMES) {
        const entry = MATRIX[name]
        if (entry === 'no-research') continue
        const reply = await caller(name, ...entry(freshIds())[0]!)
        expect(reply.status, `${label}: ${name}`).toBe(503)
        expect(reply.json(), `${label}: ${name}`).toEqual({ error: 'research-unavailable' })
        refused++
      }
      expect(refused).toBeGreaterThan(50)
    }
    // Calls that carry no research content still work.
    expect((await hostCall(w.live, w.host, 'getAppInfo')).status).toBe(200)
    expect((await hostCall(w.live, w.host, 'getBackupStatus')).status).toBe(200)
    expect(result<AppUser>(await pcall(w.live, a, 'getMyAccount')).id).toBe(w.users.a.id)
  })
})
