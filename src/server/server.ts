import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { AppData } from '../main/database/app-data'
import type { AppInfo } from '../shared/ipc'
import { acquireDataDirLock, checkLiveDataDir } from './data-dir'
import { checkLanDemoResolves, LanHostError, validateHttpsHost, validateLanDemoName, validateLanHost, type LanDemoResolve } from './lan'
import { startDemoMirror, type RunningDemoMirror } from './demo-mirror'
import { assertLanDataAllowed } from './lan-profile'
import { createLiveHost, type LiveHost } from './live-host'

// Starts the Live web host (#110): opens the web profile's database, then
// serves the API and the built client on 127.0.0.1. By default that is the only
// listener. With an explicit `lanHost` (#135) a second listener binds to that one
// validated private IPv4 address; paired devices (#136) may use it, but only on
// a profile marked as fictional test data (lan-profile.ts). Any failure to set it
// up closes everything and rethrows (fail closed). With an explicit `httpsHost`
// (#167) the second listener is instead bound to 127.0.0.1 on port + 2 for a
// local reverse proxy (e.g. Caddy) that terminates TLS for that DNS name; it uses
// the same device-pairing request path with the https origin. Forwarded headers
// are never read. Same fictional-profile gate. See
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
  /**
   * Opt-in trusted-proxy HTTPS mode (#167): the DNS name a local reverse proxy serves over
   * TLS. A listener on 127.0.0.1:<port + 2> answers only that Host. Exclusive with `lanHost`.
   */
  httpsHost?: string | null
  /** Test-only: replaces `os.networkInterfaces()` when validating `lanHost`. */
  lanInterfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
  /**
   * Opt-in LAN demo (#137): a DNS name that points at the LAN address. A second demo
   * mirror is bound to the LAN address on port + 1 and accepts only that name.
   * Needs `lanHost` and `demoDir`; any problem leaves it off (Live still starts).
   */
  lanDemoName?: string | null
  /** The built demo (`dist-demo/`) the LAN demo serves. */
  demoDir?: string | null
  /** Test-only: replaces the DNS lookup of `lanDemoName`. */
  lanDemoResolve?: LanDemoResolve
  log?: (line: string) => void
  /** Test-only: the clock for device and pairing-code expiry. */
  now?: () => Date
}

export interface RunningLiveServer {
  origin: string
  /** Origin of the home-network listener (`https://<name>` in proxy mode), or null when it is off (the default) or turned off. */
  lanOrigin: string | null
  /** Where the LAN demo is served (`http://<name>:<port + 1>/`), or null. */
  lanDemoUrl: string | null
  /** Why the requested LAN demo is not served, or null. Safe to print. */
  lanDemoNote: string | null
  /** Turns the home-network access off (#137): closes its listeners, revokes every device. Idempotent. */
  disableLan(): Promise<void>
  port: number
  /** Full launch link, to show only to the person who started the host. */
  launchUrl: string
  close(): Promise<void>
}

