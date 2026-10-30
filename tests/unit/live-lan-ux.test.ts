import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkLanDemoResolves, validateLanDemoName } from '../../src/server/lan'
import { initLanTestProfile } from '../../src/server/lan-profile'
import { injectLiveUrlMeta, startDemoMirror } from '../../src/server/demo-mirror'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import { isDemoHostname } from '../../src/shared/dns-name'
import { call, send, signIn, type Reply } from './live-helpers'

// Operational controls and the LAN demo (#137) over real HTTP. Fictional data only.

const appInfo = { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' } as const
const privateAddresses = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .filter((e) => e.family === 'IPv4' && !e.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.address))
  .map((e) => e.address)
const lanAddress = privateAddresses.find((address) => privateAddresses.filter((a) => a === address).length === 1)
const NAME = 'tg-demo.test'

let root: string
let dataDir: string
let staticDir: string
let demoDir: string
let logs: string[]
let running: RunningLiveServer | null
let blocker: ReturnType<typeof createServer> | null

function get(
  host: string,
  port: number,
  path: string,
  hostHeader: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, method, path, agent: false, setHost: false, headers: { Host: hostHeader, ...headers } }, (res) => {
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

async function start(
  extra: { lanDemoName?: string | null; resolve?: (name: string) => Promise<string[]>; lan?: boolean; demo?: boolean } = {}
): Promise<RunningLiveServer> {
  const lan = extra.lan !== false && lanAddress
  if (lan) initLanTestProfile(dataDir)
  running = await startLiveServer({
    dataDir,
    port: 0,
    staticDir,
    appInfo,
    lanHost: lan ? lanAddress : null,
    lanDemoName: extra.lanDemoName ?? null,
    demoDir: extra.demo === false ? null : demoDir,
    lanDemoResolve: extra.resolve ?? (async (name) => (name === NAME ? [lanAddress as string] : [])),
    log: (line) => logs.push(line)
  })
  return running
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-lan-ux-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  demoDir = join(root, 'demo')
  mkdirSync(staticDir, { recursive: true })
  mkdirSync(demoDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  writeFileSync(join(demoDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Demo</title></head><body></body></html>')
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

describe('demo name rules', () => {
  it('accepts DNS names with a dot and lowercases them', () => {
    expect(validateLanDemoName('tg-demo.test')).toEqual({ ok: true, name: 'tg-demo.test' })
    expect(validateLanDemoName(' TG-Demo.Home.Arpa ')).toEqual({ ok: true, name: 'tg-demo.home.arpa' })
  })

  it.each([
    '',
    'demo',
    'localhost',
    'demo.localhost',
    'a.localhost',
    '192.168.1.20',
    '10.0.0.5',
    '1.2.3.4',
    '0x7f.0.0.1',
    '127.1',
    '-demo.test',
    'demo-.test',
    'demo.-test',
    'de mo.test',
    'demo_x.test',
    'demo..test',
    '.demo.test',
    'demo.test.',
    'demo.test:4181',
    'http://demo.test',
    'demo.test/path',
    'user@demo.test',
    'dé.test',
    `${'a'.repeat(64)}.test`,
    `${'a.'.repeat(130)}test`
  ])('refuses %j', (name) => {
    expect(validateLanDemoName(name).ok).toBe(false)
    expect(isDemoHostname(name)).toBe(false)
  })

  it('requires the LAN address among the lookup results', async () => {
    expect(await checkLanDemoResolves(NAME, '192.168.1.20', async () => ['192.168.1.20'])).toBeNull()
    expect(await checkLanDemoResolves(NAME, '192.168.1.20', async () => ['10.0.0.9', '192.168.1.20'])).toBeNull()
    expect(await checkLanDemoResolves(NAME, '192.168.1.20', async () => ['10.0.0.9'])).toMatch(/not to 192\.168\.1\.20/)
    expect(await checkLanDemoResolves(NAME, '192.168.1.20', async () => [])).toMatch(/resolves to nothing/)
    expect(await checkLanDemoResolves(NAME, '192.168.1.20', async () => Promise.reject(new Error('ENOTFOUND')))).toMatch(/does not resolve/)
  })
})

describe('default start', () => {
  it('has no LAN listener, no LAN demo, and reports LAN off', async () => {
    const live = await start({ lan: false, lanDemoName: NAME })
    expect(live.lanOrigin).toBeNull()
    expect(live.lanDemoUrl).toBeNull()
    expect(await call(live, await signIn(live), 'getLanStatus')).toEqual({ enabled: false, origin: null })
    if (lanAddress) {
      await expect(get(lanAddress, live.port, '/', `${lanAddress}:${live.port}`)).rejects.toBeInstanceOf(Error)
      await expect(get(lanAddress, live.port + 1, '/', `${NAME}:${live.port + 1}`)).rejects.toBeInstanceOf(Error)
    }
  })
})

describe('the LAN demo', () => {
  it('serves the demo on port + 1 under the name only, with the Live address injected', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ lanDemoName: NAME })
    const demoPort = live.port + 1
    expect(live.lanDemoUrl).toBe(`http://${NAME}:${demoPort}/`)
    expect(live.lanDemoNote).toBeNull()

    const ok = await get(lanAddress, demoPort, '/', `${NAME}:${demoPort}`)
    expect(ok.status).toBe(200)
    expect(ok.text).toContain(`<head><meta name="tg-live-url" content="http://${lanAddress}:${live.port}/"><meta charset="utf-8">`)
    expect(Number(ok.headers['content-length'])).toBe(Buffer.byteLength(ok.text))
    expect(String(ok.headers['content-security-policy'])).toContain("connect-src 'none'")
    expect(ok.headers['set-cookie']).toBeUndefined()

    // The IP Host would be the same site as Live: refused. So is every other Host.
    const hosts = [`${lanAddress}:${demoPort}`, `localhost:${demoPort}`, `127.0.0.1:${demoPort}`, `${NAME}:${live.port}`, `${NAME}:1`, NAME, `other.test:${demoPort}`]
    for (const host of hosts) {
      const refused = await get(lanAddress, demoPort, '/', host)
      expect(refused.status, host).toBe(421)
      expect(refused.text).toBe('')
    }
    expect((await get(lanAddress, demoPort, '/', `${NAME}:${demoPort}`, 'POST')).status).toBe(405)
    expect((await get(lanAddress, demoPort, '/api/v1/session', `${NAME}:${demoPort}`)).status).toBe(404)
  })

  it('reports it on the LAN session reply only; the loopback reply is unchanged', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ lanDemoName: NAME })
    const lanReply = await get(lanAddress, live.port, '/api/v1/session', `${lanAddress}:${live.port}`)
    expect(lanReply.json()).toEqual({ authenticated: false, demoUrl: `http://${NAME}:${live.port + 1}/`, remote: true })
    const loopback = await send(live, 'GET', '/api/v1/session')
    expect(loopback.json()).toEqual({ authenticated: false, demoUrl: null })
  })

  it('serves the loopback mirror without any injected meta', async () => {
    const mirror = await startDemoMirror({ port: 0, demoDir, log: () => undefined })
    try {
      const reply = await get('127.0.0.1', mirror!.port, '/', `localhost:${mirror!.port}`)
      expect(reply.status).toBe(200)
      expect(reply.text).not.toContain('tg-live-url')
    } finally {
      await mirror?.close()
    }
  })

  it('escapes the injected attribute and leaves pages without <head> alone', () => {
    expect(injectLiveUrlMeta('<head></head>', 'http://x/"><script>')).toBe(
      '<head><meta name="tg-live-url" content="http://x/&quot;&gt;&lt;script&gt;"></head>'
    )
    expect(injectLiveUrlMeta('<html></html>', 'http://x/')).toBeNull()
  })

  it.each([
    ['an invalid name', 'localhost', undefined, /can't be used/],
    ['an IP address', '192.168.1.20', undefined, /can't be used/],
    ['a name that does not resolve', NAME, async () => Promise.reject(new Error('ENOTFOUND')), /does not resolve/],
    ['a name that resolves elsewhere', NAME, async () => ['10.9.9.9'], /resolves to 10\.9\.9\.9/]
  ] as const)('leaves Live running and says why for %s', async (_label, name, resolve, note) => {
    if (!lanAddress) return
    const live = await start({ lanDemoName: name, ...(resolve ? { resolve } : {}) })
    expect(live.lanOrigin).toBe(`http://${lanAddress}:${live.port}`)
    expect(live.lanDemoUrl).toBeNull()
    expect(live.lanDemoNote).toMatch(note)
    await expect(get(lanAddress, live.port + 1, '/', `${NAME}:${live.port + 1}`)).rejects.toBeInstanceOf(Error)
    const reply = await get(lanAddress, live.port, '/api/v1/session', `${lanAddress}:${live.port}`)
    expect((reply.json() as { demoUrl: unknown }).demoUrl).toBeNull()
  })

  it('leaves Live running when the demo is not built', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ lanDemoName: NAME, demo: false })
    expect(live.lanDemoUrl).toBeNull()
    expect(live.lanDemoNote).toMatch(/not built/)
  })

  it('does nothing without a LAN address', async () => {
    const live = await start({ lan: false, lanDemoName: NAME })
    expect(live.lanDemoUrl).toBeNull()
    expect(live.lanDemoNote).toBeNull()
  })

  it('leaves Live running when the demo port is busy', async (context) => {
    if (!lanAddress) return context.skip()
    // Find a port whose successor is taken on the LAN address.
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = createServer()
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
      const free = (probe.address() as { port: number }).port
      await new Promise<void>((resolve) => probe.close(() => resolve()))
      const taken = createServer()
      try {
        await new Promise<void>((resolve, reject) => {
          taken.once('error', reject)
          taken.listen(free + 1, lanAddress, resolve)
        })
      } catch {
        continue
      }
      blocker = taken
      initLanTestProfile(dataDir)
      running = await startLiveServer({
        dataDir,
        port: free,
        staticDir,
        appInfo,
        lanHost: lanAddress,
        lanDemoName: NAME,
        demoDir,
        lanDemoResolve: async () => [lanAddress],
        log: () => undefined
      })
      expect(running.lanDemoUrl).toBeNull()
      expect(running.lanDemoNote).toMatch(/in use/)
      expect(running.lanOrigin).toBe(`http://${lanAddress}:${free}`)
      return
    }
  })
})

