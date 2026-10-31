import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateHttpsHost } from '../../src/server/lan'
import { initLanTestProfile } from '../../src/server/lan-profile'
import { startLiveServer, type RunningLiveServer } from '../../src/server/server'
import { call, send, signIn, type Reply, type Signed } from './live-helpers'

// #167: the trusted-proxy HTTPS mode. A local reverse proxy (not in this repo) terminates TLS
// and forwards to 127.0.0.1:<port + 2>. These tests talk to that loopback port directly with
// the Host header the proxy would pass. Fictional data and names only.

const appInfo = { name: 'Tracing Guatemala', version: '0.0.0-test', platform: 'web' } as const
const NAME = 'tg.example.com'
const ORIGIN = `https://${NAME}`
const listQuery = { text: '', status: 'all', sources: [], sort: 'name' }

let root: string
let dataDir: string
let staticDir: string
let logs: string[]
let running: RunningLiveServer | null

/** Port 0 picks the Live port; port + 2 may happen to be taken, so try a few times. */
async function start(options: { httpsHost?: string; lanHost?: string | null; marked?: boolean } = {}): Promise<RunningLiveServer> {
  if (options.marked !== false) initLanTestProfile(dataDir)
  let last: unknown
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      running = await startLiveServer({
        dataDir,
        port: 0,
        staticDir,
        appInfo,
        httpsHost: options.httpsHost ?? NAME,
        lanHost: options.lanHost ?? null,
        log: (line) => logs.push(line)
      })
      return running
    } catch (error) {
      last = error
      if (!(error instanceof Error) || !error.message.startsWith('Port ')) throw error
    }
  }
  throw last
}

/** A request to the proxy port with the exact headers given (no defaults). */
function viaProxy(
  live: RunningLiveServer,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
  host: string | null = NAME
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sent = host === null ? headers : { Host: host, ...headers }
    const req = request({ host: '127.0.0.1', port: live.port + 2, method, path, agent: false, setHost: false, headers: sent }, (res) => {
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

const json = (headers: Record<string, string> = {}): Record<string, string> => ({ 'Content-Type': 'application/json', ...headers })

async function pair(live: RunningLiveServer, host: Signed): Promise<{ cookie: string; csrf: string }> {
  const { code } = await call<{ code: string }>(live, host, 'createPairingCode')
  const reply = await viaProxy(live, 'POST', '/api/v1/lan/enroll', json({ Origin: ORIGIN }), JSON.stringify({ code, deviceName: 'Kitchen tablet' }))
  expect(reply.status, reply.text).toBe(200)
  const cookie = String(reply.headers['set-cookie']?.[0]).split(';')[0]!
  const session = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: cookie })).json() as { csrfToken: string }
  return { cookie, csrf: session.csrfToken }
}

const proxyCall = (live: RunningLiveServer, paired: { cookie: string; csrf: string }, name: string, ...args: unknown[]) =>
  viaProxy(live, 'POST', `/api/v1/call/${name}`, json({ Origin: ORIGIN, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf }), JSON.stringify({ args }))

