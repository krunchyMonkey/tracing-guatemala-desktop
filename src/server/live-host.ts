import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { caseContracts, contracts, liveContracts, type CallContract } from '../main/contracts'
import { createDataServices } from '../main/data-services'
import type { AppData } from '../main/database/app-data'
import { contentTypeFor, resolveStaticPath } from '../main/renderer-files'
import { buildContentSecurityPolicy } from '../shared/csp'
import type { AppInfo } from '../shared/ipc'
import {
  CSRF_HEADER,
  hostIsAllowed,
  allowedHosts,
  isNotCrossSite,
  isSameOriginRequest,
  lanAllowedHosts,
  lanClearCookie,
  lanCookieName,
  lanSessionCookie,
  readCookie,
  sessionCookie,
  sessionCookieName,
  SessionStore,
  type Session
} from './access'
import { DeviceAccess, type Device, type DeviceSession } from './devices'
import { signIn, type AccountDecision, type IdentityFailure, type IdentityProvider, type VerifiedIdentity } from './auth/identity'
import { authorizeCall, NEVER_REMOTE_CALLS, SELF_CALLS, USER_ADMIN_CALLS, type Principal } from './auth/policy'
import {
  clearLoginCookie,
  clearUserSessionCookie,
  LOGIN_COOKIE,
  loginCookie,
  readUniqueCookie,
  SESSION_COOKIE,
  userSessionCookie
} from './auth/session-cookies'
import { createMemoryUserSessionStore, sameSessionSecret, type UserSession, type UserSessionStore } from './auth/user-sessions'
import type { AppUser, UserAuthState } from '../shared/users'
import { createWebBackupService, MAX_UPLOAD_BYTES, UploadTooLargeError } from './backup'

// The Live web host's HTTP handler (#110): a small, versioned, same-origin JSON
// API over the same repositories, validation and contracts as the desktop IPC,
// plus the launch link and (in production) the built web client. Responses
// carry only result data or an error code; logs carry method, route and status,
// never bodies, ids, names or paths.

export const API_PREFIX = '/api/v1'
export const LAUNCH_PATH = '/launch'
// Room for a full notebook page at its stored bound (1 MiB of JSON, PAGE_JSON_MAX); a research
// brief at its raw bound (five sections, up to 4 bytes per character) is far smaller.
const MAX_JSON_BYTES = 1024 * 1024
const MAX_ENROLL_BYTES = 4 * 1024

/** The data calls the browser may make, by name. Backup file choice is an upload instead. */
const callable = {
  getAppInfo: contracts.getAppInfo,
  listClients: contracts.listClients,
  getClient: contracts.getClient,
  createClient: contracts.createClient,
  updateClient: contracts.updateClient,
  archiveClient: contracts.archiveClient,
  restoreClient: contracts.restoreClient,
  findDuplicateClients: contracts.findDuplicateClients,
  listNotes: contracts.listNotes,
  createNote: contracts.createNote,
  updateNote: contracts.updateNote,
  createBackup: contracts.createBackup,
  restoreBackup: contracts.restoreBackup,
  getBackupStatus: liveContracts.getBackupStatus,
  listCases: caseContracts.listCases,
  getCase: caseContracts.getCase,
  listCaseEvents: caseContracts.listCaseEvents,
  createCase: caseContracts.createCase,
  updateCase: caseContracts.updateCase,
  setCaseState: caseContracts.setCaseState,
  archiveCase: caseContracts.archiveCase,
  unarchiveCase: caseContracts.unarchiveCase,
  getCaseBrief: caseContracts.getCaseBrief,
  saveCaseBrief: caseContracts.saveCaseBrief,
  listJournalEntries: caseContracts.listJournalEntries,
  createJournalEntry: caseContracts.createJournalEntry,
  updateJournalEntry: caseContracts.updateJournalEntry,
  getNotebook: caseContracts.getNotebook,
  createNotebookSection: caseContracts.createNotebookSection,
  renameNotebookSection: caseContracts.renameNotebookSection,
  moveNotebookSection: caseContracts.moveNotebookSection,
  archiveNotebookSection: caseContracts.archiveNotebookSection,
  unarchiveNotebookSection: caseContracts.unarchiveNotebookSection,
  createNotebookPage: caseContracts.createNotebookPage,
  getNotebookPage: caseContracts.getNotebookPage,
  renameNotebookPage: caseContracts.renameNotebookPage,
  moveNotebookPage: caseContracts.moveNotebookPage,
  archiveNotebookPage: caseContracts.archiveNotebookPage,
  unarchiveNotebookPage: caseContracts.unarchiveNotebookPage,
  saveNotebookPage: caseContracts.saveNotebookPage,
  listPageRevisions: caseContracts.listPageRevisions,
  getPageRevision: caseContracts.getPageRevision,
  restorePageRevision: caseContracts.restorePageRevision,
  listCaseTasks: caseContracts.listCaseTasks,
  createCaseTask: caseContracts.createCaseTask,
  updateCaseTask: caseContracts.updateCaseTask,
  completeCaseTask: caseContracts.completeCaseTask,
  reopenCaseTask: caseContracts.reopenCaseTask,
  listTimeEntries: caseContracts.listTimeEntries,
  createTimeEntry: caseContracts.createTimeEntry,
  updateTimeEntry: caseContracts.updateTimeEntry,
  deleteTimeEntry: caseContracts.deleteTimeEntry,
  getActiveTimer: caseContracts.getActiveTimer,
  startTimer: caseContracts.startTimer,
  pauseTimer: caseContracts.pauseTimer,
  resumeTimer: caseContracts.resumeTimer,
  heartbeatTimer: caseContracts.heartbeatTimer,
  stopAndSaveTimer: caseContracts.stopAndSaveTimer,
  discardTimer: caseContracts.discardTimer,
  getStudioSummary: caseContracts.getStudioSummary,
  // Host-only device administration (#136): never reachable from a paired device.
  getLanStatus: liveContracts.getLanStatus,
  createPairingCode: liveContracts.createPairingCode,
  listDevices: liveContracts.listDevices,
  revokeDevice: liveContracts.revokeDevice,
  revokeAllDevices: liveContracts.revokeAllDevices,
  disableLan: liveContracts.disableLan,
  // Host-only user directory (#179).
  listUsers: liveContracts.listUsers,
  listSignInRequests: liveContracts.listSignInRequests,
  createUser: liveContracts.createUser,
  approveSignInRequest: liveContracts.approveSignInRequest,
  dismissSignInRequest: liveContracts.dismissSignInRequest,
  setUserRole: liveContracts.setUserRole,
  setUserStatus: liveContracts.setUserStatus,
  revokeUserSessions: liveContracts.revokeUserSessions,
  // Own-account calls (#180): signed-in users only (the host session gets null from getMyAccount).
  getMyAccount: liveContracts.getMyAccount,
  revokeMySessions: liveContracts.revokeMySessions
} as const

