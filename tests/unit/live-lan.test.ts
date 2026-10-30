import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireDataDirLock } from '../../src/server/data-dir'
import { defaultLiveDataDir } from '../../src/server/data-dir'
import { LanHostError } from '../../src/server/lan'
import { assertLanDataAllowed, initLanTestProfile, LAN_TEST_MARKER } from '../../src/server/lan-profile'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import { call, send, signIn, type Reply, type Signed } from './live-helpers'

// The opt-in home-network listener (#135) over real HTTP, with household-device
// enrollment and sessions (#136). Fictional data only.

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

/** A profile marked as fictional test data, as `--init-lan-test-profile` makes it. */
function markProfile(): void {
  if (!existsSync(join(dataDir, LAN_TEST_MARKER))) initLanTestProfile(dataDir)
}

async function start(lanHost: string | null = lanAddress ?? null, now?: () => Date): Promise<RunningLiveServer> {
  if (lanHost) markProfile()
  running = await startLiveServer({ dataDir, port: 0, staticDir, lanHost, appInfo, log: (line) => logs.push(line), ...(now ? { now } : {}) })
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
    // Backups never travel over the home network, signed in or not.
    for (const [method, path, body] of [
      ['POST', '/api/v1/backup/upload', 'not a backup'],
      ['GET', '/api/v1/backup/download/any.tgbackup', undefined]
    ] as const) {
      const reply = await lanSend(live.port, method, path, headers, body)
      expect(reply.status, `${method} ${path}`).toBe(403)
      expect(reply.json()).toEqual({ error: 'host-only' })
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
    markProfile()
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

// ---- Device enrollment, sessions and host-only administration (#136) ----

const clientInput = {
  displayName: 'Ana Ejemplo',
  source: 'fiverr',
  sourceDetail: null,
  fiverrUsername: 'fictional_buyer_01',
  email: null,
  otherContact: null,
  preferredContactChannel: 'fiverr'
}
const listQuery = { text: '', status: 'all', sources: [], sort: 'name' }

interface Paired {
  cookie: string
  csrf: string
  setCookie: string
}

const json = (headers: Record<string, string> = {}): Record<string, string> => ({ 'Content-Type': 'application/json', ...headers })

async function newCode(live: RunningLiveServer, host: Signed): Promise<string> {
  return (await call<{ code: string }>(live, host, 'createPairingCode')).code
}

function enrollRequest(live: RunningLiveServer, code: string, deviceName?: string, extra: Record<string, string> = {}) {
  return lanSend(
    live.port,
    'POST',
    '/api/v1/lan/enroll',
    json({ Origin: live.lanOrigin as string, ...extra }),
    JSON.stringify(deviceName === undefined ? { code } : { code, deviceName })
  )
}

async function pair(live: RunningLiveServer, host: Signed, deviceName = 'Kitchen tablet'): Promise<Paired> {
  const reply = await enrollRequest(live, await newCode(live, host), deviceName)
  expect(reply.status, reply.text).toBe(200)
  const setCookie = String(reply.headers['set-cookie']?.[0])
  const cookie = setCookie.split(';')[0]!
  const session = (await lanSend(live.port, 'GET', '/api/v1/session', { Cookie: cookie })).json() as { csrfToken: string }
  return { cookie, csrf: session.csrfToken, setCookie }
}

const lanHeaders = (live: RunningLiveServer, paired: Paired, extra: Record<string, string> = {}) =>
  json({ Origin: live.lanOrigin as string, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf, ...extra })

const lanCall = (live: RunningLiveServer, paired: Paired, name: string, args: unknown[] = [], extra: Record<string, string> = {}) =>
  lanSend(live.port, 'POST', `/api/v1/call/${name}`, lanHeaders(live, paired, extra), JSON.stringify({ args }))

const START = Date.parse('2026-10-30T09:00:00.000Z')

describe('device enrollment and sessions', () => {
  it('pairs a device, then one SQLite serves both the device and the host', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    expect(paired.setCookie).toBe(`${paired.cookie}; Path=/; HttpOnly; SameSite=Strict`)
    expect(paired.cookie.startsWith(`tg_lan_${live.port}=`)).toBe(true)

    const session = (await lanSend(live.port, 'GET', '/api/v1/session', { Cookie: paired.cookie })).json()
    expect(session).toEqual({ authenticated: true, csrfToken: paired.csrf, demoUrl: null, remote: true, device: { name: 'Kitchen tablet' } })

    const created = await lanCall(live, paired, 'createClient', [clientInput])
    expect(created.status, created.text).toBe(200)
    const fromHost = await call<{ displayName: string }[]>(live, host, 'listClients', listQuery)
    expect(fromHost.map((c) => c.displayName)).toEqual(['Ana Ejemplo'])
    const fromLan = (await lanCall(live, paired, 'listClients', [listQuery])).json() as { result: { displayName: string }[] }
    expect(fromLan.result.map((c) => c.displayName)).toEqual(['Ana Ejemplo'])
  })

  it('prints a console line for a pairing with no name and no code', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const code = await newCode(live, host)
    logs.length = 0
    expect((await enrollRequest(live, code, 'Secret Name Tablet')).status).toBe(200)
    expect(logs).toContain('A device was paired on the home network.')
    const all = logs.join('\n')
    expect(all).not.toContain('Secret Name Tablet')
    expect(all).not.toContain(code.replace('-', ''))
    expect(all).not.toContain(code)
  })

  it('refuses a data call without the CSRF token', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const paired = await pair(live, await signIn(live))
    for (const csrf of [undefined, 'wrong-token']) {
      const headers = json({ Origin: live.lanOrigin as string, Cookie: paired.cookie, ...(csrf ? { 'X-TG-CSRF': csrf } : {}) })
      const reply = await lanSend(live.port, 'POST', '/api/v1/call/listClients', headers, JSON.stringify({ args: [listQuery] }))
      expect(reply.status).toBe(403)
      expect(reply.json()).toEqual({ error: 'bad-csrf-token' })
    }
  })

  it('refuses a wrong Origin, a cross-site fetch and a missing session', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const paired = await pair(live, await signIn(live))
    const body = JSON.stringify({ args: [listQuery] })
    for (const origin of [`http://127.0.0.1:${live.port}`, 'http://evil.example', `https://${lanAddress}:${live.port}`]) {
      const reply = await lanSend(live.port, 'POST', '/api/v1/call/listClients', { ...lanHeaders(live, paired), Origin: origin }, body)
      expect(reply.status, origin).toBe(403)
      expect(reply.json()).toEqual({ error: 'not-same-origin' })
      noCookieOrCors(reply)
    }
    const noOrigin = lanHeaders(live, paired)
    delete noOrigin['Origin']
    expect((await lanSend(live.port, 'POST', '/api/v1/call/listClients', noOrigin, body)).status).toBe(403)

    const crossSite = await lanCall(live, paired, 'listClients', [listQuery], { 'Sec-Fetch-Site': 'cross-site' })
    expect(crossSite.status).toBe(403)
    expect(crossSite.json()).toEqual({ error: 'not-same-origin' })
    expect((await lanCall(live, paired, 'listClients', [listQuery], { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200)

    const anonymous = await lanSend(live.port, 'POST', '/api/v1/call/listClients', json({ Origin: live.lanOrigin as string, 'X-TG-CSRF': paired.csrf }), body)
    expect(anonymous.status).toBe(401)
  })

  it('refuses the loopback cookie on LAN, and the LAN cookie on loopback', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const body = JSON.stringify({ args: [listQuery] })
    // Loopback cookie and CSRF presented to the LAN listener, also under the LAN cookie name.
    const hostSession = host.cookie.split('=')[1]!
    for (const cookie of [host.cookie, `tg_lan_${live.port}=${hostSession}`]) {
      const reply = await lanSend(live.port, 'POST', '/api/v1/call/listClients', json({ Origin: live.lanOrigin as string, Cookie: cookie, 'X-TG-CSRF': host.csrf }), body)
      expect(reply.status).toBe(401)
    }
    const probe = (await lanSend(live.port, 'GET', '/api/v1/session', { Cookie: host.cookie })).json() as { authenticated: boolean }
    expect(probe.authenticated).toBe(false)

    // The LAN session id presented to loopback, under either cookie name.
    const lanId = paired.cookie.split('=')[1]!
    for (const name of [`tg_lan_${live.port}`, `tg_live_${live.port}`]) {
      const session = (await send(live, 'GET', '/api/v1/session', { Cookie: `${name}=${lanId}` })).json() as { authenticated: boolean }
      expect(session.authenticated).toBe(false)
      const reply = await send(live, 'POST', '/api/v1/call/listClients', json({ Origin: live.origin, Cookie: `${name}=${lanId}`, 'X-TG-CSRF': paired.csrf }), body)
      expect(reply.status).toBe(401)
    }
  })

  it('keeps host-only calls, backups and device administration away from paired devices', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const paired = await pair(live, await signIn(live))
    const hostOnly = [
      'createBackup',
      'restoreBackup',
      'getBackupStatus',
      'getLanStatus',
      'createPairingCode',
      'listDevices',
      'revokeDevice',
      'revokeAllDevices',
      'noSuchCall'
    ]
    for (const name of hostOnly) {
      const reply = await lanCall(live, paired, name, name === 'revokeDevice' ? ['x'] : [])
      expect(reply.status, name).toBe(403)
      expect(reply.json()).toEqual({ error: 'host-only' })
    }
    const upload = await lanSend(live.port, 'POST', '/api/v1/backup/upload', lanHeaders(live, paired, { 'Content-Type': 'application/octet-stream' }), 'x')
    expect(upload.status).toBe(403)
    expect(upload.json()).toEqual({ error: 'host-only' })
    const download = await lanSend(live.port, 'GET', '/api/v1/backup/download/a.tgbackup', { Cookie: paired.cookie })
    expect(download.status).toBe(403)
    expect(download.json()).toEqual({ error: 'host-only' })
    // The device is still signed in.
    expect((await lanCall(live, paired, 'getAppInfo')).status).toBe(200)
  })

  it('answers other /api paths 404 when signed in and 401 when not', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const paired = await pair(live, await signIn(live))
    expect((await lanSend(live.port, 'GET', '/api/other', { Cookie: paired.cookie })).status).toBe(404)
    expect((await lanSend(live.port, 'GET', '/api/other')).status).toBe(401)
  })

  it('stops brute force: 5 wrong guesses kill the code, and the 11th attempt in a minute is a 429', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const code = await newCode(live, host)
    for (let i = 0; i < 5; i++) {
      const reply = await enrollRequest(live, 'WRONG-CODE')
      expect(reply.status).toBe(401)
      expect(reply.json()).toEqual({ error: 'invalid-code' })
      expect(reply.headers['set-cookie']).toBeUndefined()
    }
    const killed = await enrollRequest(live, code)
    expect(killed.status).toBe(401)
    expect(killed.headers['set-cookie']).toBeUndefined()

    // 6 attempts used; four more are allowed, then the limiter answers without checking the code.
    const fresh = await newCode(live, host)
    for (let i = 0; i < 4; i++) expect((await enrollRequest(live, 'WRONG-CODE')).status).toBe(401)
    const limited = await enrollRequest(live, fresh)
    expect(limited.status).toBe(429)
    expect(limited.json()).toEqual({ error: 'too-many-attempts' })
    noCookieOrCors(limited)
  })

  it('refuses a replayed code and answers used and wrong codes identically', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const code = await newCode(live, host)
    expect((await enrollRequest(live, code, 'Phone')).status).toBe(200)
    const replay = await enrollRequest(live, code, 'Phone')
    const wrong = await enrollRequest(live, 'ZZZZ-ZZZZ', 'Phone')
    expect(replay.status).toBe(401)
    expect(replay.text).toBe(wrong.text)
    expect(replay.headers['set-cookie']).toBeUndefined()
  })

  it('validates the enrollment request', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const code = await newCode(live, host)
    const origin = live.lanOrigin as string
    const post = (headers: Record<string, string>, body: string) => lanSend(live.port, 'POST', '/api/v1/lan/enroll', headers, body)

    const badOrigins: Record<string, string>[] = [{}, { Origin: 'http://evil.example' }, { Origin: `http://127.0.0.1:${live.port}` }]
    for (const bad of badOrigins) {
      const reply = await post(json(bad), JSON.stringify({ code }))
      expect(reply.status).toBe(403)
      expect(reply.json()).toEqual({ error: 'not-same-origin' })
    }
    expect((await post(json({ Origin: origin, 'Sec-Fetch-Site': 'cross-site' }), JSON.stringify({ code }))).status).toBe(403)
    expect((await post({ Origin: origin, 'Content-Type': 'text/plain' }, JSON.stringify({ code }))).status).toBe(415)
    expect((await post(json({ Origin: origin }), 'not json')).status).toBe(400)
    expect((await post(json({ Origin: origin }), JSON.stringify({ code, extra: 1 }))).status).toBe(400)
    expect((await post(json({ Origin: origin }), JSON.stringify({ code: 'x'.repeat(21) }))).status).toBe(400)
    expect((await post(json({ Origin: origin }), JSON.stringify({ code: 5 }))).status).toBe(400)
    expect((await post(json({ Origin: origin }), JSON.stringify({ code, deviceName: 'bad\nname' }))).status).toBe(400)
    const big = await post(json({ Origin: origin }), JSON.stringify({ code, deviceName: 'x'.repeat(5000) }))
    expect(big.status).toBe(413)
    expect((await lanSend(live.port, 'GET', '/api/v1/lan/enroll')).status).toBe(401)
    // None of those used up the code.
    expect((await enrollRequest(live, code, '  Tablet  ')).status).toBe(200)
  })

  it('caps devices at 10 and re-enrolling rotates the old session', async (context) => {
    if (!lanAddress) return context.skip()
    let clock = START
    const live = await start(lanAddress, () => new Date(clock))
    const host = await signIn(live)
    const first = await pair(live, host, 'Device 0')
    for (let i = 1; i < 10; i++) {
      clock += 7_000
      await pair(live, host, `Device ${i}`)
    }
    clock += 61_000
    const full = await enrollRequest(live, await newCode(live, host), 'One too many')
    expect(full.status).toBe(409)
    expect(full.json()).toEqual({ error: 'too-many-devices' })
    expect(full.headers['set-cookie']).toBeUndefined()

    // The same browser pairing again drops its old session and reuses its slot.
    const code = await newCode(live, host)
    const again = await lanSend(
      live.port,
      'POST',
      '/api/v1/lan/enroll',
      json({ Origin: live.lanOrigin as string, Cookie: first.cookie }),
      JSON.stringify({ code, deviceName: 'Device 0 again' })
    )
    expect(again.status, again.text).toBe(200)
    expect((await lanCall(live, first, 'getAppInfo')).status).toBe(401)
    expect((await call<unknown[]>(live, host, 'listDevices')).length).toBe(10)
  })

  it('revokes one device and all devices', async (context) => {
    if (!lanAddress) return context.skip()
    let clock = START
    const live = await start(lanAddress, () => new Date(clock))
    const host = await signIn(live)
    const a = await pair(live, host, 'Tablet A')
    clock += 7_000
    const b = await pair(live, host, 'Tablet B')
    const list = await call<{ id: string; name: string; enrolledAt: string; lastSeenAt: string }[]>(live, host, 'listDevices')
    expect(list.map((d) => d.name)).toEqual(['Tablet A', 'Tablet B'])
    expect(Object.keys(list[0]!).sort()).toEqual(['enrolledAt', 'id', 'lastSeenAt', 'name'])
    expect(JSON.stringify(list)).not.toContain(a.cookie.split('=')[1]!)

    expect(await call(live, host, 'revokeDevice', list[0]!.id)).toEqual({ revoked: true })
    expect((await lanCall(live, a, 'getAppInfo')).status).toBe(401)
    expect((await lanCall(live, b, 'getAppInfo')).status).toBe(200)
    expect(await call(live, host, 'revokeDevice', list[0]!.id)).toEqual({ revoked: false })
    expect(await call(live, host, 'revokeAllDevices')).toEqual({ revoked: 1 })
    expect((await lanCall(live, b, 'getAppInfo')).status).toBe(401)
    expect(await call(live, host, 'listDevices')).toEqual([])
  })

  it('logs out: needs Origin and CSRF, then clears the cookie and the device', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const logout = (headers: Record<string, string>) => lanSend(live.port, 'POST', '/api/v1/lan/logout', headers, '{}')

    expect((await logout(json({ Origin: 'http://evil.example', Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf }))).status).toBe(403)
    expect((await logout(json({ Origin: live.lanOrigin as string, Cookie: paired.cookie }))).status).toBe(403)
    expect((await logout(json({ Origin: live.lanOrigin as string, 'X-TG-CSRF': paired.csrf }))).status).toBe(401)
    expect((await lanCall(live, paired, 'getAppInfo')).status).toBe(200)

    const done = await logout(lanHeaders(live, paired))
    expect(done.status).toBe(200)
    expect(done.headers['set-cookie']?.[0]).toBe(`tg_lan_${live.port}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
    expect((await lanCall(live, paired, 'getAppInfo')).status).toBe(401)
    expect(await call(live, host, 'listDevices')).toEqual([])
  })

  it('expires a session after 60 minutes idle and after 12 hours', async (context) => {
    if (!lanAddress) return context.skip()
    let clock = START
    const live = await start(lanAddress, () => new Date(clock))
    const host = await signIn(live)
    const idle = await pair(live, host, 'Idle')
    clock += 59 * 60_000
    expect((await lanCall(live, idle, 'getAppInfo')).status).toBe(200)
    clock += 61 * 60_000
    expect((await lanCall(live, idle, 'getAppInfo')).status).toBe(401)
    const probe = (await lanSend(live.port, 'GET', '/api/v1/session', { Cookie: idle.cookie })).json() as { authenticated: boolean }
    expect(probe.authenticated).toBe(false)

    const busy = await pair(live, host, 'Busy')
    for (let i = 0; i < 23; i++) {
      clock += 30 * 60_000
      expect((await lanCall(live, busy, 'getAppInfo')).status, `after ${(i + 1) * 30} min`).toBe(200)
    }
    clock += 30 * 60_000
    expect((await lanCall(live, busy, 'getAppInfo')).status).toBe(401)
  })

  it('expires a pairing code after 5 minutes', async (context) => {
    if (!lanAddress) return context.skip()
    let clock = START
    const live = await start(lanAddress, () => new Date(clock))
    const code = await newCode(live, await signIn(live))
    clock += 5 * 60_000
    expect((await enrollRequest(live, code)).status).toBe(401)
  })

  it('sets no cookie on failures and sends no CORS headers anywhere', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const replies = [
      await enrollRequest(live, 'WRONG-CODE'),
      await lanSend(live.port, 'POST', '/api/v1/lan/enroll', json(), '{}'),
      await lanSend(live.port, 'OPTIONS', '/api/v1/call/listClients', { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' }),
      await lanSend(live.port, 'GET', '/api/v1/session', { Origin: 'http://evil.example' }),
      await lanCall(live, paired, 'createBackup'),
      await lanSend(live.port, 'GET', '/', { Origin: 'http://evil.example' })
    ]
    for (const reply of replies) noCookieOrCors(reply)
  })

  it('logs only method, route template and status', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const code = await newCode(live, host)
    logs.length = 0
    const reply = await enrollRequest(live, code, 'Sensitive Device Name')
    const cookie = String(reply.headers['set-cookie']?.[0]).split(';')[0]!
    const lanLines = () => logs.filter((l) => l.startsWith('lan '))
    expect(lanLines()).toEqual(['lan POST /api/v1/lan/enroll 200'])
    await lanSend(live.port, 'POST', '/api/v1/call/listClients', json({ Cookie: cookie }), '{"args":["secret-body"]}')
    expect(lanLines()[1]).toBe('lan POST /api/v1/call/:name 403')
    const all = logs.join('\n')
    expect(all).not.toContain(cookie.split('=')[1]!)
    expect(all).not.toContain('Sensitive Device Name')
    expect(all).not.toContain('secret-body')
    expect(all).not.toContain(lanAddress)
  })

  it('reports host status, and refuses restore and backup upload while the LAN listener is on', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    expect(await call(live, host, 'getLanStatus')).toEqual({ enabled: true, origin: live.lanOrigin })
    expect(await call<{ code: string }>(live, host, 'createPairingCode')).toMatchObject({ code: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/) })
    const headers = json({ Origin: live.origin, Cookie: host.cookie, 'X-TG-CSRF': host.csrf })
    const restore = await send(live, 'POST', '/api/v1/call/restoreBackup', headers, JSON.stringify({ args: ['x'.repeat(10)] }))
    expect(restore.status).toBe(409)
    expect(restore.json()).toEqual({ error: 'restore-disabled-while-lan' })
    const upload = await send(live, 'POST', '/api/v1/backup/upload', { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': '1' }, 'x')
    expect(upload.status).toBe(409)
    expect(upload.json()).toEqual({ error: 'restore-disabled-while-lan' })
    // Making a backup on the host still works.
    expect((await send(live, 'POST', '/api/v1/call/createBackup', headers, '{"args":[]}')).status).toBe(200)
  })

  it('needs the loopback session and CSRF for host-only calls', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const noCsrf = await send(live, 'POST', '/api/v1/call/createPairingCode', json({ Origin: live.origin, Cookie: host.cookie }), '{"args":[]}')
    expect(noCsrf.status).toBe(403)
    const anon = await send(live, 'POST', '/api/v1/call/createPairingCode', json({ Origin: live.origin }), '{"args":[]}')
    expect(anon.status).toBe(401)
  })
})

describe('when the home-network listener is off', () => {
  it('reports it off, refuses pairing codes and does not block restore', async () => {
    const live = await start(null)
    const host = await signIn(live)
    expect(await call(live, host, 'getLanStatus')).toEqual({ enabled: false, origin: null })
    const headers = json({ Origin: live.origin, Cookie: host.cookie, 'X-TG-CSRF': host.csrf })
    const code = await send(live, 'POST', '/api/v1/call/createPairingCode', headers, '{"args":[]}')
    expect(code.status).toBe(409)
    expect(code.json()).toEqual({ error: 'lan-off' })
    expect(await call(live, host, 'listDevices')).toEqual([])
    const restore = await send(live, 'POST', '/api/v1/call/restoreBackup', headers, JSON.stringify({ args: ['no-such-token'] }))
    // Reaches the normal validation (a made-up token is not a valid one), not the LAN guard.
    expect(restore.status).not.toBe(409)
  })
})

describe('real-data gate', () => {
  const lanInterfaces = {
    Ethernet: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.20/24' }]
  }

  it('refuses the default profile', async () => {
    const port = await freeLoopbackPort()
    await expect(startLiveServer({ dataDir: defaultLiveDataDir(), port, staticDir, lanHost: '192.168.1.20', lanInterfaces, appInfo })).rejects.toThrow(
      /default data folder/
    )
    await loopbackPortIsFree(port)
  })

  it('refuses a folder with no marker, and one with the wrong marker, before binding', async () => {
    const port = await freeLoopbackPort()
    const options = { dataDir, port, staticDir, lanHost: '192.168.1.20', lanInterfaces, appInfo }
    await expect(startLiveServer(options)).rejects.toBeInstanceOf(LanHostError)
    await expect(startLiveServer(options)).rejects.toThrow(/fictional test profile/)
    mkdirSync(dataDir, { recursive: true })
    for (const content of ['not json', '{}', '{"kind":"real"}', '{"kind":"fictional-test-ish"}', '[]', 'null']) {
      writeFileSync(join(dataDir, LAN_TEST_MARKER), content)
      await expect(startLiveServer(options), content).rejects.toBeInstanceOf(LanHostError)
    }
    await loopbackPortIsFree(port)
    acquireDataDirLock(dataDir)()
  })

  describe('--init-lan-test-profile', () => {
    it('writes the marker into a new folder or an empty one', () => {
      initLanTestProfile(dataDir)
      expect(JSON.parse(readFileSync(join(dataDir, LAN_TEST_MARKER), 'utf8'))).toMatchObject({ kind: 'fictional-test' })
      expect(() => assertLanDataAllowed(dataDir)).not.toThrow()

      const empty = join(root, 'empty')
      mkdirSync(empty)
      initLanTestProfile(empty)
      expect(existsSync(join(empty, LAN_TEST_MARKER))).toBe(true)
    })

    it('refuses a folder that already has anything in it, and never writes there', () => {
      const used = join(root, 'used')
      mkdirSync(used)
      writeFileSync(join(used, 'tracing-guatemala.sqlite'), 'pretend database')
      expect(() => initLanTestProfile(used)).toThrow(/doesn't exist yet or is empty/)
      expect(existsSync(join(used, LAN_TEST_MARKER))).toBe(false)
      // Running it twice does not re-mark either.
      initLanTestProfile(dataDir)
      expect(() => initLanTestProfile(dataDir)).toThrow(LanHostError)
    })

    it('refuses the default profile and a plain file', () => {
      expect(() => initLanTestProfile(defaultLiveDataDir())).toThrow(/default data folder/)
      const file = join(root, 'a-file')
      writeFileSync(file, 'x')
      expect(() => initLanTestProfile(file)).toThrow(LanHostError)
    })

    it('explains fictional data, unencrypted HTTP and the HTTPS phase', () => {
      let message = ''
      try {
        assertLanDataAllowed(dataDir)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toMatch(/fictional test data only/)
      expect(message).toMatch(/unencrypted/)
      expect(message).toMatch(/HTTPS phase/)
    })
  })
})