function connects(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(1_000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-https-proxy-'))
  dataDir = join(root, 'profile')
  staticDir = join(root, 'client')
  mkdirSync(staticDir, { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Live</title>')
  logs = []
  running = null
})

afterEach(async () => {
  await running?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('--https-host name and combination checks', () => {
  it('accepts a DNS name, lower-cased and trimmed', () => {
    expect(validateHttpsHost('  TG.Example.com ')).toEqual({ ok: true, name: 'tg.example.com' })
  })

  it.each(['192.168.1.20', '127.0.0.1', 'localhost', 'app.localhost', 'tg', 'tg.example.com:443', 'https://tg.example.com', 'a b.example.com', ''])(
    'refuses %j and starts nothing',
    async (bad) => {
      expect(validateHttpsHost(bad).ok).toBe(false)
      initLanTestProfile(dataDir)
      await expect(startLiveServer({ dataDir, port: 0, staticDir, appInfo, httpsHost: bad })).rejects.toThrow(/HTTPS name/)
    }
  )

  it('refuses an unmarked data folder before binding anything', async () => {
    await expect(start({ marked: false })).rejects.toThrow(/fictional test profile/)
  })

  it('refuses --lan-host combined with --https-host', async () => {
    await expect(start({ lanHost: '192.168.1.20' })).rejects.toThrow(/can't be used together/)
  })
})

describe('the proxy listener', () => {
  it('binds 127.0.0.1 only, on port + 2, and reports the https origin', async () => {
    const live = await start()
    expect(live.lanOrigin).toBe(ORIGIN)
    expect(await connects(live.port + 2)).toBe(true)
    // Loopback behaviour is unchanged: its own Host works, the proxy name does not.
    expect((await send(live, 'GET', '/')).status).toBe(200)
    expect((await send(live, 'GET', '/', { Host: NAME })).status).toBe(421)
    const host = await signIn(live)
    expect(await call(live, host, 'getLanStatus')).toEqual({ enabled: true, origin: ORIGIN })
  })

  it('closes everything and says so when port + 2 is busy', async () => {
    initLanTestProfile(dataDir)
    // Find a free Live port, then occupy the port two above it.
    for (let attempt = 0; attempt < 8; attempt++) {
      const probe = await startLiveServer({ dataDir, port: 0, staticDir, appInfo })
      const livePort = probe.port
      await probe.close()
      const plug = createServer()
      const plugged = await new Promise<boolean>((resolve) => {
        plug.once('error', () => resolve(false))
        plug.listen(livePort + 2, '127.0.0.1', () => resolve(true))
      })
      if (!plugged) continue
      try {
        await expect(startLiveServer({ dataDir, port: livePort, staticDir, appInfo, httpsHost: NAME })).rejects.toThrow(/Port \d+ .*in use/)
        expect(await connects(livePort)).toBe(false)
        // The data folder lock was released too: a plain start works again.
        running = await startLiveServer({ dataDir, port: livePort, staticDir, appInfo })
      } finally {
        await new Promise<void>((r) => plug.close(() => r()))
      }
      return
    }
    throw new Error('no free port pair found')
  })

  it.each([
    ['the loopback address', '127.0.0.1:PORT2'],
    ['a LAN address', '192.168.1.20:PORT2'],
    ['another name', 'other.example.com'],
    ['the name with :443', `${NAME}:443`],
    ['the name with the proxy port', `${NAME}:PORT2`],
    ['localhost', 'localhost']
  ])('answers 421 for Host = %s', async (_label, template) => {
    const live = await start()
    const host = template.replace('PORT2', String(live.port + 2))
    for (const path of ['/', '/api/v1/session']) {
      const reply = await viaProxy(live, 'GET', path, {}, undefined, host)
      expect(reply.status).toBe(421)
      expect(reply.headers['set-cookie']).toBeUndefined()
    }
  })

  it('refuses a request with no Host header', async () => {
    const live = await start()
    const status = await new Promise<number>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: live.port + 2 })
      let data = ''
      socket.on('data', (c) => (data += c.toString()))
      socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1])))
      socket.on('error', reject)
      socket.write('GET / HTTP/1.0\r\n\r\n')
    })
    expect([400, 421]).toContain(status)
  })

  it('serves the static client and the signed-out session probe for the right Host', async () => {
    const live = await start()
    const page = await viaProxy(live, 'GET', '/')
    expect(page.status).toBe(200)
    expect(page.text).toContain('Live')
    const session = await viaProxy(live, 'GET', '/api/v1/session')
    expect(session.json()).toMatchObject({ authenticated: false, remote: true })
    expect((await viaProxy(live, 'GET', '/launch')).status).toBe(404)
    expect((await viaProxy(live, 'GET', `/launch?token=${live.launchUrl.split('token=')[1]}`)).status).toBe(404)
  })
})

describe('forwarded headers are never trusted', () => {
  const forged = {
    'X-Forwarded-Host': NAME,
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-For': '192.168.1.20',
    'X-Real-IP': '192.168.1.20',
    Forwarded: `host=${NAME};proto=https`
  }

  it('does not make a wrong Host acceptable', async () => {
    const live = await start()
    expect((await viaProxy(live, 'GET', '/api/v1/session', forged, undefined, `127.0.0.1:${live.port + 2}`)).status).toBe(421)
    expect((await viaProxy(live, 'GET', '/api/v1/session', forged, undefined, 'other.example.com')).status).toBe(421)
  })

  it('does not change the https origin check or the Secure cookie', async () => {
    const live = await start()
    const host = await signIn(live)
    const { code } = await call<{ code: string }>(live, host, 'createPairingCode')
    const body = JSON.stringify({ code, deviceName: 'Kitchen tablet' })
    // Forwarded headers claim https but the Origin is plain http: still refused.
    const refused = await viaProxy(live, 'POST', '/api/v1/lan/enroll', json({ ...forged, Origin: `http://${NAME}` }), body)
    expect(refused.status).toBe(403)
    // Forwarded headers claim plain http: the cookie is still Secure.
    const ok = await viaProxy(live, 'POST', '/api/v1/lan/enroll', json({ Origin: ORIGIN, 'X-Forwarded-Proto': 'http', Forwarded: 'proto=http' }), body)
    expect(ok.status, ok.text).toBe(200)
    expect(String(ok.headers['set-cookie']?.[0])).toContain('Secure')
  })
})