export type CallName = keyof typeof callable
export const CALL_NAMES = Object.keys(callable) as CallName[]

/**
 * What a paired home-network device may call (pairing mode): everything except
 * backups, device/LAN administration, the user directory and own-account calls.
 * The rule itself lives in auth/policy.ts (`authorizeCall`).
 */
export const REMOTE_CALL_NAMES: readonly CallName[] = CALL_NAMES.filter(
  (name) => !NEVER_REMOTE_CALLS.has(name) && !USER_ADMIN_CALLS.has(name) && !SELF_CALLS.has(name)
)

/** The recorded actor for user changes made from the loopback (host) session. */
const HOST_ACTOR = 'host'

/** Who is making a call, as the implementations need to know it. */
interface CallContext {
  principal: Principal
  /** Recorded actor for user changes: 'host' or the signed-in user's id. */
  actor: string
  /** The signed-in user's id and session; null for host and device. */
  userId: string | null
  sessionId: string | null
  /** Headers an implementation wants on the response (e.g. clearing the session cookie). */
  headers: Record<string, string>
}

const enrollBody = z.strictObject({ code: z.string().max(20), deviceName: z.string().max(200).optional() })

/** Error codes the API returns. They never include submitted or stored values. */
export type ApiErrorCode =
  | 'bad-host'
  | 'not-same-origin'
  | 'not-signed-in'
  | 'bad-csrf-token'
  | 'unsupported-media-type'
  | 'too-large'
  | 'invalid-request'
  | 'invalid-arguments'
  | 'not-found'
  | 'method-not-allowed'
  | 'internal-error'
  | 'host-only'
  | 'forbidden'
  | 'pairing-disabled'
  | 'invalid-code'
  | 'too-many-attempts'
  | 'too-many-devices'
  | 'lan-off'
  | 'restore-disabled-while-lan'

/** What one listener accepts: its Host allowlist and its own origin (scheme included). */
export interface ListenerPolicy {
  kind: 'loopback' | 'lan' | 'proxy'
  hosts: string[]
  origin: string
}

export interface LiveHostOptions {
  /** The port the host listens on, used to check Host headers and name the cookie. */
  port: number
  dataDir: string
  data: () => AppData
  appInfo: AppInfo
  /** The built web client to serve; null when Vite serves it (`web:dev`). */
  staticDir: string | null
  /**
   * Where the fictional demo mirror listens (#114), or null when there is none.
   * Reported by `GET /api/v1/session` so the page can offer a link; not a secret.
   */
  demoUrl?: string | null
  /**
   * Opt-in home-network listener (#135): the validated private address it will be bound to.
   * `demoUrl` (#137) is where the LAN demo is served (a different host name), or null.
   * `httpsName` (#167) makes it the trusted-proxy listener instead: `address` is then
   * 127.0.0.1, Host must be exactly that bare DNS name and the origin is `https://<name>`
   * (cookies get `Secure`). The scheme comes from this setting, never from a request header.
   */
  lan?: { address: string; demoUrl?: string | null; httpsName?: string | null }
  /** Called once when the host turns the home-network listener off (#137); closes the sockets. */
  onDisableLan?: () => void
  /**
   * Google user-session mode (#180): the identity provider for the HTTPS proxy listener. Needs
   * `lan.httpsName`. With it the proxy uses per-user sessions and refuses device pairing; without
   * it the proxy keeps fictional device pairing. Never used by the loopback or plain-HTTP LAN listener.
   */
  identity?: IdentityProvider
  /** Injectable session store (#187). Defaults to an in-memory store that dies with the process. */
  userSessions?: UserSessionStore
  now?: () => Date
  log?: (line: string) => void
}

export interface LiveHost {
  /** Handles the request and returns true, or returns false to let Vite serve it (dev only). */
  handle(req: IncomingMessage, res: ServerResponse): boolean
  /** Present only when `options.lan` is set: the static client, device enrollment (#136) and the remote-allowed data calls of paired devices. */
  handleLan?: (req: IncomingMessage, res: ServerResponse) => boolean
  /** Path of the secret launch link, for printing to the person who started the host. */
  launchPath: string
  /** Turns the home-network side off for good (#137): revokes every device and clears the code. Idempotent. */
  disableLan(): boolean
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store'
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode
  ) {
    super(code)
    this.name = 'RequestError'
  }
}

