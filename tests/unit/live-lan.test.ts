import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireDataDirLock } from '../../src/server/data-dir'
import { LanHostError } from '../../src/server/lan'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import { send, signIn, type Reply } from './live-helpers'

// The opt-in home-network listener (#135) over real HTTP: static client only,
// every data API closed. Fictional data only.

const appInfo = { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' } as const

const privateAddresses = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter((e) => e.family === 'IPv4' && !e.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.address))
  .map((e) => e.address)
const lanAddress = privateAddresses.find((address) => privateAddresses.filter((a) => a === address).length === 1)

let root: string
let dataDir: string
let staticDir: string
let logs: string[]
let running: RunningLiveServer | null
let blocker: ReturnType<typeof createServer> | null

async function start(lanHost: string | null = lanAddress ?? null): Promise<RunningLiveServer> {
  running = await startLiveServer({ dataDir, port: 0, staticDir, lanHost, appInfo, log: (line) => logs.push(line) })
  return running
}

/** A request to the home-network socket with any Host header. */
function lanSend(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
  host = `${lanAddress}:${port}`
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: lanAddress, port, method, path, agent: false, headers: { Host: host, ...headers } }, (res) => {
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

const noCookieOrCors = (reply: Reply) => {
  expect(reply.headers['set-cookie']).toBeUndefined()
  expect(Object.keys(reply.headers).filter((h) => h.startsWith('access-control-'))).toEqual([])
}

const freeLoopbackPort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port
      probe.close(() => resolve(p))
    })
  })

const loopbackPortIsFree = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const check = createServer()
    check.once('error', reject)
    check.listen(port, '127.0.0.1', () => check.close(() => resolve()))
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-lan-test-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  logs = []
  running = null
  blocker = null
})

