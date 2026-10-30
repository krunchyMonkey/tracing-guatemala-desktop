import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { z } from 'zod'
import { contracts, type ChannelContract } from '../main/contracts'
import { createDataServices } from '../main/data-services'
import type { AppData } from '../main/database/app-data'
import { contentTypeFor, resolveStaticPath } from '../main/renderer-files'
import { buildContentSecurityPolicy } from '../shared/csp'
import type { AppInfo } from '../shared/ipc'
import {
  CSRF_HEADER,
  hostIsAllowed,
  isNotCrossSite,
  isSameOriginRequest,
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
const MAX_JSON_BYTES = 64 * 1024

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
  restoreBackup: contracts.restoreBackup
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
  now?: () => Date
  log?: (line: string) => void
}

export interface LiveHost {
  /** Handles the request and returns true, or returns false to let Vite serve it (dev only). */
  handle(req: IncomingMessage, res: ServerResponse): boolean
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
  const { clients, notes } = createDataServices(data)
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
    restoreBackup: ([token]) => backup.restore(token)
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const json = JSON.stringify(body)
    res.writeHead(status, {
      ...securityHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      ...headers
    })
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
    if (!isSameOriginRequest(req)) throw new RequestError(403, 'not-same-origin')
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

    const contract = callable[name as CallName] as ChannelContract<z.ZodTuple, z.ZodType>
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
    res.writeHead(200, {
      ...securityHeaders,
      'Content-Type': contentTypeFor(file),
      'Content-Length': size,
      'Content-Security-Policy': csp
    })
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

  return {
    launchPath: `${LAUNCH_PATH}?token=${sessions.launchToken}`,

    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const owned = url.pathname === LAUNCH_PATH || url.pathname === '/api' || url.pathname.startsWith('/api/')
      if (!owned && !staticDir) return false

      const method = req.method ?? 'GET'
      if (!hostIsAllowed(req, port)) {
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
    }
  }
}