function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const announced = Number(req.headers['content-length'] ?? 0)
    if (announced > maxBytes) {
      reject(new RequestError(413, 'too-large'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > maxBytes) {
        failed = true
        reject(new RequestError(413, 'too-large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new RequestError(400, 'invalid-request'))
      }
    })
    req.on('error', () => reject(new RequestError(400, 'invalid-request')))
  })
}

const MAX_CALLBACK_QUERY = 4 * 1024
const SIGN_IN_FAILURE_PAGE: Partial<Record<IdentityFailure, string>> = {
  'provider-unavailable': 'unavailable',
  'expired-login': 'expired',
  'state-mismatch': 'expired',
  'denied-by-user': 'cancelled',
  'too-many-attempts': 'busy'
}

function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
}

export function createLiveHost(options: LiveHostOptions): LiveHost {
  const { port, data, appInfo, staticDir } = options
  const demoUrl = options.demoUrl ?? null
  const log = options.log ?? ((line: string) => console.log(line))
  const sessions = new SessionStore()
  const devices = new DeviceAccess({ now: options.now })
  const identity = options.identity ?? null
  if (identity && !options.lan?.httpsName) throw new Error('Google sessions need the HTTPS proxy listener (--https-host).')
  const clock = options.now
  const userSessions = options.userSessions ?? createMemoryUserSessionStore(clock ? { now: () => clock().getTime() } : {})
  const backup = createWebBackupService(options.dataDir, data, options.now)
  const { clients, notes, cases, briefs, journal, notebook, tasks, time, studio } = createDataServices(data)
  const loopback: ListenerPolicy = { kind: 'loopback', hosts: allowedHosts(port), origin: `http://127.0.0.1:${port}` }
  let lan: ListenerPolicy | null = !options.lan
    ? null
    : options.lan.httpsName
      ? // Trusted reverse proxy (#167): browsers omit :443, so the Host is the bare name.
        { kind: 'proxy', hosts: [options.lan.httpsName], origin: `https://${options.lan.httpsName}` }
      : { kind: 'lan', hosts: lanAllowedHosts(options.lan.address, port), origin: `http://${options.lan.address}:${port}` }
  const lanDemoUrl = options.lan?.demoUrl ?? null

  /** One-way: after this the host serves loopback only until it is restarted with --lan-host or --https-host. */
  function disableLan(): boolean {
    if (!lan) return false
    lan = null
    devices.revokeAll()
    devices.clearCode()
    userSessions.deleteAll()
    options.onDisableLan?.()
    return true
  }
  const csp = buildContentSecurityPolicy({ mode: 'production', connectToSelf: true })

  const implementations: { [K in CallName]: (args: z.output<(typeof callable)[K]['args']>, ctx: CallContext) => unknown } = {
    getAppInfo: () => appInfo,
    listClients: ([query]) => clients.list(query),
    getClient: ([id]) => clients.get(id),
    createClient: ([input]) => clients.create(input),
    updateClient: ([id, input]) => clients.update(id, input),
    archiveClient: ([id]) => clients.archive(id),
    restoreClient: ([id]) => clients.restore(id),
    findDuplicateClients: ([input, excludeId]) => clients.findDuplicates(input, excludeId),
    listNotes: ([clientId]) => notes.list(clientId),
    createNote: ([clientId, input]) => notes.create(clientId, input),
    updateNote: ([clientId, noteId, input]) => notes.update(clientId, noteId, input),
    createBackup: () => backup.create(),
    restoreBackup: ([token]) => backup.restore(token),
    getBackupStatus: () => backup.status(),
    listCases: ([query]) => cases.list(query),
    getCase: ([id]) => cases.get(id),
    listCaseEvents: ([caseId]) => cases.listEvents(caseId),
    createCase: ([clientId, input]) => cases.create(clientId, input),
    updateCase: ([id, input]) => cases.update(id, input),
    setCaseState: ([id, to]) => cases.setState(id, to),
    archiveCase: ([id]) => cases.archive(id),
    unarchiveCase: ([id]) => cases.unarchive(id),
    getCaseBrief: ([caseId]) => briefs.get(caseId),
    saveCaseBrief: ([caseId, input]) => briefs.save(caseId, input),
    listJournalEntries: ([caseId]) => journal.list(caseId),
    createJournalEntry: ([caseId, input]) => journal.create(caseId, input),
    updateJournalEntry: ([caseId, entryId, input]) => journal.update(caseId, entryId, input),
    getNotebook: ([caseId]) => notebook.getOutline(caseId),
    createNotebookSection: ([caseId, input]) => notebook.createSection(caseId, input),
    renameNotebookSection: ([caseId, sectionId, input]) => notebook.renameSection(caseId, sectionId, input),
    moveNotebookSection: ([caseId, sectionId, toIndex]) => notebook.moveSection(caseId, sectionId, toIndex),
    archiveNotebookSection: ([caseId, sectionId]) => notebook.archiveSection(caseId, sectionId),
    unarchiveNotebookSection: ([caseId, sectionId]) => notebook.unarchiveSection(caseId, sectionId),
    createNotebookPage: ([caseId, sectionId, input]) => notebook.createPage(caseId, sectionId, input),
    getNotebookPage: ([caseId, pageId]) => notebook.getPage(caseId, pageId),
    renameNotebookPage: ([caseId, pageId, input]) => notebook.renamePage(caseId, pageId, input),
    moveNotebookPage: ([caseId, pageId, move]) => notebook.movePage(caseId, pageId, move),
    archiveNotebookPage: ([caseId, pageId]) => notebook.archivePage(caseId, pageId),
    unarchiveNotebookPage: ([caseId, pageId]) => notebook.unarchivePage(caseId, pageId),
    saveNotebookPage: ([caseId, pageId, save]) => notebook.savePage(caseId, pageId, save),
    listPageRevisions: ([caseId, pageId]) => notebook.listRevisions(caseId, pageId),
    getPageRevision: ([caseId, pageId, revisionId]) => notebook.getRevision(caseId, pageId, revisionId),
    restorePageRevision: ([caseId, pageId, revisionId, baseVersion]) => notebook.restoreRevision(caseId, pageId, revisionId, baseVersion),
    listCaseTasks: ([caseId]) => tasks.list(caseId),
    createCaseTask: ([caseId, input]) => tasks.create(caseId, input),
    updateCaseTask: ([caseId, taskId, input]) => tasks.update(caseId, taskId, input),
    completeCaseTask: ([caseId, taskId]) => tasks.complete(caseId, taskId),
    reopenCaseTask: ([caseId, taskId]) => tasks.reopen(caseId, taskId),
    listTimeEntries: ([caseId]) => time.list(caseId),
    createTimeEntry: ([caseId, input]) => time.create(caseId, input),
    updateTimeEntry: ([caseId, entryId, input]) => time.update(caseId, entryId, input),
    deleteTimeEntry: ([caseId, entryId]) => time.delete(caseId, entryId),
    getActiveTimer: () => time.getActiveTimer(),
    startTimer: ([caseId]) => time.start(caseId),
    pauseTimer: ([version]) => time.pause(version),
    resumeTimer: ([version]) => time.resume(version),
    heartbeatTimer: ([version]) => time.heartbeat(version),
    stopAndSaveTimer: ([version, options]) => time.stopAndSave(version, options),
    discardTimer: ([version]) => time.discard(version),
    getStudioSummary: () => studio.summary(),
    getLanStatus: () => ({ enabled: lan !== null, origin: lan?.origin ?? null }),
    createPairingCode: () => {
      if (!lan) throw new RequestError(409, 'lan-off')
      // Google sessions replace pairing on the HTTPS listener: a code could never be used.
      if (identity) throw new RequestError(409, 'pairing-disabled')
      return devices.createCode()
    },
    listDevices: () => (lan ? devices.listDevices() : []),
    revokeDevice: ([id]) => ({ revoked: devices.revokeDevice(id) }),
    revokeAllDevices: () => ({ revoked: devices.revokeAll() }),
    disableLan: () => ({ disabled: disableLan() }),
    listUsers: () => data().users.list(),
    listSignInRequests: () => data().users.listSignInRequests(),
    createUser: ([input], ctx) => data().users.create(input, ctx.actor),
    approveSignInRequest: ([requestId, target, expectedVersion], ctx) =>
      data().users.approveSignInRequest(requestId, target, ctx.actor, expectedVersion),
    dismissSignInRequest: ([id]) => ({ dismissed: data().users.dismissSignInRequest(id) }),
    setUserRole: ([id, role, version], ctx) => data().users.setRole(id, role, ctx.actor, version),
    setUserStatus: ([id, status, version], ctx) => data().users.setStatus(id, status, ctx.actor, version),
    revokeUserSessions: ([id], ctx) => data().users.revokeSessions(id, ctx.actor),
    getMyAccount: (_args, ctx) => (ctx.userId ? data().users.get(ctx.userId) : null),
    revokeMySessions: (_args, ctx) => {
      if (!ctx.userId) throw new RequestError(403, 'forbidden')
      // Bumps auth_version (every session on any host ends), then drops the ones held here.
      data().users.revokeSessions(ctx.userId, ctx.userId)
      userSessions.deleteForUser(ctx.userId)
      ctx.headers['Set-Cookie'] = clearUserSessionCookie()
      return { ok: true }
    }
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const json = JSON.stringify(body)
    res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), ...headers })
    res.end(json)
  }

  function sendError(res: ServerResponse, status: number, code: ApiErrorCode): void {
    send(res, status, { error: code })
  }

  function sessionOf(req: IncomingMessage): Session | null {
    return sessions.find(readCookie(req, sessionCookieName(port)))
  }

  /** Writes need a session, the same origin and the session's CSRF token. */
  function authorizeWrite(req: IncomingMessage): Session {
    if (!isSameOriginRequest(req, loopback.origin)) throw new RequestError(403, 'not-same-origin')
    const session = sessionOf(req)
    if (!session) throw new RequestError(401, 'not-signed-in')
    if (!sessions.checkCsrf(session, req.headers[CSRF_HEADER])) throw new RequestError(403, 'bad-csrf-token')
    return session
  }

  /** Home-network writes: the LAN origin, a paired device's session and its CSRF token. */
  function authorizeLan(req: IncomingMessage, policy: ListenerPolicy): { session: DeviceSession; device: Device } {
    if (!isSameOriginRequest(req, policy.origin)) throw new RequestError(403, 'not-same-origin')
    const found = devices.find(readCookie(req, lanCookieName(port)))
    if (!found) throw new RequestError(401, 'not-signed-in')
    if (!devices.checkCsrf(found.session, req.headers[CSRF_HEADER])) throw new RequestError(403, 'bad-csrf-token')
    return found
  }

  /** The signed-in person behind a session cookie, re-read from the user directory on EVERY request. */
  function userSessionOf(req: IncomingMessage): { session: UserSession; state: UserAuthState } | null {
    const session = userSessions.find(readUniqueCookie(req, SESSION_COOKIE))
    if (!session) return null
    let state: UserAuthState | null
    try {
      state = data().users.getAuthState(session.userId)
    } catch {
      return null
    }
    // A disabled user, a changed auth version (role change, disable, revoke) or a removed
    // account ends the session now; the role is never taken from the session.
    if (!state || state.status !== 'active' || state.authVersion !== session.authVersion) {
      userSessions.delete(session.id)
      return null
    }
    userSessions.touch(session.id)
    return { session, state }
  }

  /** Google-mode writes: the exact HTTPS origin, a live user session and its CSRF token. */
  function authorizeUser(req: IncomingMessage, policy: ListenerPolicy): { session: UserSession; state: UserAuthState } {
    if (!isSameOriginRequest(req, policy.origin)) throw new RequestError(403, 'not-same-origin')
    const found = userSessionOf(req)
    if (!found) throw new RequestError(401, 'not-signed-in')
    const header = req.headers[CSRF_HEADER]
    if (typeof header !== 'string' || !sameSessionSecret(header, found.session.csrfToken)) throw new RequestError(403, 'bad-csrf-token')
    return found
  }

  async function handleCall(req: IncomingMessage, res: ServerResponse, name: string, remote: ListenerPolicy | null = null): Promise<void> {
    let ctx: CallContext
    if (remote && identity) {
      const { session, state } = authorizeUser(req, remote)
      if (!Object.hasOwn(callable, name)) throw new RequestError(404, 'not-found')
      const principal: Principal = { kind: 'user', role: state.role }
      const decision = authorizeCall(name, principal)
      if (!decision.allowed) throw new RequestError(403, decision.code)
      ctx = { principal, actor: session.userId, userId: session.userId, sessionId: session.id, headers: {} }
    } else if (remote) {
      authorizeLan(req, remote)
      const principal: Principal = { kind: 'device' }
      if (!Object.hasOwn(callable, name)) throw new RequestError(403, 'host-only')
      const decision = authorizeCall(name, principal)
      if (!decision.allowed) throw new RequestError(403, decision.code)
      ctx = { principal, actor: HOST_ACTOR, userId: null, sessionId: null, headers: {} }
    } else {
      authorizeWrite(req)
      if (!Object.hasOwn(callable, name)) throw new RequestError(404, 'not-found')
      const principal: Principal = { kind: 'host' }
      const decision = authorizeCall(name, principal)
      if (!decision.allowed) throw new RequestError(403, decision.code)
      // A real backup must never be importable into a profile the home network can reach.
      if (lan && name === 'restoreBackup') throw new RequestError(409, 'restore-disabled-while-lan')
      ctx = {
        principal,
        actor: HOST_ACTOR,
        userId: null,
        sessionId: null,
        headers: {}
      }
    }
    if (mediaType(req) !== 'application/json') throw new RequestError(415, 'unsupported-media-type')
    const body = await readJsonBody(req)
    if (typeof body !== 'object' || body === null || !Array.isArray((body as { args?: unknown }).args)) {
      throw new RequestError(400, 'invalid-request')
    }

    const contract = callable[name as CallName] as CallContract<z.ZodTuple, z.ZodType>
    const parsed = contract.args.safeParse((body as { args: unknown[] }).args)
    if (!parsed.success) throw new RequestError(400, 'invalid-arguments')
    let result: unknown
    try {
      const impl = implementations[name as CallName] as (args: unknown, ctx: CallContext) => unknown
      result = contract.result.parse(await impl(parsed.data, ctx))
    } catch (error) {
      if (error instanceof RequestError) throw error
      // Database and schema errors can quote stored values: log only the error name.
      console.error(`API ${name} failed: ${error instanceof Error ? error.name : 'unknown error'}`)
      throw new RequestError(500, 'internal-error')
    }
    // Belt and braces: auth_version already ends a changed user's sessions, but drop them now.
    if (USER_ADMIN_CALLS.has(name)) {
      const user = (result as { ok?: unknown; user?: AppUser } | null)?.user
      if ((result as { ok?: unknown } | null)?.ok === true && user) userSessions.deleteForUser(user.id)
    }
    // A restored database is a different set of users: nobody stays signed in across it.
    if (name === 'restoreBackup') userSessions.deleteAll()
    send(res, 200, { result }, ctx.headers)
  }

  async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    authorizeWrite(req)
    if (lan) throw new RequestError(409, 'restore-disabled-while-lan')
    if (mediaType(req) !== 'application/octet-stream') throw new RequestError(415, 'unsupported-media-type')
    const announced = Number(req.headers['content-length'])
    if (!Number.isInteger(announced) || announced < 0) throw new RequestError(400, 'invalid-request')
    if (announced > MAX_UPLOAD_BYTES) throw new RequestError(413, 'too-large')

    const rawName = req.headers['x-tg-file-name']
    let fileName: string | null = null
    if (typeof rawName === 'string') {
      try {
        fileName = decodeURIComponent(rawName)
      } catch {
        fileName = null
      }
    }
    const modified = Number(req.headers['x-tg-last-modified'])
    const lastModified = Number.isFinite(modified) && modified > 0 ? new Date(modified) : null

    const choice = await backup.acceptUpload(req, fileName, lastModified)
    send(res, 200, { result: contracts.chooseBackupToRestore.result.parse(choice) })
  }

  function handleDownload(req: IncomingMessage, res: ServerResponse, encodedName: string): void {
    if (!isNotCrossSite(req)) throw new RequestError(403, 'not-same-origin')
    if (!sessionOf(req)) throw new RequestError(401, 'not-signed-in')
    let fileName: string
    try {
      fileName = decodeURIComponent(encodedName)
    } catch {
      throw new RequestError(404, 'not-found')
    }
    const path = backup.downloadPath(fileName)
    if (!path) throw new RequestError(404, 'not-found')
    res.writeHead(200, {
      ...securityHeaders,
      'Content-Type': 'application/octet-stream',
      'Content-Length': statSync(path).size,
      'Content-Disposition': `attachment; filename="${fileName}"`
    })
    createReadStream(path).pipe(res)
  }

  function handleLaunch(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const token = url.searchParams.get('token') ?? ''
    if (!sessions.isLaunchToken(token)) {
      const html =
        '<!doctype html><meta charset="utf-8"><title>Tracing Guatemala</title>' +
        '<p>This link has expired. Use the link shown when Tracing Guatemala was started on this computer.</p>'
      res.writeHead(403, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp })
      res.end(html)
      return
    }
    const session = sessions.create()
    // Redirect so the token leaves the address bar straight away.
    res.writeHead(303, { ...securityHeaders, 'Set-Cookie': sessionCookie(port, session.id), Location: '/' })
    res.end()
  }

  function handleStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!staticDir) throw new RequestError(404, 'not-found')
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new RequestError(405, 'method-not-allowed')
    const file = resolveStaticPath(staticDir, url.pathname)
    let size: number
    try {
      if (!file) throw new Error('outside root')
      const stat = statSync(file)
      if (!stat.isFile()) throw new Error('not a file')
      size = stat.size
    } catch {
      throw new RequestError(404, 'not-found')
    }
    res.writeHead(200, { ...securityHeaders, 'Content-Type': contentTypeFor(file), 'Content-Length': size, 'Content-Security-Policy': csp })
    if (req.method === 'HEAD') res.end()
    else createReadStream(file).pipe(res)
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<string> {
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === LAUNCH_PATH) {
      if (method !== 'GET') throw new RequestError(405, 'method-not-allowed')
      handleLaunch(req, res, url)
      return LAUNCH_PATH
    }
    if (path === `${API_PREFIX}/session`) {
      if (method !== 'GET') throw new RequestError(405, 'method-not-allowed')
      const session = sessionOf(req)
      send(res, 200, session ? { authenticated: true, csrfToken: session.csrfToken, demoUrl } : { authenticated: false, demoUrl })
      return path
    }
    if (path.startsWith(`${API_PREFIX}/call/`)) {
      if (method !== 'POST') throw new RequestError(405, 'method-not-allowed')
      await handleCall(req, res, path.slice(`${API_PREFIX}/call/`.length))
      return `${API_PREFIX}/call/:name`
    }
    if (path === `${API_PREFIX}/backup/upload`) {
      if (method !== 'POST') throw new RequestError(405, 'method-not-allowed')
      await handleUpload(req, res)
      return path
    }
    if (path.startsWith(`${API_PREFIX}/backup/download/`)) {
      if (method !== 'GET') throw new RequestError(405, 'method-not-allowed')
      handleDownload(req, res, path.slice(`${API_PREFIX}/backup/download/`.length))
      return `${API_PREFIX}/backup/download/:file`
    }
    if (path === '/api' || path.startsWith('/api/')) throw new RequestError(404, 'not-found')
    handleStatic(req, res, url)
    return 'static'
  }

  /**
   * The home-network listener (#135, #136). It serves the static client, lets a
   * paired device (enrolled with a pairing code shown on the host) call the
   * remote-allowed data calls, and refuses everything else. The loopback launch
   * token and session store are never consulted. There is no CORS. Logs hold
   * the method, a route template and the status only.
   */
  function handleLanRequest(policy: ListenerPolicy, req: IncomingMessage, res: ServerResponse): boolean {
    const logLan = (line: string) => log(`lan ${line}`)
    const method = req.method ?? 'GET'
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://lan.invalid')
    } catch {
      sendError(res, 400, 'invalid-request')
      return true
    }
    const path = url.pathname
    const isApi = path === '/api' || path.startsWith('/api/')
    const fail = (label: string, status: number, code: ApiErrorCode) => {
      logLan(`${method} ${label} ${status}`)
      // Don't keep reading a rejected body: answer, then drop the connection.
      if (!req.complete) res.setHeader('Connection', 'close')
      sendError(res, status, code)
    }

    if (!hostIsAllowed(req, policy.hosts)) {
      fail(isApi ? 'api' : 'static', 421, 'bad-host')
      return true
    }
    if (path === LAUNCH_PATH) {
      fail(LAUNCH_PATH, 404, 'not-found')
      return true
    }
    const ctx = { label: isApi ? 'api' : 'static' }
    void lanRoute(policy, req, res, url, ctx).then(
      () => logLan(`${method} ${ctx.label} ${res.statusCode}`),
      (error: unknown) => {
        const failure = error instanceof RequestError ? error : new RequestError(500, 'internal-error')
        if (failure.status === 500) console.error(`API request failed: ${error instanceof Error ? error.name : 'unknown error'}`)
        if (res.headersSent) {
          logLan(`${method} ${ctx.label} ${failure.status}`)
          res.destroy()
          return
        }
        fail(ctx.label, failure.status, failure.code)
      }
    )
    return true
  }

  function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
    res.writeHead(303, {
      ...securityHeaders,
      Location: location,
      ...(cookies.length ? { 'Set-Cookie': cookies } : {})
    })
    res.end()
  }

  /**
   * The HTTPS proxy listener in Google mode (#180): per-user sessions instead of device pairing.
   * Pairing and device cookies do not exist here, and there is no launch-token fallback.
   */
  async function googleRoute(policy: ListenerPolicy, req: IncomingMessage, res: ServerResponse, url: URL, ctx: { label: string }): Promise<void> {
    if (!identity) throw new RequestError(500, 'internal-error')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === `${API_PREFIX}/session` && method === 'GET') {
      ctx.label = path
      const found = userSessionOf(req)
      const user = found ? data().users.get(found.session.userId) : null
      send(
        res,
        200,
        found && user
          ? {
              authenticated: true,
              csrfToken: found.session.csrfToken,
              remote: true,
              auth: 'google',
              demoUrl: null,
              user: {
                displayName: user.displayName,
                role: found.state.role,
                email: user.identity?.email ?? user.contactEmail
              }
            }
          : {
              authenticated: false,
              remote: true,
              auth: 'google',
              demoUrl: null
            }
      )
      return
    }

    if (path === `${API_PREFIX}/auth/google/start`) {
      ctx.label = path
      if (method !== 'GET') throw new RequestError(405, 'method-not-allowed')
      // A top-level navigation from a link on our own sign-in page (or typed by the person),
      // never one another site started. A link, not a form: the page CSP keeps
      // `form-action 'none'` and the host keeps `Referrer-Policy: no-referrer` (which makes
      // browsers send `Origin: null` on form posts). Fetch Metadata is required: a browser
      // that sends none can't start a sign-in. Forging a start gains nothing anyway: the
      // login is bound to the `__Host-` login cookie, its `state` and its nonce.
      const site = req.headers['sec-fetch-site']
      const mode = req.headers['sec-fetch-mode']
      const dest = req.headers['sec-fetch-dest']
      if ((site !== 'same-origin' && site !== 'none') || mode !== 'navigate' || (dest !== undefined && dest !== 'document')) {
        throw new RequestError(403, 'not-same-origin')
      }
      const claimed = req.headers.origin
      if (claimed !== undefined && claimed.toLowerCase() !== policy.origin.toLowerCase()) throw new RequestError(403, 'not-same-origin')
      let begun: { redirectUrl: string; loginId: string }
      try {
        begun = identity.beginSignIn()
      } catch (error) {
        redirect(res, `/?signin=${error instanceof Error && error.message === 'too-many-attempts' ? 'busy' : 'unavailable'}`)
        return
      }
      redirect(res, begun.redirectUrl, [loginCookie(begun.loginId)])
      return
    }

    if (path === `${API_PREFIX}/auth/google/callback`) {
      ctx.label = path
      if (method !== 'GET') throw new RequestError(405, 'method-not-allowed')
      // Google's redirect is a cross-site top-level navigation; anything else (fetch, iframe, image) is not.
      const mode = req.headers['sec-fetch-mode']
      const dest = req.headers['sec-fetch-dest']
      if ((mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document')) throw new RequestError(403, 'not-same-origin')
      if (url.search.length > MAX_CALLBACK_QUERY) throw new RequestError(400, 'invalid-request')
      let authVersion = 0
      const gate = (claims: VerifiedIdentity): AccountDecision => {
        const resolved = data().users.resolveIdentity(claims)
        if (resolved.kind === 'active') {
          authVersion = resolved.user.authVersion
          return { allowed: true, userId: resolved.user.id }
        }
        return { allowed: false, reason: resolved.kind }
      }
      let target: string
      let cookies = [clearLoginCookie()]
      try {
        const result = await signIn(identity, gate, readUniqueCookie(req, LOGIN_COOKIE), url.searchParams)
        if (result.ok) {
          // Rotate: whatever session this browser already held is ended, a fresh one is issued.
          const previous = userSessions.find(readUniqueCookie(req, SESSION_COOKIE))
          if (previous) userSessions.delete(previous.id)
          const session = userSessions.create(result.userId, authVersion)
          cookies = [userSessionCookie(session.id), clearLoginCookie()]
          target = '/'
        } else if (result.reason === 'account-denied') {
          // Only a stranger leaves a request for the owner to review; it grants nothing.
          if (result.account === 'unknown') data().users.recordSignInRequest(result.identity)
          target = `/?signin=${result.account === 'disabled' ? 'disabled' : 'not-approved'}`
        } else {
          target = `/?signin=${SIGN_IN_FAILURE_PAGE[result.reason] ?? 'failed'}`
        }
      } catch {
        target = '/?signin=failed'
      }
      redirect(res, target, cookies)
      return
    }

    if (path === `${API_PREFIX}/auth/logout` && method === 'POST') {
      ctx.label = path
      const { session } = authorizeUser(req, policy)
      userSessions.delete(session.id)
      send(res, 200, { result: { ok: true } }, { 'Set-Cookie': clearUserSessionCookie() })
      return
    }
    if (path.startsWith(`${API_PREFIX}/call/`) && method === 'POST') {
      ctx.label = `${API_PREFIX}/call/:name`
      await handleCall(req, res, path.slice(`${API_PREFIX}/call/`.length), policy)
      return
    }
    // No device pairing in this mode, whatever the request carries.
    if (path === `${API_PREFIX}/lan/enroll` || path === `${API_PREFIX}/lan/logout`) {
      ctx.label = path
      throw new RequestError(404, 'not-found')
    }
    if (path === `${API_PREFIX}/backup/upload`) {
      ctx.label = path
      throw new RequestError(403, 'host-only')
    }
    if (path.startsWith(`${API_PREFIX}/backup/download/`)) {
      ctx.label = `${API_PREFIX}/backup/download/:file`
      throw new RequestError(403, 'host-only')
    }
    if (path === '/api' || path.startsWith('/api/')) {
      ctx.label = 'api'
      throw userSessionOf(req) ? new RequestError(404, 'not-found') : new RequestError(401, 'not-signed-in')
    }
    handleStatic(req, res, url)
  }

  async function lanRoute(policy: ListenerPolicy, req: IncomingMessage, res: ServerResponse, url: URL, ctx: { label: string }): Promise<void> {
    const path = url.pathname
    const method = req.method ?? 'GET'
    const secure = policy.origin.startsWith('https:')
    const cookieId = () => readCookie(req, lanCookieName(port))
    if (identity) return googleRoute(policy, req, res, url, ctx)

    if (path === `${API_PREFIX}/session` && method === 'GET') {
      ctx.label = path
      const found = devices.find(cookieId())
      send(
        res,
        200,
        found
          ? { authenticated: true, csrfToken: found.session.csrfToken, demoUrl: lanDemoUrl, remote: true, device: { name: found.device.name } }
          : { authenticated: false, demoUrl: lanDemoUrl, remote: true }
      )
      return
    }
    if (path === `${API_PREFIX}/lan/enroll` && method === 'POST') {
      ctx.label = path
      if (!isSameOriginRequest(req, policy.origin)) throw new RequestError(403, 'not-same-origin')
      if (mediaType(req) !== 'application/json') throw new RequestError(415, 'unsupported-media-type')
      const parsed = enrollBody.safeParse(await readJsonBody(req, MAX_ENROLL_BYTES))
      if (!parsed.success) throw new RequestError(400, 'invalid-request')
      const result = devices.enroll(parsed.data.code, parsed.data.deviceName, cookieId())
      if (!result.ok) {
        if (result.reason === 'too-many-attempts') throw new RequestError(429, 'too-many-attempts')
        if (result.reason === 'too-many-devices') throw new RequestError(409, 'too-many-devices')
        if (result.reason === 'invalid-name') throw new RequestError(400, 'invalid-request')
        throw new RequestError(401, 'invalid-code')
      }
      log('A device was paired on the home network.')
      send(res, 200, { result: { device: { name: result.device.name } } }, { 'Set-Cookie': lanSessionCookie(port, result.session.id, secure) })
      return
    }
    if (path === `${API_PREFIX}/lan/logout` && method === 'POST') {
      ctx.label = path
      const { session } = authorizeLan(req, policy)
      devices.logout(session.id)
      send(res, 200, { result: { ok: true } }, { 'Set-Cookie': lanClearCookie(port, secure) })
      return
    }
    if (path.startsWith(`${API_PREFIX}/call/`) && method === 'POST') {
      ctx.label = `${API_PREFIX}/call/:name`
      await handleCall(req, res, path.slice(`${API_PREFIX}/call/`.length), policy)
      return
    }
    // Backups never travel over the home network. Refused before any body is read.
    if (path === `${API_PREFIX}/backup/upload`) {
      ctx.label = path
      throw new RequestError(403, 'host-only')
    }
    if (path.startsWith(`${API_PREFIX}/backup/download/`)) {
      ctx.label = `${API_PREFIX}/backup/download/:file`
      throw new RequestError(403, 'host-only')
    }
    if (path === '/api' || path.startsWith('/api/')) {
      ctx.label = 'api'
      throw devices.find(cookieId()) ? new RequestError(404, 'not-found') : new RequestError(401, 'not-signed-in')
    }
    handleStatic(req, res, url)
  }

  return {
    launchPath: `${LAUNCH_PATH}?token=${sessions.launchToken}`,

    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const owned = url.pathname === LAUNCH_PATH || url.pathname === '/api' || url.pathname.startsWith('/api/')
      if (!owned && !staticDir) return false

      const method = req.method ?? 'GET'
      if (!hostIsAllowed(req, loopback.hosts)) {
        log(`${method} ${owned ? 'api' : 'static'} 421`)
        sendError(res, 421, 'bad-host')
        return true
      }
      void route(req, res, url).then(
        (label) => log(`${method} ${label} ${res.statusCode}`),
        (error: unknown) => {
          const { status, code } =
            error instanceof RequestError
              ? error
              : error instanceof UploadTooLargeError
                ? new RequestError(413, 'too-large')
                : new RequestError(500, 'internal-error')
          if (status === 500) console.error(`API request failed: ${error instanceof Error ? error.name : 'unknown error'}`)
          log(`${method} ${owned ? 'api' : 'static'} ${status}`)
          if (res.headersSent) {
            res.destroy()
            return
          }
          // Don't keep reading a rejected body: answer, then drop the connection.
          if (!req.complete) res.setHeader('Connection', 'close')
          sendError(res, status, code)
        }
      )
      return true
    },

    disableLan,

    handleLan: options.lan
      ? (req, res) => {
          // Turned off at run time: the socket is closed too, but never answer from here.
          if (!lan) return false
          return handleLanRequest(lan, req, res)
        }
      : undefined
  }
}