describe('pairing and use through the proxy', () => {
  it('refuses enrollment from the wrong Origin and sets a Secure cookie for the right one', async () => {
    const live = await start()
    const host = await signIn(live)
    const { code } = await call<{ code: string }>(live, host, 'createPairingCode')
    const body = JSON.stringify({ code, deviceName: 'Kitchen tablet' })
    for (const origin of [`http://${NAME}`, 'https://other.example.com', `https://${NAME}:8443`, `http://127.0.0.1:${live.port + 2}`]) {
      const reply = await viaProxy(live, 'POST', '/api/v1/lan/enroll', json({ Origin: origin }), body)
      expect(reply.status, origin).toBe(403)
      expect(reply.headers['set-cookie']).toBeUndefined()
    }
    expect((await viaProxy(live, 'POST', '/api/v1/lan/enroll', json(), body)).status).toBe(403)
    const ok = await viaProxy(live, 'POST', '/api/v1/lan/enroll', json({ Origin: ORIGIN }), body)
    expect(ok.status, ok.text).toBe(200)
    const cookie = String(ok.headers['set-cookie']?.[0])
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('HttpOnly; SameSite=Strict')
    expect(cookie).not.toMatch(/Domain=/i)
    expect(cookie.startsWith(`tg_lan_${live.port}=`)).toBe(true)
  })

  it('lets a paired device make remote-allowed calls and refuses host-only ones', async () => {
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const list = await proxyCall(live, paired, 'listClients', listQuery)
    expect(list.status, list.text).toBe(200)
    for (const name of ['createBackup', 'restoreBackup', 'getBackupStatus', 'createPairingCode', 'disableLan']) {
      expect((await proxyCall(live, paired, name)).status, name).toBe(403)
    }
    // A write without the CSRF token or with the wrong Origin is refused.
    const noCsrf = await viaProxy(live, 'POST', '/api/v1/call/listClients', json({ Origin: ORIGIN, Cookie: paired.cookie }), JSON.stringify({ args: [listQuery] }))
    expect(noCsrf.status).toBe(403)
    const wrongOrigin = await viaProxy(
      live,
      'POST',
      '/api/v1/call/listClients',
      json({ Origin: `http://${NAME}`, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf }),
      JSON.stringify({ args: [listQuery] })
    )
    expect(wrongOrigin.status).toBe(403)
  })

  it('refuses backup upload and download as host-only, and does not accept the loopback session', async () => {
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const headers = { Origin: ORIGIN, Cookie: paired.cookie, 'X-TG-CSRF': paired.csrf }
    expect((await viaProxy(live, 'POST', '/api/v1/backup/upload', { ...headers, 'Content-Type': 'application/octet-stream' }, 'x')).status).toBe(403)
    expect((await viaProxy(live, 'GET', '/api/v1/backup/download/anything.tgbackup', headers)).status).toBe(403)
    const probe = (await viaProxy(live, 'GET', '/api/v1/session', { Cookie: host.cookie })).json() as { authenticated: boolean }
    expect(probe.authenticated).toBe(false)
    const asHost = await viaProxy(
      live,
      'POST',
      '/api/v1/call/listClients',
      json({ Origin: ORIGIN, Cookie: host.cookie, 'X-TG-CSRF': host.csrf }),
      JSON.stringify({ args: [listQuery] })
    )
    expect(asHost.status).toBe(401)
  })

  it('logs no bodies, names or secrets', async () => {
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    await proxyCall(live, paired, 'listClients', listQuery)
    const all = logs.join('\n')
    expect(all).not.toContain(paired.cookie.split('=')[1]!)
    expect(all).not.toContain(paired.csrf)
    expect(all).not.toContain('Kitchen tablet')
  })
})

describe('turning it off and restore', () => {
  it('disableLan closes the proxy port and revokes sessions', async () => {
    const live = await start()
    const host = await signIn(live)
    const paired = await pair(live, host)
    const port = live.port + 2
    expect(await call(live, host, 'disableLan')).toEqual({ disabled: true })
    await live.disableLan()
    expect(await connects(port)).toBe(false)
    expect(live.lanOrigin).toBeNull()
    expect(paired.cookie).toContain('tg_lan_')
    expect(await call(live, host, 'getLanStatus')).toEqual({ enabled: false, origin: null })
    // The loopback listener still works.
    expect((await send(live, 'GET', '/')).status).toBe(200)
  })

  it('refuses restoring a backup on loopback while the proxy listener is on', async () => {
    const live = await start()
    const host = await signIn(live)
    const reply = await send(
      live,
      'POST',
      '/api/v1/call/restoreBackup',
      { Origin: live.origin, 'Content-Type': 'application/json', Cookie: host.cookie, 'X-TG-CSRF': host.csrf },
      JSON.stringify({ args: ['x'.repeat(10)] })
    )
    expect(reply.status).toBe(409)
    expect(reply.text).toContain('restore-disabled-while-lan')
  })

  it('does not start any proxy listener without the flag', async () => {
    initLanTestProfile(dataDir)
    running = await startLiveServer({ dataDir, port: 0, staticDir, appInfo })
    expect(running.lanOrigin).toBeNull()
    expect(await connects(running.port + 2)).toBe(false)
  })
})
