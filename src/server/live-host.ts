import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { z } from 'zod'
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
  readCookie,
  sessionCookie,
  sessionCookieName,
  SessionStore,
  type Session
} from './access'
import { createWebBackupService, MAX_UPLOAD_BYTES, UploadTooLargeError } from './backup'

// The Live web host's HTTP handler (#110): a small, versioned, same-origin JSON
// API over the same repositories, validation and contracts as the desktop IPC,
// plus the launch link and (in production) the built web client. Responses
// carry only result data or an error code; logs carry method, route and status,
// never bodies, ids, names or paths.

export const API_PREFIX = '/api/v1'
export const LAUNCH_PATH = '/launch'
// Room for a full research brief at its raw bound (five sections, up to 4 bytes per character).
const MAX_JSON_BYTES = 256 * 1024

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
  getStudioSummary: caseContracts.getStudioSummary
} as const

export type CallName = keyof typeof callable
export const CALL_NAMES = Object.keys(callable) as CallName[]

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

/** What one listener accepts: its Host allowlist and its own origin (scheme included). */
export interface ListenerPolicy {
  kind: 'loopback' | 'lan'
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
  /** Opt-in home-network listener (#135): the validated private address it will be bound to. */
  lan?: { address: string }
  now?: () => Date
  log?: (line: string) => void
}

export interface LiveHost {
  /** Handles the request and returns true, or returns false to let Vite serve it (dev only). */
  handle(req: IncomingMessage, res: ServerResponse): boolean
  /** Present only when `options.lan` is set: the static client and nothing else (data is closed until device sign-in, #136). */
  handleLan?: (req: IncomingMessage, res: ServerResponse) => boolean
  /** Path of the secret launch link, for printing to the person who started the host. */
  launchPath: string
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

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const announced = Number(req.headers['content-length'] ?? 0)
    if (announced > MAX_JSON_BYTES) {
      reject(new RequestError(413, 'too-large'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
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

function mediaType(req: IncomingMessage): string {
  return (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
}

export function createLiveHost(options: LiveHostOptions): LiveHost {
  const { port, data, appInfo, staticDir } = options
  const demoUrl = options.demoUrl ?? null
  const log = options.log ?? ((line: string) => console.log(line))
  const sessions = new SessionStore()
  const backup = createWebBackupService(options.dataDir, data, options.now)
  const { clients, notes, cases, briefs, journal, tasks, time, studio } = createDataServices(data)
  const loopback: ListenerPolicy = { kind: 'loopback', hosts: allowedHosts(port), origin: `http://127.0.0.1:${port}` }
  const lan: ListenerPolicy | null = options.lan
    ? { kind: 'lan', hosts: lanAllowedHosts(options.lan.address, port), origin: `http://${options.lan.address}:${port}` }
    : null
  const csp = buildContentSecurityPolicy({ mode: 'production', connectToSelf: true })

  const implementations: { [K in CallName]: (args: z.output<(typeof callable)[K]['args']>) => unknown } = {
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
    getStudioSummary: () => studio.summary()
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

  async function handleCall(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    authorizeWrite(req)
    if (!Object.hasOwn(callable, name)) throw new RequestError(404, 'not-found')
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
      const impl = implementations[name as CallName] as (args: unknown) => unknown
      result = contract.result.parse(await impl(parsed.data))
    } catch (error) {
      // Database and schema errors can quote stored values: log only the error name.
      console.error(`API ${name} failed: ${error instanceof Error ? error.name : 'unknown error'}`)
      throw new RequestError(500, 'internal-error')
    }
    send(res, 200, { result })
  }

  async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    authorizeWrite(req)
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
   * The home-network listener (#135). It serves the static client and answers
   * the session probe as signed-out; every other /api path is refused before any
   * body or session is read. No cookie is ever set or read, and there is no CORS.
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
    const finish = (label: string, status: number, code: ApiErrorCode | null) => {
      logLan(`${method} ${label} ${status}`)
      if (code) {
        if (!req.complete) res.setHeader('Connection', 'close')
        sendError(res, status, code)
      }
    }

    if (!hostIsAllowed(req, policy.hosts)) {
      finish(isApi ? 'api' : 'static', 421, 'bad-host')
      return true
    }
    if (path === LAUNCH_PATH) {
      finish(LAUNCH_PATH, 404, 'not-found')
      return true
    }
    if (path === `${API_PREFIX}/session` && method === 'GET') {
      send(res, 200, { authenticated: false, demoUrl: null, remote: true })
      logLan(`${method} ${path} 200`)
      return true
    }
    if (isApi) {
      finish('api', 401, 'not-signed-in')
      return true
    }
    try {
      handleStatic(req, res, url)
      logLan(`${method} static ${res.statusCode}`)
    } catch (error) {
      const failure = error instanceof RequestError ? error : new RequestError(500, 'internal-error')
      finish('static', failure.status, failure.code)
    }
    return true
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

    handleLan: lan ? (req, res) => handleLanRequest(lan, req, res) : undefined
  }
}
