import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { contentTypeFor, resolveStaticPath } from '../main/renderer-files'
import { buildContentSecurityPolicy } from '../shared/csp'

// The fictional demo, served from the Live host's own computer (#114). It is a
// second, static-only listener on 127.0.0.1 so that Live and the demo are two
// independent origins: the demo is reached as http://localhost:<port>/, which
// is a different *site* from Live's http://127.0.0.1:<port>/, so Live's cookie,
// storage and memory can never reach the demo's page. Switching modes is a
// navigation between the two, never an in-place data-source flip. The bundle is
// the unchanged `dist-demo/` build (no API client, `connect-src 'none'`). This
// listener has no API, never sets or reads cookies, and answers only GET/HEAD.
// See docs/architecture/web-first-runtime.md.

const LOOPBACK = '127.0.0.1'

export interface DemoMirrorOptions {
  /** 0 picks a free port (tests). */
  port: number
  /** The built demo (`dist-demo/`). */
  demoDir: string
  log?: (line: string) => void
}

export interface RunningDemoMirror {
  /** `http://localhost:<port>`: the name the demo is meant to be opened by. */
  origin: string
  port: number
  close(): Promise<void>
}

const securityHeaders = {
  'Content-Security-Policy': buildContentSecurityPolicy({ mode: 'production' }),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store'
}

function hostIsAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host
  return typeof host === 'string' && [`localhost:${port}`, `${LOOPBACK}:${port}`].includes(host.toLowerCase())
}

function refuse(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...securityHeaders, 'Content-Length': 0, ...headers })
  res.end()
}

/**
 * Starts the demo mirror, or resolves to null when `demoDir` has no built demo
 * (Live then reports no demo address). Rejects with the listen error, e.g.
 * EADDRINUSE, for the caller to report.
 */
export async function startDemoMirror(options: DemoMirrorOptions): Promise<RunningDemoMirror | null> {
  const { demoDir } = options
  const log = options.log ?? ((line: string) => console.log(line))
  if (!existsSync(join(demoDir, 'index.html'))) return null

  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, LOOPBACK, () => resolve())
  })
  const port = (server.address() as AddressInfo).port

  // Request cookies are never read, so a Live session cookie changes nothing here.
  server.on('request', (req, res) => {
    const method = req.method ?? 'GET'
    // Host check against DNS rebinding, like the Live host.
    if (!hostIsAllowed(req, port)) {
      log(`${method} demo 421`)
      refuse(res, 421)
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      log(`${method} demo 405`)
      refuse(res, 405, { Allow: 'GET, HEAD' })
      return
    }
    // Only the path matters: the query (`?live=<port>`) is for the page's script.
    const path = (req.url ?? '/').split(/[?#]/, 1)[0]!
    const file = path === '/api' || path.startsWith('/api/') ? null : resolveStaticPath(demoDir, path)
    let size = 0
    let found = false
    try {
      if (file) {
        const stat = statSync(file)
        found = stat.isFile()
        size = stat.size
      }
    } catch {
      found = false
    }
    if (!file || !found) {
      log(`${method} demo 404`)
      refuse(res, 404)
      return
    }
    log(`${method} demo 200`)
    res.writeHead(200, { ...securityHeaders, 'Content-Type': contentTypeFor(file), 'Content-Length': size })
    if (method === 'HEAD') res.end()
    else createReadStream(file).pipe(res)
  })
  server.requestTimeout = 60_000
  server.headersTimeout = 30_000

  return {
    origin: `http://localhost:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
