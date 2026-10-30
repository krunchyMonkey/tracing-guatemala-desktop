import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { AppData } from '../main/database/app-data'
import type { AppInfo } from '../shared/ipc'
import { acquireDataDirLock, checkLiveDataDir } from './data-dir'
import { LanHostError, validateLanHost } from './lan'
import { assertLanDataAllowed } from './lan-profile'
import { createLiveHost, type LiveHost } from './live-host'

// Starts the Live web host (#110): opens the web profile's database, then
// serves the API and the built client on 127.0.0.1. By default that is the only
// listener. With an explicit `lanHost` (#135) a second listener binds to that one
// validated private IPv4 address; paired devices (#136) may use it, but only on
// a profile marked as fictional test data (lan-profile.ts). Any failure to set it
// up closes everything and rethrows (fail closed). See
// docs/architecture/web-first-runtime.md.

export const LIVE_HOST = '127.0.0.1'
export const DEFAULT_LIVE_PORT = 4180

export interface StartLiveServerOptions {
  dataDir: string
  /** 0 picks a free port (tests). */
  port: number
  staticDir: string | null
  appInfo: AppInfo
  /** Address of the fictional demo mirror (#114), reported to the page; null when there is none. */
  demoUrl?: string | null
  /** Opt-in home-network address (#135): one private IPv4 address of this computer. Never auto-picked. */
  lanHost?: string | null
  /** Test-only: replaces `os.networkInterfaces()` when validating `lanHost`. */
  lanInterfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
  log?: (line: string) => void
  /** Test-only: the clock for device and pairing-code expiry. */
  now?: () => Date
}

export interface RunningLiveServer {
  origin: string
  /** Origin of the home-network listener, or null when it is off (the default). */
  lanOrigin: string | null
  port: number
  /** Full launch link, to show only to the person who started the host. */
  launchUrl: string
  close(): Promise<void>
}

/** Opens the data (taking the folder lock) and returns the host, ready to mount on any HTTP server. */
export function openLiveHost(options: StartLiveServerOptions & { lan?: { address: string } }): { host: LiveHost; close: () => void } {
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

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.closeAllConnections()
    server.close(() => resolve())
  })

function limits(server: Server): void {
  // Stop slow or idle clients from holding the database open.
  server.requestTimeout = 5 * 60_000
  server.headersTimeout = 30_000
}

export async function startLiveServer(options: StartLiveServerOptions): Promise<RunningLiveServer> {
  // Refuse a bad home-network address before binding anything or opening data.
  let lanAddress: string | null = null
  if (options.lanHost !== undefined && options.lanHost !== null) {
    const checked = validateLanHost(options.lanHost, options.lanInterfaces)
    if (!checked.ok) throw new LanHostError(checked.error)
    lanAddress = checked.address
    // Plain HTTP: only a profile marked as fictional test data may be exposed.
    assertLanDataAllowed(options.dataDir)
  }

  // The real port is needed for Host checks, so a free port is found first.
  const server = createServer()
  await listen(server, options.port, LIVE_HOST)
  const port = (server.address() as AddressInfo).port

  let opened: ReturnType<typeof openLiveHost>
  try {
    opened = openLiveHost({ ...options, port, ...(lanAddress ? { lan: { address: lanAddress } } : {}) })
  } catch (error) {
    await closeServer(server)
    throw error
  }
  server.on('request', (req, res) => {
    if (!opened.host.handle(req, res)) {
      res.writeHead(404).end()
    }
  })
  limits(server)

  let lanServer: Server | null = null
  let lanOrigin: string | null = null
  if (lanAddress) {
    const lan = createServer()
    try {
      const handleLan = opened.host.handleLan
      if (!handleLan) throw new LanHostError('The home-network listener could not be set up. Nothing was started.')
      lan.on('request', (req, res) => {
        if (!handleLan(req, res)) res.writeHead(404).end()
      })
      limits(lan)
      await listen(lan, port, lanAddress)
      const bound = lan.address() as AddressInfo
      if (bound.address !== lanAddress || bound.port !== port) {
        throw new LanHostError('The home-network listener bound to an unexpected address. Nothing was started.')
      }
      lanServer = lan
      lanOrigin = `http://${lanAddress}:${port}`
    } catch (error) {
      await closeServer(lan)
      await closeServer(server)
      opened.close()
      throw error
    }
  }

  const origin = `http://${LIVE_HOST}:${port}`
  return {
    origin,
    lanOrigin,
    port,
    launchUrl: `${origin}${opened.host.launchPath}`,
    close: async () => {
      await Promise.all([closeServer(server), lanServer ? closeServer(lanServer) : Promise.resolve()])
      opened.close()
    }
  }
}