describe('turning home-network access off', () => {
  async function pairDevice(live: RunningLiveServer, host: Awaited<ReturnType<typeof signIn>>): Promise<string> {
    const { code } = await call<{ code: string }>(live, host, 'createPairingCode')
    const enrolled = await get(
      lanAddress as string,
      live.port,
      '/api/v1/lan/enroll',
      `${lanAddress}:${live.port}`,
      'POST',
      { Origin: `http://${lanAddress}:${live.port}`, 'Content-Type': 'application/json' },
      JSON.stringify({ code })
    )
    expect(enrolled.status).toBe(200)
    return String(enrolled.headers['set-cookie']?.[0]).split(';')[0]!
  }

  it('closes the LAN listener and LAN demo, revokes devices, clears the code and logs a line', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ lanDemoName: NAME })
    const host = await signIn(live)
    const cookie = await pairDevice(live, host)
    const { code: unused } = await call<{ code: string }>(live, host, 'createPairingCode')
    expect(await call(live, host, 'listDevices')).toHaveLength(1)

    expect(await call(live, host, 'disableLan')).toEqual({ disabled: true })

    expect(await call(live, host, 'getLanStatus')).toEqual({ enabled: false, origin: null })
    expect(await call(live, host, 'listDevices')).toEqual([])
    expect(live.lanOrigin).toBeNull()
    expect(live.lanDemoUrl).toBeNull()
    // Closing is asynchronous; the handle's disableLan() waits for it.
    await live.disableLan()
    await expect(get(lanAddress, live.port, '/api/v1/session', `${lanAddress}:${live.port}`, 'GET', { Cookie: cookie })).rejects.toBeInstanceOf(Error)
    await expect(get(lanAddress, live.port + 1, '/', `${NAME}:${live.port + 1}`)).rejects.toBeInstanceOf(Error)

    const refused = await send(
      live,
      'POST',
      '/api/v1/call/createPairingCode',
      { Origin: live.origin, 'Content-Type': 'application/json', Cookie: host.cookie, 'X-TG-CSRF': host.csrf },
      '{"args":[]}'
    )
    expect(refused.status).toBe(409)
    expect(refused.json()).toEqual({ error: 'lan-off' })

    // Idempotent, and the console says so once, with no code, token or cookie.
    expect(await call(live, host, 'disableLan')).toEqual({ disabled: false })
    expect(logs.filter((line) => line.startsWith('Home-network access was turned off'))).toHaveLength(1)
    const everything = logs.join('\n')
    expect(everything).not.toContain(unused)
    expect(everything).not.toMatch(/tg_lan|token=/)
  })

  it('lets restore and upload work again afterwards', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start()
    const host = await signIn(live)
    const headers = { Origin: live.origin, Cookie: host.cookie, 'X-TG-CSRF': host.csrf }
    const upload = () => send(live, 'POST', '/api/v1/backup/upload', { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': '1' }, 'x')
    expect((await upload()).status).toBe(409)
    await call(live, host, 'disableLan')
    // Now it reaches the backup checks instead of the LAN refusal.
    expect((await upload()).status).not.toBe(409)
  })

  it('can be done from the handle too', async (context) => {
    if (!lanAddress) return context.skip()
    const live = await start({ lanDemoName: NAME })
    await live.disableLan()
    expect(await call(live, await signIn(live), 'getLanStatus')).toEqual({ enabled: false, origin: null })
    expect(live.lanDemoUrl).toBeNull()
  })

  it('is a no-op when the listener was never on', async () => {
    const live = await start({ lan: false })
    expect(await call(live, await signIn(live), 'disableLan')).toEqual({ disabled: false })
  })
})