/** Opens the data (taking the folder lock) and returns the host, ready to mount on any HTTP server. */
export function openLiveHost(options: StartLiveServerOptions & { lan?: { address: string; demoUrl?: string | null; httpsName?: string | null }; onDisableLan?: () => void }): { host: LiveHost; close: () => void } {
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
  let httpsName: string | null = null
  if (options.httpsHost !== undefined && options.httpsHost !== null) {
    if (options.lanHost !== undefined && options.lanHost !== null) {
      throw new LanHostError("--https-host and --lan-host can't be used together. Choose one. Nothing was started.")
    }
    const name = validateHttpsHost(options.httpsHost)
    if (!name.ok) throw new LanHostError(name.error)
    httpsName = name.name
    // The proxy encrypts, but real data waits for the HTTPS review (#168): fictional profiles only.
    assertLanDataAllowed(options.dataDir)
  }
  if (options.lanHost !== undefined && options.lanHost !== null) {
    const checked = validateLanHost(options.lanHost, options.lanInterfaces)
    if (!checked.ok) throw new LanHostError(checked.error)
    lanAddress = checked.address
    // Plain HTTP: only a profile marked as fictional test data may be exposed.
    assertLanDataAllowed(options.dataDir)
  }

  const log = options.log ?? ((line: string) => console.log(line))

  // The real port is needed for Host checks, so a free port is found first.
  const server = createServer()
  await listen(server, options.port, LIVE_HOST)
  const port = (server.address() as AddressInfo).port

  // The LAN demo is a convenience: whatever goes wrong, Live still starts without it.
  let lanDemo: RunningDemoMirror | null = null
  let lanDemoUrl: string | null = null
  let lanDemoNote: string | null = null
  if (lanAddress && options.lanDemoName) {
    const name = validateLanDemoName(options.lanDemoName)
    if (!name.ok) lanDemoNote = name.error
    else if (!options.demoDir) lanDemoNote = 'the demo is not built (run `npm run web:build`).'
    else {
      const problem = await checkLanDemoResolves(name.name, lanAddress, options.lanDemoResolve)
      if (problem) lanDemoNote = problem
      else {
        try {
          const demoPort = port + 1
          lanDemo = await startDemoMirror({
            port: demoPort,
            demoDir: options.demoDir,
            bindAddress: lanAddress,
            hosts: (bound) => [`${name.name}:${bound}`],
            liveUrl: `http://${lanAddress}:${port}/`,
            log: options.log
          })
          if (!lanDemo) lanDemoNote = 'the demo is not built (run `npm run web:build`).'
          else lanDemoUrl = `http://${name.name}:${lanDemo.port}/`
        } catch (error) {
          lanDemoNote =
            (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `port ${port + 1} is in use on ${lanAddress}.` : 'it could not start.'
        }
      }
    }
  }

  let lanServer: Server | null = null
  let lanOrigin: string | null = null
  let lanClosed: Promise<void> = Promise.resolve()
  /** Closes the home-network sockets (listener and demo). Runs at most once. */
  const closeLanSockets = (): Promise<void> => {
    const closing = [lanServer ? closeServer(lanServer) : Promise.resolve(), lanDemo ? lanDemo.close() : Promise.resolve()]
    lanServer = null
    lanOrigin = null
    lanDemo = null
    lanDemoUrl = null
    return Promise.all(closing).then(() => undefined)
  }

  let opened: ReturnType<typeof openLiveHost>
  try {
    opened = openLiveHost({
      ...options,
      port,
      ...(lanAddress ? { lan: { address: lanAddress, demoUrl: lanDemoUrl } } : {}),
      ...(httpsName ? { lan: { address: LIVE_HOST, httpsName } } : {}),
      onDisableLan: () => {
        lanClosed = closeLanSockets()
        log(`Home-network access was turned off. Paired devices were signed out. Restart with ${httpsName ? '--https-host' : '--lan-host'} to turn it on again.`)
      }
    })
  } catch (error) {
    await closeLanSockets()
    await closeServer(server)
    throw error
  }
  server.on('request', (req, res) => {
    if (!opened.host.handle(req, res)) {
      res.writeHead(404).end()
    }
  })
  limits(server)

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
      await closeLanSockets()
      await closeServer(server)
      opened.close()
      throw error
    }
  }

  if (httpsName) {
    const proxy = createServer()
    const proxyPort = port + 2
    try {
      const handleLan = opened.host.handleLan
      if (!handleLan) throw new LanHostError('The HTTPS listener could not be set up. Nothing was started.')
      proxy.on('request', (req, res) => {
        if (!handleLan(req, res)) res.writeHead(404).end()
      })
      limits(proxy)
      try {
        await listen(proxy, proxyPort, LIVE_HOST)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EADDRINUSE' || code === 'EACCES') {
          throw new LanHostError(
            `Port ${proxyPort} (the Live port + 2, where the HTTPS reverse proxy connects) is in use or not allowed. Nothing was started. Stop the other program or use --port <n>.`
          )
        }
        throw error
      }
      const bound = proxy.address() as AddressInfo
      if (bound.address !== LIVE_HOST || bound.port !== proxyPort) {
        throw new LanHostError('The HTTPS listener bound to an unexpected address. Nothing was started.')
      }
      lanServer = proxy
      lanOrigin = `https://${httpsName}`
    } catch (error) {
      await closeServer(proxy)
      await closeLanSockets()
      await closeServer(server)
      opened.close()
      throw error
    }
  }

  const origin = `http://${LIVE_HOST}:${port}`
  return {
    origin,
    get lanOrigin() {
      return lanOrigin
    },
    get lanDemoUrl() {
      return lanDemoUrl
    },
    lanDemoNote,
    port,
    launchUrl: `${origin}${opened.host.launchPath}`,
    disableLan: async () => {
      opened.host.disableLan()
      await lanClosed
    },
    close: async () => {
      await Promise.all([closeServer(server), closeLanSockets(), lanClosed])
      opened.close()
    }
  }
}
