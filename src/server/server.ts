import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AppData } from '../main/database/app-data'
import type { AppInfo } from '../shared/ipc'
import { acquireDataDirLock, checkLiveDataDir } from './data-dir'
import { createLiveHost, type LiveHost } from './live-host'

// Starts the Live web host (#110): opens the web profile's database, then
// serves the API and the built client on 127.0.0.1. The address is fixed: the
// Live host has no option to listen on another interface (see #114/#117 and
// docs/architecture/web-first-runtime.md for why remote access is deferred).

export const LIVE_HOST = '127.0.0.1'
export const DEFAULT_LIVE_PORT = 4180

export interface StartLiveServerOptions {
  dataDir: string
  /** 0 picks a free port (tests). */
  port: number
  staticDir: string | null
  appInfo: AppInfo
  log?: (line: string) => void
}

export interface RunningLiveServer {
  origin: string
  port: number
  /** Full launch link, to show only to the person who started the host. */
  launchUrl: string
  close(): Promise<void>
}

/** Opens the data (taking the folder lock) and returns the host, ready to mount on any HTTP server. */
export function openLiveHost(options: StartLiveServerOptions): {
  host: LiveHost
  close: () => void
} {
  const checked = checkLiveDataDir(options.dataDir)
  if (!checked.ok) throw new Error(checked.error)
  const release = acquireDataDirLock(options.dataDir)
  let data: AppData | null
  try {
    data = new AppData(options.dataDir)
  } catch (error) {
    release()
    throw error
  }
  const current = (): AppData => {
    if (!data) throw new Error('Data is closed')
    return data
  }
  const host = createLiveHost({ ...options, data: current })
  return {
    host,
    close() {
      data?.close()
      data = null
      release()
    }
  }
}

export async function startLiveServer(options: StartLiveServerOptions): Promise<RunningLiveServer> {
  // The real port is needed for Host checks, so a free port is found first.
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, LIVE_HOST, () => resolve())
  })
  const port = (server.address() as AddressInfo).port

  let opened: ReturnType<typeof openLiveHost>
  try {
    opened = openLiveHost({ ...options, port })
  } catch (error) {
    await new Promise((resolve) => server.close(resolve))
    throw error
  }
  server.on('request', (req, res) => {
    if (!opened.host.handle(req, res)) {
      res.writeHead(404).end()
    }
  })
  // Stop slow or idle clients from holding the database open.
  server.requestTimeout = 5 * 60_000
  server.headersTimeout = 30_000

  const origin = `http://${LIVE_HOST}:${port}`
  return {
    origin,
    port,
    launchUrl: `${origin}${opened.host.launchPath}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          opened.close()
          resolve()
        })
      })
  }
}