afterEach(async () => {
  await running?.close()
  const held = blocker
  if (held) await new Promise<void>((resolve) => held.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

describe('default start', () => {
  it('has no home-network listener', async () => {
    const live = await start(null)
    expect(live.lanOrigin).toBeNull()
  })
})

describe('with --lan-host', () => {
  it('reports the origin and serves the static client with the same security headers', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    expect(live.lanOrigin).toBe(`http://${lanAddress}:${live.port}`)
    const reply = await lanSend(live.port, 'GET', '/')
    expect(reply.status).toBe(200)
    expect(reply.text).toContain('<title>Live</title>')
    expect(String(reply.headers['content-security-policy'])).toContain("script-src 'self'")
    expect(reply.headers['x-frame-options']).toBe('DENY')
    noCookieOrCors(reply)
  })

  it('refuses every Host but its own address and port', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const hosts = [
      `192.0.2.1:${live.port}`,
      `mypc.local:${live.port}`,
      `127.0.0.1:${live.port}`,
      `localhost:${live.port}`,
      `${lanAddress}:${live.port + 1}`,
      lanAddress
    ]
    for (const host of hosts) {
      for (const path of ['/', '/api/v1/session', '/launch']) {
        const reply = await lanSend(live.port, 'GET', path, {}, undefined, host)
        expect(reply.status, `${host} ${path}`).toBe(421)
        expect(reply.json()).toEqual({ error: 'bad-host' })
        noCookieOrCors(reply)
      }
    }
  })

  it('makes the loopback socket refuse the home-network Host', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const reply = await send(live, 'GET', '/api/v1/session', { Host: `${lanAddress}:${live.port}` })
    expect(reply.status).toBe(421)
  })

  it('never inspects the launch token or sets a cookie on /launch', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const launchPath = new URL(live.launchUrl).pathname + new URL(live.launchUrl).search
    const reply = await lanSend(live.port, 'GET', launchPath)
    expect(reply.status).toBe(404)
    noCookieOrCors(reply)
    // The token was not consumed: it still works on loopback.
    expect((await send(live, 'GET', launchPath)).status).toBe(303)
  })

  it('answers the session probe as signed out, even with a valid loopback cookie', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const signed = await signIn(live)
    const reply = await lanSend(live.port, 'GET', '/api/v1/session', { Cookie: signed.cookie })
    expect(reply.status).toBe(200)
    expect(reply.json()).toEqual({ authenticated: false, demoUrl: null, remote: true })
    noCookieOrCors(reply)
  })

  it('closes every data path to a valid loopback session', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const signed = await signIn(live)
    const headers = { Origin: live.lanOrigin as string, Cookie: signed.cookie, 'X-TG-CSRF': signed.csrf, 'Content-Type': 'application/json' }
    const attempts: [string, string, string?][] = [
      ['POST', '/api/v1/call/listClients', JSON.stringify({ args: [{ text: '', status: 'all', sources: [], sort: 'name' }] })],
      ['POST', '/api/v1/call/noSuchCall', '{}'],
      ['POST', '/api/v1/backup/upload', 'not a backup'],
      ['GET', '/api/v1/backup/download/any.tgbackup'],
      ['GET', '/api/v1/session/extra'],
      ['PUT', '/api/v1/session', '{}'],
      ['DELETE', '/api/v1/call/listClients'],
      ['GET', '/api'],
      ['GET', '/api/other']
    ]
    for (const [method, path, body] of attempts) {
      const reply = await lanSend(live.port, method, path, headers, body)
      expect(reply.status, `${method} ${path}`).toBe(401)
      expect(reply.json()).toEqual({ error: 'not-signed-in' })
      noCookieOrCors(reply)
    }
  })

  it('logs with a lan prefix and no addresses, tokens or bodies', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const signed = await signIn(live)
    logs.length = 0
    await lanSend(live.port, 'GET', '/')
    await lanSend(live.port, 'POST', '/api/v1/call/listClients', { Cookie: signed.cookie }, '{"args":["secret-body"]}')
    await lanSend(live.port, 'GET', '/', {}, undefined, 'mypc.local')
    expect(logs).toHaveLength(3)
    expect(logs.every((line) => line.startsWith('lan '))).toBe(true)
    const all = logs.join('\n')
    expect(all).not.toContain(lanAddress)
    expect(all).not.toContain(signed.csrf)
    expect(all).not.toContain('secret-body')
  })

  it('leaves loopback fully working alongside', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const signed = await signIn(live)
    const session = (await send(live, 'GET', '/api/v1/session', { Cookie: signed.cookie })).json() as { authenticated: boolean }
    expect(session.authenticated).toBe(true)
    expect((await send(live, 'GET', '/')).status).toBe(200)
  })

  it('stops both listeners when closed', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const { port } = live
    await live.close()
    running = null
    await expect(lanSend(port, 'GET', '/')).rejects.toThrow()
    await expect(send({ port } as RunningLiveServer, 'GET', '/')).rejects.toThrow()
  })

  it('fails closed when the home-network port is busy', async (context) => {
    if (!lanAddress) return context.skip()
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, lanAddress, () => resolve()))
    const port = (probe.address() as { port: number }).port
    blocker = probe
    await expect(startLiveServer({ dataDir, port, staticDir, lanHost: lanAddress, appInfo })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    // The loopback port was released and the data folder lock is free again.
    await loopbackPortIsFree(port)
    acquireDataDirLock(dataDir)()
  })
})

describe('fail closed on an invalid address', () => {
  it('rejects before binding anything or opening data', async () => {
    for (const lanHost of ['0.0.0.0', '8.8.8.8', '127.0.0.1', 'localhost', '']) {
      await expect(startLiveServer({ dataDir, port: 0, staticDir, lanHost, appInfo })).rejects.toBeInstanceOf(LanHostError)
    }
    acquireDataDirLock(dataDir)()
  })

  it('rejects an address the computer does not have, leaving the loopback port and lock free', async () => {
    const port = await freeLoopbackPort()
    const lanInterfaces = {
      Ethernet: [
        { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.20/24' }
      ]
    }
    await expect(startLiveServer({ dataDir, port, staticDir, lanHost: '192.168.77.77', lanInterfaces, appInfo })).rejects.toThrow(
      /not an address of this computer/
    )
    await loopbackPortIsFree(port)
    acquireDataDirLock(dataDir)()
  })
})
